"""Validation as a reviewer sees it: what failed, why, and whether that
blocks an ordinary approval.

Everything here comes from what extraction recorded in ``evidence_json``
(``validation`` / ``validation_status``) or from re-running the validator on
a reviewer's correction. No correction is ever suggested unless extraction
stored one.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from app.models.document_metadata_field import DocumentMetadataField
from app.services.evidence_text import source_text_of
from app.services.result_validation import build_validation_result

# Plain names for the validator's check types.
RULE_LABELS = {
    "data_type": "Data type",
    "format": "Value present",
    "label_rejection": "Not a form label or prose",
    "source_presence": "Found in the source text",
}

REASON_VALIDATION_FAILED = "validation_failed"


def _evidence(field: DocumentMetadataField) -> dict[str, Any]:
    return field.evidence_json if isinstance(field.evidence_json, dict) else {}


def validation_summary(field: DocumentMetadataField) -> dict[str, Any]:
    """``{status, failed_rules, messages, suggested_value, blocking,
    override}`` for one field. ``status`` is "not_run" when extraction
    recorded no validation."""

    evidence = _evidence(field)
    validation = evidence.get("validation")
    validation = validation if isinstance(validation, dict) else {}
    status = validation.get("status") or evidence.get("validation_status") or "not_run"
    failed_rules = [
        {
            "rule": check.get("type") or "check",
            "label": RULE_LABELS.get(check.get("type") or "", check.get("type") or "Check"),
            "detail": check.get("detail"),
        }
        for check in validation.get("checks") or []
        if isinstance(check, dict) and check.get("status") == "failed"
    ]
    messages = [str(m) for m in validation.get("warnings") or [] if str(m).strip()]
    suggested = evidence.get("suggested_value")
    override = evidence.get("validation_override")
    return {
        "status": status,
        "failed_rules": failed_rules,
        "messages": messages,
        # Only a correction extraction itself recorded; never invented here.
        "suggested_value": suggested if isinstance(suggested, str) and suggested.strip() else None,
        "blocking": status == "failed",
        "override": override if isinstance(override, dict) else None,
    }


def blocks_approval(field: DocumentMetadataField) -> bool:
    return validation_summary(field)["blocking"]


def revalidate_correction(
    field: DocumentMetadataField,
    value: str,
    *,
    reviewer: str,
) -> dict[str, Any]:
    """Re-run validation on a reviewer's corrected value and store the result
    on the field's evidence (returned too). The source-presence check is
    skipped: the reviewer typed the value from the document themselves."""

    evidence = dict(_evidence(field))
    result = build_validation_result(
        value=value,
        value_type=field.value_type,
        source_text=source_text_of(evidence),
        page_text="",
        source_presence_ok=True,
    )
    checks = []
    for check in result.checks:
        data = check.model_dump()
        if data["type"] == "source_presence":
            data.update(status="skipped", detail="Value entered by reviewer")
        checks.append(data)
    status = "failed" if any(c["status"] == "failed" for c in checks) else "passed"
    validation = {"status": status, "checks": checks, "warnings": list(result.warnings)}

    evidence["validation"] = validation
    evidence["validation_status"] = status
    decision = dict(evidence.get("review_decision") or {})
    reasons = [r for r in decision.get("reasons") or [] if r != REASON_VALIDATION_FAILED]
    if status == "failed":
        reasons.append(REASON_VALIDATION_FAILED)
    decision["reasons"] = reasons
    evidence["review_decision"] = decision
    evidence["corrected_by"] = reviewer
    evidence["corrected_at"] = datetime.now(timezone.utc).isoformat()
    # An override applied to the previous value doesn't carry over.
    evidence.pop("validation_override", None)
    field.evidence_json = evidence
    return validation


def record_override(
    field: DocumentMetadataField,
    *,
    reason: str,
    reviewer: str,
) -> dict[str, Any]:
    """Note on the field that a blocking validation failure was overridden."""

    evidence = dict(_evidence(field))
    summary = validation_summary(field)
    override = {
        "reason": reason,
        "reviewer": reviewer,
        "at": datetime.now(timezone.utc).isoformat(),
        "failed_rules": [rule["rule"] for rule in summary["failed_rules"]],
        "messages": summary["messages"],
    }
    evidence["validation_override"] = override
    field.evidence_json = evidence
    return override
