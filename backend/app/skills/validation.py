"""Validation across a document's fields: a skill's cross-field rules,
and the document-wide summary of everything that needs attention —
missing required fields, conflicting or duplicated values, values under the
wrong label, invalid dates / identifiers / amounts, totals that don't add
up and fields that contradict each other.

Each issue names the records it concerns (their layout keys) and the page,
so the workspace can show the source. Validation is kept apart from
extraction confidence and from what a person decided.
"""

from __future__ import annotations

from typing import Any

from app.skills.definitions import Skill
from app.skills.values import dates_in, parse_date, parse_money

_TOLERANCE = 0.01

# Layout flags (app/source_structure/original_layout.py) by issue kind.
_LAYOUT_KIND = {
    "label_value_mismatch": "incorrect_association",
    "evidence_other_field": "incorrect_association",
    "page_mismatch": "incorrect_association",
    "missed_value": "missing_value",
    "conflicting_values": "conflicting_values",
    "cell_column_mismatch": "invalid_cell",
}

KIND_LABELS = {
    "missing_required": "Missing required fields",
    "missing_value": "Values extraction missed",
    "conflicting_values": "Conflicting values",
    "duplicate_candidates": "Duplicate extraction candidates",
    "incorrect_association": "Incorrect field associations",
    "invalid_date": "Invalid dates",
    "invalid_identifier": "Invalid identifiers",
    "invalid_number": "Invalid numeric formats",
    "invalid_cell": "Table cells that don't fit their column",
    "incorrect_total": "Incorrect totals",
    "cross_field": "Cross-field inconsistencies",
}

_SEVERITY = {
    "missing_required": "error",
    "conflicting_values": "error",
    "incorrect_total": "error",
    "cross_field": "error",
    "invalid_date": "error",
    "invalid_identifier": "warning",
    "invalid_number": "error",
    "incorrect_association": "warning",
    "missing_value": "warning",
    "duplicate_candidates": "info",
    "invalid_cell": "warning",
}


def _date_of(field: dict[str, Any] | None, last: bool = False) -> Any:
    if not field or not field.get("value"):
        return None
    parsed = parse_date(field["value"])
    if parsed:
        return parsed
    found = dates_in(field["value"])
    return (found[-1] if last else found[0])[1] if found else None


def _money(field: dict[str, Any] | None) -> float | None:
    return parse_money(field["value"]) if field and field.get("value") else None


def cross_field_issues(skill: Skill, values: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """Checks that need more than one field. A rule whose fields aren't all
    present is skipped — absence is reported as missing, not as a failure."""

    issues = []
    for rule in skill.rules:
        kind = rule["rule"]
        involved: list[str] = []
        failed = False
        if kind == "date_order":
            first, then = values.get(rule["first"]), values.get(rule["then"])
            a, b = _date_of(first), _date_of(then, last=True)
            involved = [rule["first"], rule["then"]]
            failed = a is not None and b is not None and b < a
            category = "cross_field"
        elif kind == "not_greater":
            a, limit = _money(values.get(rule["value"])), _money(values.get(rule["limit"]))
            involved = [rule["value"], rule["limit"]]
            failed = a is not None and limit is not None and a > limit + _TOLERANCE
            category = "cross_field"
        elif kind == "sum_equals":
            parts = [_money(values.get(key)) for key in rule["parts"]]
            total = _money(values.get(rule["total"]))
            involved = [*rule["parts"], rule["total"]]
            failed = total is not None and all(p is not None for p in parts) and abs(sum(parts) - total) > _TOLERANCE
            category = "incorrect_total"
        elif kind == "balance":
            opening, credits, debits, closing = (
                _money(values.get(rule[k])) for k in ("opening", "credits", "debits", "closing")
            )
            involved = [rule[k] for k in ("opening", "credits", "debits", "closing")]
            known = None not in (opening, credits, debits, closing)
            failed = known and abs(opening + credits - abs(debits) - closing) > _TOLERANCE  # type: ignore[operator]
            category = "incorrect_total"
        else:
            continue
        if failed:
            fields = [values[k] for k in involved if values.get(k)]
            issues.append({
                "kind": category,
                "severity": _SEVERITY[category],
                "message": rule["message"],
                "fields": involved,
                "values": {f["key"]: f["value"] for f in fields},
                "record_keys": [f["record_key"] for f in fields if f.get("record_key")],
                "page": next((f["page"] for f in fields if f.get("page")), None),
            })
    return issues


def validation_summary(business: dict[str, Any], layout: dict[str, Any]) -> dict[str, Any]:
    """Every issue in the document, grouped by kind."""

    issues: list[dict[str, Any]] = []
    for section in business["sections"]:
        for field in section["fields"]:
            for issue in field["issues"]:
                code = issue["code"]
                if issue.get("source") == "layout" or code in ("repeating_record", "repeated_in_other_sections"):
                    continue  # layout flags are reported once, below
                issues.append({
                    "kind": code,
                    "severity": _SEVERITY.get(code, "warning"),
                    "message": f"{field['label']}: {issue['message']}",
                    "fields": [field["key"]],
                    "values": {field["key"]: field["value"]} if field["value"] else {},
                    "candidates": [c["value"] for c in field["candidates"] if c["value"]],
                    "record_keys": [c["record_key"] for c in field["candidates"]],
                    "page": field["page"] or next((c["page"] for c in field["candidates"] if c["page"]), None),
                    "section": section["label"],
                })
    issues.extend(business.get("issues") or [])

    for section in layout["sections"]:
        for item in section["items"]:
            if item["kind"] == "field":
                for flag in item.get("flags") or []:
                    kind = _LAYOUT_KIND.get(flag["code"], "incorrect_association")
                    issues.append({
                        "kind": kind,
                        "severity": _SEVERITY[kind],
                        "message": f"{item['label']}: {flag['message']}",
                        "fields": [],
                        "values": {"printed": item.get("document_value"), "extracted": item.get("extracted_value")},
                        "record_keys": [item["record_key"]],
                        "page": item.get("page"),
                        "section": section["title"],
                    })
            else:
                for row in item["rows"]:
                    for flag in row.get("flags") or []:
                        column = flag.get("column")
                        header = item["headers"][column] if column is not None and column < len(item["headers"]) else ""
                        issues.append({
                            "kind": "invalid_cell",
                            "severity": _SEVERITY["invalid_cell"],
                            "message": f"{item.get('title') or 'Table'} · {header}: {flag['message']}",
                            "fields": [],
                            "values": {"cell": row["cells"][column] if column is not None and column < len(row["cells"]) else ""},
                            "record_keys": [row["record_key"]],
                            "page": row.get("page"),
                            "section": section["title"],
                        })
    groups = []
    for kind, label in KIND_LABELS.items():
        found = [i for i in issues if i["kind"] == kind]
        if found:
            groups.append({"kind": kind, "label": label, "severity": _SEVERITY[kind], "issues": found})
    return {
        "groups": groups,
        "counts": {
            "errors": sum(1 for i in issues if i["severity"] == "error"),
            "warnings": sum(1 for i in issues if i["severity"] == "warning"),
            "info": sum(1 for i in issues if i["severity"] == "info"),
        },
    }
