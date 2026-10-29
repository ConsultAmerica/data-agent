"""Build the structured source view of a stored document.

Every reader here is bounded and inert:

- the viewer is chosen from the stored file's verified type (its upload
  spec plus a fresh magic-byte check), never from the name alone;
- spreadsheet formulas are read as text and never evaluated; a cached
  value is shown only when the file stores one; VBA is never loaded;
- XML uses the hardened parser (no entities, DTDs or network);
- Word content becomes typed blocks (no HTML), so nothing in a document
  can inject markup or load an external resource;
- sizes, cells, rows and nodes are capped, and a capped view says so.
"""

from __future__ import annotations

import csv
import zipfile
from io import StringIO
from pathlib import Path
from typing import Any

from app.parsers.data_file_parsers import DataFileError, load_json_bytes
from app.parsers.office_text_parsers import (
    _DELIMITER_NAMES,
    decode_text_bytes,
    encoding_was_guessed,
    sniff_delimiter,
)
from app.services.security_validation import (
    SecurityValidationError,
    UPLOAD_TYPES,
    validate_signature,
)

MAX_SOURCE_BYTES = 25 * 1024 * 1024
MAX_SHEET_CELLS = 200_000
MAX_DELIMITED_ROWS = 50_000
MAX_XML_NODES = 20_000
MAX_WORD_BLOCKS = 20_000
MAX_TEXT = 20_000

# Viewer per verified upload kind.
_VIEWERS = {
    "pdf": "pdf",
    "image": "image",
    "xlsx": "spreadsheet",
    "ods": "spreadsheet",
    "csv": "delimited",
    "json": "json",
    "xml": "xml",
    "docx": "word",
}


class SourceViewError(ValueError):
    """The source can't be shown in a structured viewer."""


def resolve_viewer(stored_filename: str, path: Path) -> dict[str, Any]:
    """{viewer, format, verified, note} for a stored file.

    The extension picks a candidate type; the file's own first bytes must
    agree (same check as upload) or the generic text viewer is used."""

    suffix = Path(stored_filename).suffix.lower()
    spec = UPLOAD_TYPES.get(suffix)
    if spec is None:
        return {"viewer": "unsupported", "format": suffix.lstrip("."), "verified": False,
                "note": "This file type has no preview."}
    try:
        with path.open("rb") as handle:
            validate_signature(spec, handle.read(4096))
    except (OSError, SecurityValidationError) as exc:
        return {"viewer": "unsupported", "format": suffix.lstrip("."), "verified": False,
                "note": f"The stored file doesn't match its type ({exc})."}
    viewer = _VIEWERS.get(spec.kind)
    note = None
    if spec.kind == "legacy_office":
        viewer = "text"
        note = ("Legacy Office files are shown as the text read from their converted copy; "
                "the original layout isn't reproduced.")
    elif viewer is None:
        viewer = "text"
    return {"viewer": viewer, "format": suffix.lstrip("."), "verified": True, "note": note}


def _check_size(path: Path) -> None:
    if path.stat().st_size > MAX_SOURCE_BYTES:
        raise SourceViewError(
            f"The file is larger than {MAX_SOURCE_BYTES // (1024 * 1024)} MB; "
            "its structured view isn't available. Use the page text view."
        )


# ── Spreadsheets ─────────────────────────────────────────────────────


def column_letter(index: int) -> str:
    """1 → A, 27 → AA."""

    letters = ""
    while index > 0:
        index, remainder = divmod(index - 1, 26)
        letters = chr(65 + remainder) + letters
    return letters


def _cell_text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _load_openpyxl(path: Path):
    from openpyxl import load_workbook

    # Two reads of the same file: formulas as written, and the values the
    # file cached when it was last saved. keep_vba stays False (default):
    # macros are never loaded.
    formulas = load_workbook(filename=str(path), data_only=False)
    values = load_workbook(filename=str(path), data_only=True)
    return formulas, values


def spreadsheet_summary(path: Path, fmt: str) -> dict[str, Any]:
    _check_size(path)
    if fmt == "ods":
        sheets = _ods_sheets(path)
        return {
            "sheets": [
                {"index": i, "name": s["name"], "max_row": s["max_row"], "max_column": s["max_column"], "frozen": None}
                for i, s in enumerate(sheets)
            ],
            "formulas_available": True,
            "macros_note": None,
        }
    formulas, values = _load_openpyxl(path)
    try:
        return {
            "sheets": [
                {"index": i, "name": ws.title, "max_row": ws.max_row, "max_column": ws.max_column,
                 "frozen": ws.freeze_panes}
                for i, ws in enumerate(formulas.worksheets)
            ],
            "formulas_available": True,
            "macros_note": "Macros in this workbook are never loaded or run." if fmt == "xlsm" else None,
        }
    finally:
        formulas.close()
        values.close()


