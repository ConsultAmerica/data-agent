"""Universal structure-aware source extraction (app/source_structure/):
schema-neutral label/value, table and region recovery from PDF (native and
OCR) and HTML, with provenance — no business vocabulary."""

import io
from pathlib import Path
from uuid import uuid4

import fitz
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.database.session import SessionLocal
from app.main import app
from app.models.document import Document
from app.models.document_page import DocumentPage
from app.models.document_staging_workbook import DocumentStagingWorkbook
from app.services.v3_orchestrator import run_and_persist_v3_extraction
from app.source_structure.html_structure import extract_html_structure, readable_dom_text
from app.source_structure.ocr_geometry import OcrCoordinateSpace, coordinate_space_for
from app.source_structure.pdf_structure import (
    Word,
    build_lines,
    extract_page_structure,
    native_words,
    ocr_skew_slope,
)
from app.source_structure.text_shapes import infer_value_type, label_rejection
from app.staging.resolver import resolve_and_persist_profile

client = TestClient(app)
FIXTURES = Path(__file__).parent / "fixtures" / "html"


# --- label shape and value types ----------------------------------------------


@pytest.mark.parametrize(
    "label",
    ["Invoice Number", "Invoice Date", "Account Number", "Customer ID", "Ship To",
     "Payment Terms", "Total Due", "Tax ID:", "PO #", "Sales Tax (10.2%)", "• DNA"],
)
def test_noun_phrase_labels_are_accepted(label):
    assert label_rejection(label) is None


@pytest.mark.parametrize(
    "label",
    ["Contractor shall email", "Please remit payment within",
     "For additional information contact", "The supplier agrees that",
     "Questions about this invoice", "of the Government, for example"],
)
def test_clause_shaped_labels_are_rejected(label):
    assert label_rejection(label) is not None


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("INV-2025-0417", "identifier"),
        ("03/14/2025", "date"),
        ("2026-08-31", "date"),
        ("09/18/2026 10:30 AM", "datetime"),
        ("$1,240.55", "currency"),
        ("12,114.05", "currency"),
        ("10.2%", "percentage"),
        ("16", "number"),
        ("billing@example.com", "email"),
        ("(253) 555-0142", "phone"),
        ("Yes", "boolean"),
        ("PO Box 4410\nOakland, CA 94607", "address"),
        ("Net 30", "text"),
    ],
)
def test_value_type_hints(value, expected):
    assert infer_value_type(value) == expected


# --- OCR coordinates ------------------------------------------------------------


def test_ocr_pixels_scale_to_pdf_points():
    space = OcrCoordinateSpace(dpi=144, image_width=1224, image_height=1584)
    assert space.to_pdf_points((144, 288, 288, 432)) == pytest.approx((72, 144, 144, 216))


def test_ocr_deskew_is_undone_about_the_image_centre():
    space = OcrCoordinateSpace(dpi=72, image_width=200, image_height=200, deskew_degrees=90)
    # A point right of centre, after a 90° CCW rotation (y down), sits above
    # it; undoing it maps back to the right.
    x0, y0, x1, y1 = space.to_pdf_points((100, 50, 100, 50))
    assert (round(x0), round(y0)) == (150, 100)


def test_legacy_layouts_infer_their_dpi():
    space = coordinate_space_for(
        {"words": [], "preprocess": ["deskew_+1.5"]},
        page_width_pt=612, page_height_pt=792, ocr_dpi=300,
    )
    assert space.dpi == 220  # capped layout DPI used by the OCR layer
    assert space.deskew_degrees == 1.5


# --- PDF structure ------------------------------------------------------------


def _pdf_page(draw) -> fitz.Page:
    doc = fitz.open()
    page = doc.new_page(width=612, height=792)
    draw(page)
    return fitz.open("pdf", doc.tobytes())[0]


def _structure(page):
    return extract_page_structure(
        page_number=1, words=native_words(page), extraction_method="native", fitz_page=page
    )


