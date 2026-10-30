"""The Original Structure view as an Excel workbook: the document's
sections in reading order, each field under its numbered item, and each
table with its printed headers — the layout the user sees on screen.

Every value is written as text exactly as printed ("07/01/2025",
"$33,747,047.53"), so Excel doesn't turn it into a date or a number, and
text that looks like a formula is never executed."""

from __future__ import annotations

import io
import re
from typing import Any

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

from app.staging.custom_export import safe_cell
from app.staging.xlsx_style import BANNER_FILL, BORDER, HEADER_FILL

# Same columns, same order as the Original Structure grid.
FIELD_COLUMNS = [
    "No.",
    "Category / Section",
    "Field / Label",
    "Extracted Value",
    "Evidence",
    "Review Status",
    "Type",
    "Found By",
    "Source Page",
]
_WIDTHS = [7, 30, 34, 34, 48, 16, 12, 16, 12]

# "3. Briefed Through", "9a) Prime Contractor": a numbered form item.
_NUMBERED_ITEM = re.compile(r"^(\d{1,3}[a-z]?[.)])\s+(\S.*)$")
# Short names for how a field was found, as the grid shows them.
FOUND_BY_LABEL = {
    "ruled form row": "Form line",
    "form fill in": "Fill-in blank",
    "same line separator": "Label: value",
    "left right separator": "Label: value",
    "left right typography": "Bold label",
    "left right whitespace": "Label  value",
    "same line filler": "Leader line",
    "table key value grid": "Key/value grid",
    "label above value": "Label above",
    "form widget": "Form field",
    "label value": "Label/value",
}
_ILLEGAL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")

_SECTION_FILL = PatternFill("solid", fgColor="DDEFF7")
_TABLE_FILL = PatternFill("solid", fgColor="EEF3F7")
_TOP = Alignment(vertical="top", wrap_text=True)


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


def _text(value: Any) -> str | None:
    if value is None or value == "":
        return None
    return safe_cell(_ILLEGAL.sub(" ", str(value)))


class _Sheet:
    def __init__(self, ws) -> None:
        self.ws = ws
        self.row = 0

    def write(self, values: list[Any], *, font: Font | None = None, fill: PatternFill | None = None) -> None:
        self.row += 1
        for column, value in enumerate(values, start=1):
            cell = self.ws.cell(row=self.row, column=column)
            text = _text(value)
            if text is not None:
                cell.value = text
                cell.data_type = "s"  # never a formula, never re-typed
            cell.number_format = "@"
            cell.alignment = _TOP
            if font:
                cell.font = font
            if fill:
                cell.fill = fill
                cell.border = BORDER

    def band(self, text: str, width: int, *, font: Font, fill: PatternFill) -> None:
        self.write([text] + [None] * (width - 1), font=font, fill=fill)
        if width > 1:
            self.ws.merge_cells(start_row=self.row, start_column=1, end_row=self.row, end_column=width)

    def header(self, labels: list[str]) -> None:
        self.write(labels, font=Font(bold=True, color="FFFFFF"), fill=HEADER_FILL)

    def gap(self) -> None:
        self.row += 1


def _pages(pages: list[int]) -> str:
    if not pages:
        return ""
    return f"page {pages[0]}" if len(pages) == 1 else f"pages {pages[0]}–{pages[-1]}"


def build_original_structure_xlsx(layout: dict[str, Any], document_name: str) -> bytes:
    workbook = Workbook()
    ws = workbook.active
    ws.title = "Original Structure"
    sheet = _Sheet(ws)
    widest = max(
        [len(FIELD_COLUMNS)]
        + [len(item["headers"]) + 2 for s in layout["sections"] for item in s["items"] if item["kind"] == "table"]
    )
    stats = layout["stats"]
    sheet.band(f"{document_name} — Original Structure", widest, font=Font(bold=True, size=15, color="FFFFFF"), fill=BANNER_FILL)
    sheet.band(
        f"{stats['fields']} fields ({stats['blank_fields']} blank on the page) · {stats['tables']} tables · "
        f"{stats['table_rows']} table rows · values as printed in the document",
        widest, font=Font(italic=True, size=9, color="44546A"), fill=PatternFill(fill_type=None),
    )

    sections = list(layout["sections"])
    if layout.get("unplaced"):
        sections.append({"title": "Other extracted fields (no position in the layout)", "page": 0, "items": layout["unplaced"]})
    for section in sections:
        sheet.gap()
        title = section["title"] or "Document start"
        if section.get("page"):
            title += f"  (page {section['page']})"
        sheet.band(title, widest, font=Font(bold=True, size=12), fill=_SECTION_FILL)
        in_fields = False
        # An item's number and name are written once, merged down its rows.
        run: dict[str, Any] = {"key": None, "start": 0}

        def close_run() -> None:
            if run["key"] is not None and sheet.row > run["start"]:
                for column in (1, 2):
                    ws.merge_cells(start_row=run["start"], start_column=column, end_row=sheet.row, end_column=column)
            run["key"] = None

        for item in section["items"]:
            if item["kind"] == "field":
                if not in_fields:
                    sheet.header(FIELD_COLUMNS)
                    in_fields = True
                number, category, label = item_parts(item.get("group"), item["label"])
                key = (number, category)
                first = key != run["key"]
                if first:
                    close_run()
                value = item.get("extracted_value") or ""
                reviewed = item.get("effective_value") or ""
                if reviewed and reviewed != value:
                    value = f"{value}\nReviewed: {reviewed}" if value else f"Reviewed: {reviewed}"
                status = item["review_status"]
                flags = [flag["message"] for flag in item.get("flags") or []]
                if flags:
                    status = "\n".join([status, *flags])
                sheet.write([
                    number if first else None, category if first else None, label, value, item.get("evidence"), status,
                    item.get("value_type"), FOUND_BY_LABEL.get(item.get("found_by") or "", item.get("found_by")), item.get("page"),
                ])
                if first:
                    run.update(key=key, start=sheet.row)
                continue
            close_run()
            in_fields = False
            heading = f"Table: {item.get('title') or 'Table'} · {item['row_count']} rows · {_pages(item.get('pages') or [])}"
            if item.get("continued"):
                heading += " · continued across pages"
            sheet.band(heading, widest, font=Font(bold=True), fill=_TABLE_FILL)
            sheet.header([*item["headers"], "Source Page", "Review Status"])
            columns = len(item["headers"])
            for row in item["rows"]:
                cells = (list(row["cells"]) + [""] * columns)[:columns]
                status = row.get("review_status") or ""
                notes = [f"{item['headers'][f['column']]}: {f['message']}" for f in row.get("flags") or [] if f.get("column") is not None and f["column"] < columns]
                if notes:
                    status = "\n".join([status, *notes])
                sheet.write([*cells, row.get("page"), status])
        close_run()

    for index in range(widest):
        ws.column_dimensions[get_column_letter(index + 1)].width = _WIDTHS[index] if index < len(_WIDTHS) else 18
    ws.sheet_view.showGridLines = True
    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()
