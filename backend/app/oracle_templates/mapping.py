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

Transformations are configuration: each one names how a source value is
turned into the target's (a date format, a lookup table, a condition) and
can be changed or removed at any time. The source value is never changed;
the preview shows both side by side.
"""

from __future__ import annotations

import csv
import difflib
import io
import json
import re
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.staging.models import StagingCell, StagingDataset, StagingWorkbook
from app.staging.selection_export import is_exportable

Shape = Literal["single", "pair", "column"]
Transform = Literal[
    "as_is", "trim", "upper", "lower", "title", "date_iso", "number", "currency",
    "default", "lookup", "conditional", "split", "concat",
]
TRANSFORM_LABELS: dict[str, str] = {
    "as_is": "Direct",
    "trim": "Trim whitespace",
    "upper": "Upper case",
    "lower": "Lower case",
    "title": "Title case",
    "date_iso": "Date conversion",
    "number": "Numeric conversion",
    "currency": "Currency normalization",
    "default": "Default value when empty",
    "lookup": "Lookup mapping",
    "conditional": "Conditional mapping",
    "split": "Split a composite value",
    "concat": "Concatenate",
}

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
    # The transformation's settings (TRANSFORM_OPTIONS), e.g. {"format":
    # "%m/%d/%Y"}, {"map": {"FFP": "FIRM_FIXED"}}, {"part": "City"}.
    options: dict[str, Any] = Field(default_factory=dict)
    # Further sources for "concat", joined after `source`.
    sources: list[SourceRef] = Field(default_factory=list, max_length=10)


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
    # The document section it was read in, and its validation result
    # (passed | failed | not_checked) — extraction quality, kept apart from
    # whether a mapping of it is valid.
    section: str | None = None
    quality: str | None = None


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


def _quality(cell: StagingCell | None) -> dict:
    if cell is None:
        return {}
    section = cell.provenance.source_locator.section if (
        cell.provenance and cell.provenance.source_locator and getattr(cell.provenance.source_locator, "section", None)
    ) else None
    return {"quality": cell.validation.status, **({"section": section} if section else {})}


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
                        **{"section": dataset.display_name, **_quality(cell)},
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
                        **{"section": dataset.display_name, **_quality(cell)},
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
                        **{"section": dataset.display_name, **_quality(cell)},
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


def _decimal(text: str) -> Decimal | None:
    cleaned = re.sub(r"(?i)\b(usd|eur|gbp|cad|aud|jpy|chf)\b|[$€£¥\s,]", "", text)
    negative = cleaned.startswith("(") and cleaned.endswith(")")
    cleaned = cleaned.strip("()")
    if not re.fullmatch(r"[-+]?\d+(\.\d+)?", cleaned):
        return None
    value = Decimal(cleaned)
    return -abs(value) if negative else value


_CURRENCY_CODE = re.compile(r"(?i)\b(USD|EUR|GBP|CAD|AUD|JPY|CHF)\b|([$€£¥])")
_CURRENCY_SYMBOLS = {"$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY"}


def _part(text: str, options: dict[str, Any]) -> tuple[str, str | None]:
    """A part of a composite value: a printed date range's Start/End Date,
    an address block's City/State/…, or the n-th piece split on a
    separator. A part the value doesn't have is a problem, never a guess."""

    from app.source_structure.original_layout import block_parts, composite_parts

    label = str(options.get("part") or "").strip()
    if label:
        parts = composite_parts(text) or block_parts(text)
        found = next((p["value"] for p in parts if p["label"].lower() == label.lower()), None)
        if found is None:
            return text, f"{text[:60]!r} has no {label} part."
        return found, None
    separator = options.get("separator")
    if separator:
        pieces = [piece.strip() for piece in text.split(str(separator))]
        try:
            index = int(options.get("index", 0))
        except (TypeError, ValueError):
            index = 0
        if 0 <= index < len(pieces):
            return pieces[index], None
        return text, f"{text[:60]!r} has no piece {index + 1} when split on {separator!r}."
    return text, "Choose which part to take."