def _statement(page):
    def t(x, y, s, bold=False):
        page.insert_text((x, y), s, fontsize=10, fontname="hebo" if bold else "helv")

    t(40, 60, "Harbor Utilities Cooperative", bold=True)
    t(360, 90, "Account Number:", bold=True)
    t(460, 90, "ACCT-558210")
    t(360, 104, "Statement Date:", bold=True)
    t(460, 104, "08/31/2026")
    t(40, 120, "Service Address:", bold=True)
    t(40, 134, "77 Birch Lane")
    t(40, 148, "Tacoma, WA 98402")
    t(40, 200, "Meter Reading: 55120")
    cols = [40, 110, 330, 420, 510]
    for x, h in zip(cols, ["Date", "Charge", "Usage", "Rate", "Amount"]):
        t(x, 240, h, bold=True)
    rows = [
        ("08/01/2026", "Water service base fee", "1", "12.00", "12.00"),
        ("08/01/2026", "Metered consumption", "4200", "0.01", "42.00"),
        ("08/15/2026", "Stormwater surcharge", "1", "6.50", "6.50"),
    ]
    for i, row in enumerate(rows):
        for x, v in zip(cols, row):
            t(x, 258 + 18 * i, v)
    t(420, 330, "Balance Due:", bold=True)
    t(510, 330, "60.50")


def test_pdf_label_value_and_table_recovered_without_vocabulary():
    result = _structure(_pdf_page(_statement))
    fields = {f.label_text: f for f in result.fields if f.acceptance == "accepted"}

    assert fields["Account Number"].raw_value == "ACCT-558210"
    assert fields["Account Number"].structural_relation == "left_right_separator"
    assert fields["Statement Date"].value_type_hint == "date"
    assert fields["Service Address"].structural_relation == "label_above_value"
    assert fields["Service Address"].raw_value == "77 Birch Lane\nTacoma, WA 98402"
    assert fields["Meter Reading"].structural_relation == "same_line_separator"
    assert fields["Balance Due"].value_type_hint == "currency"
    # Every value carries its own geometry.
    assert all(f.value_bbox for f in fields.values())

    tables = [t for t in result.tables if t.acceptance == "accepted"]
    assert len(tables) == 1
    table = tables[0]
    assert table.headers == ["Date", "Charge", "Usage", "Rate", "Amount"]
    assert len(table.rows) == 3
    assert all(cell.bbox for row in table.rows for cell in row if cell.text)
    assert "repeating_records" in table.table_hints
    assert "numeric_amount_column" in table.column_hints[4]
    assert "date_column" in table.column_hints[0]


def test_two_column_prose_is_not_a_table():
    left = [
        "The committee reviewed the annual plan and",
        "agreed that maintenance priorities should",
        "focus on the oldest facilities first, with",
        "attention to safety and accessibility work.",
    ]
    right = [
        "Budget discussions continued into the",
        "afternoon session where members asked",
        "for clearer reporting on deferred repairs",
        "and on the status of pending contracts.",
    ]

    def draw(page):
        for i, (a, b) in enumerate(zip(left, right)):
            page.insert_text((40, 100 + 14 * i), a, fontsize=10)
            page.insert_text((320, 100 + 14 * i), b, fontsize=10)

    result = _structure(_pdf_page(draw))
    assert not [t for t in result.tables if t.acceptance == "accepted"]
    assert not [f for f in result.fields if f.acceptance == "accepted"]
    assert any(r.region_type in ("PARAGRAPH", "NARRATIVE") for r in result.regions)


def test_sentence_with_colon_is_not_a_field():
    def draw(page):
        page.insert_text((40, 100), "Please remit payment within: thirty days of receipt", fontsize=10)
        page.insert_text((40, 120), "The supplier agrees that: all goods are new", fontsize=10)

    result = _structure(_pdf_page(draw))
    assert not [f for f in result.fields if f.acceptance == "accepted"]


# --- label/value and table edge cases found by the invoice fixtures -------------


@pytest.mark.parametrize("label", ["Invoice No.", "Invoice No.:", "Ref. No.", "Acct. Number"])
def test_abbreviation_period_is_not_sentence_punctuation(label):
    assert label_rejection(label) is None


@pytest.mark.parametrize("label", ["Thanks.", "Payment due."])
def test_sentence_periods_still_reject(label):
    assert label_rejection(label) is not None


