"""Extraction completeness: what the source holds against what the
Original File layout represents, with the numbers for each.

Coverage is claimed only where it is measured. A measure is `complete`
when every source unit is represented, `gaps` when some aren't (they're
listed), and `not_measured` when the source gives nothing to count against.
Overall the document is complete only when every measure that applies is.
"""

from __future__ import annotations

import re
from typing import Any

from app.models.document import Document
from app.models.document_page import DocumentPage
from app.document_validation import business_fields, layout_fields, layout_tables
from app.source_structure.form_geometry import NOT_SELECTED, SELECTED, UNRECOGNIZED
from app.source_structure.models import StructuredSourceDocument

def _rect_key(page: int | None, rect: Any) -> tuple[int, tuple[int, ...]] | None:
    if not rect:
        return None
    return (page or 0, tuple(round(float(x)) for x in rect))


def _measure(key: str, label: str, source: int | None, represented: int | None, detail: str = "",
             missing: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    if source is None or represented is None:
        status = "not_measured"
    elif source == 0 and represented == 0:
        status = "not_applicable"
    else:
        status = "complete" if represented >= source else "gaps"
    return {"key": key, "label": label, "source": source, "represented": represented, "status": status,
            "detail": detail, "missing": (missing or [])[:25], "missing_count": len(missing or [])}


def _item_gaps(numbers: list[str]) -> list[str]:
    """Whole item numbers missing between the first and last printed."""

    whole = sorted({int(m.group()) for n in numbers if (m := re.match(r"\d+", n))})
    if len(whole) < 3:
        return []
    return [str(n) for n in range(whole[0], whole[-1] + 1) if n not in set(whole)]


def completeness_audit(
    document: Document,
    pages: list[DocumentPage],
    layout: dict[str, Any],
    structure: StructuredSourceDocument | None,
    form_boxes: list[dict[str, Any]] | None,
    business: dict[str, Any] | None = None,
) -> dict[str, Any]:
    measures: list[dict[str, Any]] = []
    review: list[dict[str, Any]] = []
    stats = layout.get("stats") or {}

    # Pages
    total_pages = document.page_count or 0
    unreadable_pages = [p.page_number for p in pages if p.requires_ocr and not p.ocr_succeeded and not (p.final_text or "").strip()]
    measures.append(_measure(
        "pages", "Pages processed", total_pages, len(pages),
        detail=f"{len(pages)} of {total_pages} pages read",
        missing=[{"page": n} for n in range(1, total_pages + 1) if n not in {p.page_number for p in pages}],
    ))
    readable = [p for p in pages if (p.final_text or "").strip()]
    measures.append(_measure(
        "readable_pages", "Pages with readable text", len(pages), len(readable),
        detail=(f"{len(unreadable_pages)} page(s) need OCR that didn't succeed" if unreadable_pages
                else f"{len(pages) - len(readable)} page(s) hold no text" if len(readable) < len(pages) else ""),
        missing=[{"page": p.page_number, "reason": "Needs OCR" if p.requires_ocr else "No text on the page"}
                 for p in pages if not (p.final_text or "").strip()],
    ))

    # Filled form fields
    fields = list(layout_fields(layout))
    form_tables = [t for t in layout_tables(layout) if t.get("form_table")]
    if form_boxes is None:
        measures.append(_measure("form_fields", "Filled form fields", None, None,
                                 detail="The source file couldn't be read for its form fields"))
    else:
        field_rects = {_rect_key(f.get("page"), f.get("value_bbox")) for f in fields if f.get("found_by") == "form widget"}
        table_boxes = {
            (page, name)
            for t in form_tables for page in (t.get("pages") or [None])[:1]
            for row in t["rows"] for name in row.get("form_boxes") or []
        }
        filled = [b for b in form_boxes if b["filled"]]
        missing = [
            {"page": b["page"], "label": b["label"], "value": b["value"]}
            for b in filled
            if _rect_key(b["page"], b["rect"]) not in field_rects and (b["page"], b["name"]) not in table_boxes
        ]
        measures.append(_measure(
            "form_fields", "Filled form fields", len(filled), len(filled) - len(missing),
            detail=f"{len(form_boxes)} form boxes in the file, {len(filled)} filled", missing=missing,
        ))
        choices = [b for b in form_boxes if b["state"] is not None]
        if choices:
            unrecognized = [b for b in choices if b["state"] == UNRECOGNIZED]
            measures.append(_measure(
                "checkboxes", "Checkbox states read", len(choices), len(choices) - len(unrecognized),
                detail=(f"{sum(1 for b in choices if b['state'] == SELECTED)} selected, "
                        f"{sum(1 for b in choices if b['state'] == NOT_SELECTED)} not selected"),
                missing=[{"page": b["page"], "label": b["label"], "value": b["value"]} for b in unrecognized],
            ))

    # Tables
    if structure is not None:
        accepted = {t.candidate_id: t for t in structure.table_candidates if t.acceptance == "accepted"}
        read = [t for t in layout_tables(layout) if not t.get("form_table")]
        # A grid read over a form's ruled cells is represented by the form's boxes.
        shown = [t for t in read if not t.get("form_duplicate")]
        represented_ids = {i for t in read for i in t.get("source_tables") or [t["id"]]}
        set_aside = stats.get("table_sources_set_aside") or 0
        merged = sum(len(t.get("source_tables") or []) - 1 for t in shown if len(t.get("source_tables") or []) > 1)
        missing_tables = [
            {"page": t.page, "headers": t.headers[:6]} for i, t in accepted.items() if i not in represented_ids
        ]
        measures.append(_measure(
            "tables", "Detected tables", len(accepted),
            len(accepted) - max(0, len(missing_tables) - set_aside),
            detail=(f"{len(shown)} shown" + (f", {merged} continued across pages and merged" if merged else "")
                    + (f", {stats.get('tables_set_aside')} set aside as paragraphs" if set_aside else "")
                    + (f", {len(read) - len(shown)} shown as form boxes" if len(read) > len(shown) else "")),
            missing=missing_tables if len(missing_tables) > set_aside else [],
        ))
        source_rows = sum(len(accepted[i].rows) for t in shown for i in t.get("source_tables") or [] if i in accepted)
        shown_rows = sum(sum(1 for r in t["rows"] if not r.get("added")) for t in shown)
        measures.append(_measure(
            "table_rows", "Table rows", source_rows, shown_rows,
            detail=f"{shown_rows} of {source_rows} detected rows shown in their tables",
        ))
    if form_tables:
        measures.append(_measure(
            "form_tables", "Form tables", len(form_tables), len(form_tables),
            detail=f"{sum(t['row_count'] for t in form_tables)} rows read from form boxes",
        ))

    # Numbered items
    numbers = [f["item"]["number"] for f in fields if (f.get("item") or {}).get("number")]
    numbers += [t["item"]["number"] for t in form_tables if (t.get("item") or {}).get("number")]
    gaps = _item_gaps(numbers)
    if numbers:
        # A number between two printed ones may be an item left blank, so
        # it's reported, not counted as a gap.
        measures.append({
            "key": "numbered_items", "label": "Numbered items", "source": None, "represented": len(set(numbers)),
            "status": "complete" if not gaps else "info",
            "detail": f"{len(set(numbers))} item numbers" + (f"; not found: {', '.join(gaps[:15])}" if gaps else ""),
            "missing": [{"item": n} for n in gaps[:25]], "missing_count": len(gaps),
        })

    # Values that need attention, from the layout's own counts.
    quality = stats.get("quality") or {}
    cell_issues = stats.get("cell_issues") or {}
    duplicates = sum(1 for f in business_fields(business)
                     if "duplicate_candidates" in {i["code"] for i in f.get("issues") or []})
    for key, count, message in (
        ("missing_extraction", quality.get("missing_extraction", 0), "Printed values extraction didn't read"),
        ("unreadable", quality.get("unreadable", 0) + cell_issues.get("unreadable", 0), "Values that couldn't be read"),
        ("conflicting", quality.get("conflicting", 0), "Values read differently by two methods"),
        ("unverified_ocr", quality.get("unverified_ocr", 0) + cell_issues.get("unverified_ocr", 0), "OCR values not yet verified"),
        ("unplaced", stats.get("unplaced") or 0, "Extracted values without a printed position"),
        ("duplicate_candidates", duplicates, "Fields read more than once: one value is used, the others are kept"),
    ):
        if count:
            review.append({"key": key, "count": count, "message": message})

    applicable = [m for m in measures if m["status"] not in ("not_applicable", "not_measured")]
    if any(m["status"] == "gaps" for m in applicable):
        status = "gaps"
    elif applicable and not any(m["status"] == "not_measured" for m in measures):
        status = "complete"
    else:
        status = "partial"
    return {
        "status": status,
        "measures": measures,
        "gaps": [m for m in measures if m["status"] == "gaps"],
        "review": review,
    }
