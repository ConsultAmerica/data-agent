"""Reads an Oracle Fusion import template the user uploaded and finds its
columns: the technical attribute names (what an import file's header row
must say, exactly), the display labels when the template carries them, and
the column order. Nothing here supplies an Oracle name of its own.

Layouts recognized, in the first rows of a CSV or of a worksheet:

* technical names, then display labels (two header rows);
* display labels, then technical names;
* technical names only;
* display labels only — kept as the header strings to write back, since
  that is what this template's import expects; a warning says so.

A cell is a technical name when it is a single identifier token
(``ContractNumber``, ``CONTRACT_NUMBER``); a display label reads as words.
A leading or trailing ``*`` on a label marks the column required — the only
"required" signal taken from a template; without it, required is unknown.
Workbooks are read with openpyxl, which never runs macros.
"""

from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass, field
from pathlib import PurePath

MAX_TEMPLATE_BYTES = 5 * 1024 * 1024
_SCAN_ROWS = 12
_TECHNICAL = re.compile(r"^[A-Za-z_][A-Za-z0-9_.]*$")
_SKIP_SHEETS = re.compile(r"instruction|readme|read me|help|cover|lookup|note", re.IGNORECASE)


class TemplateError(ValueError):
    """The file can't be used as an import template; the message says why."""


@dataclass
class TemplateColumn:
    position: int
    # Unique within the template: what mappings refer to.
    technical_name: str
    display_label: str | None
    required: bool | None
    # The header exactly as the template prints it, when that differs from
    # technical_name (a repeated header, told apart as "Supplier (2)").
    header: str | None = None


@dataclass
class ParsedTemplate:
    object_name: str
    file_format: str
    sheet_name: str | None
    technical_row: int
    label_row: int | None
    columns: list[TemplateColumn]
    warnings: list[str] = field(default_factory=list)


def _trimmed(row: list[object]) -> list[str]:
    cells = ["" if value is None else str(value) for value in row]
    while cells and not cells[-1].strip():
        cells.pop()
    return cells


def _is_technical(cell: str) -> bool:
    return bool(_TECHNICAL.fullmatch(cell.strip()))


def _row_kind(cells: list[str]) -> str | None:
    """"technical", "label" or None (blank / not a header row)."""

    values = [cell.strip() for cell in cells if cell.strip()]
    if len(values) < 2 and not (len(values) == 1 and len(cells) == 1):
        return None
    if all(_is_technical(value) for value in values):
        return "technical"
    if all(re.search(r"[A-Za-z]", value) for value in values):
        return "label"
    return None


def name_tokens(text: str) -> set[str]:
    """Lower-case words of a header: "ContractNumber" / "Contract Number"
    / "CONTRACT_NUMBER" → {"contract", "number"}."""

    spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])", " ", text)
    return {word for word in re.split(r"[^A-Za-z0-9]+", spaced.lower()) if word}


def _word_count(row: list[str]) -> float:
    names = [cell for cell in row if cell.strip()]
    return sum(len(name_tokens(cell)) for cell in names) / max(1, len(names))


def _labels_match(technical: list[str], labels: list[str]) -> bool:
    """A display-label row describes its technical row: enough columns share
    a word ("Number" / "ContractNumber"). Sample data rows don't."""

    pairs = [(t, l) for t, l in zip(technical, labels) if t.strip() and l.strip()]
    if not pairs:
        return False
    shared = sum(1 for t, l in pairs if name_tokens(t) & name_tokens(l))
    return shared / len(pairs) >= 0.4


def _label(cell: str) -> tuple[str, bool | None]:
    text = cell.strip()
    if text.startswith("*") or text.endswith("*"):
        return text.strip("*").strip(), True
    return text, None


def _object_name(filename: str, sheet: str | None) -> str:
    stem = PurePath(filename).stem
    stem = re.sub(r"(?i)[_\- ]*(template|import|fbdi|v\d+(\.\d+)*)$", "", stem).strip("_- ") or stem
    if sheet and not re.fullmatch(r"(?i)sheet\d*", sheet.strip()):
        stem = sheet.strip()
    words = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", re.sub(r"[_\-]+", " ", stem)).split()
    return " ".join(word if word.isupper() and len(word) > 1 else word.capitalize() for word in words) or "Import Object"