def test_one_run_with_two_pairs_yields_two_fields():
    def draw(page):
        page.insert_text((72, 72), "Invoice Number: INV-1001 Invoice Date: 03/14/2025", fontsize=10)
        page.insert_text((72, 90), "Note: meeting at 10:30 today", fontsize=10)

    page = _pdf_page(draw)
    structure = extract_page_structure(page_number=1, words=native_words(page), extraction_method="native", fitz_page=page)
    assert [(f.label_text, f.raw_value) for f in structure.fields] == [
        ("Invoice Number", "INV-1001"),
        ("Invoice Date", "03/14/2025"),
        ("Note", "meeting at 10:30 today"),
    ]


def test_fused_header_columns_split_at_the_data_gutter():
    def draw(page):
        for x, text in ((72, "Item"), (200, "UOM"), (226, "Unit Price"), (320, "Amount")):
            page.insert_text((x, 100), text, fontsize=9)
        for i, (item, uom, price, amount) in enumerate(
            [("Bolt", "EA", "0.42", "84.00"), ("Washer", "BX", "12.09", "18.00"), ("Seal", "PR", "5.40", "43.20")]
        ):
            y = 118 + 16 * i
            page.insert_text((72, y), item, fontsize=9)
            page.insert_text((200, y), uom, fontsize=9)
            page.insert_text((250, y), price, fontsize=9)
            page.insert_text((320, y), amount, fontsize=9)

    page = _pdf_page(draw)
    structure = extract_page_structure(page_number=1, words=native_words(page), extraction_method="native", fitz_page=page)
    (table,) = structure.tables
    assert table.headers == ["Item", "UOM", "Unit Price", "Amount"]
    assert [c.text for c in table.rows[0]] == ["Bolt", "EA", "0.42", "84.00"]


def test_skewed_ocr_rows_group_on_deskewed_lines():
    # A 0.7° tilt: across ~500pt, the right end sits ~6pt higher.
    slope = -0.0122
    layout = {
        "lines": [
            {"words": [{"text": t, "x0": x, "x1": x + 40, "y0": y + slope * x, "y1": y + 10 + slope * x} for t, x in
                       (("a", 40), ("b", 200), ("c", 360), ("d", 520))]}
            for y in (100, 140, 180)
        ]
    }
    assert abs(ocr_skew_slope(layout) - slope) < 0.001
    words = [
        Word("3", 43, 292, 48, 300, 8), Word("Bilge", 83, 291, 120, 300, 8),
        Word("3.0", 412, 288, 425, 295, 8), Word("285.00", 538, 286, 566, 293, 8),
    ]
    # With the measured tilt compensated, the row is one line.
    for w in words:
        w.row_offset = slope * ((w.x0 + w.x1) / 2 - 300)
    assert len(build_lines(words)) == 1


def test_an_oversized_title_does_not_glue_neighbouring_lines():
    # A 24pt "INVOICE" level with an 11pt letterhead name and the 7.5pt
    # address line under it: name and address stay separate lines.
    words = [
        Word("Northstar", 42, 40, 95, 52.5, 11), Word("Office", 98, 40, 128, 52.5, 11),
        Word("INVOICE", 471, 40, 570, 67, 24),
        Word("4800", 42, 55.5, 60, 63.5, 7.5), Word("Market", 62, 55.5, 88, 63.5, 7.5),
    ]
    texts = [" ".join(w.text for w in line.words) for line in build_lines(words)]
    assert any(t.startswith("Northstar Office") for t in texts)
    assert not any("Northstar" in t and "4800" in t for t in texts)


def test_html_letterhead_heading_is_not_a_label():
    x = extract_html_structure(
        b"<html><body><header><h1>Northstar Software Ltd</h1>"
        b"<address>14 Quayside<br>billing@northstar.example</address></header>"
        b"<main><section><h3>Billed To</h3><address>Tyneside Trust</address></section>"
        b"<p>Payment is due within 30 days.</p></main></body></html>"
    )
    assert not x.fields
    kinds = {(r.region_type, r.text.split(chr(10))[0]) for r in x.regions}
    assert ("HEADING", "Northstar Software Ltd") in kinds
    assert ("CONTACT_BLOCK", "14 Quayside") in kinds
    note = next(r for r in x.regions if r.text.startswith("Payment"))
    # A heading governs only its own section; the note after </section>
    # is not under "Billed To".
    assert "Billed To" not in note.source_locator.section_path


