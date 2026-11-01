"""The Oracle Fusion target catalog: what each registered import target is
in Oracle — its application, integration method, release, object code,
parent object and user keys — and whether its schema can be trusted.

A target's attributes always come from a verified source: an official
template an administrator uploaded (``uploaded_template``) or an Oracle
metadata API (``metadata_api``). Nothing here supplies an Oracle name,
attribute or object of its own.

Status:

* ``verified``: an administrator confirmed the schema is Oracle's own, for
  the stated application, method and release.
* ``draft``: registered but not yet verified (every template uploaded
  before the catalog existed reads as this).
* ``unsupported``: its integration method isn't one this application
  supports, or isn't a method Dataomatix can prepare data for.
* ``stale``: retired, or a newer version of the same object is registered.

Only a verified target can be import-ready; a draft one is a warning, an
unsupported or stale one an error.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

APPLICATIONS: tuple[str, ...] = (
    "Enterprise Contracts",
    "Procurement",
    "Financials",
    "Project Management",
    "Sales and Service",
    "Other",
)

IntegrationMethod = Literal["import_management", "fbdi", "rest", "other"]
INTEGRATION_METHODS: dict[str, str] = {
    "import_management": "Import Management",
    "fbdi": "File-Based Data Import (FBDI)",
    "rest": "REST API",
    "other": "Other",
}

# Import Management is the Sales and Service (CX) mechanism; the ERP and
# Project applications load data through FBDI or REST. "Other" names an
# application Dataomatix doesn't classify, so any method is taken as stated.
_METHODS_BY_APPLICATION: dict[str, set[str]] = {
    "Enterprise Contracts": {"fbdi", "rest"},
    "Procurement": {"fbdi", "rest"},
    "Financials": {"fbdi", "rest"},
    "Project Management": {"fbdi", "rest"},
    "Sales and Service": {"import_management", "rest"},
    "Other": {"import_management", "fbdi", "rest"},
}

VERIFIED, DRAFT, UNSUPPORTED, STALE = "verified", "draft", "unsupported", "stale"
STATUS_LABELS = {VERIFIED: "Verified", DRAFT: "Draft", UNSUPPORTED: "Unsupported", STALE: "Stale"}
NOT_CONFIGURED = "Oracle import template not configured"


class CatalogIn(BaseModel):
    application: str = Field(min_length=1, max_length=60)
    integration_method: IntegrationMethod
    oracle_release: str | None = Field(default=None, max_length=40)
    object_code: str | None = Field(default=None, max_length=120)
    parent_object: str | None = Field(default=None, max_length=120)
    user_keys: list[str] = Field(default_factory=list, max_length=20)
    description: str | None = Field(default=None, max_length=1000)

    @field_validator("application")
    @classmethod
    def _known_application(cls, value: str) -> str:
        if value not in APPLICATIONS:
            raise ValueError(f"Application must be one of: {', '.join(APPLICATIONS)}.")
        return value


def catalog_of(template: Any) -> dict[str, Any]:
    """The template's catalog entry, with defaults for what isn't set."""

    stored = dict(getattr(template, "catalog", None) or {})
    return {
        "application": stored.get("application"),
        "integration_method": stored.get("integration_method"),
        "oracle_release": stored.get("oracle_release"),
        "object_code": stored.get("object_code"),
        "parent_object": stored.get("parent_object"),
        "user_keys": list(stored.get("user_keys") or []),
        "description": stored.get("description"),
        "source": stored.get("source") or "uploaded_template",
        "verified": bool(stored.get("verified")),
        "verified_by": stored.get("verified_by"),
        "verified_at": stored.get("verified_at"),
    }


def method_problem(application: str | None, method: str | None) -> str | None:
    """Why an application/method pair isn't supported, or None."""

    if not application or not method:
        return None
    if method == "other":
        return "Dataomatix prepares data only for Import Management, FBDI and REST targets."
    if method not in _METHODS_BY_APPLICATION.get(application, set()):
        return f"{INTEGRATION_METHODS.get(method, method)} is not an integration method of {application}."
    return None


def status_of(template: Any, newer_version: bool = False) -> tuple[str, str | None]:
    """(status, reason) of a registered target."""

    entry = catalog_of(template)
    if getattr(template, "status", "active") == "retired":
        return STALE, "The template is retired."
    if newer_version:
        return STALE, "A newer version of this object is registered."
    problem = method_problem(entry["application"], entry["integration_method"])
    if problem:
        return UNSUPPORTED, problem
    if not entry["application"] or not entry["integration_method"]:
        return DRAFT, "Its Oracle application and integration method aren't set."
    if not entry["verified"]:
        return DRAFT, "Not yet verified by an administrator."
    return VERIFIED, None


def updated_catalog(template: Any, payload: CatalogIn) -> dict[str, Any]:
    """The catalog after an edit. Changing what the target is (application,
    method, release, object code) withdraws an earlier verification."""

    entry = catalog_of(template)
    names = {column["technical_name"] for column in template.columns}
    unknown = [key for key in payload.user_keys if key not in names]
    if unknown:
        raise ValueError(f"User keys must be attributes of this target: {', '.join(unknown)}.")
    identity = ("application", "integration_method", "oracle_release", "object_code")
    changed = any(entry[key] != getattr(payload, key) for key in identity)
    entry.update(payload.model_dump())
    if changed:
        entry.update(verified=False, verified_by=None, verified_at=None)
    return entry


def verified_catalog(template: Any, actor_name: str) -> dict[str, Any]:
    entry = catalog_of(template)
    if not entry["application"] or not entry["integration_method"]:
        raise ValueError("Set the Oracle application and integration method before verifying.")
    problem = method_problem(entry["application"], entry["integration_method"])
    if problem:
        raise ValueError(problem)
    entry.update(verified=True, verified_by=actor_name, verified_at=datetime.now(timezone.utc).isoformat())
    return entry


def required_attributes(columns: list[dict]) -> list[str]:
    return [column["technical_name"] for column in columns if column.get("required")]
