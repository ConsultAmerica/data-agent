"""Label-to-value association: values that were read from the wrong box.

The nearest text isn't always a field's value. These checks catch the
associations that are wrong on their face:
- value_is_label: the value is itself a label — a field's own or another
  field's ("Contract Number → Solicitation Number").
- shared_identifier: two different identifiers hold the same value, so one
  was likely read from the other's box (Contract Number and Solicitation
  Number both "FA300224C0008").
- type mismatch: a field whose label names a date or an amount holds a
  value that isn't one.

A failed check never changes or drops a value: the value stays a
candidate, and the field is marked Needs Review.
"""

from __future__ import annotations

from functools import lru_cache
import re
from typing import Any

from app.document_validation import business_fields, layout_fields
from app.skills.definitions import SKILLS
from app.skills.values import dates_in, normalized, parse_date, parse_money
from app.source_structure.original_export import field_value

# Values that answer a field without being of its type ("N/A", "TBD",
# "See Section B"): not a mismatch.
_NOT_APPLICABLE = re.compile(r"^(?:n/?a|none|nil|tbd|tba|not applicable|see\b.*|various|as needed|-+|—)$", re.I)
_DATE_LABEL = re.compile(r"\bdate\b|\bdated\b|\bdob\b|\bexpir", re.I)
_AMOUNT_LABEL = re.compile(r"\b(?:amount|total|price|balance|cost|subtotal|tax)\b", re.I)
# Words that make a label something other than a single amount or date.
_NOT_SCALAR = re.compile(r"\b(?:number|no|code|type|method|terms|basis|by|of pages|name|description|status|format)\b", re.I)
_MONTH = re.compile(r"\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b", re.I)
# Words a printed label is made of, after its number.
_LEADING_NUMBER = re.compile(r"^\d{1,3}[a-z]?\s+")
# A label names what follows it: "Solicitation Number", "Date Issued".
# Other captions ("Firm Fixed Price", "Contractor") can be values too.
_LABEL_HEAD = re.compile(
    r"\b(?:number|no|num|nbr|date|code|name|address|amount|total|id|identifier|period|telephone|phone|email|rating)$"
    r"|^(?:date|name|total)\b"
)


def _label_text(label: str | None) -> str:
    return _LEADING_NUMBER.sub("", normalized(label))


@lru_cache(maxsize=1)
def skill_label_vocabulary() -> frozenset[str]:
    """Every label any document skill knows, normalized."""

    return frozenset(
        plain for skill in SKILLS for _, spec in skill.fields() for alias in spec.aliases
        if _LABEL_HEAD.search(plain := normalized(alias))
    )


def label_vocabulary(layout: dict[str, Any]) -> set[str]:
    """Known labels plus every label this document prints."""

    vocabulary = set(skill_label_vocabulary())
    for item in layout_fields(layout):
        for text in (item.get("label"), item.get("field_name")):
            plain = _label_text(text)
            if len(plain) >= 4 and _LABEL_HEAD.search(plain):
                vocabulary.add(plain)
    return vocabulary


def looks_like_label(value: str | None, vocabulary: set[str]) -> bool:
    """The value is a label, not a value: it has no digit and reads exactly
    as a known label ("Solicitation Number", "Contract No.:")."""

    text = (value or "").strip()
    if not text or any(ch.isdigit() for ch in text) or len(text) > 60:
        return False
    plain = _label_text(text)
    return bool(plain) and plain in vocabulary


def type_mismatch(label: str | None, value: str | None) -> str | None:
    """invalid_date / invalid_number when the label names a date or an
    amount and the value can't be one; None when it can or when the label
    names something else."""

    text = (value or "").strip()
    plain = label or ""
    if not text or _NOT_APPLICABLE.match(text) or _NOT_SCALAR.search(plain):
        return None
    if _DATE_LABEL.search(plain):
        if parse_date(text) or dates_in(text) or _MONTH.search(text) or re.search(r"\b(?:19|20)\d{2}\b", text):
            return None
        return "invalid_date"
    if _AMOUNT_LABEL.search(plain):
        if parse_money(text) is not None or re.search(r"\d", text):
            return None
        return "invalid_number"
    return None


def shared_identifier_issues(fields: list[dict[str, Any]]) -> dict[str, list[str]]:
    """{field key: [other field labels]} for identifier fields holding the
    same value as another identifier field."""

    by_value: dict[str, list[dict[str, Any]]] = {}
    for field in fields:
        if field.get("type") == "identifier" and field.get("value"):
            by_value.setdefault(normalized(field["value"]), []).append(field)
    shared: dict[str, list[str]] = {}
    for group in by_value.values():
        if len({f["key"] for f in group}) < 2:
            continue
        for field in group:
            shared[field["key"]] = [f["label"] for f in group if f["key"] != field["key"]]
    return shared


def layout_association_issues(layout: dict[str, Any], business: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Validation issues (app/skills/validation.py shape) for layout
    fields: a value that is a label, and — for values no skill field
    checks — a value that isn't its label's type. A record a skill field
    already reports on isn't reported twice."""

    claimed = {c["record_key"] for f in business_fields(business) for c in f.get("candidates") or [] if c.get("record_key")}
    vocabulary = label_vocabulary(layout)
    issues = []
    for item in layout_fields(layout):
        if (item.get("form_duplicate") or item.get("choice") or item.get("structure_review")
                or item["record_key"] in claimed):
            continue
        value = field_value(item).strip()
        label = item.get("field_name") or item.get("label") or ""
        common = {"fields": [], "record_keys": [item["record_key"]], "page": item.get("page"),
                  "values": {"label": label, "value": value}}
        if looks_like_label(value, vocabulary) and _label_text(value) != _label_text(label):
            issues.append({
                **common, "kind": "incorrect_association", "severity": "warning", "code": "value_is_label",
                "message": f"{label}: the value read, “{value}”, is a label — the value is likely in another box",
            })
            continue
        mismatch = type_mismatch(label, value)
        if mismatch:
            what = "date" if mismatch == "invalid_date" else "amount"
            issues.append({
                **common, "kind": mismatch, "severity": "warning", "code": mismatch,
                "message": f"{label}: “{value}” isn't a {what} — check that it was read from this field's box",
            })
    return issues