def test_html_fill_in_table_reads_its_label_row_as_the_header():
    # FAR clause forms: a title row, the column labels in <td>s, then
    # underscore lines to write on.
    x = extract_html_structure(
        b"<table><tbody>"
        b"<tr><td colspan='3'>Required Delivery Schedule</td></tr>"
        b"<tr><td colspan='3'>[Contracting Officer insert specific details]</td></tr>"
        b"<tr><td>Item No.</td><td>Quantity</td><td>Within Days After Date of Contract</td></tr>"
        b"<tr><td>________</td><td>________</td><td>[insert]</td></tr>"
        b"<tr><td>________</td><td>________</td><td>________</td></tr>"
        b"</tbody></table>"
        b"<table><thead><tr><th>Line Item No.</th><th>Country of Origin</th></tr></thead>"
        b"<tbody><tr><td>__________</td><td>__________</td></tr></tbody></table>"
        b"<table><tr><td>Line Item No.</td><td>Country of Origin</td></tr>"
        b"<tr><td>CLIN 0001</td><td>Canada</td></tr></table>"
    )
    schedule, printed, filled = x.tables
    assert schedule.headers == ["Item No.", "Quantity", "Within Days After Date of Contract"]
    assert schedule.header_cells and schedule.acceptance == "accepted"
    assert schedule.caption == "Required Delivery Schedule — [Contracting Officer insert specific details]"
    assert [c.text for c in schedule.rows[1]] == ["", "", ""]
    # Blank lines are empty cells, never values.
    assert [c.text for c in printed.rows[0]] == ["", ""]
    # A label row over real values stays a row: nothing says it is a header.
    assert not filled.header_cells
    assert [c.text for c in filled.rows[1]] == ["CLIN 0001", "Canada"]


def test_html_items_carry_document_order_so_tables_stay_under_their_heading():
    from app.source_structure.original_layout import _at

    x = extract_html_structure(
        b"<h2>52.211-8 Time of Delivery.</h2><table><tr><th>Item No.</th></tr><tr><td>1</td></tr></table>"
        b"<h2>52.211-9 Desired Time of Delivery.</h2><table><tr><th>Item No.</th></tr><tr><td>2</td></tr></table>"
    )
    first, second = (r for r in x.regions if r.region_type == "HEADING")
    table_a, table_b = x.tables
    order = [_at(None, item.source_locator) for item in (first, table_a, second, table_b)]
    assert order == sorted(order) and len(set(order)) == 4


# --- HTML fixtures A–E ----------------------------------------------------------


def _html(name: str):
    return extract_html_structure((FIXTURES / name).read_bytes())


def test_html_a_semantic_table_stays_a_table_with_cell_locators():
    x = _html("a_semantic_table.html")
    assert not x.fields
    (table,) = x.tables
    assert table.acceptance == "accepted"
    assert table.headers == ["Line", "Part Number", "Description", "Qty", "Unit Cost", "Extended"]
    assert [c.text for c in table.rows[1]][:3] == ["2", "HX-4410", "Quick coupler, brass"]
    assert table.total_row_indices == [3]  # <tfoot>
    cell = table.rows[1][4]
    assert cell.source_locator.table_index == 0
    assert (cell.source_locator.row_index, cell.source_locator.column_index) == (1, 4)
    assert cell.source_locator.dom_path.endswith("tbody/tr[2]/td[5]")
    assert cell.source_locator.section_path == ["Shipment Manifest"]


def test_html_b_div_layouts_keep_labels_with_values():
    x = _html("b_div_label_value.html")
    pairs = {f.label_text: (f.raw_value, f.structural_relation) for f in x.fields if f.acceptance == "accepted"}
    assert pairs["Account Number"] == ("ACCT-558210", "html_adjacent_elements")
    assert pairs["Balance Due"][0] == "$1,240.55"
    assert pairs["Payment Terms"] == ("Net 15", "html_label_for")
    assert pairs["Customer ID"] == ("C-10442", "html_inline_separator")
    assert pairs["Contact Email"][0] == "ar@example.com"
    # The instruction sentence is narrative, not a field.
    assert not any("remit" in label.lower() for label in pairs)
    terms = next(f for f in x.fields if f.label_text == "Payment Terms")
    assert terms.source_locator.element_id == "terms"