def _columns_from_rows(rows: list[list[str]]) -> tuple[int, int | None, list[TemplateColumn], list[str]]:
    kinds = [_row_kind(row) for row in rows]
    header = next((index for index, kind in enumerate(kinds) if kind is not None), None)
    if header is None:
        raise TemplateError("No header row found in the first rows of the template.")

    warnings: list[str] = []
    following = header + 1 if header + 1 < len(rows) else None
    pair = following is not None and kinds[following] is not None and kinds[following] != kinds[header]
    if pair:
        technical_candidate = rows[header] if kinds[header] == "technical" else rows[following]
        label_candidate = rows[following] if kinds[header] == "technical" else rows[header]
        pair = _labels_match(technical_candidate, label_candidate)
    elif following is not None and kinds[header] == kinds[following] == "technical":
        # One-word labels ("Number") read as identifiers too: the row whose
        # names are clearly shorter versions of the other's is the label row.
        first, second = _word_count(rows[header]), _word_count(rows[following])
        if first != second and _labels_match(rows[header], rows[following]):
            pair = True
            kinds[header if first < second else following] = "label"
    if pair and kinds[header] == "technical":
        technical_row, label_row = header, following
    elif pair:
        technical_row, label_row = following, header
    else:
        technical_row, label_row = header, None
        if kinds[header] == "label":
            warnings.append(
                "The header row reads as display labels, not technical attribute names. "
                "Exports will use these header strings exactly as the template has them."
            )

    technical = rows[technical_row]
    labels = rows[label_row] if label_row is not None else []
    if label_row is not None and len(_trimmed(labels)) != len(_trimmed(technical)):
        warnings.append("The label row and the technical row have different lengths; labels were matched by position.")

    columns: list[TemplateColumn] = []
    for position, raw in enumerate(technical):
        name = raw.strip()
        if not name:
            raise TemplateError(f"Header column {position + 1} is empty.")
        label_text = labels[position] if position < len(labels) else ""
        label, required = _label(label_text) if label_text.strip() else (None, None)
        if label_row is None and kinds[technical_row] == "label":
            label, required = _label(name)
        elif name.startswith("*") or name.endswith("*"):
            required = True
        columns.append(TemplateColumn(position=position, technical_name=raw, display_label=label, required=required))

    names = [column.technical_name.strip() for column in columns]
    duplicates = sorted({name for name in names if names.count(name) > 1})
    if duplicates and kinds[technical_row] == "technical":
        # A technical attribute named twice: Oracle couldn't tell them apart.
        raise TemplateError(f"Duplicate header names: {', '.join(duplicates)}.")
    if duplicates:
        # Display labels repeat legitimately: Oracle exports print a lookup as
        # two columns under one label (the Supplier's id, then its name). Each
        # keeps its place and its printed header; the second and later are
        # told apart for mapping.
        seen: dict[str, int] = {}
        for column in columns:
            name = column.technical_name.strip()
            seen[name] = seen.get(name, 0) + 1
            if seen[name] > 1:
                column.header = column.technical_name
                column.technical_name = f"{name} ({seen[name]})"
                if column.display_label:
                    column.display_label = f"{column.display_label} ({seen[name]})"
        warnings.append(
            f"Repeated header names ({', '.join(duplicates)}) are kept in place: each repeat is mapped as "
            f"\"{duplicates[0]} (2)\" and so on, and exports print the headers exactly as the template does."
        )
    if not any(column.required for column in columns):
        warnings.append("The template does not mark required columns; required checks are not applied.")
    return technical_row, label_row, columns, warnings


def _csv_rows(data: bytes) -> list[list[str]]:
    for encoding in ("utf-8-sig", "cp1252"):
        try:
            text = data.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    else:  # pragma: no cover - cp1252 decodes almost anything
        raise TemplateError("The CSV is not UTF-8 or Windows-1252 text.")
    sample = text[:20000]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    reader = csv.reader(io.StringIO(text), dialect)
    rows: list[list[str]] = []
    for row in reader:
        rows.append(_trimmed(row))
        if len(rows) >= _SCAN_ROWS:
            break
    return rows


def _sheet_rows(sheet) -> list[list[str]]:
    rows: list[list[str]] = []
    for row in sheet.iter_rows(max_row=_SCAN_ROWS, values_only=True):
        rows.append(_trimmed(list(row)))
    return rows


