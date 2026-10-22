"""Build the public sample contract shown at /sample on the marketing site.

Generates a fictional SF 1449-style contract PDF, runs the same
deterministic line-level pipeline the regression reports use (form-cell
association, structural routing, clause citations, CLIN rows), and writes:

  frontend/public/sample/sample-contract.pdf
  frontend/public/sample/page-<n>.png        (rendered at RENDER_ZOOM)
  frontend/lib/sample/sample-extraction.json  (bundled, so /sample never waits on the API)

Values, confidence scores, and boxes in the JSON are pipeline output, not
hand-written. Review routing applies the same rules as
app.services.review_routing (band thresholds from confidence_engine). Every
name and number in the PDF is fictional.

Usage: python backend/scripts/build_public_sample.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))

import fitz  # noqa: E402

from app.api.page_extraction import RENDER_ZOOM, locate_highlight  # noqa: E402
from app.services.candidate_router import (  # noqa: E402
    deduplicate_clin_funding_overlap,
    route_clause_citations,
    route_clin_rows,
    route_form_cell_associations,
    route_page_regions,
)
from app.services.clause_citation_scanner import scan_pages_for_clause_citations  # noqa: E402
from app.services.clin_block_detector import parse_clin_rows  # noqa: E402
from app.services.confidence_engine import confidence_band  # noqa: E402
from app.services.contract_summary_fields import match_label  # noqa: E402
from app.services.form_cell_associator import associate_form_cells  # noqa: E402
from app.services.generic_table_extractor import extract_page_tables  # noqa: E402
from app.services.line_model import lines_from_fitz_page  # noqa: E402
from app.services.structure_classifier import (  # noqa: E402
    build_document_context,
    classify_page_regions,
)

OUT_DIR = BACKEND_ROOT.parent / "frontend" / "public" / "sample"
JSON_PATH = BACKEND_ROOT.parent / "frontend" / "lib" / "sample" / "sample-extraction.json"
PDF_NAME = "sample-contract.pdf"

PAGE_W, PAGE_H = 612, 792
MARGIN = 36
FONT = "helv"
BOLD = "hebo"


# --------------------------------------------------------------------------
# PDF generation
# --------------------------------------------------------------------------


def _cell(page, x0, y0, x1, y1, label, value=None, value_size=9.5):
    page.draw_rect(fitz.Rect(x0, y0, x1, y1), color=(0, 0, 0), width=0.6)
    page.insert_text((x0 + 3, y0 + 9), label, fontname=FONT, fontsize=6.5)
    if value:
        for i, line in enumerate(value.split("\n")):
            page.insert_text(
                (x0 + 5, y0 + 22 + i * 11), line, fontname=BOLD, fontsize=value_size
            )


def _specimen_banner(page):
    page.insert_text(
        (MARGIN, 24),
        "SPECIMEN - FICTIONAL DATA FOR DEMONSTRATION ONLY - NOT A REAL CONTRACT",
        fontname=BOLD,
        fontsize=7.5,
        color=(0.75, 0.1, 0.1),
    )


def build_pdf(path: Path) -> None:
    doc = fitz.open()
    right = PAGE_W - MARGIN
    mid = PAGE_W / 2

    # ---- Page 1: SF 1449-style award face ----
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    _specimen_banner(page)
    page.insert_text(
        (MARGIN, 44),
        "SOLICITATION/CONTRACT/ORDER FOR COMMERCIAL PRODUCTS AND COMMERCIAL SERVICES",
        fontname=BOLD,
        fontsize=9,
    )
    page.insert_text((right - 60, 44), "PAGE 1 OF 2", fontname=FONT, fontsize=7)

    y = 52
    h = 34
    _cell(page, MARGIN, y, mid, y + h, "1. REQUISITION NUMBER", "0011734552-0001")
    _cell(page, mid, y, right, y + h, "2. CONTRACT NUMBER", "W91ZZZ26C0042")
    y += h
    _cell(page, MARGIN, y, mid, y + h, "3. AWARD/EFFECTIVE DATE", "08/19/2026")
    _cell(page, mid, y, right, y + h, "4. ORDER NUMBER", "N/A")
    y += h
    _cell(page, MARGIN, y, mid, y + h, "5. SOLICITATION NUMBER", "W91ZZZ26R0007")
    _cell(page, mid, y, right, y + h, "6. SOLICITATION ISSUE DATE", "05/04/2026")
    y += h
    _cell(page, MARGIN, y, mid, y + h, "7a. FOR SOLICITATION INFORMATION CALL: NAME", "Jordan Avery")
    _cell(page, mid, y, right, y + h, "7b. TELEPHONE NUMBER", "(555) 010-4417")
    y += h
    _cell(
        page, MARGIN, y, mid, y + 46, "9. ISSUED BY",
        "Sample Contracting Activity\n100 Example Way, Suite 4",
    )
    _cell(
        page, mid, y, right, y + 46, "16. ADMINISTERED BY",
        "Sample Contract Management Office\nRoom 210, Building 7",
    )
    y += 46
    _cell(
        page, MARGIN, y, mid, y + 46, "17a. CONTRACTOR/OFFEROR",
        "Northwind Analytics LLC\n4400 Fictional Pkwy, Arlington VA",
    )
    _cell(page, mid, y, right, y + 46, "UNIQUE ENTITY ID (UEI)", "QX7LMN4TZ8K1")
    y += 46
    _cell(page, MARGIN, y, right, y + h, "PERIOD OF PERFORMANCE", "09/01/2026 - 08/31/2027")
    y += h

    # Schedule of supplies/services (CLIN table)
    y += 10
    cols = [MARGIN, MARGIN + 50, MARGIN + 290, MARGIN + 335, MARGIN + 380, MARGIN + 455, right]
    heads = ["19. ITEM NO.", "20. SCHEDULE OF SUPPLIES/SERVICES", "21. QUANTITY",
             "22. UNIT", "23. UNIT PRICE", "24. AMOUNT"]
    for i, head in enumerate(heads):
        page.draw_rect(fitz.Rect(cols[i], y, cols[i + 1], y + 16), color=(0, 0, 0), width=0.6)
        page.insert_text((cols[i] + 2, y + 11), head, fontname=BOLD, fontsize=6)
    y += 16
    rows = [
        ["0001", "Contract data extraction services, base year", "12", "MO", "$78,500.00", "$942,000.00"],
        ["0002", "Clause compliance review support", "1", "LO", "$188,000.00", "$188,000.00"],
        ["0003", "Travel, cost reimbursable (NTE)", "1", "LO", "$120,000.00", "$120,000.00"],
    ]
    for row in rows:
        for i, text in enumerate(row):
            page.draw_rect(fitz.Rect(cols[i], y, cols[i + 1], y + 18), color=(0, 0, 0), width=0.4)
            page.insert_text((cols[i] + 3, y + 12), text, fontname=FONT, fontsize=7.5)
        y += 18

    y += 8
    _cell(page, MARGIN, y, mid, y + h, "25. ACCOUNTING AND APPROPRIATION DATA",
          "AA: 097 X 0100.0000 DISB")
    _cell(page, mid, y, right, y + h, "26. TOTAL AWARD AMOUNT (For Govt. Use Only)",
          "$1,250,000.00")
    y += h
    _cell(page, MARGIN, y, mid, y + 40, "31a. UNITED STATES OF AMERICA (SIGNATURE OF CONTRACTING OFFICER)",
          "/s/ Jordan Avery")
    _cell(page, mid, y, right, y + 40, "31c. DATE SIGNED", "08/19/2026")

    # ---- Page 2: accounting + clauses ----
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    _specimen_banner(page)
    page.insert_text((MARGIN, 44), "SECTION G - CONTRACT ADMINISTRATION DATA",
                     fontname=BOLD, fontsize=9)
    page.insert_text((right - 60, 44), "PAGE 2 OF 2", fontname=FONT, fontsize=7)
    y = 64
    lines = [
        "ACCOUNTING AND APPROPRIATION DATA",
        "AA: 097 X 0100.0000 DISB  ACRN AA  CLIN 0001, 0002  $1,130,000.00",
        "AB: 097 2026 0100.0000 DISB  ACRN AB  CLIN 0003  $120,000.00",
        "Treasury Account Symbol (TAS): 097-0100   Business Event Type Code (BETC): DISB",
        "",
        "Payment will be made by electronic funds transfer through the Wide Area",
        "WorkFlow (WAWF) system. Invoices shall be submitted monthly in arrears.",
    ]
    for line in lines:
        page.insert_text((MARGIN, y), line, fontname=FONT, fontsize=8.5)
        y += 13

    y += 14
    page.insert_text((MARGIN, y), "SECTION I - CONTRACT CLAUSES", fontname=BOLD, fontsize=9)
    y += 16
    page.insert_text((MARGIN, y), "CLAUSES INCORPORATED BY REFERENCE", fontname=BOLD, fontsize=8)
    y += 14
    clauses = [
        ("52.204-21", "Basic Safeguarding of Covered Contractor Information Systems", "NOV 2021"),
        ("52.212-4", "Contract Terms and Conditions - Commercial Products and Commercial Services", "NOV 2023"),
        ("52.232-33", "Payment by Electronic Funds Transfer - System for Award Management", "OCT 2018"),
        ("252.204-7012", "Safeguarding Covered Defense Information and Cyber Incident Reporting", "MAY 2024"),
        ("252.232-7003", "Electronic Submission of Payment Requests and Receiving Reports", "DEC 2018"),
    ]
    for number, title, date in clauses:
        page.insert_text((MARGIN, y), f"{number}  {title}  {date}", fontname=FONT, fontsize=8)
        y += 13

    doc.save(str(path), garbage=4, deflate=True)
    doc.close()


# --------------------------------------------------------------------------
# Pipeline (mirrors scripts/step2_regression_report.py)
# --------------------------------------------------------------------------


def run_pipeline(path: Path):
    doc = fitz.open(str(path))
    lines_by_page, tables_by_page, heights, context = {}, {}, {}, []
    for index in range(doc.page_count):
        page = doc[index]
        number = index + 1
        lines = lines_from_fitz_page(page=page, page_number=number)
        lines_by_page[number] = lines
        heights[number] = float(page.rect.height)
        context.append((number, lines, float(page.rect.height)))
        try:
            tables_by_page[number] = extract_page_tables(str(path), number)
        except Exception:
            tables_by_page[number] = []

    doc_context = build_document_context(pages=context)
    regions, text_by_page = {}, {}
    for number in lines_by_page:
        regions[number] = classify_page_regions(
            page_number=number,
            blocks=lines_by_page[number],
            tables=tables_by_page[number],
            page_height=heights[number],
            doc_context=doc_context,
        )
        text_by_page[number] = "\n".join(line.text for line in lines_by_page[number])

    pseudo_pages = [
        SimpleNamespace(page_number=n, final_text=text_by_page[n], tables_json=tables_by_page[n])
        for n in lines_by_page
    ]
    citations = scan_pages_for_clause_citations(pages=pseudo_pages, regions_by_page=regions)
    clin_rows = []
    for page in pseudo_pages:
        clin_rows.extend(parse_clin_rows(page=page))

    candidates = []
    for number in lines_by_page:
        candidates.extend(route_form_cell_associations(associate_form_cells(lines=lines_by_page[number])))
        candidates.extend(
            route_page_regions(
                [r for r in regions[number] if r.region_type not in ("FORM_FIELD_LABEL", "FORM_FIELD_VALUE")]
            )
        )
    candidates.extend(route_clause_citations(citations))
    candidates.extend(route_clin_rows(clin_rows))
    doc.close()
    return deduplicate_clin_funding_overlap(candidates)


# --------------------------------------------------------------------------
# Output
# --------------------------------------------------------------------------

FIELD_CATEGORIES = {"GENERAL_ACCEPTED_FIELD", "CONTRACT_SUMMARY", "QA_REVIEW"}
CLAUSE_CATEGORIES = {"FAR_REFERENCE", "DFARS", "CLAUSE"}
# Fragments of the CLIN table that form-cell association picks up as
# key/value pairs; the panel shows summary fields and clauses only.
SKIPPED_LABELS = {"ITEM NO.", "QUANTITY 22. UNIT", "UNIT PRICE", "AMOUNT"}

# Same labels as app.services.review_routing.human_reason_labels.
REASON_LABELS = {
    "ambiguous_multiple_validated_candidates": "Ambiguous candidates",
    "no_semantically_valid_value": "Validation failed",
}


def _routing(candidate) -> tuple[str, list[str]]:
    """Mirror review_routing.decide_review_for_scalar for a candidate."""
    reasons = [REASON_LABELS[r] for r in candidate.reason_codes if r in REASON_LABELS]
    if confidence_band(candidate.confidence) == "low" and "Low confidence" not in reasons:
        reasons.insert(0, "Low confidence")
    return ("needs_review" if reasons else "ready_to_accept"), reasons


def _alternates(candidate) -> list[str]:
    for reason in candidate.reason_codes:
        if reason.startswith("alternates:"):
            return [part.strip().strip("'") for part in reason[len("alternates:"):].split("',")]
    return []


def _box(rect) -> dict[str, float] | None:
    if rect is None:
        return None
    return {k: round(float(v), 2) for k, v in zip(("x0", "y0", "x1", "y1"), rect)}


def build_output(pdf_path: Path) -> dict:
    candidates = run_pipeline(pdf_path)
    doc = fitz.open(str(pdf_path))
    pages = []
    for index in range(doc.page_count):
        page = doc[index]
        image = f"page-{index + 1}.png"
        page.get_pixmap(matrix=fitz.Matrix(RENDER_ZOOM, RENDER_ZOOM)).save(str(OUT_DIR / image))
        pages.append({
            "page_number": index + 1,
            "image": f"/sample/{image}",
            "width": float(page.rect.width),
            "height": float(page.rect.height),
        })

    fields = []
    for c in candidates:
        is_clause = c.category in CLAUSE_CATEGORIES
        if not (is_clause or c.category in FIELD_CATEGORIES) or c.label in SKIPPED_LABELS:
            continue
        page = doc[c.source_page - 1]
        if is_clause:
            rect = locate_highlight(page, highlight=c.clause_number, anchor=None, region=None)
        elif c.value:
            rect = locate_highlight(page, highlight=c.value, anchor=c.label, region=None)
        else:
            # No single value (ambiguous or rejected): box the whole form
            # cell so the reviewer sees every competing candidate.
            rect = fitz.Rect(c.bbox) if c.bbox else None
            if rect is not None:
                cells = [
                    d["rect"] for d in page.get_drawings()
                    if d["rect"].contains(rect) and d["rect"].width < page.rect.width - 2 * MARGIN + 1
                ]
                if cells:
                    rect = min(cells, key=lambda r: r.get_area())
        decision, reasons = _routing(c)
        fields.append({
            "id": f"f{len(fields) + 1}",
            "kind": "clause" if is_clause else "field",
            "label": f"{c.regulation or 'FAR'} {c.clause_number}" if is_clause else c.label,
            "value": c.value,
            "alternates": _alternates(c),
            "confidence": round(c.confidence, 2),
            "band": confidence_band(c.confidence),
            "page": c.source_page,
            "bbox": _box(rect),
            "decision": decision,
            "reasons": reasons,
        })
    doc.close()
    return {
        "document": {"name": PDF_NAME, "pdf": f"/sample/{PDF_NAME}", "pages": pages},
        "generated_by": "backend/scripts/build_public_sample.py",
        "fields": fields,
    }


if __name__ == "__main__":
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    pdf_path = OUT_DIR / PDF_NAME
    build_pdf(pdf_path)
    output = build_output(pdf_path)
    JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
    JSON_PATH.write_text(
        json.dumps(output, indent=2) + "\n", encoding="utf-8"
    )
    for f in output["fields"]:
        print(f"{f['decision']:16} {f['band']:6} {f['confidence']:.2f} p{f['page']} "
              f"{'box' if f['bbox'] else 'NOBOX'} {f['label']!r} = {f['value']!r} {f['reasons']} {f['alternates']}")