def test_html_c_definition_list_pairs_dt_with_dd():
    x = _html("c_definition_list.html")
    pairs = {f.label_text: f for f in x.fields}
    assert set(pairs) == {"Vendor Name", "Tax ID", "Remit Address", "Phone", "Preferred Currency"}
    assert pairs["Remit Address"].raw_value == "PO Box 4410\nOakland, CA 94607"
    assert pairs["Phone"].value_type_hint == "phone"
    assert all(f.structural_relation == "html_definition_list" for f in pairs.values())


def test_html_d_nested_sections_give_section_trails():
    x = _html("d_nested_sections.html")
    by_label = {f.label_text: f for f in x.fields}
    assert by_label["Department"].source_locator.section_path == ["Work Order WO-7781", "Requester"]
    assert by_label["Start Date"].source_locator.section_path == [
        "Work Order WO-7781", "Schedule", "Service Window",
    ]
    # A header-less th/td table is a key/value layout, not a data table.
    assert by_label["Room"].raw_value == "B-114"
    assert by_label["Room"].structural_relation == "html_table_header_cell"
    assert not x.tables


def test_html_e_narrative_does_not_become_fields():
    x = _html("e_narrative_with_table.html")
    assert not x.fields
    (table,) = x.tables
    assert table.headers == ["Site", "Inspection Date", "Technician", "Cost"]
    assert len(table.rows) == 3
    assert "date_column" in table.column_hints[1]
    kinds = {r.region_type for r in x.regions}
    assert "NARRATIVE" in kinds


def test_readable_dom_text_keeps_structure_and_drops_script():
    text, tables = readable_dom_text((FIXTURES / "a_semantic_table.html").read_bytes())
    assert "Line | Part Number | Description" in text
    assert "border-collapse" not in text
    assert tables and tables[0]["headers"][0] == "Line"


# --- end to end ---------------------------------------------------------------------


def _upload(name: str, content: bytes, mime: str) -> str:
    # The test DB persists across runs; make every upload unique so
    # duplicate detection doesn't intercept it.
    if mime == "text/html":
        content = content + f"<!-- {uuid4()} -->".encode()
    else:
        pdf = fitz.open("pdf", content)
        pdf.set_metadata({"subject": str(uuid4())})
        content = pdf.tobytes()
    response = client.post("/api/documents/upload", files={"file": (name, content, mime)})
    assert response.status_code == 201, response.text
    document_id = response.json()["document_id"]
    extracted = client.post(f"/api/documents/{document_id}/extract-pages", json={"run_ocr": False})
    assert extracted.status_code == 200, extracted.text
    return document_id


def _process(document_id: str) -> None:
    database = SessionLocal()
    try:
        document = database.get(Document, document_id)
        pages = list(database.scalars(select(DocumentPage).where(DocumentPage.document_id == document_id)))
        run_and_persist_v3_extraction(database=database, document=document, pages=pages)
        resolve_and_persist_profile(database, document)
    finally:
        database.close()


def _dataset(workbook: dict, dataset_id: str) -> dict:
    return next(d for d in workbook["datasets"] if d["dataset_id"] == dataset_id)


def test_pdf_statement_populates_generic_workbook_with_cell_provenance():
    doc = fitz.open()
    _statement(doc.new_page(width=612, height=792))
    document_id = _upload(f"statement-{uuid4()}.pdf", doc.tobytes(), "application/pdf")
    _process(document_id)

    workbook = client.get(f"/api/documents/{document_id}/staging-workbook").json()
    assert workbook["profile"]["profile_id"] == "generic_business_document"
    assert workbook["profile"]["profile_version"] == 2
    keys = {r["cells"]["document.field.name"]["value"]: r for r in _dataset(workbook, "key_fields")["records"]}
    account = keys["Account Number"]["cells"]["document.field.value"]
    assert account["value"] == "ACCT-558210"
    assert account["review_status"] == "Verified"
    assert account["provenance"]["source_page"] == 1
    assert account["provenance"]["source_bbox"] is not None

    lines = _dataset(workbook, "line_items")["records"]
    assert len(lines) == 3
    amount = lines[1]["cells"]["document.line_item.amount"]
    assert amount["value"] == "42.00"
    assert amount["provenance"]["highlight_text"] == "42.00"
    assert amount["provenance"]["source_bbox"] is not None


