"""Upload and extraction validation: what a document's upload, type,
labels, extracted values, Original File layout and Excel export are worth,
said with the evidence for it.

- file_check: the stored file — type and signature, size, pages,
  integrity, password, duplicate uploads, text layer, scans, form fields,
  rotation and readable pages.
- labels: each value's printed label, its clean display label, item number
  and business meaning, from document-type aliases.
- association: values read from the wrong box (another field's label, two
  identifiers sharing one value, a value that isn't its label's type).
- completeness: what the source holds against what the layout represents.
- consistency: the Original File tab's layout against its Excel export.
- readiness: whether the source data is ready for Oracle Fusion mapping.
- service: the document's validation report, its processing stages and
  targeted revalidation.

Nothing here changes a value or deletes a record: it reports.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any


def layout_fields(layout: dict[str, Any]) -> Iterator[dict[str, Any]]:
    """Every field of an Original File layout, placed or not."""

    for section in layout.get("sections") or []:
        yield from (item for item in section["items"] if item["kind"] == "field")
    yield from layout.get("unplaced") or []


def layout_tables(layout: dict[str, Any]) -> Iterator[dict[str, Any]]:
    for section in layout.get("sections") or []:
        yield from (item for item in section["items"] if item["kind"] == "table")


def business_fields(business: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Every skill field of a business-data result."""

    return [f for s in (business or {}).get("sections") or [] for f in s.get("fields") or []]
