"""Maps a document's extracted fields onto an uploaded import template's
columns, builds the import rows, validates them and writes the CSV.

Fields are named by reference — never by value — so a mapping saved on one
contract fills the same columns from the next contract of that type:

* ``single``: a field of a one-record dataset (Contract Summary).
* ``pair``: one row of a label/value dataset (Contract Details), found by
  its stable field id when the dataset has one, else by its printed label.
* ``column``: a column of a repeating dataset (Line Items); the import file
  gets one row per record of that dataset.

Suggestions are deterministic and explain themselves (method + score); a
suggestion is only a proposal until a person saves the mapping. Values
always come from the document's staging workbook, as reviewed there.
"""

from __future__ import annotations

import csv
import difflib
import io
import re
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.staging.models import StagingCell, StagingDataset, StagingWorkbook
from app.staging.selection_export import is_exportable

Shape = Literal["single", "pair", "column"]
Transform = Literal["as_is", "trim", "upper", "date_iso", "number"]

_NAME_KEYS = ("label", "name", "field")
_VALUE_KEYS = ("value", "printed")
_ID_KEY = "field_id"
MAX_ROWS = 200_000


class SourceRef(BaseModel):
    kind: Literal["field", "constant", "none"] = "none"
    dataset_id: str | None = Field(default=None, max_length=120)
    field: str | None = Field(default=None, max_length=200)
    shape: Shape | None = None
    # pair rows: matched on the dataset's field-id column, else its label column.
    pair_by: Literal["field_id", "label"] | None = None
    pair_key: str | None = Field(default=None, max_length=300)
    constant: str | None = Field(default=None, max_length=500)


class ColumnMapping(BaseModel):
    column: str = Field(min_length=1, max_length=200)  # template technical name, exact
    source: SourceRef = Field(default_factory=SourceRef)
    transform: Transform = "as_is"
    method: str | None = Field(default=None, max_length=40)
    confidence: float | None = None


class ParentLink(BaseModel):
    profile_id: int
    links: list[tuple[str, str]] = Field(default_factory=list)  # (child column, parent column)


class MappingSpec(BaseModel):
    row_dataset: str | None = Field(default=None, max_length=120)
    mappings: list[ColumnMapping] = Field(default_factory=list, max_length=2000)
    key_columns: list[str] = Field(default_factory=list, max_length=50)
    parent: ParentLink | None = None


class SourceField(BaseModel):
    ref: SourceRef
    group: str
    label: str  # Dataomatix label
    document_label: str | None = None  # as printed in the document, when known
    sample: str = ""
    page: int | None = None
    highlight: str | None = None
    anchor: str | None = None
    review_status: str | None = None


