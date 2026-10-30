"""The Original Structure export: one sheet with the document's own fields
in reading order — Item #, Section, Fields Extracted, Value / Details — and
each printed table in place under its printed headers. Nothing is added:
no banners, colours, merged cells or provenance columns (those are in the
Structured JSON export).

Every value is written as text exactly as printed ("07/01/2025",
"$33,747,047.53"), so Excel doesn't turn it into a date or a number, and
text that looks like a formula is never executed."""

from __future__ import annotations

import io
import re
from typing import Any

from openpyxl import Workbook
from openpyxl.utils import get_column_letter

from app.staging.custom_export import safe_cell

# The export's columns, as the document's own summary tables label them.
EXPORT_COLUMNS = ["Item #", "Section", "Fields Extracted", "Value / Details"]
_WIDTHS = [8, 32, 36, 48]

# "3. Briefed Through", "9a) Prime Contractor": a numbered form item.
_NUMBERED_ITEM = re.compile(r"^(\d{1,3}[a-z]?[.)])\s+(\S.*)$")
_ILLEGAL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def field_placement(group: str | None, label: str) -> tuple[str, str]:
    """(Category, Field) as the grid shows them: the numbered item — the
    group, or the field itself when the item has no sub-labels — and the
    item's own wording."""

    if group:
        return group, label
    item = _NUMBERED_ITEM.match(label.strip())
    if item:
        return label.strip(), item.group(2)
    return "", label


def item_parts(group: str | None, label: str) -> tuple[str, str, str]:
    """(No., Category, Field) as the grid shows them: "1." and "Contractor
    Information" for every field of item 1, and the field's own wording."""

    category, field = field_placement(group, label)
    numbered = _NUMBERED_ITEM.match(category)
    if numbered:
        return numbered.group(1), numbered.group(2), field
    return "", category, field


def field_value(item: dict[str, Any]) -> str:
    """The value now in effect: a reviewer's correction, else what was read."""

    return item.get("effective_value") or item.get("extracted_value") or item.get("document_value") or ""


def original_rows(layout: dict[str, Any]) -> list[list[str]]:
    """The export as rows: the columns, then every field in reading order —
    its item number and section written on the item's first row only, as
    printed — and each printed table in place under its own headers."""

    rows: list[list[str]] = [list(EXPORT_COLUMNS)]

    def gap() -> None:
        if rows[-1]:
            rows.append([])

    sections = list(layout["sections"])
    if layout.get("unplaced"):
        sections.append({"title": "Other extracted fields", "items": layout["unplaced"]})
    for section in sections:
        previous = None
        for item in section["items"]:
            if item["kind"] == "field":
                number, category, label = item_parts(item.get("group"), item["label"])
                key = (number, category or section.get("title") or "")
                first = key != previous
                rows.append([key[0] if first else "", key[1] if first else "", label, field_value(item)])
                previous = key
                continue
            previous = None
            gap()
            if item.get("title"):
                rows.append([item["title"]])
            width = len(item["headers"])
            rows.append(list(item["headers"]))
            for row in item["rows"]:
                cells = row.get("reviewed_cells") or row["cells"]
                rows.append((list(cells) + [""] * width)[:width])
            gap()
    while rows and not rows[-1]:
        rows.pop()
    return rows


def _text(value: Any) -> str | None:
    if value is None or value == "":
        return None
    return safe_cell(_ILLEGAL.sub(" ", str(value)))


def build_original_structure_xlsx(layout: dict[str, Any]) -> bytes:
    workbook = Workbook()
    ws = workbook.active
    ws.title = "Original Structure"
    for row_number, values in enumerate(original_rows(layout), start=1):
        for column, value in enumerate(values, start=1):
            text = _text(value)
            if text is None:
                continue
            cell = ws.cell(row=row_number, column=column, value=text)
            cell.data_type = "s"  # never a formula, never re-typed
            cell.number_format = "@"
    for index, width in enumerate(_WIDTHS, start=1):
        ws.column_dimensions[get_column_letter(index)].width = width
    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()
