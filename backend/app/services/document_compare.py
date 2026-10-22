"""Side-by-side comparison of two documents (e.g. a modification against its
base award).

Read-only over what extraction already stored. Contracts compare their
normalized tables (summary, CLINs, funding, clauses, periods, amendments);
any other document compares the business fields of its persisted staging
workbook. Values are normalized (whitespace, case, money, dates) before a
row is called "changed", so formatting noise never shows up as a change.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable
from datetime import date, datetime

from dateutil import parser as date_parser
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.document import Document
from app.models.document_amendment_history import DocumentAmendmentHistory
from app.models.document_clause_reference import DocumentClauseReference
from app.models.document_contract_summary import DocumentContractSummary
from app.models.document_funding_line import DocumentFundingLine
from app.models.document_line_item import DocumentLineItem
from app.models.document_performance_period import DocumentPerformancePeriod
from app.models.document_staging_workbook import DocumentStagingWorkbook

CHANGES = ("changed", "added", "removed", "unchanged")

# (attribute, label, kind) — kind drives normalization and the delta text.
SUMMARY_FIELDS = [
    ("contract_number", "Contract number", "text"),
    ("solicitation_rfp", "Solicitation / RFP", "text"),
    ("contract_vehicle", "Contract vehicle", "text"),
    ("agency_office", "Agency / office", "text"),
    ("contractor", "Contractor", "text"),
    ("award_date", "Award date", "date"),
    ("ceiling_max_aggregate", "Ceiling / max aggregate", "money"),
    ("minimum_guarantee", "Minimum guarantee", "money"),
    ("base_period", "Base period", "text"),
    ("options", "Options", "text"),
    ("max_duration", "Max duration", "text"),
    ("task_order_range", "Task order range", "text"),
    ("naics", "NAICS", "text"),
    ("size_standard", "Size standard", "text"),
]
LINE_ITEM_FIELDS = [
    ("description", "Description", "text"),
    ("quantity", "Quantity", "quantity"),
    ("unit", "Unit", "text"),
    ("unit_price", "Unit price", "money"),
    ("amount", "Amount", "money"),
    ("pricing_type", "Pricing type", "text"),
]
FUNDING_FIELDS = [
    ("amount", "Amount", "money"),
    ("line_of_accounting", "Line of accounting", "text"),
]
CLAUSE_FIELDS = [
    ("title", "Title", "text"),
    ("effective_date", "Effective date", "date"),
    ("alternate", "Alternate", "text"),
    ("incorporation_type", "Incorporation type", "text"),
]
PERIOD_FIELDS = [
    ("start_date", "Start", "date"),
    ("end_date", "End", "date"),
]
AMENDMENT_FIELDS = [
    ("effective_date", "Effective date", "date"),
    ("description", "Description", "text"),
]

_MONEY = re.compile(r"-?\d[\d,]*(?:\.\d+)?")


# --- normalization ---------------------------------------------------------


def _text(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    text = re.sub(r"\s+", " ", str(value)).strip()
    return text or None


def _number(value) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    match = _MONEY.search(str(value))
    if not match:
        return None
    try:
        return float(match.group(0).replace(",", ""))
    except ValueError:
        return None


def _date(value) -> date | None:
    text = _text(value)
    if not text:
        return None
    try:
        parsed = date_parser.parse(text, fuzzy=False, default=datetime(1900, 1, 1))
    except (ValueError, OverflowError, TypeError):
        return None
    return parsed.date() if parsed.year > 1900 else None


def _comparable(value, kind: str):
    """The value two sides are compared on — formatting removed."""

    if kind in ("money", "quantity"):
        number = _number(value)
        if number is not None:
            return round(number, 2)
    if kind == "date":
        parsed = _date(value)
        if parsed is not None:
            return parsed
    text = _text(value)
    return text.casefold() if text else None


def _display(value, kind: str) -> str | None:
    if value is None:
        return None
    if kind == "money" and isinstance(value, (int, float)):
        return f"${value:,.2f}"
    return _text(value)


def _delta(left, right, kind: str) -> str | None:
    if kind == "money":
        a, b = _number(left), _number(right)
        if a is not None and b is not None and a != b:
            diff = b - a
            return f"{'+' if diff > 0 else '-'}${abs(diff):,.2f}"
    if kind == "quantity":
        a, b = _number(left), _number(right)
        if a is not None and b is not None and a != b:
            diff = b - a
            shown = int(diff) if float(diff).is_integer() else round(diff, 4)
            return f"{'+' if diff > 0 else ''}{shown} units"
    if kind == "date":
        a, b = _date(left), _date(right)
        if a is not None and b is not None and a != b:
            days = (b - a).days
            return f"{'+' if days > 0 else ''}{days} days"
    return None


def normalize_clause_number(value: str | None) -> str:
    text = re.sub(r"\s+", "", value or "").upper()
    return re.sub(r"^(FAR|DFARS)", "", text)


def _row(key: str, label: str, left, right, kind: str = "text", group: str | None = None) -> dict:
    a, b = _comparable(left, kind), _comparable(right, kind)
    if a is None and b is None:
        change = "unchanged"
    elif a is None:
        change = "added"
    elif b is None:
        change = "removed"
    else:
        change = "unchanged" if a == b else "changed"
    return {
        "key": key,
        "label": label,
        "group": group,
        "left": _display(left, kind),
        "right": _display(right, kind),
        "change": change,
        "detail": _delta(left, right, kind) if change == "changed" else None,
    }


# --- keyed entity sections -------------------------------------------------


def _keyed(rows: Iterable, key_of: Callable[[object], str]) -> dict[str, object]:
    """Rows by key; a repeated key gets an occurrence suffix so nothing is
    silently dropped (two CLIN 0001 rows for two periods stay two rows)."""

    keyed: dict[str, object] = {}
    seen: dict[str, int] = {}
    for row in rows:
        base = key_of(row)
        if not base:
            continue
        seen[base] = seen.get(base, 0) + 1
        keyed[base if seen[base] == 1 else f"{base} ({seen[base]})"] = row
    return keyed


def _first_by_key(rows: Iterable, key_of: Callable[[object], str]) -> dict[str, object]:
    keyed: dict[str, object] = {}
    for row in rows:
        key = key_of(row)
        if key and key not in keyed:
            keyed[key] = row
    return keyed


def _summary_line(row, fields: list[tuple[str, str, str]]) -> str | None:
    parts = [_display(getattr(row, attr, None), kind) for attr, _, kind in fields]
    return " · ".join(part for part in parts if part) or None


def _entity_rows(
    left: dict[str, object],
    right: dict[str, object],
    fields: list[tuple[str, str, str]],
    label_of: Callable[[str], str],
) -> list[dict]:
    """One row per attribute for an entity on both sides; one summary row
    for an entity on only one side."""

    rows: list[dict] = []
    for key in list(left) + [key for key in right if key not in left]:
        a, b = left.get(key), right.get(key)
        name = label_of(key)
        if a is None or b is None:
            row = _row(key, name, _summary_line(a, fields) if a else None, _summary_line(b, fields) if b else None, group=name)
            # A one-sided entity is added/removed even if it has no values.
            row["change"] = "added" if a is None else "removed"
            rows.append(row)
            continue
        attribute_rows = [
            _row(f"{key}.{attr}", f"{name} · {label}", getattr(a, attr, None), getattr(b, attr, None), kind, group=name)
            for attr, label, kind in fields
        ]
        if all(row["change"] == "unchanged" for row in attribute_rows):
            unchanged = _row(key, name, _summary_line(a, fields), _summary_line(b, fields), group=name)
            unchanged["change"] = "unchanged"
            rows.append(unchanged)
        else:
            rows.extend(row for row in attribute_rows if row["left"] is not None or row["right"] is not None)
    return rows


def _rows_of(database: Session, model, document_id: str) -> list:
    statement = select(model).where(model.document_id == document_id)
    if hasattr(model, "row_index"):
        statement = statement.order_by(model.row_index)
    return list(database.scalars(statement))


def _contract_sections(database: Session, left_id: str, right_id: str) -> list[dict]:
    sections: list[dict] = []

    summaries = [
        database.scalar(select(DocumentContractSummary).where(DocumentContractSummary.document_id == doc_id))
        for doc_id in (left_id, right_id)
    ]
    if any(summaries):
        a, b = summaries
        rows = [
            _row(attr, label, getattr(a, attr, None) if a else None, getattr(b, attr, None) if b else None, kind)
            for attr, label, kind in SUMMARY_FIELDS
        ]
        rows = [row for row in rows if row["left"] is not None or row["right"] is not None]
        if rows:
            sections.append({"section_id": "contract_summary", "label": "Contract summary", "rows": rows})

    def line_key(row) -> str:
        clin = _text(row.clin) or ""
        slin = _text(row.slin)
        return f"{clin}/{slin}" if clin and slin else (clin or slin or "")

    def funding_key(row) -> str:
        return " / ".join(part for part in (_text(row.acrn), _text(row.clin)) if part)

    def clause_key(row) -> str:
        return normalize_clause_number(row.clause_number)

    def period_key(row) -> str:
        return " / ".join(part for part in (_text(row.period_label), _text(row.clin)) if part)

    def amendment_key(row) -> str:
        return _text(row.amendment_number) or ""

    specs = [
        ("line_items", "Line items / CLINs", DocumentLineItem, line_key, LINE_ITEM_FIELDS, lambda k: f"CLIN {k}"),
        ("funding", "Funding", DocumentFundingLine, funding_key, FUNDING_FIELDS, lambda k: k),
        ("clauses", "Clauses", DocumentClauseReference, clause_key, CLAUSE_FIELDS, lambda k: k),
        ("performance_periods", "Performance periods", DocumentPerformancePeriod, period_key, PERIOD_FIELDS, lambda k: k),
        ("amendments", "Amendments", DocumentAmendmentHistory, amendment_key, AMENDMENT_FIELDS, lambda k: f"Amendment {k}"),
    ]
    for section_id, label, model, key_of, fields, label_of in specs:
        rows_left = _rows_of(database, model, left_id)
        rows_right = _rows_of(database, model, right_id)
        if section_id == "clauses":
            # A clause cited in several places is still one clause.
            left_map, right_map = _first_by_key(rows_left, key_of), _first_by_key(rows_right, key_of)
        else:
            left_map, right_map = _keyed(rows_left, key_of), _keyed(rows_right, key_of)
        if not left_map and not right_map:
            continue
        sections.append(
            {"section_id": section_id, "label": label, "rows": _entity_rows(left_map, right_map, fields, label_of)}
        )
    return sections


# --- generic fallback: staging workbook fields ------------------------------


def _cell_value(cell) -> str | None:
    if cell is None:
        return None
    return _text(cell.value)


def _workbook_fields(database: Session, document_id: str) -> dict[str, list[tuple[str, str, str | None]]]:
    """{section label: [(key, label, value)]} from the business datasets of
    the persisted staging workbook. Never raises: no workbook → {}."""

    from app.staging.service import get_staging_workbook

    try:
        workbook = get_staging_workbook(database, document_id)
    except Exception:  # noqa: BLE001 — a document without a workbook compares as empty
        return {}

    sections: dict[str, list[tuple[str, str, str | None]]] = {}
    datasets = [d for d in workbook.datasets if d.role == "business"]
    ids = {d.dataset_id for d in datasets}
    for dataset in datasets:
        # all_fields repeats key_fields; keep the fuller one only.
        if dataset.dataset_id == "key_fields" and "all_fields" in ids:
            all_fields = next(d for d in datasets if d.dataset_id == "all_fields")
            if all_fields.records:
                continue
        entries: list[tuple[str, str, str | None]] = []
        if dataset.cardinality == "single":
            for record in dataset.records[:1]:
                for field, cell in record.cells.items():
                    entries.append((field, cell.display_label, _cell_value(cell)))
        else:
            seen: dict[str, int] = {}
            for index, record in enumerate(dataset.records):
                cells = record.cells
                name_cell = cells.get("name")
                value_cell = cells.get("value")
                if name_cell is not None and value_cell is not None and _cell_value(name_cell):
                    category = _cell_value(cells.get("category"))
                    label = _cell_value(name_cell) or ""
                    key = f"{category}: {label}" if category else label
                    value = _cell_value(value_cell)
                else:
                    identity = [_cell_value(cells.get(f)) for f in dataset.identity_fields]
                    identity = [part for part in identity if part]
                    key = " / ".join(identity) if identity else f"Row {index + 1}"
                    label = key
                    value = " · ".join(v for v in (_cell_value(c) for c in cells.values()) if v) or None
                norm = key.casefold()
                seen[norm] = seen.get(norm, 0) + 1
                if seen[norm] > 1:
                    norm, label = f"{norm} ({seen[norm]})", f"{label} ({seen[norm]})"
                entries.append((norm, label, value))
        if entries:
            sections[dataset.display_name] = entries
    return sections


def _generic_sections(database: Session, left_id: str, right_id: str) -> list[dict]:
    left, right = _workbook_fields(database, left_id), _workbook_fields(database, right_id)
    sections: list[dict] = []
    for name in list(left) + [n for n in right if n not in left]:
        a = {key: (label, value) for key, label, value in left.get(name, [])}
        b = {key: (label, value) for key, label, value in right.get(name, [])}
        rows = []
        for key in list(a) + [k for k in b if k not in a]:
            label = (a.get(key) or b.get(key))[0]
            kind = "money" if re.search(r"amount|total|price|cost|value \(\$\)", label, re.I) else "text"
            rows.append(_row(key, label, a.get(key, (None, None))[1], b.get(key, (None, None))[1], kind))
        rows = [row for row in rows if row["left"] is not None or row["right"] is not None]
        if rows:
            slug = re.sub(r"[^a-z0-9]+", "_", name.casefold()).strip("_")
            sections.append({"section_id": f"workbook_{slug}", "label": name, "rows": rows})
    return sections


# --- entry point -------------------------------------------------------------


def _describe(database: Session, document: Document) -> dict:
    staging = database.scalar(
        select(DocumentStagingWorkbook).where(DocumentStagingWorkbook.document_id == document.id)
    )
    return {
        "document_id": document.id,
        "name": document.original_filename,
        "document_type": document.document_type,
        "profile": (staging.document_family_label or staging.profile_id) if staging else None,
    }


def compare_documents(database: Session, left_id: str, right_id: str) -> dict:
    left = database.get(Document, left_id)
    right = database.get(Document, right_id)
    if left is None or right is None:
        raise ValueError("Document not found.")

    sections = _contract_sections(database, left.id, right.id)
    if not sections:
        sections = _generic_sections(database, left.id, right.id)

    summary = {change: 0 for change in CHANGES}
    for section in sections:
        for row in section["rows"]:
            summary[row["change"]] += 1
        section["counts"] = {
            change: sum(1 for row in section["rows"] if row["change"] == change) for change in CHANGES
        }
    return {
        "left": _describe(database, left),
        "right": _describe(database, right),
        "summary": summary,
        "sections": sections,
    }