def apply_mapping(value: object, mapping: "ColumnMapping", extra: list[object] | None = None) -> tuple[str, str | None]:
    """The target value of one mapping: its transformation applied to the
    source value with its options. (text, problem or None)."""

    options = mapping.options or {}
    transform = mapping.transform
    text = text_of(value)
    if transform == "concat":
        separator = str(options.get("separator", " "))
        values = [text] + [text_of(v) for v in (extra or [])]
        return separator.join(v for v in values if v.strip()), None
    if transform == "default":
        return (text if text.strip() else str(options.get("value", ""))), None
    if transform in ("lower", "title"):
        return (text.lower() if transform == "lower" else text.title()), None
    if transform == "lookup":
        table = {str(k).strip().lower(): str(v) for k, v in dict(options.get("map") or {}).items()}
        if not text.strip():
            return "", None
        if text.strip().lower() in table:
            return table[text.strip().lower()], None
        if "fallback" in options:
            return str(options["fallback"]), None
        return text, f"{text!r} has no entry in the lookup table."
    if transform == "conditional":
        test = str(options.get("when", "equals"))
        expected = str(options.get("value", ""))
        matched = {
            "equals": text.strip().lower() == expected.strip().lower(),
            "contains": expected.strip().lower() in text.lower() if expected.strip() else False,
            "empty": not text.strip(),
            "not_empty": bool(text.strip()),
        }.get(test, False)
        chosen = options.get("then") if matched else options.get("else", "{value}")
        return str(chosen if chosen is not None else "{value}").replace("{value}", text), None
    if transform == "split":
        return _part(text, options) if text.strip() else ("", None)
    if transform == "currency":
        if not text.strip():
            return "", None
        amount = _decimal(text)
        if amount is None:
            return text, f"{text!r} is not an amount."
        expected = str(options.get("currency") or "").upper()
        code = _CURRENCY_CODE.search(text)
        found = (code.group(1) or _CURRENCY_SYMBOLS.get(code.group(2) or "", "")).upper() if code else ""
        if expected and found and found != expected:
            return text, f"{text!r} is in {found}, not {expected}."
        try:
            places = int(options.get("decimals", 2))
        except (TypeError, ValueError):
            places = 2
        quantum = Decimal(1).scaleb(-places)
        try:
            return str(amount.quantize(quantum, rounding=ROUND_HALF_UP)), None
        except InvalidOperation:
            return text, f"{text!r} can't be written with {places} decimals."
    if transform == "date_iso" and options.get("format"):
        converted, problem = apply_transform(value, "date_iso")
        if problem:
            return converted, problem
        try:
            return datetime.fromisoformat(converted).strftime(str(options["format"])), None
        except ValueError:
            return converted, f"{options['format']!r} is not a date format."
    return apply_transform(value, transform)


def explain(mapping: "ColumnMapping") -> str:
    """How the target value is made, in words (for the preview)."""

    options = mapping.options or {}
    label = TRANSFORM_LABELS.get(mapping.transform, mapping.transform)
    if mapping.source.kind == "constant":
        return f"Static value {mapping.source.constant!r}"
    detail = {
        "date_iso": f" to {options['format']}" if options.get("format") else " to YYYY-MM-DD",
        "currency": f" to {options.get('decimals', 2)} decimals" + (f" ({options['currency']})" if options.get("currency") else ""),
        "default": f": {options.get('value', '')!r} when empty",
        "lookup": f" ({len(dict(options.get('map') or {}))} entries)",
        "conditional": f": when {options.get('when', 'equals')} {options.get('value', '')!r} then {options.get('then', '{value}')!r}",
        "split": f": {options['part']}" if options.get("part") else (f" on {options.get('separator')!r}, piece {int(options.get('index', 0)) + 1}" if options.get("separator") else ""),
        "concat": f" of {1 + len(mapping.sources)} values",
    }.get(mapping.transform, "")
    return label + detail


class BuiltCell(BaseModel):
    value: str
    review_status: str | None = None
    problem: str | None = None
    page: int | None = None
    highlight: str | None = None
    # The source value before its transformation (kept, never replaced).
    source_value: str | None = None


class BuiltRows(BaseModel):
    headers: list[str]
    rows: list[list[BuiltCell]]