def spreadsheet_sheet(path: Path, fmt: str, index: int) -> dict[str, Any]:
    """One sheet's non-empty cells: ref, row, column, value, formula."""

    _check_size(path)
    if fmt == "ods":
        sheets = _ods_sheets(path, with_cells=True)
        if not 0 <= index < len(sheets):
            raise SourceViewError("No such sheet.")
        sheet = sheets[index]
        return {"index": index, "name": sheet["name"], "max_row": sheet["max_row"], "max_column": sheet["max_column"],
                "frozen": None, "merged": sheet["merged"], "cells": sheet["cells"], "truncated": sheet["truncated"]}

    formulas, values = _load_openpyxl(path)
    try:
        if not 0 <= index < len(formulas.worksheets):
            raise SourceViewError("No such sheet.")
        ws = formulas.worksheets[index]
        cached = values.worksheets[index]
        cells: list[dict[str, Any]] = []
        truncated = False
        for row in ws.iter_rows():
            for cell in row:
                if cell.value is None:
                    continue
                if len(cells) >= MAX_SHEET_CELLS:
                    truncated = True
                    break
                raw = cell.value
                formula = raw if isinstance(raw, str) and raw.startswith("=") else None
                stored = cached.cell(row=cell.row, column=cell.column).value
                cells.append({
                    "ref": f"{column_letter(cell.column)}{cell.row}",
                    "row": cell.row,
                    "column": cell.column,
                    "formula": formula,
                    # A formula's value is the one the file cached (None when
                    # it was never calculated); it is never computed here.
                    "value": _cell_text(stored) if formula else _cell_text(raw),
                    "type": cell.data_type,
                })
            if truncated:
                break
        return {
            "index": index,
            "name": ws.title,
            "max_row": ws.max_row,
            "max_column": ws.max_column,
            "frozen": ws.freeze_panes,
            "merged": [str(r) for r in ws.merged_cells.ranges],
            "cells": cells,
            "truncated": truncated,
        }
    finally:
        formulas.close()
        values.close()


_T = "{urn:oasis:names:tc:opendocument:xmlns:table:1.0}"
_TEXT = "{urn:oasis:names:tc:opendocument:xmlns:text:1.0}"
_OFFICE = "{urn:oasis:names:tc:opendocument:xmlns:office:1.0}"
_ODS_REPEAT_CAP = 1_000


def _ods_sheets(path: Path, with_cells: bool = False) -> list[dict[str, Any]]:
    from app.xml_records.parse import XmlSourceError, parse_tree

    try:
        with zipfile.ZipFile(path) as archive:
            info = archive.getinfo("content.xml")
            if info.file_size > 200 * 1024 * 1024:
                raise SourceViewError("The spreadsheet is too large to show.")
            raw = archive.read(info)
        root = parse_tree(raw)
    except (KeyError, zipfile.BadZipFile, XmlSourceError) as exc:
        raise SourceViewError("The ODS spreadsheet could not be read.") from exc

    def repeat(element, name: str, cap: int | None = _ODS_REPEAT_CAP) -> int:
        """The repeat count; capped where repeats are expanded into cells.
        Empty runs advance by their real count so later cells keep their
        true row and column."""
        try:
            n = max(1, int(element.get(f"{_T}{name}", "1")))
        except ValueError:
            return 1
        return min(n, cap) if cap else n

    sheets = []
    for table in root.iter(f"{_T}table"):
        cells: list[dict[str, Any]] = []
        merged: list[str] = []
        truncated = False
        max_row = max_column = 0
        row_number = 0
        for row in table.iter(f"{_T}table-row"):
            row_cells = []
            column = 0
            for cell in row:
                if cell.tag not in (f"{_T}table-cell", f"{_T}covered-table-cell"):
                    continue
                paragraphs = cell.findall(f"{_TEXT}p")
                text = "\n".join("".join(p.itertext()) for p in paragraphs) or None
                formula = cell.get(f"{_T}formula")
                if not (text or formula):
                    column += repeat(cell, "number-columns-repeated", cap=None)
                    continue
                stored = cell.get(f"{_OFFICE}value") or cell.get(f"{_OFFICE}date-value") or cell.get(f"{_OFFICE}boolean-value")
                span_c = int(cell.get(f"{_T}number-columns-spanned", "1") or 1)
                span_r = int(cell.get(f"{_T}number-rows-spanned", "1") or 1)
                for _ in range(repeat(cell, "number-columns-repeated")):
                    column += 1
                    row_cells.append((column, text, formula, stored, span_c, span_r))
            if not row_cells:
                row_number += repeat(row, "number-rows-repeated", cap=None)
                continue
            for _ in range(repeat(row, "number-rows-repeated")):
                row_number += 1
                max_row = row_number
                for column, text, formula, stored, span_c, span_r in row_cells:
                    max_column = max(max_column, column + span_c - 1)
                    if not with_cells:
                        continue
                    if len(cells) >= MAX_SHEET_CELLS:
                        truncated = True
                        continue
                    ref = f"{column_letter(column)}{row_number}"
                    cells.append({
                        "ref": ref, "row": row_number, "column": column,
                        # ODF stores the formula as written ("of:=[.B2]*[.C2]").
                        "formula": formula,
                        "value": text if not formula else (text or stored),
                        "type": "f" if formula else "s",
                    })
                    if span_c > 1 or span_r > 1:
                        merged.append(f"{ref}:{column_letter(column + span_c - 1)}{row_number + span_r - 1}")
        sheets.append({
            "name": table.get(f"{_T}name") or f"Sheet{len(sheets) + 1}",
            "max_row": max_row, "max_column": max_column,
            "cells": cells, "merged": merged, "truncated": truncated,
        })
    return sheets