def parse_template(filename: str, data: bytes, *, sheet: str | None = None) -> ParsedTemplate:
    if not data:
        raise TemplateError("The file is empty.")
    if len(data) > MAX_TEMPLATE_BYTES:
        raise TemplateError("Templates are limited to 5 MB.")
    suffix = PurePath(filename).suffix.lower()

    if suffix in {".csv", ".txt", ".tsv"}:
        technical_row, label_row, columns, warnings = _columns_from_rows(_csv_rows(data))
        return ParsedTemplate(
            object_name=_object_name(filename, None),
            file_format="csv",
            sheet_name=None,
            technical_row=technical_row,
            label_row=label_row,
            columns=columns,
            warnings=warnings,
        )

    if suffix in {".xlsx", ".xlsm"}:
        from openpyxl import load_workbook

        try:
            workbook = load_workbook(io.BytesIO(data), read_only=True, data_only=True, keep_vba=False)
        except Exception as exc:  # noqa: BLE001 - openpyxl raises many types for bad files
            raise TemplateError("The workbook could not be read.") from exc
        try:
            if sheet is not None:
                if sheet not in workbook.sheetnames:
                    raise TemplateError(f"The workbook has no sheet {sheet!r}.")
                candidates = [sheet]
            else:
                candidates = [name for name in workbook.sheetnames if not _SKIP_SHEETS.search(name)]
                candidates += [name for name in workbook.sheetnames if name not in candidates]
            last_error: TemplateError | None = None
            for name in candidates:
                try:
                    technical_row, label_row, columns, warnings = _columns_from_rows(_sheet_rows(workbook[name]))
                except TemplateError as exc:
                    last_error = exc
                    continue
                if len(columns) < 2 and sheet is None:
                    continue
                if suffix == ".xlsm":
                    warnings.insert(0, "Macro-enabled workbook: read as data only; its macros are never run.")
                return ParsedTemplate(
                    object_name=_object_name(filename, name),
                    file_format=suffix.lstrip("."),
                    sheet_name=name,
                    technical_row=technical_row,
                    label_row=label_row,
                    columns=columns,
                    warnings=warnings,
                )
            raise last_error or TemplateError("No worksheet has a header row.")
        finally:
            workbook.close()

    raise TemplateError("Upload the template as CSV, XLSX or XLSM.")


# ---------------------------------------------------------------- attribute definitions
#
# Official templates often document each attribute on a sheet of its own
# (name, data type, length, required, lookup) — FBDI workbooks do, and an
# administrator can upload the same table from Oracle's documentation. It
# is read only when its header names an attribute column and at least one
# property column; nothing is inferred from sample data.

_ATTRIBUTE_NAME = re.compile(
    r"(?i)^(attribute|attribute name|column|column name|technical name|name|field|field name|interface column)$"
)
_ATTRIBUTE_PROPERTIES = {
    "data_type": re.compile(r"(?i)^(data ?type|type|format)$"),
    "max_length": re.compile(r"(?i)^(length|max(imum)? ?length|size|width)$"),
    "precision": re.compile(r"(?i)^precision$"),
    "scale": re.compile(r"(?i)^(scale|decimals|decimal places)$"),
    "required": re.compile(r"(?i)^(required|mandatory|is required)$"),
    "lookup": re.compile(r"(?i)^(lookup|lookup type|lookup values|valid values|allowed values|values)$"),
    "description": re.compile(r"(?i)^(description|comments?|notes?|help text)$"),
}
_TYPES = (
    (re.compile(r"(?i)^(varchar2?|nvarchar2?|char|nchar|string|text|clob|alphanumeric)\b"), "string"),
    (re.compile(r"(?i)^(timestamp|datetime|date ?time)\b"), "datetime"),
    (re.compile(r"(?i)^date\b"), "date"),
    (re.compile(r"(?i)^(integer|int|long|bigint|smallint)\b"), "integer"),
    (re.compile(r"(?i)^(number|numeric|decimal|float|double|bigdecimal|amount|currency)\b"), "number"),
    (re.compile(r"(?i)^(boolean|bool|flag|y/n|yes/no)\b"), "boolean"),
)
_SIZE = re.compile(r"\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?(?:char|byte)?\s*\)", re.I)
_YES = {"y", "yes", "true", "required", "mandatory", "x", "1"}
_NO = {"n", "no", "false", "optional", "0"}


def _int(text: str) -> int | None:
    match = re.search(r"\d+", text or "")
    return int(match.group()) if match else None


def _definition(cells: dict[str, str]) -> dict:
    definition: dict = {}
    raw_type = cells.get("data_type", "").strip()
    if raw_type:
        kind = next((name for pattern, name in _TYPES if pattern.search(raw_type)), None)
        definition["data_type"] = kind or "string"
        definition["declared_type"] = raw_type
        size = _SIZE.search(raw_type)
        if size and kind == "number":
            definition["precision"] = int(size.group(1))
            if size.group(2) is not None:
                definition["scale"] = int(size.group(2))
        elif size and kind != "integer":
            definition["max_length"] = int(size.group(1))
        if kind == "integer":
            definition["data_type"], definition["scale"] = "number", 0
    for key in ("max_length", "precision", "scale"):
        value = _int(cells.get(key, ""))
        if value is not None:
            definition[key] = value
    required = cells.get("required", "").strip().lower()
    if required in _YES:
        definition["required"] = True
    elif required in _NO:
        definition["required"] = False
    lookup = cells.get("lookup", "").strip()
    if lookup:
        values = [v.strip() for v in re.split(r"[;|\n]+|,\s*", lookup) if v.strip()]
        if len(values) >= 2:
            definition["lookup_values"] = values
        else:
            definition["lookup_type"] = lookup
    if cells.get("description", "").strip():
        definition["description"] = cells["description"].strip()
    return definition