def test_html_document_uses_dom_provenance_without_page_numbers():
    html = (FIXTURES / "a_semantic_table.html").read_bytes()
    document_id = _upload(f"manifest-{uuid4()}.html", html, "text/html")
    _process(document_id)

    workbook = client.get(f"/api/documents/{document_id}/staging-workbook").json()
    assert workbook["outcome"]["status"] in ("populated", "needs_review")
    lines = _dataset(workbook, "line_items")["records"]
    assert len(lines) == 3
    cell = lines[0]["cells"]["document.line_item.description"]
    provenance = cell["provenance"]
    assert provenance["source_type"] == "html"
    assert provenance["source_page"] is None
    assert provenance["source_locator"]["table_index"] == 0
    assert provenance["source_locator"]["column_index"] == 2

    context = client.get(
        f"/api/documents/{document_id}/source-structure/regions/{provenance['source_region_id']}"
    ).json()
    assert context["table"]["headers"][2] == "Description"
    assert (context["row_index"], context["column_index"]) == (0, 2)

    # Unmapped columns keep their identity: raw header, no role, value,
    # provenance — mappable later without reparsing.
    part = next(c for c in lines[0]["source_columns"] if c["raw_header"] == "Part Number")
    assert part["structural_role"] is None
    assert part["raw_value"] == "HX-2201"
    assert part["provenance"]["source_locator"]["column_index"] == 1
    assert cell["source_column"]["raw_header"] == "Description"

    # The tfoot total surfaces as a key field from the table's total row.
    keys = {r["cells"]["document.field.name"]["value"] for r in _dataset(workbook, "key_fields")["records"]}
    assert "Total" in keys


def test_document_pinned_to_generic_v1_keeps_rendering_v1():
    document_id = _upload(f"memo-{uuid4()}.pdf", _one_line_pdf(), "application/pdf")
    database = SessionLocal()
    try:
        database.add(
            DocumentStagingWorkbook(
                document_id=document_id,
                profile_id="generic_business_document",
                profile_version=1,
                resolution_reasons=["pinned before phase C"],
            )
        )
        database.commit()
    finally:
        database.close()
    workbook = client.get(f"/api/documents/{document_id}/staging-workbook").json()
    assert workbook["profile"]["profile_version"] == 1


def _one_line_pdf() -> bytes:
    doc = fitz.open()
    doc.new_page().insert_text((72, 72), "Internal memo", fontsize=10)
    return doc.tobytes()


# --- All Fields, CSV and reading-order transcript ---------------------------------


def _record_form(page: fitz.Page) -> None:
    """A certificate-like form: separator-less captions in two columns, an
    underline-filled pair, a dated line and a marks table."""

    t = lambda x, y, s, size=10: page.insert_text((x, y), s, fontsize=size)  # noqa: E731
    t(150, 60, "REGIONAL EXAMINATION BOARD", 14)
    t(60, 100, "Roll No."); t(120, 100, "516522"); t(330, 100, "Registration No."); t(430, 100, "0222420149")
    t(60, 125, "Group __ HUMANITIES")
    for i, (subject, maximum, obtained) in enumerate([("ENGLISH", "200", "069"), ("URDU", "200", "129"), ("ECONOMICS", "200", "126")]):
        y = 180 + 18 * i
        t(60, y, f"{i + 1}."); t(100, y, subject); t(330, y, maximum); t(430, y, obtained)
    t(60, 300, "Issued at Islamabad on December 10, 2005 by the board secretary.")


