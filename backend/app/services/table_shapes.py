"""One shape for the tables stored on a page.

PDF table detection stores {"headers": [...], "rows": [...]}; native
spreadsheet, CSV, ODS and Word ingest store the table as a plain list of
rows. Code that reads tables goes through `page_tables` so both work —
the stored data itself is unchanged.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any


def as_table(table: Any) -> dict[str, Any] | None:
    """{"headers", "rows", ...} for either stored shape; None otherwise.

    A list-of-rows table's first row is its header row."""

    if isinstance(table, dict):
        return table
    if isinstance(table, (list, tuple)) and table and all(isinstance(row, (list, tuple)) for row in table):
        rows = [list(row) for row in table]
        return {"headers": rows[0], "rows": rows[1:]}
    return None


def page_tables(tables_json: Any) -> Iterator[dict[str, Any]]:
    for table in tables_json or []:
        shaped = as_table(table)
        if shaped is not None:
            yield shaped
