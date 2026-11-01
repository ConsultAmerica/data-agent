"""The Original File tab against its Excel export.

The tab renders the layout; the export writes original_rows(layout) to one
`Original File` sheet. This builds the workbook, reads it back and checks
it against what the layout says the tab shows: section order, item
numbers, field names and values, blank values, table titles, columns, row
counts and cells, parent metadata written once, one sheet, no merged cells.
"""

from __future__ import annotations

import io
from typing import Any

from openpyxl import load_workbook

from app.source_structure.original_export import (
    Row,
    _text,
    build_original_structure_xlsx,
    field_value,
    original_rows,
)

_EXAMPLES = 5


def _visible_sections(layout: dict[str, Any]) -> list[dict[str, Any]]:
    sections = list(layout.get("sections") or [])
    if layout.get("unplaced"):
        sections.append({"title": "Extracted fields without a printed position", "level": 1, "items": layout["unplaced"]})
    return [
        {**s, "items": [i for i in s["items"] if not i.get("form_duplicate")]}
        for s in sections
        if any(not i.get("form_duplicate") for i in s["items"])
    ]


def _expected(layout: dict[str, Any]) -> dict[str, list[Any]]:
    """What the tab shows, read from the layout itself."""

    sections, fields, numbers, tables = [], [], [], []
    for section in _visible_sections(layout):
        if section.get("title"):
            sections.append(section["title"])
        previous = None
        for item in section["items"]:
            if item["kind"] == "field":
                parent = item.get("item")
                value = "" if item.get("parts") else field_value(item)
                fields.append((item.get("field_name") or item["label"], value))
                if parent is not None and parent["id"] != previous and parent.get("number"):
                    numbers.append(parent["number"])
                previous = parent["id"] if parent is not None else None
                continue
            previous = None
            shared = {entry["column"] for entry in item.get("shared_columns") or []}
            width = len(item["headers"])
            kept = [c for c in range(width) if c not in shared]
            tables.append({
                "title": item.get("title"),
                "headers": [item["headers"][c] for c in kept],
                "rows": [
                    [((list(r.get("reviewed_cells") or r["cells"]) + [""] * width)[:width])[c] for c in kept]
                    for r in item["rows"]
                ],
                "number": (item.get("item") or {}).get("number"),
            })
            if (item.get("item") or {}).get("number"):
                numbers.append(item["item"]["number"])
    return {"sections": sections, "fields": fields, "numbers": numbers, "tables": tables}


def _exported(rows: list[Row]) -> dict[str, list[Any]]:
    sections, fields, numbers, tables, contexts = [], [], [], [], []
    current: dict[str, Any] | None = None
    for row in rows:
        values = [("" if v is None else str(v)) for v in row.values]
        if row.kind in ("section", "subsection"):
            sections.append(values[0])
        elif row.kind in ("field", "subfield"):
            fields.append((values[1], values[2]))
            if row.kind == "field" and values[0]:
                numbers.append(values[0])
        elif row.kind == "item":
            numbers.append(values[0])
        elif row.kind == "table_title":
            current = {"headers": [], "rows": [], "contexts": 0}
            tables.append(current)
            if len(values) == 3:  # a form's numbered table
                numbers.append(values[0])
        elif row.kind == "context" and current is not None:
            current["contexts"] += 1
            contexts.append(values[0])
        elif row.kind == "table_header" and current is not None:
            current["headers"] = values
        elif row.kind == "table_row" and current is not None:
            current["rows"].append(values)
    return {"sections": sections, "fields": fields, "numbers": numbers, "tables": tables, "contexts": contexts}


def _check(key: str, label: str, ok: bool, expected: Any = None, found: Any = None,
           examples: list[Any] | None = None) -> dict[str, Any]:
    return {"key": key, "label": label, "status": "consistent" if ok else "inconsistent",
            "expected": expected, "found": found, "examples": (examples or [])[:_EXAMPLES]}


def _differences(expected: list[Any], found: list[Any]) -> list[dict[str, Any]]:
    out = []
    for index in range(max(len(expected), len(found))):
        a = expected[index] if index < len(expected) else None
        b = found[index] if index < len(found) else None
        if a != b:
            out.append({"position": index + 1, "tab": a, "excel": b})
            if len(out) >= _EXAMPLES:
                break
    return out