# ── Delimited text ───────────────────────────────────────────────────


def delimited_view(path: Path) -> dict[str, Any]:
    _check_size(path)
    text, encoding = decode_text_bytes(path.read_bytes())
    default = "\t" if path.suffix.lower() == ".tsv" else ","
    sample = text[:64_000]
    delimiter = sniff_delimiter(sample, default=default)
    warnings: list[str] = []
    guessed = encoding_was_guessed(encoding)
    if guessed:
        warnings.append(f"The encoding ({encoding}) was guessed; check accented characters and symbols.")
    try:
        has_header = csv.Sniffer().has_header(sample) if sample.strip() else False
        header_detected = True
    except csv.Error:
        has_header, header_detected = True, False
        warnings.append("The header row couldn't be detected; the first row is shown as the header.")
    rows: list[list[str]] = []
    truncated = False
    widths: set[int] = set()
    for row in csv.reader(StringIO(text), delimiter=delimiter):
        if len(rows) >= MAX_DELIMITED_ROWS:
            truncated = True
            break
        rows.append(row)
        widths.add(len(row))
    if len(widths) > 1:
        warnings.append(f"Rows have different numbers of fields ({min(widths)}–{max(widths)}).")
    if truncated:
        warnings.append(f"Only the first {MAX_DELIMITED_ROWS:,} rows are shown.")
    return {
        "encoding": encoding,
        "encoding_guessed": guessed,
        "delimiter": _DELIMITER_NAMES.get(delimiter, delimiter),
        "has_header": has_header,
        "header_detected": header_detected,
        "rows": rows,
        "truncated": truncated,
        "warnings": warnings,
    }


# ── JSON ─────────────────────────────────────────────────────────────


def json_view(path: Path) -> dict[str, Any]:
    _check_size(path)
    try:
        return {"data": load_json_bytes(path.read_bytes())}
    except DataFileError as exc:
        raise SourceViewError(str(exc)) from exc


# ── XML ──────────────────────────────────────────────────────────────


