"""Which recognition providers may see which documents.

Local engines (native text, Tesseract, a loopback Ollama) always may.
An external provider may see a document only when its data class allows:

    public, internal   allowed
    confidential       allowed under EXTERNAL_AI_POLICY=legacy (the
                       behaviour before data classes); under "enterprise"
                       only with an active approval
    unclassified       not classified yet (e.g. at upload/OCR time): as
                       confidential under legacy; approval under enterprise
    restricted         only with an active approval, under either policy

An approval (models/provider_approval.py) names the provider (or "*"),
the data class and the purpose; it can expire or be revoked. A document
not yet classified is treated as confidential.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.parse import urlparse

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.models.provider_approval import ProviderApproval

DEFAULT_DATA_CLASS = "confidential"
# A document whose class can't be determined yet (no profile, resolution
# not confident). Approvable like a data class.
UNCLASSIFIED = "unclassified"
_OPEN_CLASSES = {"public", "internal"}
_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}


@dataclass(frozen=True)
class PolicyDecision:
    allowed: bool
    data_class: str
    reason: str


def effective_data_class(data_class: str | None) -> str:
    return data_class or DEFAULT_DATA_CLASS


def provider_locality(provider_id: str, settings) -> str:
    if provider_id in {"disabled", "local_ocr", "native_text", "source_structure", "tesseract", "mrz", "rapidocr"}:
        return "local"
    if provider_id == "ollama":
        host = urlparse(getattr(settings, "ollama_base_url", None) or "").hostname or ""
        return "local" if host in _LOOPBACK_HOSTS else "external"
    return "external"


def member_provider_ids(provider) -> list[str]:
    """The concrete providers behind a provider object (a fallback chain
    lists its members)."""

    members = getattr(provider, "providers", None)
    if members:
        return [pid for member in members for pid in member_provider_ids(member)]
    return [getattr(provider, "provider_id", provider.__class__.__name__)]


def _approved(database: Session, provider_id: str, data_class: str, now: datetime) -> bool:
    row = database.scalars(
        select(ProviderApproval.id)
        .where(
            ProviderApproval.provider_id.in_([provider_id, "*"]),
            ProviderApproval.data_class == data_class,
            ProviderApproval.revoked_at.is_(None),
            or_(ProviderApproval.expires_at.is_(None), ProviderApproval.expires_at > now),
        )
        .limit(1)
    ).first()
    return row is not None


def decide_external_processing(
    database: Session | None,
    *,
    data_class: str | None,
    provider_ids: list[str],
    settings,
    now: datetime | None = None,
) -> PolicyDecision:
    cls = effective_data_class(data_class)
    external = [pid for pid in provider_ids if provider_locality(pid, settings) == "external"]
    if not external:
        return PolicyDecision(True, cls, "Local processing only.")
    if cls in _OPEN_CLASSES:
        return PolicyDecision(True, cls, f"{cls.capitalize()} documents may use external providers.")
    policy = (getattr(settings, "external_ai_policy", "legacy") or "legacy").strip().lower()
    if cls in ("confidential", UNCLASSIFIED) and policy != "enterprise":
        return PolicyDecision(True, cls, f"{cls.capitalize()} documents may use external providers (legacy policy).")

    now = now or datetime.now(timezone.utc)
    missing = [
        pid for pid in external if database is None or not _approved(database, pid, cls, now)
    ]
    if missing:
        return PolicyDecision(
            False,
            cls,
            f"External processing of {cls} documents is not approved for: {', '.join(missing)}.",
        )
    return PolicyDecision(True, cls, f"Approved for {cls} documents: {', '.join(external)}.")


def classify_for_policy(database: Session | None, document) -> str:
    """The document's data class for a policy decision, without side
    effects: its own class, else its pinned staging profile's, else a
    confident (cheap, structure-free) profile resolution's — else
    UNCLASSIFIED. Never builds source structure."""

    if getattr(document, "data_class", None):
        return document.data_class
    if database is None:
        return UNCLASSIFIED
    try:
        from app.models.document_staging_workbook import DocumentStagingWorkbook
        from app.staging import registry
        from app.staging.resolver import resolve_profile

        record = database.scalars(
            select(DocumentStagingWorkbook).where(DocumentStagingWorkbook.document_id == document.id)
        ).first()
        if record is not None and record.profile_id:
            profile = registry.get_profile(record.profile_id, record.profile_version)
            if profile is not None:
                return profile.data_class
        resolution = resolve_profile(database, document)
        if resolution.confident:
            return resolution.profile.data_class
    except Exception:  # noqa: BLE001 - classification for policy must not fail a run
        return UNCLASSIFIED
    return UNCLASSIFIED