def tab_export_consistency(layout: dict[str, Any], rows: list[Row] | None = None,
                           workbook: bytes | None = None) -> dict[str, Any]:
    """`rows` / `workbook`: the export to check (built from the layout when
    not given)."""

    rows = original_rows(layout) if rows is None else rows
    expected = _expected(layout)
    exported = _exported(rows)
    checks = [
        _check("sections", "Section order", expected["sections"] == exported["sections"],
               len(expected["sections"]), len(exported["sections"]),
               _differences(expected["sections"], exported["sections"])),
        _check("item_numbers", "Item number sequence", expected["numbers"] == exported["numbers"],
               len(expected["numbers"]), len(exported["numbers"]),
               _differences(expected["numbers"], exported["numbers"])),
        _check("field_labels", "Field labels", [f[0] for f in expected["fields"]] == [f[0] for f in exported["fields"]],
               len(expected["fields"]), len(exported["fields"]),
               _differences([f[0] for f in expected["fields"]], [f[0] for f in exported["fields"]])),
        _check("field_values", "Extracted values", [f[1] for f in expected["fields"]] == [f[1] for f in exported["fields"]],
               len(expected["fields"]), len(exported["fields"]),
               _differences(expected["fields"], exported["fields"])),
        _check("blank_values", "Blank source values",
               sum(1 for f in expected["fields"] if not f[1]) == sum(1 for f in exported["fields"] if not f[1]),
               sum(1 for f in expected["fields"] if not f[1]), sum(1 for f in exported["fields"] if not f[1])),
    ]
    table_issues = []
    if len(expected["tables"]) != len(exported["tables"]):
        table_issues.append({"tab": len(expected["tables"]), "excel": len(exported["tables"]), "what": "tables"})
    for index, (want, got) in enumerate(zip(expected["tables"], exported["tables"]), start=1):
        name = want["title"] or f"Table {index}"
        if want["headers"] != got["headers"]:
            table_issues.append({"table": name, "what": "columns", "tab": want["headers"], "excel": got["headers"]})
        if len(want["rows"]) != len(got["rows"]):
            table_issues.append({"table": name, "what": "row count", "tab": len(want["rows"]), "excel": len(got["rows"])})
        elif want["rows"] != got["rows"]:
            row = next(i for i, (a, b) in enumerate(zip(want["rows"], got["rows"])) if a != b)
            table_issues.append({"table": name, "what": f"row {row + 1}", "tab": want["rows"][row], "excel": got["rows"][row]})
        if got["contexts"] > 1:
            table_issues.append({"table": name, "what": "parent metadata repeated", "tab": 1, "excel": got["contexts"]})
    checks.append(_check(
        "tables", "Table titles, columns, rows and cells", not table_issues,
        len(expected["tables"]), len(exported["tables"]), table_issues,
    ))

    # The file itself: one sheet, nothing merged, every row written as built.
    data = workbook if workbook is not None else build_original_structure_xlsx(layout)
    book = load_workbook(io.BytesIO(data))
    sheet = book.worksheets[0]
    checks.append(_check("sheet", "One worksheet named Original File", book.sheetnames == ["Original File"],
                         ["Original File"], book.sheetnames))
    merged = [str(r) for r in sheet.merged_cells.ranges]
    checks.append(_check("merged_cells", "No merged cells", not merged, 0, len(merged), merged))
    written = []
    for number, row in enumerate(rows, start=1):
        for column, value in enumerate(row.values, start=1):
            want = _text(value)
            got = sheet.cell(row=number, column=column).value
            if (want or None) != (got or None):
                written.append({"row": number, "column": column, "built": want, "excel": got})
                if len(written) >= _EXAMPLES:
                    break
        if len(written) >= _EXAMPLES:
            break
    extra = sheet.max_row - len(rows) if rows else 0
    checks.append(_check(
        "workbook_rows", "Rows written to the workbook", not written and extra <= 0,
        len(rows), sheet.max_row, written,
    ))
    return {
        "status": "consistent" if all(c["status"] == "consistent" for c in checks) else "inconsistent",
        "checks": checks,
        "rows": len(rows),
    }