def text_of(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "Yes" if value else "No"
    return str(value)


def _column_key(dataset: StagingDataset, keys: tuple[str, ...]) -> str | None:
    for key in keys:
        column = next((c for c in dataset.columns if c.key == key), None)
        if column is not None:
            return column.canonical_field
    return None


def _pair_columns(dataset: StagingDataset) -> tuple[str, str, str | None] | None:
    """(label field, value field, field-id field) of a label/value dataset."""

    name = _column_key(dataset, _NAME_KEYS)
    value = _column_key(dataset, _VALUE_KEYS)
    if name is None or value is None:
        return None
    return name, value, _column_key(dataset, (_ID_KEY,))


def _usable(workbook: StagingWorkbook) -> list[StagingDataset]:
    return [d for d in workbook.datasets if d.role in ("business", "transform") and d.records]


def _evidence(cell: StagingCell | None) -> dict:
    provenance = cell.provenance if cell else None
    if provenance is None:
        return {}
    return {
        "page": provenance.source_page if provenance.source_page and provenance.source_page > 0 else None,
        "highlight": provenance.highlight_text or (text_of(cell.value) if cell else None),
        "anchor": provenance.anchor_text,
    }


def _short(text: str | None) -> str | None:
    text = (text or "").strip()
    return text if 0 < len(text) <= 80 else None


def catalogue(workbook: StagingWorkbook) -> list[SourceField]:
    """Every field a template column can be filled from, with its labels."""

    fields: list[SourceField] = []
    for dataset in _usable(workbook):
        pair = _pair_columns(dataset) if dataset.cardinality == "repeating" else None
        if dataset.cardinality == "single":
            record = dataset.records[0]
            for column in dataset.columns:
                if not is_exportable(column):
                    continue
                cell = record.cells.get(column.canonical_field)
                fields.append(
                    SourceField(
                        ref=SourceRef(kind="field", dataset_id=dataset.dataset_id, field=column.canonical_field, shape="single"),
                        group=dataset.display_name,
                        label=column.display_label,
                        document_label=_short(cell.provenance.anchor_text if cell and cell.provenance else None),
                        sample=text_of(cell.value if cell else None),
                        review_status=cell.review_status if cell else None,
                        **_evidence(cell),
                    )
                )
        elif pair is not None:
            name_field, value_field, id_field = pair
            source_label_field = _column_key(dataset, ("source_label",))
            seen: set[str] = set()
            for record in dataset.records:
                label = text_of(record.cells.get(name_field).value if record.cells.get(name_field) else None).strip()
                field_id = text_of(record.cells.get(id_field).value if id_field and record.cells.get(id_field) else None).strip()
                key = field_id or label
                if not label or key in seen:
                    continue
                seen.add(key)
                cell = record.cells.get(value_field)
                printed = record.cells.get(source_label_field) if source_label_field else None
                fields.append(
                    SourceField(
                        ref=SourceRef(
                            kind="field",
                            dataset_id=dataset.dataset_id,
                            field=value_field,
                            shape="pair",
                            pair_by="field_id" if field_id else "label",
                            pair_key=key,
                        ),
                        group=dataset.display_name,
                        label=label,
                        document_label=_short(text_of(printed.value) if printed else label),
                        sample=text_of(cell.value if cell else None),
                        review_status=cell.review_status if cell else None,
                        **_evidence(cell),
                    )
                )
        else:
            first = dataset.records[0]
            for column in dataset.columns:
                if not is_exportable(column):
                    continue
                cell = first.cells.get(column.canonical_field)
                raw_header = cell.source_column.raw_header if cell and cell.source_column else None
                fields.append(
                    SourceField(
                        ref=SourceRef(kind="field", dataset_id=dataset.dataset_id, field=column.canonical_field, shape="column"),
                        group=f"{dataset.display_name} (table)",
                        label=column.display_label,
                        document_label=_short(raw_header),
                        sample=text_of(cell.value if cell else None),
                        review_status=cell.review_status if cell else None,
                        **_evidence(cell),
                    )
                )
    return fields


# ---------------------------------------------------------------- values


def _pair_cell(dataset: StagingDataset, ref: SourceRef) -> StagingCell | None:
    pair = _pair_columns(dataset)
    if pair is None:
        return None
    name_field, value_field, id_field = pair
    match_field = id_field if ref.pair_by == "field_id" and id_field else name_field
    for record in dataset.records:
        cell = record.cells.get(match_field)
        if cell is not None and text_of(cell.value).strip() == (ref.pair_key or ""):
            return record.cells.get(ref.field or value_field)
    return None


def _find(workbook: StagingWorkbook, dataset_id: str | None) -> StagingDataset | None:
    return next((d for d in workbook.datasets if d.dataset_id == dataset_id), None)


_DATE_FORMATS = (
    "%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%d %b %Y", "%d %B %Y", "%b %d, %Y", "%B %d, %Y",
    "%d-%b-%Y", "%d-%b-%y", "%Y/%m/%d", "%d.%m.%Y", "%b %d %Y", "%B %d %Y", "%Y%m%d",
)


def apply_transform(value: object, transform: str) -> tuple[str, str | None]:
    """(text written to the file, problem or None). A failed conversion
    keeps the original text and reports it — never a guessed value."""

    text = text_of(value)
    if transform == "trim":
        return " ".join(text.split()), None
    if transform == "upper":
        return text.upper(), None
    if not text.strip():
        return "", None
    if transform == "date_iso":
        candidate = " ".join(text.replace(",", ", ").split()).replace(" ,", ",")
        for fmt in _DATE_FORMATS:
            for attempt in (text.strip(), candidate):
                try:
                    return datetime.strptime(attempt, fmt).date().isoformat(), None
                except ValueError:
                    continue
        return text, f"{text!r} is not a recognizable date."
    if transform == "number":
        cleaned = re.sub(r"(?i)\b(usd|eur|gbp|cad|aud)\b|[$€£\s,]", "", text)
        negative = cleaned.startswith("(") and cleaned.endswith(")")
        cleaned = cleaned.strip("()")
        if re.fullmatch(r"[-+]?\d+(\.\d+)?", cleaned):
            return ("-" if negative and not cleaned.startswith("-") else "") + cleaned, None
        return text, f"{text!r} is not a number."
    return text, None


class BuiltCell(BaseModel):
    value: str
    review_status: str | None = None
    problem: str | None = None
    page: int | None = None
    highlight: str | None = None


class BuiltRows(BaseModel):
    headers: list[str]
    rows: list[list[BuiltCell]]


def build_rows(workbook: StagingWorkbook, template_columns: list[dict], spec: MappingSpec) -> BuiltRows:
    """One row per record of the row dataset (or a single row); columns in
    the template's order under its exact header strings."""

    by_column = {mapping.column: mapping for mapping in spec.mappings}
    row_dataset = _find(workbook, spec.row_dataset) if spec.row_dataset else None
    if spec.row_dataset and row_dataset is None:
        raise ValueError(f"This document has no dataset {spec.row_dataset!r}.")
    if row_dataset is not None and len(row_dataset.records) > MAX_ROWS:
        raise ValueError("Too many rows to export at once.")
    records = row_dataset.records if row_dataset is not None else [None]

    headers = [column["technical_name"] for column in template_columns]
    rows: list[list[BuiltCell]] = []
    for record in records:
        row: list[BuiltCell] = []
        for column in template_columns:
            mapping = by_column.get(column["technical_name"])
            source = mapping.source if mapping else SourceRef()
            cell: StagingCell | None = None
            raw: object = None
            if source.kind == "constant":
                raw = source.constant or ""
            elif source.kind == "field":
                dataset = _find(workbook, source.dataset_id)
                if dataset is None:
                    raw = None
                elif source.shape == "column":
                    if record is not None and dataset is row_dataset:
                        cell = record.cells.get(source.field or "")
                    raw = cell.value if cell else None
                elif source.shape == "pair":
                    cell = _pair_cell(dataset, source)
                    raw = cell.value if cell else None
                else:
                    first = dataset.records[0] if dataset.records else None
                    cell = first.cells.get(source.field or "") if first else None
                    raw = cell.value if cell else None
            value, problem = apply_transform(raw, mapping.transform if mapping else "as_is")
            evidence = _evidence(cell)
            row.append(
                BuiltCell(
                    value=value,
                    review_status=cell.review_status if cell else None,
                    problem=problem,
                    page=evidence.get("page"),
                    highlight=evidence.get("highlight"),
                )
            )
        rows.append(row)
    return BuiltRows(headers=headers, rows=rows)


def write_csv(headers: list[str], rows: list[list[str]]) -> bytes:
    """UTF-8 without a byte-order mark (a BOM would become part of the first
    header name). Values are written as text, so leading zeros stay."""

    buffer = io.StringIO()
    writer = csv.writer(buffer, quoting=csv.QUOTE_MINIMAL, lineterminator="\r\n")
    writer.writerow(headers)
    writer.writerows(rows)
    return buffer.getvalue().encode("utf-8")


# ---------------------------------------------------------------- suggestions

_SYNONYMS: tuple[frozenset[str], ...] = tuple(
    frozenset(group)
    for group in (
        {"contract number", "contract no", "number", "piid", "award number", "contract id"},
        {"contract name", "contract title", "title", "name"},
        {"contract description", "description", "scope", "item description", "supplies services"},
        {"currency", "currency code"},
        {"start date", "effective start date", "effective date", "period from", "pop start"},
        {"end date", "expiration date", "period to", "pop end", "completion date"},
        {"amount", "line amount", "extended amount", "total amount", "max amount", "contract amount", "estimated amount"},
        {"contractor", "supplier", "vendor", "party name", "primary party", "offeror", "contractor name"},
        {"quantity", "qty", "max quantity"},
        {"unit of measure", "uom", "unit"},
        {"unit price", "price"},
        {"line number", "clin", "item number", "item no", "line"},
        {"naics", "naics code"},
        {"cage", "cage code"},
        {"uei", "unique entity identifier", "unique entity id"},
        {"solicitation number", "source document number", "solicitation"},
        {"signed date", "date signed", "award date"},
        {"address", "address line1", "address line 1", "street"},
        {"postal code", "zip", "zip code"},
        {"contract type", "type", "contract type code"},
    )
)


def _norm(text: str) -> str:
    """"2. CONTRACT NUMBER" / "ContractNumber" → "contract number"."""

    text = re.sub(r"^\s*\(?[0-9]{1,3}[A-Za-z]?[.)]\s*", "", text or "")
    return " ".join(_ordered_tokens(text))


def _ordered_tokens(text: str) -> list[str]:
    spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])", " ", text)
    return [word for word in re.split(r"[^A-Za-z0-9]+", spaced.lower()) if word]