def xml_view(path: Path) -> dict[str, Any]:
    """The element tree with namespaces; each node's path is written the
    way XML extraction writes source paths (/Root/Item[2]/Name)."""

    from lxml import etree

    from app.xml_records.parse import XmlSourceError, parse_tree

    _check_size(path)
    try:
        root = parse_tree(path.read_bytes())
    except XmlSourceError as exc:
        raise SourceViewError(str(exc)) from exc

    count = 0
    truncated = False

    def local(element) -> str:
        return etree.QName(element).localname

    def build(element, element_path: str) -> dict[str, Any]:
        nonlocal count, truncated
        count += 1
        qname = etree.QName(element)
        text = (element.text or "").strip()
        node: dict[str, Any] = {
            "name": qname.localname,
            "prefix": element.prefix,
            "namespace": qname.namespace,
            "path": element_path,
            "attributes": [
                {
                    "name": etree.QName(key).localname,
                    "namespace": etree.QName(key).namespace,
                    "value": value,
                    "path": f"{element_path}/@{etree.QName(key).localname}",
                }
                for key, value in element.attrib.items()
            ],
            "text": text[:MAX_TEXT] if text else None,
            "children": [],
        }
        children = [c for c in element if isinstance(c.tag, str)]
        totals: dict[str, int] = {}
        for child in children:
            totals[local(child)] = totals.get(local(child), 0) + 1
        seen: dict[str, int] = {}
        for child in children:
            if count >= MAX_XML_NODES:
                truncated = True
                break
            name = local(child)
            seen[name] = seen.get(name, 0) + 1
            suffix = f"[{seen[name]}]" if totals[name] > 1 else ""
            node["children"].append(build(child, f"{element_path}/{name}{suffix}"))
        return node

    tree = build(root, f"/{local(root)}")
    namespaces = [{"prefix": prefix, "uri": uri} for prefix, uri in (root.nsmap or {}).items()]
    return {"root": tree, "namespaces": namespaces, "node_count": count, "truncated": truncated}


# ── Word ─────────────────────────────────────────────────────────────

_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


def word_view(path: Path) -> dict[str, Any]:
    """Headings, paragraphs (with hyperlink targets as text), list items
    and tables, in document order — as data, never HTML."""

    from docx import Document as load_docx

    _check_size(path)
    try:
        document = load_docx(str(path))
    except Exception as exc:  # noqa: BLE001 - any parse failure is "can't show"
        raise SourceViewError("The Word document could not be read.") from exc

    links = {rel_id: rel.target_ref for rel_id, rel in document.part.rels.items() if rel.is_external}
    blocks: list[dict[str, Any]] = []
    section: list[str] = []
    truncated = False

    def paragraph_block(p_element) -> dict[str, Any] | None:
        style_el = p_element.find(f"{_W}pPr/{_W}pStyle")
        style = style_el.get(f"{_W}val") if style_el is not None else ""
        parts: list[dict[str, Any]] = []
        for child in p_element:
            if child.tag == f"{_W}r":
                parts.append({"text": "".join(t.text or "" for t in child.iter(f"{_W}t"))})
            elif child.tag == f"{_W}hyperlink":
                target = links.get(child.get(f"{_R}id") or "")
                anchor = child.get(f"{_W}anchor")
                parts.append({
                    "text": "".join(t.text or "" for t in child.iter(f"{_W}t")),
                    "href": target,
                    "anchor": anchor,
                })
        text = "".join(part["text"] for part in parts)
        if not text.strip():
            return None
        heading = None
        lowered = style.lower()
        if lowered.startswith("heading"):
            digits = "".join(ch for ch in style if ch.isdigit())
            heading = int(digits) if digits else 1
        elif lowered == "title":
            heading = 1
        num = p_element.find(f"{_W}pPr/{_W}numPr")
        if heading is not None:
            del section[heading - 1:]
            section.append(text.strip())
            return {"type": "heading", "level": heading, "text": text, "section": list(section)}
        if num is not None or lowered.startswith("list"):
            level_el = num.find(f"{_W}ilvl") if num is not None else None
            level = int(level_el.get(f"{_W}val", "0")) if level_el is not None else 0
            return {"type": "list_item", "level": level, "text": text, "parts": parts, "section": list(section)}
        return {"type": "paragraph", "text": text, "parts": parts, "section": list(section), "style": style or None}

    for element in document.element.body:
        if len(blocks) >= MAX_WORD_BLOCKS:
            truncated = True
            break
        if element.tag == f"{_W}p":
            block = paragraph_block(element)
            if block:
                block["index"] = len(blocks)
                blocks.append(block)
        elif element.tag == f"{_W}tbl":
            rows = []
            for tr in element.iter(f"{_W}tr"):
                rows.append([
                    "\n".join("".join(t.text or "" for t in p.iter(f"{_W}t")) for p in tc.iter(f"{_W}p")).strip()
                    for tc in tr.iter(f"{_W}tc")
                ])
            if rows:
                blocks.append({"type": "table", "rows": rows, "section": list(section), "index": len(blocks)})

    core = document.core_properties
    metadata = {
        "title": core.title or None,
        "author": core.author or None,
        "created": core.created.isoformat() if core.created else None,
        "modified": core.modified.isoformat() if core.modified else None,
    }
    return {"blocks": blocks, "metadata": metadata, "truncated": truncated}
