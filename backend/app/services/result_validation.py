"""First-class validation objects for extracted target values."""

from __future__ import annotations

import re
from typing import Any, Literal

from app.schemas.extraction_intelligence import ValidationCheck, ValidationResult
from app.services.label_rejection import is_word_not_identifier, reject_as_field_value
from app.services.source_validator import validate_source_value

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_PHONE_RE = re.compile(r"^[\d\s().+-]{7,}$")
_DATE_HINT_RE = re.compile(
    r"\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2})\b"
)
_CURRENCY_HINT_RE = re.compile(
    r"^[$€£]?\s?-?\d{1,3}(?:,\d{3})*(?:\.\d+)?%?$|^[$€£]?\s?-?\d+(?:\.\d+)?$"
)
_IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/\-]{2,47}$")

CheckStatus = Literal["passed", "failed", "skipped"]

_IDENTIFIER_TYPES = frozenset(
    {
        "identifier",
        "id",
        "contract_number",
        "solicitation_number",
    }
)


def build_validation_result(
    *,
    value: Any,
    value_type: str | None,
    source_text: str,
    page_text: str,
    source_presence_ok: bool | None = None,
) -> ValidationResult:
    checks: list[ValidationCheck] = []
    warnings: list[str] = []
    text = "" if value is None else str(value).strip()

    type_status: CheckStatus = "passed"
    if value_type in {"date"} and text and not _DATE_HINT_RE.search(text):
        type_status = "failed"
        warnings.append("Value does not look like a date.")
    elif value_type in {"currency", "amount", "money", "number"} and text and not (
        _CURRENCY_HINT_RE.match(text.replace(" ", ""))
        or any(ch.isdigit() for ch in text)
    ):
        type_status = "failed"
        warnings.append("Currency/amount value has no digits.")
    elif value_type == "email" and text and not _EMAIL_RE.match(text):
        type_status = "failed"
        warnings.append("Value is not a valid email.")
    elif value_type == "phone" and text and not _PHONE_RE.match(text):
        type_status = "failed"
        warnings.append("Value does not look like a phone number.")
    elif value_type in _IDENTIFIER_TYPES and text and not _IDENTIFIER_RE.match(
        text.replace(" ", "")
    ):
        type_status = "failed"
        warnings.append("Identifier is not a compact ID pattern.")
    elif value_type in _IDENTIFIER_TYPES and is_word_not_identifier(text):
        type_status = "failed"
        warnings.append("Identifier has no digits; it reads as a word, not an ID.")
    checks.append(ValidationCheck(type="data_type", status=type_status))

    format_status: CheckStatus = "passed" if text else "failed"
    if not text:
        warnings.append("Extracted value is empty.")
    checks.append(ValidationCheck(type="format", status=format_status))

    label_reason = reject_as_field_value(text, value_type=value_type)
    label_status: CheckStatus = "failed" if label_reason else "passed"
    if label_reason:
        warnings.append(f"Value rejected as form label/prose ({label_reason}).")
    checks.append(
        ValidationCheck(
            type="label_rejection",
            status=label_status,
            detail=label_reason,
        )
    )

    if source_presence_ok is None:
        source_presence_ok = validate_source_value(
            value=value,
            source_text=source_text,
            page_text=page_text,
        )
    presence_status: CheckStatus = "passed" if source_presence_ok else "failed"
    if not source_presence_ok:
        warnings.append("Value could not be grounded in source text.")
    checks.append(ValidationCheck(type="source_presence", status=presence_status))

    overall: CheckStatus = "passed"
    if any(check.status == "failed" for check in checks):
        overall = "failed"

    return ValidationResult(status=overall, checks=checks, warnings=warnings)
