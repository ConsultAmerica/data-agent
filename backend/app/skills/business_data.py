"""Business Data: the document's values organized by its skill's canonical
sections (Contractor Information, Contract Values, Invoice Lines …),
built from the same layout records as Original Structure — so a record has
one key in both views and selecting it in one selects it in the other.

The source hierarchy (the document's own headings) stays in Original
Structure; here every value sits in its business category, with the
printed label it was found under, its page, evidence, extraction
confidence, validation status and review status kept apart. Values no
category claims are listed under "Other Extracted Data", never dropped.
"""

from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any

from app.document_validation.association import label_vocabulary, looks_like_label, shared_identifier_issues
from app.skills.definitions import FieldSpec, Skill, TableSpec
from app.skills.registry import skill_for_family
from app.skills.values import normalized, parse_date, parse_money

# Words printed before a label that don't name the field.
_FILLER = ("enter the ", "enter ", "the ", "name of the ")
# Words that make a label a different field from the one it contains
# ("Abbreviated Legal Entity" is not the Legal Entity, "Prime Contractor"
# not the contractor).
_QUALIFIERS = {"abbreviated", "prime", "sub", "previous", "former", "alternate", "other", "parent", "ultimate"}
# More printed occurrences than this make a field a repeating record (a
# value per line item or per contact), not one value with conflicts.
_REPEATING = 3
_REVIEWED = {"Approved", "Corrected"}


@dataclass
class _Record:
    item: dict[str, Any]
    section: str | None
    label: str

    @property
    def value(self) -> str:
        item = self.item
        return str(item.get("effective_value") or item.get("extracted_value") or item.get("document_value") or "").strip()


def _plain_label(label: str) -> str:
    text = normalized(label.replace("kv_", " ").replace("_", " "))
    # "2 enter the contract number", "9a prime contractor"
    text = text.split(" ", 1)[1] if text[:1].isdigit() and " " in text else text
    for filler in _FILLER:
        if text.startswith(filler):
            text = text[len(filler):]
    return text.strip()


def _match_score(label: str, spec: FieldSpec) -> int:
    plain = _plain_label(label)
    if not plain:
        return 0
    best = 0
    words = plain.split()
    for alias in spec.aliases:
        alias_plain = normalized(alias)
        if plain == alias_plain:
            return 3
        if (
            f" {alias_plain} " in f" {plain} "
            and len(words) <= len(alias_plain.split()) + 3
            and not (_QUALIFIERS & set(words) - set(alias_plain.split()))
        ):
            best = max(best, 2)
    return best


def _best_spec(label: str, skill: Skill) -> FieldSpec | None:
    scored = [(score, -index, spec) for index, (_, spec) in enumerate(skill.fields())
              if (score := _match_score(label, spec)) > 0]
    if not scored:
        return None
    return max(scored, key=lambda item: (item[0], item[1]))[2]


def _table_score(headers: list[str], spec: TableSpec) -> int:
    columns = {normalized(c) for c in spec.columns}
    return sum(1 for h in headers if normalized(h) in columns)


# A month and year dates a clause or a period ("NOV 2021", "June 2024").
_MONTH_YEAR = re.compile(r"^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4}$", re.I)


def _type_check(spec: FieldSpec, value: str) -> str | None:
    if not value:
        return None
    if spec.type == "date" and parse_date(value) is None and not _MONTH_YEAR.match(value.strip()):
        return "invalid_date"
    if spec.type in ("currency", "number") and parse_money(value) is None:
        return "invalid_number"
    if spec.type == "identifier" and spec.pattern:
        if not re.fullmatch(spec.pattern, value.strip().upper()):
            return "invalid_identifier"
    return None


ISSUE_MESSAGES = {
    "missing_required": "Required field not found in the document",
    "conflicting_values": "Different values were found for this field",
    "duplicate_candidates": "The same value was extracted more than once",
    "invalid_date": "The value isn't a valid date",
    "invalid_number": "The value isn't a valid amount",
    "invalid_identifier": "The value doesn't match the identifier's format",
    "repeating_record": "Printed for several records; each value is kept",
    "repeated_in_other_sections": "Also printed elsewhere in the document for another record",
    "value_is_label": "The value read is a label, not a value: the value is likely in another box",
    "shared_identifier": "Has the same value as another identifier: one was likely read from the other's box",
}
# Issues that make which value belongs to the field uncertain.
_AMBIGUOUS = {"conflicting_values", "value_is_label", "shared_identifier", "layout_flags"}


def _plausible(spec: FieldSpec, value: str) -> bool:
    # A name is words: "98S99" printed in a name's box is a code.
    if "name" in spec.key and not re.search(r"[A-Za-z]{2}", value):
        return False
    return True