def test_all_fields_is_the_union_and_its_csv_is_never_header_only():
    doc = fitz.open()
    _record_form(doc.new_page(width=612, height=792))
    document_id = _upload(f"record-form-{uuid4()}.pdf", doc.tobytes(), "application/pdf")
    _process(document_id)

    workbook = client.get(f"/api/documents/{document_id}/staging-workbook").json()
    assert workbook["profile"]["profile_id"] == "generic_business_document"
    records = _dataset(workbook, "all_fields")["records"]
    by_category: dict[str, list[dict]] = {}
    for record in records:
        by_category.setdefault(record["cells"]["document.field.category"]["value"], []).append(record)

    fields = {r["cells"]["document.field.name"]["value"]: r["cells"]["document.field.value"] for r in by_category["Key Field"]}
    assert fields["Roll No."]["value"] == "516522"
    assert fields["Registration No."]["value"] == "0222420149"
    # An identifier caption types its value as an identifier, not a phone.
    assert _dataset(workbook, "contacts")["records"] == []
    assert fields["Group"]["value"] == "HUMANITIES"
    # Table values arrive cell by cell with context: "<row label> / <column>".
    cells = [r for r in records if r["cells"]["document.field.value_type"]["value"] == "table cell"]
    names = {r["cells"]["document.field.name"]["value"]: r["cells"]["document.field.value"]["value"] for r in cells}
    assert len(cells) >= 6
    assert any(name.startswith("ECONOMICS / ") and value == "126" for name, value in names.items())
    assert any(r["cells"]["document.field.value"]["value"] == "December 10, 2005" for r in by_category["Detected Value"])
    # Every All Fields value is source-supported.
    for record in records:
        value = record["cells"]["document.field.value"]
        assert value["provenance"] and value["provenance"]["source_page"] == 1

    csv_text = client.get(
        f"/api/documents/{document_id}/staging-workbook/datasets/all_fields.csv"
    ).text
    import csv
    import io

    # The CSV opens with a UTF-8 BOM so Excel reads it as UTF-8.
    rows = list(csv.reader(io.StringIO(csv_text.removeprefix("﻿"))))
    assert rows[0] == ["Category", "Field", "Value", "Type", "Found By", "Source Page", "Evidence", "Review Status"]
    assert len(rows) - 1 == len(records) > 0


def test_transcript_reads_columns_in_order_and_grids_by_row():
    from app.source_structure.reading_order import reconstruct_page

    def words_of(page: fitz.Page):
        return native_words(fitz.open("pdf", page.parent.tobytes())[page.number])

    doc = fitz.open()
    page = doc.new_page(width=612, height=792)
    left = ["Alpha column begins here and", "continues on its second line", "and ends on the third one."]
    right = ["Beta column is independent,", "its lines sit at other heights", "and it is read after Alpha."]
    for i, text in enumerate(left):
        page.insert_text((60, 100 + 14 * i), text, fontsize=10)
    for i, text in enumerate(right):
        page.insert_text((330, 107 + 14 * i), text, fontsize=10)
    for i, (label, value) in enumerate([("Subtotal", "$605.20"), ("Tax", "$36.25"), ("Invoice Total", "$659.45")]):
        page.insert_text((330, 250 + 16 * i), label, fontsize=10)
        page.insert_text((500, 250 + 16 * i), value, fontsize=10)

    blocks = reconstruct_page(words_of(page))
    lines = [line["text"] for block in blocks for line in block.as_dict()["lines"]]
    text = "\n".join(lines)
    # Columns: all of Alpha before any of Beta — not interleaved by height.
    assert text.index("third one.") < text.index("Beta column")
    # Grid: each label stays with its value, row by row.
    assert "Subtotal   $605.20" in lines and "Invoice Total   $659.45" in lines
    assert text.index("Subtotal") < text.index("Tax") < text.index("Invoice Total")
    # Every line keeps its words' page-space boxes for evidence highlighting.
    for block in blocks:
        for line in block.as_dict()["lines"]:
            assert line["bbox"] and line["words"]


def test_transcript_endpoint_returns_reading_order_blocks():
    doc = fitz.open()
    _record_form(doc.new_page(width=612, height=792))
    document_id = _upload(f"record-form-{uuid4()}.pdf", doc.tobytes(), "application/pdf")
    transcript = client.get(f"/api/documents/{document_id}/pages/1/transcript").json()
    assert transcript["extraction_method"] == "native"
    kinds = [b["kind"] for b in transcript["blocks"]]
    assert "table" in kinds
    first_text = next(b["text"] for b in transcript["blocks"] if b["kind"] != "table")
    assert first_text == "REGIONAL EXAMINATION BOARD"
    assert any("Roll No.   516522   Registration No.   0222420149" == b["text"] for b in transcript["blocks"])
    assert client.get(f"/api/documents/{document_id}/pages/99/transcript").status_code == 404


