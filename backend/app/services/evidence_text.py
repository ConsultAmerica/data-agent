"""The document text a value was read from — never a validation message.

Unresolved target fields used to store their failure reason (for example
"candidate failed label/value validation") in ``source_text``. Rows written
before that was fixed still hold it, so every reader goes through
:func:`source_text_of`, which drops text that is really a recorded reason.
"""

from __future__ import annotations

from typing import Any


def _recorded_reasons(evidence: dict[str, Any]) -> set[str]:
    reasons: set[str] = set()
    field_evidence = evidence.get("field_evidence")
    if isinstance(field_evidence, dict):
        reason = field_evidence.get("consensus_reason")
        if isinstance(reason, str):
            reasons.add(reason.strip())
    validation = evidence.get("validation")
    if isinstance(validation, dict):
        for warning in validation.get("warnings") or []:
            if isinstance(warning, str):
                reasons.add(warning.strip())
    return reasons


def source_text_of(evidence: dict[str, Any] | None) -> str:
    """``evidence["source_text"]``, or "" when none was recorded or what is
    stored there is a validation / consensus reason, not document text."""

    if not isinstance(evidence, dict):
        return ""
    text = evidence.get("source_text")
    if not isinstance(text, str) or not text.strip():
        return ""
    if evidence.get("extraction_method") == "unresolved_value_region":
        return ""
    if text.strip() in _recorded_reasons(evidence):
        return ""
    return text


def with_clean_source_text(evidence: dict[str, Any] | None) -> dict[str, Any]:
    """A copy of ``evidence`` whose ``source_text`` is document text or ""."""

    cleaned = dict(evidence or {})
    if "source_text" in cleaned:
        cleaned["source_text"] = source_text_of(evidence)
    return cleaned
