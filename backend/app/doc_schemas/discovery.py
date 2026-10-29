"""Field Discovery: a proposed schema for a document, from what the
document actually contains.

Sources, all from the existing extraction (never invented):

* label/value pairs the document prints (form fields, "Key: value" lines),
  grouped by the section they were found in;
* single-value fields its profile extracted;
* tables, as repeating groups with one column per table column;
* for a classified document, the fields its type's built-in schema
  expects — listed as *suggested for this type*, marked not found when the
  document doesn't contain them.

Every proposed field says where it came from: ``found`` (with value, page
and printed label), ``category`` (expected for the type, not in this
document) or ``not_found``. Labels are generated from the document's own
wording (``humanize``); field ids are stable slugs of them.
"""

from __future__ import annotations

from collections import OrderedDict
from typing import Literal

from pydantic import BaseModel

from app.doc_schemas.definition import Definition, SchemaField, SchemaGroup, all_fields, humanize, slug
from app.oracle_templates.mapping import SourceField, catalogue
from app.staging.models import StagingWorkbook

MAX_FIELDS = 150
MAX_TABLES = 8


class Suggestion(BaseModel):
    field_id: str
    group_id: str
    label: str
    raw_label: str | None
    type: str
    origin: Literal["found", "category", "not_found"]
    value: str | None = None
    page: int | None = None
    evidence: str | None = None


class Discovery(BaseModel):
    definition: Definition
    suggestions: list[Suggestion]
    found: int
    category: int
    tables: int


def _type_of(sample: str) -> str:
    from app.oracle_templates.mapping import apply_transform

    text = (sample or "").strip()
    if not text:
        return "text"
    if "@" in text and "." in text.split("@")[-1] and " " not in text:
        return "email"
    if apply_transform(text, "date_iso")[1] is None and any(ch.isdigit() for ch in text):
        return "date"
    if any(sym in text for sym in ("$", "USD", "EUR", "£", "€")) and apply_transform(text, "number")[1] is None:
        return "currency"
    if apply_transform(text, "number")[1] is None:
        return "number"
    if text.isupper() and any(ch.isdigit() for ch in text) and " " not in text:
        return "identifier"
    return "text"


def _group_key(field: SourceField) -> str:
    return field.group or "Document fields"


def discover(workbook: StagingWorkbook, *, category_definition: Definition | None = None, prefix: str = "doc") -> Discovery:
    fields = catalogue(workbook)
    sections: "OrderedDict[str, list[tuple[SourceField, str]]]" = OrderedDict()
    tables: "OrderedDict[str, list[SourceField]]" = OrderedDict()
    seen_labels: set[str] = set()
    for field in fields:
        if field.ref.shape == "column":
            tables.setdefault(field.ref.dataset_id or "", []).append(field)
            continue
        if not field.sample.strip():
            continue
        label = humanize(field.document_label or field.label)
        key = label.lower()
        if key in seen_labels:
            continue
        seen_labels.add(key)
        sections.setdefault(_group_key(field), []).append((field, label))

    used_ids: set[str] = set()

    def unique(field_id: str) -> str:
        candidate, n = field_id, 2
        while candidate in used_ids:
            candidate = f"{field_id}_{n}"
            n += 1
        used_ids.add(candidate)
        return candidate

    groups: list[SchemaGroup] = []
    suggestions: list[Suggestion] = []
    count = 0
    for name, items in sections.items():
        group_id = slug(name)[:55] or "section"
        group_id = group_id if group_id[0].isalpha() else f"g_{group_id}"
        group_fields: list[SchemaField] = []
        for order, (field, label) in enumerate(items):
            if count >= MAX_FIELDS:
                break
            field_id = unique(slug(label, prefix=prefix))
            kind = _type_of(field.sample)
            group_fields.append(SchemaField(field_id=field_id, label=label, type=kind, source=field.ref, order=order))
            suggestions.append(Suggestion(
                field_id=field_id, group_id=group_id, label=label, raw_label=field.document_label or field.label,
                type=kind, origin="found", value=field.sample[:300], page=field.page,
                evidence=f"Printed as {field.document_label or field.label!r}" + (f" on page {field.page}" if field.page else ""),
            ))
            count += 1
        if group_fields:
            groups.append(SchemaGroup(group_id=group_id, label=name, kind="section", fields=group_fields))

    table_count = 0
    for dataset_id, columns in tables.items():
        if table_count >= MAX_TABLES or not any(c.sample.strip() for c in columns):
            continue
        table_count += 1
        name = columns[0].group.replace(" (table)", "")
        group_id = (slug(name)[:50] or "table") + "_rows"
        group_id = group_id if group_id[0].isalpha() else f"t_{group_id}"
        group_fields = []
        for order, column in enumerate(columns):
            label = humanize(column.document_label or column.label)
            field_id = unique(slug(label, prefix=f"{prefix}.{slug(name)[:20]}"))
            kind = _type_of(column.sample)
            group_fields.append(SchemaField(field_id=field_id, label=label, type=kind, source=column.ref, order=order))
            suggestions.append(Suggestion(
                field_id=field_id, group_id=group_id, label=label, raw_label=column.document_label or column.label,
                type=kind, origin="found" if column.sample.strip() else "not_found",
                value=column.sample[:300] or None, page=column.page, evidence=f"Column of table {name!r}",
            ))
        groups.append(SchemaGroup(group_id=group_id, label=name, kind="repeating", source_dataset=dataset_id,
                                  fields=group_fields))

    category_count = 0
    if category_definition is not None:
        found_labels = {s.label.lower() for s in suggestions}
        expected: list[SchemaField] = []
        for group, field in all_fields(category_definition):
            if group.kind == "repeating" or field.label.lower() in found_labels:
                continue
            field_id = unique(field.field_id)
            expected.append(field.model_copy(update={"field_id": field_id, "order": len(expected)}))
            suggestions.append(Suggestion(
                field_id=field_id, group_id="expected_for_type", label=field.label, raw_label=None, type=field.type,
                origin="category", evidence="Expected for this document type; not found in this document",
            ))
            category_count += 1
            if category_count >= 40:
                break
        if expected:
            groups.append(SchemaGroup(group_id="expected_for_type", label="Expected for this document type",
                                      kind="section", fields=expected))
    return Discovery(definition=Definition(groups=groups), suggestions=suggestions, found=count,
                     category=category_count, tables=table_count)
