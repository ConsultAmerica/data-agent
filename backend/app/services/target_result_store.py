"""Persist targeted extraction results as durable intelligence records.

Repository / Field Explorer / reopen must reconstruct from PostgreSQL,
not React state or job blobs alone.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.document_extracted_table import DocumentExtractedTable
from app.models.document_metadata_field import DocumentMetadataField
from app.models.metadata_field_audit_log import MetadataFieldAuditLog
from app.schemas.document_target import (
    ExtractTargetsResponse,
    ScalarTargetResult,
    TableTargetResult,
)
from app.schemas.extraction_intelligence import (
    ConfidenceDetail,
    ConfidenceSignals,
    RetrievalTrace,
    ValidationResult,
    confidence_detail_to_legacy_signals,
)
from app.schemas.universal_extraction import SourceEvidence
from app.services.detected_target_store import load_document_targets
from app.services.discovery_enrichment import humanize_field_key
from app.services.field_classification import is_auto_kv_key
from app.services.review_routing import (
    REASON_EXTRACTION_DIFFERS,
    decide_review_for_scalar,
)
from app.core.config import get_settings


def _stringify_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float, bool)):
        return str(value)
    return json.dumps(value, ensure_ascii=False)


def _evidence_dict(evidence: Any) -> dict:
    if evidence is None:
        return {
            "page_number": 1,
            "source_text": "",
            "source_reference": "",
        }
    if isinstance(evidence, SourceEvidence):
        return evidence.model_dump()
    if isinstance(evidence, dict):
        return evidence
    return {
        "page_number": 1,
        "source_text": str(evidence),
        "source_reference": "",
    }


def clear_stale_target_values(
    *,
    database: Session,
    document_id: str,
    unresolved_keys: list[str],
) -> int:
    """Remove machine values the latest extraction no longer produces.

    A target that resolved to nothing this run (its old value now fails
    validation, or is gone from the source) must not keep showing the old
    value. Only untouched rows go: pending, never reviewed, no audit entry.
    Accepted, edited or rejected values stay as reviewers left them.
    """

    keys = sorted({key for key in unresolved_keys if key})
    if not keys:
        return 0
    rows = list(
        database.scalars(
            select(DocumentMetadataField).where(
                DocumentMetadataField.document_id == document_id,
                DocumentMetadataField.extraction_source == "target",
                DocumentMetadataField.field_key.in_(keys),
                DocumentMetadataField.review_status == "pending",
            )
        )
    )
    audited = set(
        database.scalars(
            select(MetadataFieldAuditLog.metadata_field_id).where(
                MetadataFieldAuditLog.metadata_field_id.in_([row.id for row in rows])
            )
        )
    ) if rows else set()
    cleared = 0
    for row in rows:
        if row.id in audited:
            continue
        database.delete(row)
        cleared += 1
    return cleared


def persist_target_extraction_results(
    *,
    database: Session,
    document_id: str,
    scalars: list[ScalarTargetResult] | list[dict],
    tables: list[TableTargetResult] | list[dict],
    extraction_job_id: int | None = None,
) -> None:
    """Upsert scalars + tables from a completed targeted extraction."""

    discovered = load_document_targets(database=database, document_id=document_id)
    label_by_key: dict[str, str] = {}
    group_by_key: dict[str, str] = {}
    value_type_by_key: dict[str, str] = {}
    if discovered:
        for target in discovered.targets:
            label_by_key[target.key] = target.display_name or target.label
            if target.group:
                group_by_key[target.key] = target.group
            if target.value_type:
                value_type_by_key[target.key] = target.value_type

    now = datetime.now(timezone.utc)

    for item in scalars:
        if isinstance(item, dict):
            scalar = ScalarTargetResult.model_validate(item)
        else:
            scalar = item

        key = scalar.normalized_key
        value = _stringify_value(scalar.value)
        evidence = _evidence_dict(scalar.evidence)

        existing = database.scalar(
            select(DocumentMetadataField).where(
                DocumentMetadataField.document_id == document_id,
                DocumentMetadataField.field_key == key,
                DocumentMetadataField.extraction_source == "target",
            )
        )

        # scalar.target is often just the raw candidate key re-echoed
        # (ScalarTargetResult.target == DocumentTarget.key upstream), so it
        # is only trusted as a label when it isn't itself an internal
        # kv_/custom_ key — otherwise humanize the key rather than ever
        # persist a raw candidate key as the user-facing label.
        candidate_label = (scalar.target or "").strip()
        if not candidate_label or candidate_label == key or is_auto_kv_key(
            candidate_label
        ):
            candidate_label = None
        label = label_by_key.get(key) or candidate_label or humanize_field_key(key)
        group = group_by_key.get(key) or "extracted"
        value_type = value_type_by_key.get(key) or "string"
        if is_auto_kv_key(key):
            # Debug/provenance only — the raw discovery candidate id must
            # never surface as the field's identity outside this blob.
            evidence["candidate_key"] = key
            evidence["canonical_field_name"] = key[3:]
        if scalar.confidence_signals:
            evidence["confidence_signals"] = scalar.confidence_signals
        evidence["validation_status"] = scalar.validation_status
        evidence["confidence_band"] = scalar.confidence_band
        if scalar.retrieval is not None:
            evidence["retrieval"] = scalar.retrieval.model_dump()
        if scalar.confidence_detail is not None:
            evidence["confidence_detail"] = scalar.confidence_detail.model_dump()
        if scalar.validation is not None:
            evidence["validation"] = scalar.validation.model_dump()

        decision = decide_review_for_scalar(
            scalar,
            auto_accept_high_confidence=bool(
                get_settings().auto_accept_high_confidence
            ),
        )
        evidence["review_decision"] = {
            "status": decision["status"],
            "priority": decision["priority"],
            "reasons": decision["reasons"],
        }
        evidence["machine_value"] = value
        initial_review_status = decision["review_status"]

        if existing is None:
            database.add(
                DocumentMetadataField(
                    document_id=document_id,
                    field_group=group[:30],
                    field_key=key[:120],
                    label=label[:255],
                    value=value,
                    original_value=value,
                    confidence=scalar.confidence,
                    confidence_band=scalar.confidence_band,
                    value_type=value_type,
                    extraction_method=(scalar.extraction_method or "label_value")[
                        :40
                    ],
                    display_method=(scalar.display_method or None),
                    evidence_json=evidence,
                    verified=bool(scalar.verified),
                    human_approved=initial_review_status == "accepted",
                    review_status=initial_review_status,
                    extraction_source="target",
                    extraction_job_id=extraction_job_id,
                    extracted_at=now,
                )
            )
        else:
            prior_status = existing.review_status
            human_locked = prior_status in {"edited", "accepted", "rejected"}
            reviewed_value = existing.value

            # Always refresh intelligence metadata + latest machine value.
            existing.label = label[:255]
            existing.field_group = group[:30]
            existing.confidence = scalar.confidence
            existing.confidence_band = scalar.confidence_band
            existing.value_type = value_type
            existing.extraction_method = (
                scalar.extraction_method or existing.extraction_method
            )[:40]
            existing.display_method = scalar.display_method or existing.display_method
            existing.verified = bool(scalar.verified)
            existing.extraction_job_id = extraction_job_id
            existing.extracted_at = now

            if not human_locked:
                # Machine-owned pending rows can be overwritten.
                existing.value = value
                if not existing.original_value:
                    existing.original_value = value
                existing.evidence_json = evidence
                if prior_status == "pending":
                    existing.review_status = initial_review_status
                    existing.human_approved = initial_review_status == "accepted"
            else:
                # Preserve reviewed/authoritative value; keep machine_value.
                evidence["reviewed_value"] = reviewed_value
                evidence["prior_review_status"] = prior_status
                if _stringify_value(reviewed_value) != value:
                    reasons = list(decision["reasons"])
                    if REASON_EXTRACTION_DIFFERS not in reasons:
                        reasons.append(REASON_EXTRACTION_DIFFERS)
                    evidence["review_decision"] = {
                        "status": "needs_review",
                        "priority": "low",
                        "reasons": reasons,
                    }
                    existing.review_status = "pending"
                    existing.human_approved = False
                else:
                    # Same machine value — keep human decision intact.
                    evidence["review_decision"] = {
                        "status": "ready_to_accept"
                        if prior_status in {"accepted", "edited"}
                        else decision["status"],
                        "priority": decision["priority"],
                        "reasons": [],
                    }
                existing.evidence_json = evidence
                if not existing.original_value:
                    existing.original_value = value


    for item in tables:
        if isinstance(item, dict):
            table = TableTargetResult.model_validate(item)
        else:
            table = item

        # TableTargetResult.target is display label; prefer slug from target id.
        target_key = (
            table.target.lower().replace(" ", "_")[:120]
            if table.target
            else "table"
        )
        # Prefer matching discovered table keys when label matches.
        if discovered:
            for discovered_target in discovered.targets:
                if (
                    discovered_target.target_type == "table"
                    and discovered_target.label == table.target
                ):
                    target_key = discovered_target.key
                    break

        existing_table = database.scalar(
            select(DocumentExtractedTable).where(
                DocumentExtractedTable.document_id == document_id,
                DocumentExtractedTable.target_key == target_key,
            )
        )
        if existing_table is None:
            database.add(
                DocumentExtractedTable(
                    document_id=document_id,
                    target_key=target_key,
                    display_name=table.target,
                    columns_json=list(table.columns or []),
                    rows_json=list(table.rows or []),
                    pages_json=list(table.pages or []),
                    extraction_method="table",
                    confidence=None,
                    evidence_json=None,
                    extraction_job_id=extraction_job_id,
                    extracted_at=now,
                )
            )
        else:
            existing_table.display_name = table.target
            existing_table.columns_json = list(table.columns or [])
            existing_table.rows_json = list(table.rows or [])
            existing_table.pages_json = list(table.pages or [])
            existing_table.extraction_job_id = extraction_job_id
            existing_table.extracted_at = now

    database.commit()


def load_persisted_extract_results(
    *,
    database: Session,
    document_id: str,
) -> ExtractTargetsResponse | None:
    """Rebuild ExtractTargetsResponse from durable rows (no re-extract)."""

    scalar_rows = list(
        database.scalars(
            select(DocumentMetadataField)
            .where(
                DocumentMetadataField.document_id == document_id,
                DocumentMetadataField.extraction_source == "target",
            )
            .order_by(DocumentMetadataField.id)
        )
    )
    table_rows = list(
        database.scalars(
            select(DocumentExtractedTable)
            .where(DocumentExtractedTable.document_id == document_id)
            .order_by(DocumentExtractedTable.id)
        )
    )

    if not scalar_rows and not table_rows:
        return None

    scalars: list[ScalarTargetResult] = []
    for row in scalar_rows:
        raw_evidence = dict(row.evidence_json or {})
        signals = list(raw_evidence.pop("confidence_signals", []) or [])
        validation_status = raw_evidence.pop("validation_status", "passed")
        raw_evidence.pop("confidence_band", None)
        retrieval_raw = raw_evidence.pop("retrieval", None)
        confidence_detail_raw = raw_evidence.pop("confidence_detail", None)
        validation_raw = raw_evidence.pop("validation", None)
        review_decision_raw = raw_evidence.pop("review_decision", None)
        # Governance metadata stored alongside evidence — not SourceEvidence fields.
        machine_value = raw_evidence.pop("machine_value", None)
        raw_evidence.pop("reviewed_value", None)
        raw_evidence.pop("prior_review_status", None)
        evidence = SourceEvidence.model_validate(
            raw_evidence
            or {
                "page_number": 1,
                "source_text": "",
                "source_reference": "",
            }
        )
        band = row.confidence_band or (
            "high"
            if row.confidence >= 0.85
            else "medium"
            if row.confidence >= 0.6
            else "low"
        )

        retrieval = None
        if isinstance(retrieval_raw, dict):
            try:
                retrieval = RetrievalTrace.model_validate(retrieval_raw)
            except Exception:
                retrieval = None

        confidence_detail = None
        if isinstance(confidence_detail_raw, dict):
            try:
                confidence_detail = ConfidenceDetail.model_validate(
                    confidence_detail_raw
                )
            except Exception:
                confidence_detail = None
        if confidence_detail is None:
            confidence_detail = ConfidenceDetail(
                score=float(row.confidence or 0),
                band=band,  # type: ignore[arg-type]
                signals=ConfidenceSignals(
                    source_grounded=bool(row.verified),
                    format_validation=validation_status == "passed",
                    ai_fallback=(row.extraction_method or "") == "ai",
                ),
            )

        validation = None
        if isinstance(validation_raw, dict):
            try:
                validation = ValidationResult.model_validate(validation_raw)
            except Exception:
                validation = None
        if validation is None:
            validation = ValidationResult(
                status=validation_status  # type: ignore[arg-type]
                if validation_status in {"passed", "failed", "skipped"}
                else "passed",
                checks=[],
                warnings=[],
            )

        if not signals:
            signals = confidence_detail_to_legacy_signals(confidence_detail)

        scalars.append(
            ScalarTargetResult(
                target=row.label,
                normalized_key=row.field_key,
                value=row.value,
                extracted_value=(
                    machine_value
                    if machine_value is not None
                    else row.original_value or row.value
                ),
                review_status=row.review_status,
                page=evidence.page_number,
                confidence=row.confidence,
                confidence_band=band,  # type: ignore[arg-type]
                verified=row.verified,
                extraction_method=row.extraction_method,
                display_method=row.display_method or "",
                evidence=evidence,
                retrieval=retrieval,
                confidence_detail=confidence_detail,
                validation=validation,
                review_decision=review_decision_raw
                if isinstance(review_decision_raw, dict)
                else None,
                confidence_signals=signals,
                validation_status=validation.status,
            )
        )

    tables = [
        TableTargetResult(
            target=row.display_name,
            columns=list(row.columns_json or []),
            rows=list(row.rows_json or []),
            pages=list(row.pages_json or []),
        )
        for row in table_rows
    ]

    return ExtractTargetsResponse(
        document_id=document_id,
        scalars=scalars,
        tables=tables,
        unresolved_targets=[],
        warnings=[],
    )


def list_target_metadata_fields(
    *,
    database: Session,
    document_id: str,
) -> list[DocumentMetadataField]:
    return list(
        database.scalars(
            select(DocumentMetadataField).where(
                DocumentMetadataField.document_id == document_id,
                DocumentMetadataField.extraction_source == "target",
            )
        )
    )