def _definitions_from_rows(rows: list[list[str]]) -> dict[str, dict] | None:
    for index, row in enumerate(rows[:_SCAN_ROWS]):
        names = [cell.strip() for cell in row]
        name_at = next((i for i, cell in enumerate(names) if _ATTRIBUTE_NAME.match(cell)), None)
        if name_at is None:
            continue
        properties = {
            key: next((i for i, cell in enumerate(names) if i != name_at and pattern.match(cell)), None)
            for key, pattern in _ATTRIBUTE_PROPERTIES.items()
        }
        if not any(position is not None for key, position in properties.items() if key != "description"):
            continue
        definitions: dict[str, dict] = {}
        for data in rows[index + 1:]:
            name = data[name_at].strip() if name_at < len(data) else ""
            if not name:
                continue
            cells = {key: (data[pos] if pos is not None and pos < len(data) else "") for key, pos in properties.items()}
            definition = _definition(cells)
            if definition:
                definitions[name.strip("*").strip()] = definition
        return definitions or None
    return None


def _all_rows(sheet, limit: int = 5000) -> list[list[str]]:
    return [_trimmed(list(row)) for row in sheet.iter_rows(max_row=limit, values_only=True)]


def template_definitions(filename: str, data: bytes, template_sheet: str | None) -> dict[str, dict]:
    """Attribute definitions printed in the template workbook itself, on a
    sheet other than the one holding the header rows."""

    if PurePath(filename).suffix.lower() not in {".xlsx", ".xlsm"}:
        return {}
    from openpyxl import load_workbook

    workbook = load_workbook(io.BytesIO(data), read_only=True, data_only=True, keep_vba=False)
    try:
        for name in workbook.sheetnames:
            if name == template_sheet:
                continue
            found = _definitions_from_rows(_all_rows(workbook[name]))
            if found:
                return found
    finally:
        workbook.close()
    return {}


def parse_attribute_definitions(filename: str, data: bytes) -> dict[str, dict]:
    """A table of attribute definitions an administrator uploaded (CSV or
    workbook): attribute name, then any of data type, length, precision,
    scale, required, lookup and description."""

    if not data:
        raise TemplateError("The file is empty.")
    if len(data) > MAX_TEMPLATE_BYTES:
        raise TemplateError("Definition files are limited to 5 MB.")
    suffix = PurePath(filename).suffix.lower()
    if suffix in {".csv", ".txt", ".tsv"}:
        text = data.decode("utf-8-sig", errors="replace")
        try:
            dialect = csv.Sniffer().sniff(text[:20000], delimiters=",;\t|")
        except csv.Error:
            dialect = csv.excel
        found = _definitions_from_rows([_trimmed(row) for row in csv.reader(io.StringIO(text), dialect)])
    elif suffix in {".xlsx", ".xlsm"}:
        from openpyxl import load_workbook

        try:
            workbook = load_workbook(io.BytesIO(data), read_only=True, data_only=True, keep_vba=False)
        except Exception as exc:  # noqa: BLE001
            raise TemplateError("The workbook could not be read.") from exc
        try:
            found = next(
                (d for name in workbook.sheetnames if (d := _definitions_from_rows(_all_rows(workbook[name])))), None
            )
        finally:
            workbook.close()
    else:
        raise TemplateError("Upload the attribute definitions as CSV, XLSX or XLSM.")
    if not found:
        raise TemplateError(
            "No attribute definitions found: the file needs a header row with an attribute name column "
            "and at least one of Data Type, Length, Precision, Scale, Required or Lookup."
        )
    return found


def apply_definitions(columns: list[dict], definitions: dict[str, dict]) -> tuple[list[dict], list[str]]:
    """Columns with their documented properties merged in, and a warning for
    each definition naming no column of the template. A definition's
    "required" fills an unknown (None) required mark only."""

    merged = [dict(column) for column in columns]
    by_name = {column["technical_name"].strip().strip("*").strip().lower(): column for column in merged}
    by_label = {(column.get("display_label") or "").strip().lower(): column for column in merged if column.get("display_label")}
    warnings: list[str] = []
    for name, definition in definitions.items():
        column = by_name.get(name.lower()) or by_label.get(name.lower())
        if column is None:
            warnings.append(f"The definitions name {name!r}, which is not an attribute of this template.")
            continue
        for key, value in definition.items():
            if key == "required":
                if column.get("required") is None:
                    column["required"] = value
                continue
            column[key] = value
    return merged, warnings