def _read(
    workbook: StagingWorkbook, source: SourceRef, record, row_dataset: StagingDataset | None
) -> tuple[StagingCell | None, object]:
    """(cell, value) a source names, for the current row's record."""

    if source.kind == "constant":
        return None, source.constant or ""
    if source.kind != "field":
        return None, None
    dataset = _find(workbook, source.dataset_id)
    cell: StagingCell | None = None
    if dataset is None:
        return None, None
    if source.shape == "column":
        if record is not None and dataset is row_dataset:
            cell = record.cells.get(source.field or "")
    elif source.shape == "pair":
        cell = _pair_cell(dataset, source)
    else:
        first = dataset.records[0] if dataset.records else None
        cell = first.cells.get(source.field or "") if first else None
    return cell, (cell.value if cell else None)


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

    # As the template prints them: a repeated header is written repeated.
    headers = [column.get("header") or column["technical_name"] for column in template_columns]
    rows: list[list[BuiltCell]] = []
    for record in records:
        row: list[BuiltCell] = []
        for column in template_columns:
            mapping = by_column.get(column["technical_name"])
            source = mapping.source if mapping else SourceRef()
            cell, raw = _read(workbook, source, record, row_dataset)
            extra = [_read(workbook, more, record, row_dataset)[1] for more in (mapping.sources if mapping else [])]
            value, problem = apply_mapping(raw, mapping) if mapping and mapping.transform != "concat" else (
                apply_mapping(raw, mapping, extra) if mapping else apply_transform(raw, "as_is")
            )
            evidence = _evidence(cell)
            row.append(
                BuiltCell(
                    value=value,
                    review_status=cell.review_status if cell else None,
                    problem=problem,
                    page=evidence.get("page"),
                    highlight=evidence.get("highlight"),
                    source_value=text_of(raw) if source.kind != "none" else None,
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

_BUILT_IN_SYNONYMS: tuple[frozenset[str], ...] = tuple(
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
_ALIASES_FILE = Path(__file__).with_name("aliases.json")


@lru_cache(maxsize=1)
def synonyms() -> tuple[frozenset[str], ...]:
    """Groups of names meaning the same field: the built-in ones, then
    aliases.json beside this module, then the file named by the
    ORACLE_MAPPING_ALIASES_PATH setting (each group a list of names)."""

    from app.core.config import get_settings

    groups = list(_BUILT_IN_SYNONYMS)
    for path in (_ALIASES_FILE, get_settings().oracle_mapping_aliases_path):
        if not path:
            continue
        try:
            data = json.loads(Path(path).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        for group in data.get("groups", []) if isinstance(data, dict) else data:
            names = frozenset(_norm(str(name)) for name in group if str(name).strip())
            if len(names) >= 2:
                groups.append(names)
    return tuple(groups)


_SYNONYMS = _BUILT_IN_SYNONYMS


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
    return any(a in group and b in group for group in synonyms())


class Suggestion(BaseModel):
    column: str
    source: SourceRef
    method: str
    confidence: float
    reason: str
    # The target attribute is required by the template.
    required: bool = False
    # Always true: a suggestion is a proposal until a person accepts it.
    needs_approval: bool = True


def _type_fit(column: dict, sample: str) -> tuple[float, str] | None:
    """A score adjustment when the target declares a data type: a sample
    of that type fits it, one of another type doesn't."""

    kind = column.get("data_type")
    if not kind or not sample.strip():
        return None
    if kind in ("date", "datetime"):
        fits = apply_transform(sample, "date_iso")[1] is None
    elif kind == "number":
        fits = _decimal(sample) is not None
    else:
        return None
    return (0.03, f"the value fits its {kind} type") if fits else (-0.15, f"the value is not a {kind}")


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
    scored = _name_score(column, field)
    if scored is None:
        return None
    fit = _type_fit(column, field.sample)
    if fit is None:
        return scored
    return round(max(0.05, min(0.97, scored[0] + fit[0])), 2), scored[1], f"{scored[2]}; {fit[1]}"


def _name_score(column: dict, field: SourceField) -> tuple[float, str, str] | None:
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
    description = _norm(column.get("description") or "")
    if description:
        for name in names:
            words = set(name.split()) - _GENERIC_WORDS
            if len(words) >= 1 and f" {name} " in f" {description} " and len(name.split()) >= 2:
                return 0.6, "attribute description", f"the attribute's description mentions {field.label!r}"
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
                           reason="Used for this column in an approved mapping", required=bool(column.get("required")))
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
            suggestions.append(Suggestion(column=name, source=field.ref, method=method, confidence=confidence, reason=reason,
                                          required=bool(column.get("required"))))
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


def _attribute_problems(column: dict, value: str) -> list[tuple[str, str, str]]:
    """(severity, code, message) for a value against its target attribute's
    declared data type, length, precision, scale and lookup values."""

    problems: list[tuple[str, str, str]] = []
    name = column["technical_name"]
    text = value.strip()
    if not text:
        return problems
    kind = column.get("data_type")
    if kind in ("date", "datetime") and not re.fullmatch(r"\d{4}-\d{2}-\d{2}([ T][\d:.]+)?", text):
        problems.append(("error", "data_type", f"{name} is a {kind}; {text!r} isn't written as YYYY-MM-DD (use Date conversion)."))
    if kind == "number":
        amount = _decimal(text) if re.fullmatch(r"[-+]?\d+(\.\d+)?", text) else None
        if amount is None:
            problems.append(("error", "data_type", f"{name} is a number; {text!r} isn't (use Numeric conversion)."))
        else:
            digits, exponent = amount.as_tuple().digits, amount.as_tuple().exponent
            decimals = -exponent if isinstance(exponent, int) and exponent < 0 else 0
            scale, precision = column.get("scale"), column.get("precision")
            if scale is not None and decimals > scale:
                problems.append(("error", "scale", f"{name} allows {scale} decimal place(s); {text!r} has {decimals}."))
            if precision is not None and len(digits) > precision:
                problems.append(("error", "precision", f"{name} allows {precision} digits; {text!r} has {len(digits)}."))
    if kind == "boolean" and text.lower() not in {"y", "n", "yes", "no", "true", "false", "1", "0"}:
        problems.append(("error", "data_type", f"{name} is a yes/no flag; {text!r} isn't."))
    length = column.get("max_length")
    if length is not None and len(value) > length:
        problems.append(("error", "length", f"{name} allows {length} characters; the value has {len(value)}."))
    values = column.get("lookup_values")
    if values and text not in values:
        problems.append(("error", "lookup", f"{text!r} is not a value of {name} ({', '.join(values[:8])}{'…' if len(values) > 8 else ''})."))
    return problems


# Per-attribute states, apart from the extraction's own confidence: a
# mapping can be valid while the value it carries still needs review.
VALID, WARNING, ERROR, NEEDS_REVIEW, NOT_CONFIGURED = "Valid", "Warning", "Error", "Needs Review", "Not Configured"


def column_states(template_columns: list[dict], spec: MappingSpec, issues: list["Issue"]) -> dict[str, str]:
    mapped = {m.column for m in spec.mappings if m.source.kind != "none"}
    states: dict[str, str] = {}
    for column in template_columns:
        name = column["technical_name"]
        own = [i for i in issues if i.column and name in i.column.split(", ")]
        if any(i.severity == "error" for i in own):
            states[name] = ERROR
        elif name not in mapped:
            states[name] = NOT_CONFIGURED
        elif any(i.code == "unreviewed" for i in own):
            states[name] = NEEDS_REVIEW
        elif any(i.severity == "warning" for i in own):
            states[name] = WARNING
        else:
            states[name] = VALID
    return states


class Contracts(BaseModel):
    """The contract numbers a document names. `tables`: those its tables
    carry row by row (a brief listing several contracts); `fields`: those
    its label/value fields give (one contract, or an extraction conflict);
    `rows`: per repeating dataset, the contract of each record ("" when
    none). A column or row counts when it names the Contract Number concept."""

    tables: set[str] = Field(default_factory=set)
    fields: set[str] = Field(default_factory=set)
    rows: dict[str, list[str]] = Field(default_factory=dict)

    def all(self) -> set[str]:
        return self.tables | self.fields


def contract_numbers(workbook: StagingWorkbook) -> Contracts:
    """The contract numbers a document names (see Contracts)."""

    from app.source_structure.original_layout import metadata_concept

    def is_contract(label: str | None, field: str | None = None) -> bool:
        return metadata_concept(label) == "Contract Number" or bool(field and field.endswith("contract_number"))

    contracts = Contracts()
    for dataset in workbook.datasets:
        pair = _pair_columns(dataset) if dataset.cardinality == "repeating" else None
        if pair is not None:
            name_field, value_field, id_field = pair
            for record in dataset.records:
                label = text_of(record.cells.get(name_field).value if record.cells.get(name_field) else None)
                field_id = text_of(record.cells.get(id_field).value if id_field and record.cells.get(id_field) else None)
                if is_contract(re.sub(r"^\s*\d+[A-Za-z]?[.)]\s*", "", label), field_id):
                    value = text_of(record.cells.get(value_field).value if record.cells.get(value_field) else None).strip()
                    if value:
                        contracts.fields.add(value)
            continue
        columns = [c for c in dataset.columns if is_contract(c.display_label, c.canonical_field)]
        if not columns:
            continue
        values = []
        for record in dataset.records:
            value = next((text_of(record.cells[c.canonical_field].value).strip() for c in columns
                          if c.canonical_field in record.cells and text_of(record.cells[c.canonical_field].value).strip()), "")
            values.append(value)
        if dataset.cardinality == "repeating":
            contracts.rows[dataset.dataset_id] = values
            contracts.tables |= {v for v in values if v}
        else:
            contracts.fields |= {v for v in values if v}
    # A solicitation number read into a contract column is the same
    # contract's solicitation, not a second contract.
    solicitations = _solicitation_numbers(workbook)
    contracts.tables -= solicitations
    contracts.fields -= solicitations
    return contracts


def _solicitation_numbers(workbook: StagingWorkbook) -> set[str]:
    found: set[str] = set()
    for dataset in workbook.datasets:
        pair = _pair_columns(dataset) if dataset.cardinality == "repeating" else None
        if pair is not None:
            name_field, value_field, _ = pair
            for record in dataset.records:
                label = text_of(record.cells.get(name_field).value if record.cells.get(name_field) else None)
                if re.search(r"(?i)solicitation", label):
                    value = text_of(record.cells.get(value_field).value if record.cells.get(value_field) else None).strip()
                    if value:
                        found.add(value)
            continue
        for column in dataset.columns:
            if re.search(r"(?i)solicitation", column.display_label) or column.canonical_field.endswith("solicitation_number"):
                found |= {text_of(r.cells[column.canonical_field].value).strip() for r in dataset.records
                          if column.canonical_field in r.cells and text_of(r.cells[column.canonical_field].value).strip()}
    return found


def validate(
    template_columns: list[dict],
    spec: MappingSpec,
    built: BuiltRows,
    parent_rows: BuiltRows | None = None,
    available: set[tuple] | None = None,
    classification_status: str | None = None,
    contracts: "Contracts | None" = None,
    schema: tuple[str, str | None] | None = None,
) -> list[Issue]:
    """``available``: (dataset, field, pair key) of the document's fields —
    a mapped field the document doesn't have (e.g. after it was
    reclassified) is an error, never silently left empty."""

    issues: list[Issue] = []
    if schema is not None:
        status, reason = schema
        if status == "unsupported" or (status == "stale" and reason and "retired" in reason):
            issues.append(Issue(severity="error", code=f"schema_{status}",
                                message=f"The target schema is {status}: {reason} It can't be import-ready."))
        elif status == "stale":
            # A profile stays on the version it was made for; a newer one is offered, never applied.
            issues.append(Issue(severity="warning", code="schema_stale",
                                message=f"{reason} This mapping stays on its own version until it's moved."))
        elif status != "verified":
            issues.append(Issue(severity="warning", code="schema_unverified",
                                message=f"The target's Oracle metadata is not verified: {reason}"))
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

    seen_columns: set[str] = set()
    for mapping in spec.mappings:
        if mapping.column in seen_columns:
            issues.append(Issue(severity="error", code="duplicate_mapping", column=mapping.column,
                                message=f"{mapping.column} is mapped more than once."))
        seen_columns.add(mapping.column)
    by_source: dict[tuple, list[str]] = {}
    for mapping in spec.mappings:
        if mapping.source.kind == "field" and mapping.transform not in ("split", "concat"):
            key = (mapping.source.dataset_id, mapping.source.field, mapping.source.pair_key)
            by_source.setdefault(key, []).append(mapping.column)
    for columns in by_source.values():
        if len(columns) > 1:
            issues.append(Issue(severity="info", code="shared_source", column=", ".join(columns),
                                message=f"One source fills {', '.join(columns)}."))
    for mapping in spec.mappings:
        if mapping.transform == "lookup" and not (mapping.options or {}).get("map"):
            issues.append(Issue(severity="error", code="lookup_unconfigured", column=mapping.column,
                                message=f"{mapping.column} uses a lookup mapping with no entries."))
        if mapping.transform == "split" and not ((mapping.options or {}).get("part") or (mapping.options or {}).get("separator")):
            issues.append(Issue(severity="error", code="split_unconfigured", column=mapping.column,
                                message=f"{mapping.column} splits a composite value but no part is chosen."))
        if mapping.transform == "concat" and not mapping.sources:
            issues.append(Issue(severity="warning", code="concat_single", column=mapping.column,
                                message=f"{mapping.column} concatenates only one value."))

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
            if name in mapped and not cell.problem:
                for severity, code, message in _attribute_problems(template_columns[position], cell.value):
                    issues.append(Issue(severity=severity, code=code, column=name, row=row_number, message=message))

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
    if contracts is not None:
        if spec.row_dataset is None and len(contracts.tables) > 1:
            found = contracts.tables
            issues.append(Issue(severity="error", code="multiple_contracts",
                                message=f"This document's tables name {len(found)} contracts ({', '.join(sorted(found)[:5])}); "
                                        "one record would combine them. Map a table with a row per contract instead."))
        elif len(contracts.fields) > 1:
            issues.append(Issue(severity="warning", code="contract_number_conflict",
                                message=f"The document's fields give different contract numbers ({', '.join(sorted(contracts.fields)[:5])}); "
                                        "check which one is the contract's."))
        rows_contracts = {v for v in contracts.rows.get(spec.row_dataset or "", []) if v}
        if spec.row_dataset and len(rows_contracts) > 1 and parent_rows is not None and len(parent_rows.rows) == 1:
            issues.append(Issue(severity="error", code="rows_cross_contracts",
                                message=f"The rows belong to {len(rows_contracts)} contracts but the parent has one record: "
                                        "rows of different contracts can't share one parent."))
    lookups = [c for c in template_columns if c.get("lookup_values")]
    if not lookups:
        issues.append(Issue(severity="info", code="lookups_not_checked",
                            message="Lookup values are not checked: the template carries no lookup lists."))
    return issues


def import_ready(issues: list[Issue]) -> bool:
    return not any(issue.severity == "error" for issue in issues)


# ---------------------------------------------------------------- clauses


class ClauseRecord(BaseModel):
    """A clause the document cites, as extraction recorded it — the source
    side of a clause mapping. Mapping one to Oracle needs a target object
    whose verified schema has clause attributes; none is assumed here."""

    clause_id: str
    title: str | None = None
    regulation_family: Literal["FAR", "DFARS", "Agency supplement", "Other"]
    contract_number: str | None = None
    page: int | None = None
    evidence: str | None = None
    text: str | None = None
    dataset_id: str
    record_id: str
    # Other tables of the document citing the same clause.
    also_in: list[str] = Field(default_factory=list)


_CLAUSE_NUMBER = re.compile(r"\b((?:52|252|\d{4})\.\d{3}-\d{1,4})\b")


def _family(number: str) -> str:
    if number.startswith("252."):
        return "DFARS"
    if number.startswith("52."):
        return "FAR"
    if re.match(r"^\d{4}\.", number):
        return "Agency supplement"
    return "Other"


def clause_records(workbook: StagingWorkbook) -> list[ClauseRecord]:
    """Each clause the document's clause tables cite (a column of clause
    numbers like 52.204-21 or 252.204-7012), once: its first record with a
    title, the other tables citing it named in also_in."""

    found = contract_numbers(workbook).all()
    contract = next(iter(found)) if len(found) == 1 else None
    by_number: dict[str, ClauseRecord] = {}
    for dataset in _usable(workbook):
        if dataset.cardinality != "repeating":
            continue
        number_column = next(
            (c for c in dataset.columns
             if sum(1 for r in dataset.records[:20]
                    if _CLAUSE_NUMBER.search(text_of(r.cells.get(c.canonical_field).value if r.cells.get(c.canonical_field) else None)))
             >= max(1, min(3, len(dataset.records)))),
            None,
        )
        if number_column is None:
            continue
        title_column = next((c for c in dataset.columns if c is not number_column
                             and re.search(r"(?i)title|name|heading|description", c.display_label)), None)
        text_column = next((c for c in dataset.columns if re.search(r"(?i)\btext\b|full text|content", c.display_label)), None)
        for record in dataset.records:
            cell = record.cells.get(number_column.canonical_field)
            match = _CLAUSE_NUMBER.search(text_of(cell.value if cell else None))
            if not match:
                continue
            known = by_number.get(match.group(1))
            if known is not None and known.title:
                if dataset.dataset_id != known.dataset_id and dataset.dataset_id not in known.also_in:
                    known.also_in.append(dataset.dataset_id)
                continue
            title = record.cells.get(title_column.canonical_field) if title_column else None
            body = record.cells.get(text_column.canonical_field) if text_column else None
            evidence = _evidence(cell)
            found_record = ClauseRecord(
                clause_id=match.group(1),
                title=text_of(title.value).strip() or None if title else None,
                regulation_family=_family(match.group(1)),
                contract_number=contract,
                page=evidence.get("page"),
                evidence=evidence.get("highlight"),
                text=text_of(body.value).strip() or None if body else None,
                dataset_id=dataset.dataset_id,
                record_id=record.record_id,
                also_in=[known.dataset_id, *known.also_in] if known is not None else [],
            )
            by_number[match.group(1)] = found_record
    return list(by_number.values())