def test_page_without_word_positions_gets_a_text_only_transcript_and_no_invented_geometry():
    from PIL import Image, ImageDraw, ImageFont

    image = Image.new("RGB", (1400, 700), "white")
    draw = ImageDraw.Draw(image)
    try:
        font = ImageFont.truetype("arial.ttf", 34)
    except OSError:
        font = ImageFont.load_default()
    draw.text((80, 120), "Certificate No.   422005/155187", fill="black", font=font)
    draw.text((80, 220), f"Roll No.   516522   {uuid4().hex[:6]}", fill="black", font=font)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    upload = client.post("/api/documents/upload", files={"file": (f"no-layout-{uuid4()}.png", buffer.getvalue(), "image/png")})
    assert upload.status_code == 201, upload.text
    document_id = upload.json()["document_id"]
    assert client.post(f"/api/documents/{document_id}/extract-pages", json={"run_ocr": True}).status_code == 200

    # Simulate an OCR route that keeps the text but loses word positions.
    database = SessionLocal()
    try:
        page = database.scalars(select(DocumentPage).where(DocumentPage.document_id == document_id)).first()
        if not (page.final_text or "").strip():
            pytest.skip("OCR engine unavailable in this environment")
        page.ocr_layout_json = None
        database.commit()
    finally:
        database.close()

    transcript = client.get(f"/api/documents/{document_id}/pages/1/transcript").json()
    assert transcript["positioning"] == "text_only"
    assert transcript["word_count"] > 0
    assert transcript["blocks"] and all(b["bbox"] is None for b in transcript["blocks"])
    assert all(line["bbox"] is None and line["words"] == [] for b in transcript["blocks"] for line in b["lines"])
    assert any("positioning was not available" in w for w in transcript["warnings"])

    # Geometry-dependent structure is never built from invented positions.
    structure = client.get(f"/api/documents/{document_id}/source-structure").json()
    assert structure["field_candidates"] == [] and structure["table_candidates"] == []


def test_failed_layout_pass_falls_back_to_mupdf_ocr_word_positions():
    """Production failure mode: MuPDF OCR produces the text, but the separate
    pytesseract layout pass times out. The page must still get real word
    positions (from MuPDF's own OCR pass) — not text-only."""

    import shutil
    from unittest.mock import patch

    from PIL import Image, ImageDraw, ImageFont

    # This is the Tesseract path's own fallback. Without Tesseract the page
    # is read by RapidOCR instead (app/recognition/page_ocr.py).
    if shutil.which("tesseract") is None:
        pytest.skip("Tesseract not installed: the MuPDF/Tesseract fallback isn't used here")

    image = Image.new("RGB", (1400, 700), "white")
    draw = ImageDraw.Draw(image)
    try:
        font = ImageFont.truetype("arial.ttf", 34)
    except OSError:
        font = ImageFont.load_default()
    draw.text((80, 120), "Roll No.   516522", fill="black", font=font)
    draw.text((80, 220), f"Registration No.   0222420149   {uuid4().hex[:6]}", fill="black", font=font)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    upload = client.post("/api/documents/upload", files={"file": (f"slow-cpu-{uuid4()}.png", buffer.getvalue(), "image/png")})
    assert upload.status_code == 201, upload.text
    document_id = upload.json()["document_id"]
    with patch("app.services.ocr_word_layer.extract_ocr_layout", return_value=None):
        assert client.post(f"/api/documents/{document_id}/extract-pages", json={"run_ocr": True}).status_code == 200

    database = SessionLocal()
    try:
        page = database.scalars(select(DocumentPage).where(DocumentPage.document_id == document_id)).first()
        if not (page.final_text or "").strip():
            pytest.skip("OCR engine unavailable in this environment")
        layout = page.ocr_layout_json
        assert layout and layout["engine"] == "mupdf_textpage" and layout["words"]
        assert all(word["conf"] is None for word in layout["words"])  # unknown, never invented
    finally:
        database.close()

    transcript = client.get(f"/api/documents/{document_id}/pages/1/transcript").json()
    assert transcript["positioning"] == "spatial"
    lines = [line for block in transcript["blocks"] for line in block["lines"]]
    assert any("516522" in line["text"] for line in lines)
    assert all(line["bbox"] for line in lines)
