"""Native parsers for JSON and ODS spreadsheets.

Same output shape as office_text_parsers: paragraphs, tables and text for
one page (or one page per sheet). Nothing here executes or fetches
anything: JSON is data, ODS content.xml is read with the hardened XML
parser.
"""

from __future__ import annotations

import json
import zipfile
from pathlib import Path

from app.parsers.office_text_parsers import decode_text_bytes


class DataFileError(ValueError):
    """The file is not valid for its declared type."""


# ── JSON ─────────────────────────────────────────────────────────────

_MAX_JSON_LINES = 200_000
_MAX_JSON_TABLE_ROWS = 50_000


def load_json_bytes(raw: bytes):
    text, _ = decode_text_bytes(raw)
    try:
        return json.loads(text)
    except RecursionError as exc:
        raise DataFileError("The JSON file is nested too deeply.") from exc
    except ValueError as exc:
        raise DataFileError(f"The file is not valid JSON ({exc}).") from exc


def _scalar(value) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _is_scalar(value) -> bool:
    return value is None or isinstance(value, (str, int, float, bool))


def _record_table(items: list) -> list[list[str]] | None:
    """An array of flat objects → header row + one row per object."""

    if not items or not all(isinstance(item, dict) for item in items):
        return None
    header: list[str] = []
    for item in items:
        for key, value in item.items():
            if _is_scalar(value) and key not in header:
                header.append(key)
    if not header:
        return None
    rows = [header]
    for item in items[:_MAX_JSON_TABLE_ROWS]:
        rows.append([_scalar(item.get(key)) if _is_scalar(item.get(key)) else "" for key in header])
    return rows


def parse_json_file(file_path: str | Path) -> dict:
    """One 'path: value' line per scalar (paths as written in the file:
    invoice.lines[2].amount), plus a table for every array of objects."""

    data = load_json_bytes(Path(file_path).read_bytes())
    lines: list[str] = []
    tables: list[list[list[str]]] = []

    stack: list[tuple[str, object]] = [("", data)]
    while stack and len(lines) < _MAX_JSON_LINES:
        path, value = stack.pop()
        if isinstance(value, dict):
            for key, child in reversed(list(value.items())):
                stack.append((f"{path}.{key}" if path else str(key), child))
        elif isinstance(value, list):
            table = _record_table(value)
            if table is not None:
                tables.append(table)
            for index in range(len(value) - 1, -1, -1):
                stack.append((f"{path}[{index}]", value[index]))
        else:
            lines.append(f"{path or 'value'}: {_scalar(value)}")

    return {"paragraphs": lines, "tables": tables, "text": "\n".join(lines)}


# ── ODS (OpenDocument spreadsheet) ───────────────────────────────────

_TABLE_NS = "urn:oasis:names:tc:opendocument:xmlns:table:1.0"
_TEXT_NS = "urn:oasis:names:tc:opendocument:xmlns:text:1.0"
_OFFICE_NS = "urn:oasis:names:tc:opendocument:xmlns:office:1.0"
_T = "{%s}" % _TABLE_NS
# content.xml expands to far more than the compressed file; refuse very
# large ones rather than build a huge tree.
_MAX_ODS_CONTENT_BYTES = 200 * 1024 * 1024
# Repeat counts pad sheets to 1,048,576 rows / 16,384 columns; only
# content is expanded, and at most this many times.
_MAX_REPEAT = 1_000
_MAX_ODS_CELLS = 2_000_000


def _cell_text(cell) -> str:
    """The cell's displayed text (its text:p paragraphs), else its value."""

    paragraphs = cell.findall(f"{{{_TEXT_NS}}}p")
    if paragraphs:
        return "\n".join("".join(p.itertext()) for p in paragraphs).strip()
    for attribute in ("value", "date-value", "time-value", "boolean-value", "string-value"):
        value = cell.get(f"{{{_OFFICE_NS}}}{attribute}")
        if value is not None:
            return value.strip()
    return ""


def _repeat(element, attribute: str) -> int:
    try:
        return max(1, min(int(element.get(f"{_T}{attribute}", "1")), _MAX_REPEAT))
    except ValueError:
        return 1


def parse_ods_sheets(file_path: str | Path) -> list[dict]:
    """One dict per sheet: name, paragraphs, tables, text (as XLSX)."""

    from app.xml_records.parse import XmlSourceError, parse_tree

    try:
        with zipfile.ZipFile(file_path) as archive:
            info = archive.getinfo("content.xml")
            if info.file_size > _MAX_ODS_CONTENT_BYTES:
                raise DataFileError("The ODS spreadsheet is too large to read.")
            with archive.open(info) as handle:
                raw = handle.read(_MAX_ODS_CONTENT_BYTES + 1)
    except (KeyError, zipfile.BadZipFile) as exc:
        raise DataFileError("The file is not a valid ODS spreadsheet.") from exc
    if len(raw) > _MAX_ODS_CONTENT_BYTES:
        raise DataFileError("The ODS spreadsheet is too large to read.")

    try:
        root = parse_tree(raw)
    except XmlSourceError as exc:
        raise DataFileError(f"The ODS spreadsheet could not be read ({exc}).") from exc

    sheets: list[dict] = []
    cells_read = 0
    for table in root.iter(f"{_T}table"):
        rows: list[list[str]] = []
        for row in table.iter(f"{_T}table-row"):
            cells: list[str] = []
            for cell in row:
                if cell.tag not in (f"{_T}table-cell", f"{_T}covered-table-cell"):
                    continue
                text = _cell_text(cell)
                cells.extend([text] * (_repeat(cell, "number-columns-repeated") if text else 1))
            while cells and not cells[-1]:
                cells.pop()
            if not cells:
                continue
            for _ in range(_repeat(row, "number-rows-repeated")):
                rows.append(list(cells))
                cells_read += len(cells)
            if cells_read > _MAX_ODS_CELLS:
                raise DataFileError("The ODS spreadsheet has too many cells to read.")

        width = max((len(row) for row in rows), default=0)
        rows = [row + [""] * (width - len(row)) for row in rows]
        paragraphs = [" | ".join(row) for row in rows]
        sheets.append(
            {
                "name": table.get(f"{_T}name") or f"Sheet{len(sheets) + 1}",
                "paragraphs": paragraphs,
                "tables": [rows] if rows else [],
                "text": "\n".join(paragraphs),
            }
        )
    return sheets