def _candidate(record: _Record) -> dict[str, Any]:
    item = record.item
    metadata = item.get("metadata") or {}
    return {
        "record_key": item["record_key"],
        "label": item["label"],
        "group": item.get("group"),
        # Its place in the printed hierarchy, as Original Structure shows it.
        "item": item.get("item"),
        "field_name": item.get("field_name"),
        "quality": item.get("quality"),
        "quality_label": item.get("quality_label"),
        "source_section": record.section,
        "value": record.value,
        "document_value": item.get("document_value"),
        "extracted_value": item.get("extracted_value"),
        "page": item.get("page"),
        "evidence": item.get("evidence"),
        "found_by": item.get("found_by"),
        "confidence": metadata.get("confidence"),
        "validation_status": metadata.get("validation_status"),
        "review_status": item.get("review_status"),
        "layout_flags": item.get("flags") or [],
    }


def _association(issues: list[str], chosen: dict[str, Any] | None) -> str:
    """confirmed (a person decided), matched, needs_review (which value
    belongs here is uncertain) or unresolved (no value)."""

    if chosen is None:
        return "unresolved"
    if chosen["review_status"] in _REVIEWED:
        return "confirmed"
    return "needs_review" if _AMBIGUOUS & set(issues) else "matched"


def _field_result(spec: FieldSpec, records: list[_Record], vocabulary: set[str] | frozenset[str] = frozenset()) -> dict[str, Any]:
    candidates = [_candidate(r) for r in records]
    # A label read as a value is kept as a candidate, never chosen.
    label_values = [c for c in candidates if c["value"] and looks_like_label(c["value"], vocabulary)]
    with_value = [c for c in candidates if c["value"] and _plausible(spec, c["value"]) and c not in label_values]
    chosen = next((c for c in with_value if c["review_status"] in _REVIEWED), None) or (with_value[0] if with_value else None)
    issues: list[str] = []
    if spec.required and not with_value:
        issues.append("missing_required")
    if label_values:
        issues.append("value_is_label")
    if len(with_value) > _REPEATING:
        issues.append("repeating_record")
    elif with_value:
        # Values compete only on the page, section and numbered item the
        # chosen one is printed in; the same caption elsewhere is another
        # record (a contract block per modification table, "Agency" under
        # 10. Acquisition Agency and under 12. Cognizant ACO).
        home = [c for c in with_value
                if (c["source_section"], c["group"], c["page"]) == (chosen["source_section"], chosen["group"], chosen["page"])]
        distinct = {normalized(c["value"]) for c in home}
        if len(distinct) > 1:
            issues.append("conflicting_values")
        elif len(home) > 1:
            issues.append("duplicate_candidates")
        if len(home) < len(with_value):
            issues.append("repeated_in_other_sections")
    type_issue = _type_check(spec, chosen["value"]) if chosen else None
    if type_issue:
        issues.append(type_issue)
    if any(c["layout_flags"] for c in candidates):
        issues.append("layout_flags")
    if not candidates:
        validation = "missing" if spec.required else "not_found"
    elif "missing_required" in issues or type_issue or "conflicting_values" in issues:
        validation = "failed"
    elif "value_is_label" in issues and not chosen:
        validation = "failed"
    elif set(issues) - {"repeating_record", "repeated_in_other_sections", "duplicate_candidates"}:
        validation = "warning"
    elif chosen:
        validation = "passed"
    else:
        validation = "not_checked"
    return {
        "key": spec.key,
        "label": spec.label,
        "type": spec.type,
        "required": spec.required,
        "date_role": spec.date_role,
        "value": chosen["value"] if chosen else None,
        "record_key": chosen["record_key"] if chosen else None,
        "page": chosen["page"] if chosen else None,
        "evidence": chosen["evidence"] if chosen else None,
        "source_label": chosen["label"] if chosen else None,
        # Kept apart: how sure extraction was, whether the value passed its
        # checks, and what a person decided.
        "confidence": chosen["confidence"] if chosen else None,
        "validation_status": validation,
        "review_status": chosen["review_status"] if chosen else None,
        "association": _association(issues, chosen),
        "issues": [{"code": code, "message": ISSUE_MESSAGES[code], "source": "field"} for code in issues if code in ISSUE_MESSAGES]
        + [{**flag, "source": "layout"} for c in candidates for flag in c["layout_flags"]],
        "candidates": candidates,
    }


def _layout_records(layout: dict[str, Any]) -> list[_Record]:
    records = []
    for section in layout["sections"]:
        for item in section["items"]:
            if item["kind"] == "field":
                records.append(_Record(item=item, section=section["title"], label=item["label"]))
    for item in layout.get("unplaced") or []:
        records.append(_Record(item=item, section=None, label=item["label"]))
    return records