_GENERIC_WORDS = frozenset({
    "contract", "number", "no", "name", "code", "id", "date", "type", "amount", "value", "line", "header",
    "ext", "the", "of", "and", "total", "information", "info", "details",
})


def _synonym(a: str, b: str) -> bool:
    return any(a in group and b in group for group in _SYNONYMS)


class Suggestion(BaseModel):
    column: str
    source: SourceRef
    method: str
    confidence: float
    reason: str


def _field_names(field: SourceField) -> list[str]:
    names = [field.label]
    if field.document_label:
        names.append(field.document_label)
    if field.ref.pair_by == "field_id" and field.ref.pair_key:
        names.append(field.ref.pair_key.rsplit(".", 1)[-1])
    elif field.ref.field and field.ref.shape != "pair":
        names.append(field.ref.field.rsplit(".", 1)[-1])
    return [_norm(name) for name in names if name]


def _score(column: dict, field: SourceField) -> tuple[float, str, str] | None:
    technical = _norm(column["technical_name"])
    label = _norm(column.get("display_label") or "")
    names = _field_names(field)
    if technical and technical in names:
        return 0.9, "exact name", f"{column['technical_name']} matches {field.label}"
    if label and label in names:
        return 0.85, "label", f"Oracle label {column.get('display_label')!r} matches {field.label}"
    for target in filter(None, (technical, label)):
        if any(_synonym(target, name) for name in names):
            return 0.75, "synonym", f"{target!r} is a known synonym of {field.label!r}"
    best = 0.0
    for target in filter(None, (technical, label)):
        for name in names:
            overlap = set(target.split()) & set(name.split())
            # Sharing only a generic word ("contract", "number") is no match:
            # "Contract Name" is not "Contract Number".
            if not overlap - _GENERIC_WORDS:
                continue
            ratio = difflib.SequenceMatcher(None, target, name).ratio()
            jaccard = len(overlap) / max(1, len(set(target.split()) | set(name.split())))
            best = max(best, ratio * 0.6 + jaccard * 0.4)
    if best >= 0.62:
        return round(0.35 + 0.35 * best, 2), "similar wording", f"similar wording to {field.label!r} ({best:.0%})"
    return None


_LINE_OBJECT = re.compile(r"(?i)\b(lines?|items?|details?|schedules?|rows?|transactions?|clins?)\b")


def suggest(
    template_columns: list[dict],
    fields: list[SourceField],
    learned: dict[str, SourceRef] | None = None,
    row_dataset: str | None = None,
    object_name: str = "",
) -> tuple[list[Suggestion], str | None]:
    """(one suggestion per column that has a plausible source, suggested
    row dataset). Only fields usable together are proposed: document-level
    fields, plus columns of one repeating dataset. A header object (one row
    per document) gets a row table only when its name says it holds lines,
    or when table columns match at least twice as often as header fields."""

    learned = learned or {}
    available = {(f.ref.dataset_id, f.ref.field, f.ref.pair_key) for f in fields}

    if row_dataset is None:
        votes: dict[str, int] = {}
        header_votes = 0
        for column in template_columns:
            scored = [(s, f) for f in fields if (s := _score(column, f)) and s[0] >= 0.75]
            if not scored:
                continue
            # A document-level field matching as well as a table column
            # counts for a one-row object.
            best = max(scored, key=lambda item: (item[0][0], item[1].ref.shape != "column"))[1]
            if best.ref.shape == "column":
                votes[best.ref.dataset_id or ""] = votes.get(best.ref.dataset_id or "", 0) + 1
            else:
                header_votes += 1
        if votes:
            dataset, count = max(votes.items(), key=lambda item: item[1])
            lines = bool(_LINE_OBJECT.search(object_name))
            if count >= 2 and (count > header_votes if lines else count >= 2 * max(1, header_votes)):
                row_dataset = dataset

    suggestions: list[Suggestion] = []
    strong: set[tuple] = set()
    for column in template_columns:
        for field in fields:
            scored = _score(column, field)
            if scored and scored[1] != "similar wording":
                strong.add((field.ref.dataset_id, field.ref.field, field.ref.pair_key))
    for column in template_columns:
        name = column["technical_name"]
        prior = learned.get(name.strip().lower())
        if prior is not None and (prior.kind == "constant" or (prior.dataset_id, prior.field, prior.pair_key) in available):
            suggestions.append(
                Suggestion(column=name, source=prior, method="previously approved", confidence=0.95,
                           reason="Used for this column in a saved mapping")
            )
            continue
        best: tuple[float, str, str, SourceField, tuple] | None = None
        for field in fields:
            if field.ref.shape == "column" and field.ref.dataset_id != row_dataset:
                continue
            scored = _score(column, field)
            if scored is None:
                continue
            # A wording-only match to a field this document left empty is noise.
            if scored[1] == "similar wording" and (
                not field.sample.strip() or (field.ref.dataset_id, field.ref.field, field.ref.pair_key) in strong
            ):
                continue
            # On a tie, a column of the row table wins (a line's Amount, not
            # the contract's), then a field that has a value.
            rank = (scored[0], field.ref.shape == "column", bool(field.sample))
            if best is None or rank > best[4]:
                best = (*scored, field, rank)
        if best is not None:
            confidence, method, reason, field, _rank = best
            suggestions.append(Suggestion(column=name, source=field.ref, method=method, confidence=confidence, reason=reason))
    return suggestions, row_dataset