def _tables(layout: dict[str, Any]) -> list[tuple[dict[str, Any], str | None]]:
    return [(item, section["title"]) for section in layout["sections"] for item in section["items"] if item["kind"] == "table"]


def _table_out(table: dict[str, Any], source_section: str | None, label: str | None = None) -> dict[str, Any]:
    return {
        "record_key": table["record_key"],
        "label": label or table.get("title") or "Table",
        "source_section": source_section,
        "headers": table["headers"],
        "pages": table["pages"],
        "rows": table["rows"],
        "row_count": table["row_count"],
    }


def build_business_data(layout: dict[str, Any], classification: dict[str, Any]) -> dict[str, Any]:
    """`classification`: family, family_label, subtype, document_class and
    its label (app/api/classification.py State)."""

    skill = skill_for_family(classification.get("family"))
    records = _layout_records(layout)
    tables = _tables(layout)
    base = {
        "document_class": classification.get("document_class"),
        "document_class_label": classification.get("document_class_label"),
        "document_type": classification.get("family_label"),
        "subtype": classification.get("subtype"),
        "skill": {"skill_id": skill.skill_id, "version": skill.version, "name": skill.name} if skill else None,
    }
    if skill is None:
        # No skill for this kind of document: its own sections, unrenamed.
        sections = []
        for section in layout["sections"]:
            fields = [_candidate(_Record(item=i, section=section["title"], label=i["label"]))
                      for i in section["items"] if i["kind"] == "field"]
            section_tables = [_table_out(i, section["title"]) for i in section["items"] if i["kind"] == "table"]
            if fields or section_tables:
                sections.append({"key": section["id"], "label": section["title"] or "Fields", "canonical": False,
                                 "fields": [], "values": fields, "tables": section_tables})
        other = [_candidate(r) for r in records if r.section is None]
        return {**base, "sections": sections, "other": {"values": other, "tables": []}, "issues": [], "stats": _stats(sections, other)}

    vocabulary = label_vocabulary(layout)
    by_spec: dict[str, list[_Record]] = {}
    unclaimed: list[_Record] = []
    for record in records:
        # The printed label first; then as the document type writes it out
        # ("P.O. No." → Purchase Order Number) or what it means ("Bill To"
        # → Customer). The printed label stays on the record.
        # (label_info: annotate_labels, run by every caller before this.)
        info = record.item.get("label_info") or {}
        spec = _best_spec(record.label, skill)
        for alternative in (info.get("display"), info.get("meaning")):
            if spec is None and alternative and alternative != record.label:
                spec = _best_spec(alternative, skill)
        if spec is None:
            unclaimed.append(record)
        else:
            by_spec.setdefault(spec.key, []).append(record)

    claimed_tables: dict[str, list[tuple[dict[str, Any], str | None]]] = {}
    other_tables = []
    for table, source in tables:
        best = max(
            ((_table_score(table["headers"], spec), spec) for section in skill.sections for spec in section.tables),
            key=lambda item: item[0], default=(0, None),
        )
        if best[1] is not None and best[0] >= best[1].min_matches:
            claimed_tables.setdefault(best[1].key, []).append((table, source))
        else:
            other_tables.append(_table_out(table, source))

    sections = []
    for section in skill.sections:
        fields = [_field_result(spec, by_spec.get(spec.key, []), vocabulary) for spec in section.fields]
        section_tables = [
            _table_out(table, source, spec.label)
            for spec in section.tables for table, source in claimed_tables.get(spec.key, [])
        ]
        sections.append({"key": section.key, "label": section.label, "canonical": True,
                         "fields": fields, "values": [], "tables": section_tables})
    other = [_candidate(r) for r in unclaimed]
    from app.skills.validation import cross_field_issues

    values = {f["key"]: f for s in sections for f in s["fields"]}
    for key, others in shared_identifier_issues(list(values.values())).items():
        field = values[key]
        field["issues"].append({
            "code": "shared_identifier", "source": "field",
            "message": f"Has the same value as {', '.join(others)}: one was likely read from the other's box",
        })
        if field["association"] == "matched":
            field["association"] = "needs_review"
        if field["validation_status"] == "passed":
            field["validation_status"] = "warning"
    return {
        **base,
        "sections": sections,
        "other": {"values": other, "tables": other_tables},
        "issues": cross_field_issues(skill, values),
        "stats": _stats(sections, other),
    }


def _stats(sections: list[dict[str, Any]], other: list[dict[str, Any]]) -> dict[str, int]:
    fields = [f for s in sections for f in s["fields"]]
    return {
        "fields": len(fields),
        "found": sum(1 for f in fields if f["value"]),
        "missing_required": sum(1 for f in fields if f["validation_status"] == "missing"),
        "values": sum(len(s["values"]) for s in sections) + len(other),
        "tables": sum(len(s["tables"]) for s in sections),
        "other_values": len(other),
    }