def suggest_links(child_columns: list[str], parent_columns: list[str]) -> list[tuple[str, str]]:
    """Child → parent key columns by name: "HeaderExtKey" → "ExtKey",
    "ParentContractNumber" → "ContractNumber", or the same name."""

    parents = {p.strip().lower(): p for p in parent_columns}
    links = []
    for child in child_columns:
        bare = re.sub(r"(?i)^(header|parent)[_ ]?", "", child.strip())
        if bare.lower() != child.strip().lower() and bare.lower() in parents:
            links.append((child, parents[bare.lower()]))
    return links


# ---------------------------------------------------------------- validation


class Issue(BaseModel):
    severity: Literal["error", "warning", "info"]
    code: str
    message: str
    column: str | None = None
    row: int | None = None  # 1-based data row


def validate(
    template_columns: list[dict],
    spec: MappingSpec,
    built: BuiltRows,
    parent_rows: BuiltRows | None = None,
    available: set[tuple] | None = None,
    classification_status: str | None = None,
) -> list[Issue]:
    """``available``: (dataset, field, pair key) of the document's fields —
    a mapped field the document doesn't have (e.g. after it was
    reclassified) is an error, never silently left empty."""

    issues: list[Issue] = []
    if available is not None:
        for mapping in spec.mappings:
            source = mapping.source
            if source.kind == "field" and (source.dataset_id, source.field, source.pair_key) not in available:
                issues.append(Issue(severity="error", code="source_missing", column=mapping.column,
                                    message=f"{mapping.column} is mapped to a field this document doesn't have "
                                            "(was the document reclassified?). Review the mapping."))
    if classification_status == "review_required":
        issues.append(Issue(severity="warning", code="classification_unconfirmed",
                            message="The document's type still needs to be confirmed in classification review."))
    names = [column["technical_name"] for column in template_columns]
    index = {name: position for position, name in enumerate(names)}

    unknown = [m.column for m in spec.mappings if m.column not in index]
    for column in unknown:
        issues.append(Issue(severity="error", code="template_mismatch", column=column,
                            message=f"{column} is not a column of this template version."))
    for column in spec.key_columns:
        if column not in index:
            issues.append(Issue(severity="error", code="template_mismatch", column=column,
                                message=f"Key column {column} is not in this template."))

    mapped = {m.column for m in spec.mappings if m.source.kind != "none"}
    for column in template_columns:
        name = column["technical_name"]
        if name in mapped:
            continue
        if column.get("required"):
            issues.append(Issue(severity="error", code="required_unmapped", column=name,
                                message=f"{name} is required by the template but not mapped."))
        else:
            issues.append(Issue(severity="info", code="unmapped", column=name, message=f"{name} is not mapped; it will be empty."))

    if not built.rows:
        issues.append(Issue(severity="error", code="no_rows", message="The row table has no records."))

    for row_number, row in enumerate(built.rows, start=1):
        for position, cell in enumerate(row):
            name = names[position]
            if cell.problem:
                issues.append(Issue(severity="error", code="data_type", column=name, row=row_number, message=cell.problem))
            if template_columns[position].get("required") and name in mapped and not cell.value.strip():
                issues.append(Issue(severity="error", code="required_empty", column=name, row=row_number,
                                    message=f"{name} is required but empty."))
            if cell.review_status == "Needs Review" and cell.value.strip():
                issues.append(Issue(severity="warning", code="unreviewed", column=name, row=row_number,
                                    message=f"{name} comes from a value that still needs review."))

    keys = [index[c] for c in spec.key_columns if c in index]
    if keys:
        seen: dict[tuple[str, ...], int] = {}
        for row_number, row in enumerate(built.rows, start=1):
            key = tuple(row[i].value.strip() for i in keys)
            if not all(key):
                issues.append(Issue(severity="error", code="missing_identifier", row=row_number,
                                    column=", ".join(spec.key_columns),
                                    message="A key column is empty, so this row can't be identified."))
                continue
            if key in seen:
                issues.append(Issue(severity="error", code="duplicate_key", row=row_number,
                                    column=", ".join(spec.key_columns),
                                    message=f"Same key as row {seen[key]}: {' / '.join(key)}."))
            else:
                seen[key] = row_number
    else:
        seen_rows: dict[tuple[str, ...], int] = {}
        for row_number, row in enumerate(built.rows, start=1):
            values = tuple(cell.value for cell in row)
            if any(v.strip() for v in values) and values in seen_rows:
                issues.append(Issue(severity="warning", code="duplicate_row", row=row_number,
                                    message=f"Identical to row {seen_rows[values]}."))
            else:
                seen_rows.setdefault(values, row_number)

    if spec.parent is not None:
        if parent_rows is None:
            issues.append(Issue(severity="error", code="parent_missing", message="The parent mapping could not be built."))
        else:
            parent_index = {name: i for i, name in enumerate(parent_rows.headers)}
            for child, parent in spec.parent.links:
                if child not in index or parent not in parent_index:
                    issues.append(Issue(severity="error", code="template_mismatch", column=child,
                                        message=f"Link {child} → {parent} names a column that doesn't exist."))
                    continue
                parent_values = {row[parent_index[parent]].value.strip() for row in parent_rows.rows}
                for row_number, row in enumerate(built.rows, start=1):
                    value = row[index[child]].value.strip()
                    if not value or value not in parent_values:
                        issues.append(Issue(severity="error", code="orphan_row", column=child, row=row_number,
                                            message=f"{child} {value!r} has no matching {parent} in the parent file."))
    issues.append(Issue(severity="info", code="lookups_not_checked",
                        message="Lookup values are not checked: the template carries no lookup lists."))
    return issues


def import_ready(issues: list[Issue]) -> bool:
    return not any(issue.severity == "error" for issue in issues)
