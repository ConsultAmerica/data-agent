"""Original Structure: fields and tables in document order, joined to
extraction and review, with disagreements flagged."""

from __future__ import annotations

from uuid import uuid4

import fitz
import pytest
from fastapi.testclient import TestClient

from app.database.session import SessionLocal
from app.main import app
from app.models.document import Document
from app.models.document_metadata_field import DocumentMetadataField
from app.source_structure.original_layout import build_original_layout
from app.source_structure.pdf_structure import extract_page_structure, native_words
from app.source_structure.service import get_or_build_source_structure
from contract_brief_fixture import MOD_COUNT, MOD_HEADERS, contract_brief_pdf, expected_fields

client = TestClient(app)


def _upload(content: bytes, name: str) -> str:
    response = client.post("/api/documents/upload", files={"file": (f"{name}-{uuid4().hex[:6]}.pdf", content, "application/pdf")})
    assert response.status_code == 201, response.text
    document_id = response.json()["document_id"]
    assert client.post(f"/api/documents/{document_id}/extract-pages", json={"run_ocr": False}).status_code == 200
    return document_id


@pytest.fixture(scope="module")
def brief_id() -> str:
    return _upload(contract_brief_pdf(), "brief")


def _layout(document_id: str, metadata: list[DocumentMetadataField] | None = None) -> dict:
    database = SessionLocal()
    try:
        structure = get_or_build_source_structure(database, database.get(Document, document_id))
        return build_original_layout(structure, metadata or [])
    finally:
        database.close()


def _fields(layout: dict) -> list[dict]:
    return [item for section in layout["sections"] for item in section["items"] if item["kind"] == "field"]


def _tables(layout: dict) -> list[dict]:
    return [item for section in layout["sections"] for item in section["items"] if item["kind"] == "table"]


def test_every_printed_field_is_kept_in_document_order(brief_id: str) -> None:
    fields = _fields(_layout(brief_id))
    pairs = [(f["label"], f["document_value"]) for f in fields]
    # Each expected pair is found after the one before it ("Address" repeats
    # under every agency, so order is checked by walking forward).
    position = -1
    for _, label, value in expected_fields():
        position = pairs.index((label.strip(), value), position + 1)
    # Blank form fields are shown, not dropped.
    blank = {f["label"] for f in fields if f["blank"]}
    assert {"9a. Prime Contractor", "9b. Prime Contract No."} <= blank


def test_sub_labels_keep_their_group_and_original_labels(brief_id: str) -> None:
    fields = _fields(_layout(brief_id))
    contract = [f for f in fields if f["group"] == "2. Contract Information"]
    assert [f["label"] for f in contract] == [
        "Contract Number", "Contract Name", "Oracle Project Number", "Date of Award",
        "Security Classification Level", "DPAS Rating",
    ]
    limitations = next(f for f in fields if f["label"] == "If yes, identify the limitations.")
    assert limitations["group"].startswith("23. Does the contract contain ceilings")
    assert limitations["document_value"] == "$40,000,000.00"


def test_sections_follow_the_document_headings(brief_id: str) -> None:
    layout = _layout(brief_id)
    titles = [section["title"] for section in layout["sections"]]
    # Headings are sections, never business fields.
    labels = {f["label"] for f in _fields(layout)} | {f["document_value"] for f in _fields(layout)}
    assert not labels & set(titles)
    assert titles == [
        "A. General Information",
        "B. Contract Clauses and Special Provisions",
        "Contract Summary",
        "C. Summary of Contract Modifications",
    ]


def test_tables_keep_printed_headers_and_merge_continued_pages_only_on_evidence(brief_id: str) -> None:
    summary, modifications, accruals = _tables(_layout(brief_id))
    assert summary["headers"][:3] == ["Period Name", "Exercised?", "Start"]
    assert modifications["headers"] == MOD_HEADERS
    assert modifications["pages"] == [4, 5] and modifications["continued"]
    # Every row once, in printed order, as rows (not one row per cell).
    assert [int(row["cells"][0]) for row in modifications["rows"]] == list(range(1, MOD_COUNT + 1))
    assert len(modifications["rows"][0]["cells"]) == len(MOD_HEADERS)
    # Page 6 repeats the header but its rows restart: a different table.
    assert accruals["pages"] == [6] and not accruals["continued"]
    assert [row["cells"][0] for row in accruals["rows"]] == ["1", "2"]


def _metadata(document_id: str, key: str, label: str, value: str, page: int, *, status: str = "pending", reviewed: str | None = None) -> DocumentMetadataField:
    return DocumentMetadataField(
        id=abs(hash((key, value, page))) % 10**6, document_id=document_id, field_group="g", field_key=key, label=label,
        value=reviewed if reviewed is not None else value, original_value=value, confidence=0.9,
        extraction_method="target", review_status=status,
        evidence_json={"page_number": page, "source_text": f"{label} {value}", "machine_value": value},
        extraction_source="target",
    )


def test_label_value_disagreements_are_flagged_and_reviewed_values_kept(brief_id: str) -> None:
    rows = [
        _metadata(brief_id, "cage_code", "CAGE Code", "7QRT2", 1, status="accepted"),
        _metadata(brief_id, "contract_no", "Contract Number", "", 1),  # the 25% "—" row
        _metadata(brief_id, "contract_number", "Contract Number", "C05550001", 1),
        _metadata(brief_id, "business_size", "Business Size", "Small", 1),  # wrong value for the label
        _metadata(brief_id, "role", "Company Role", "Prime", 1, status="edited", reviewed="Prime Contractor"),
        _metadata(brief_id, "contract_type", "Contract Type", "DIRECT", 1),
        _metadata(brief_id, "contract_type", "Contract Type", "INDIRECT", 4),
    ]
    by_label = {f["label"]: f for f in _fields(_layout(brief_id, rows)) if f["page"] in (1, 4)}

    assert by_label["Cage"]["review_status"] == "Approved" and not by_label["Cage"]["flags"]
    number = next(f for f in _fields(_layout(brief_id, rows)) if f["label"] == "Contract Number" and f["page"] == 1)
    assert number["extracted_value"] == "C05550001"
    assert [f["code"] for f in number["flags"]] == ["missed_value"]
    assert number["review_status"] == "Needs review"
    assert "label_value_mismatch" in [f["code"] for f in by_label["Business Size"]["flags"]]
    assert by_label["Business Size"]["document_value"] == "HUBZone"  # never replaced
    role = by_label["8. Company Role"]
    assert (role["extracted_value"], role["effective_value"], role["review_status"]) == ("Prime", "Prime Contractor", "Corrected")
    assert "conflicting_values" in [f["code"] for f in by_label["4. Contract Type"]["flags"]]


def test_table_cells_that_dont_fit_their_column_are_flagged() -> None:
    from app.source_structure.models import TableCandidate, TableCell, StructuredSourceDocument, StructureStats

    rows = [["1", "$1,000.00"], ["2", "$2,000.00"], ["3", "#########"], ["4", "$4,000.00"], ["5", "$5,000.00"]]
    table = TableCandidate(
        candidate_id="t1", region_id="t1", page=1, bbox=(0, 100, 100, 200), detection_method="pdf_ruling_lines",
        headers=["No", "Amount"], header_cells=[TableCell(row_index=-1, column_index=i, text=h) for i, h in enumerate(["No", "Amount"])],
        rows=[[TableCell(row_index=r, column_index=c, text=t) for c, t in enumerate(row)] for r, row in enumerate(rows)],
    )
    structure = StructuredSourceDocument(document_id="d", source_type="pdf", extractor_version=0, regions=[], field_candidates=[], table_candidates=[table], stats=StructureStats(pages=1))
    [section] = build_original_layout(structure, [])["sections"]
    flagged = [row for row in section["items"][0]["rows"] if row.get("flags")]
    assert [row["cells"][1] for row in flagged] == ["#########"]
    assert flagged[0]["review_status"] == "Needs review"


def test_box_borders_are_not_read_as_fill_in_underlines() -> None:
    doc = fitz.open()
    page = doc.new_page()
    for index, (label, value) in enumerate([("7. ISSUED BY", "N40192"), ("8. ADDRESS", "Code 1"), ("9. NAME", "Paul"), ("10. PHONE", "210")]):
        top = 80 + index * 40
        page.draw_rect(fitz.Rect(60, top, 540, top + 30), width=0.6)  # a boxed form cell
        page.insert_text((64, top + 12), label, fontsize=8)
        page.insert_text((300, top + 26), value, fontsize=9)
    result = extract_page_structure(page_number=1, words=native_words(page), extraction_method="native", fitz_page=page)
    assert not [f for f in result.fields if f.structural_relation == "ruled_form_row"]


def _hairline(page: fitz.Page, x0: float, y0: float, x1: float, y1: float) -> None:
    # Spreadsheet exports draw each rule as a thin filled rectangle.
    page.draw_rect(fitz.Rect(x0, y0, x1, y1), color=None, fill=(0, 0, 0))


def test_rectangle_drawn_grid_below_a_label_block() -> None:
    """aa.pdf page 4: underlined label/value rows over a grid whose rules are
    all thin filled rectangles; long values run past their underline."""

    doc = fitz.open()
    page = doc.new_page()
    block = [("Contractor Name", "ORBITAL FIELD SERVICES, LLC"), ("Contract Name", "OFS JV"), ("Contract Number", "C05550001"), ("Contract Type", "DIRECT")]
    for index, (label, value) in enumerate(block):
        y = 90 + index * 12
        page.insert_text((60, y), label, fontsize=7)
        page.insert_text((160, y), value, fontsize=7)
        _hairline(page, 158, y + 1.5, 230, y + 2)  # shorter than the long name
    columns = [60, 110, 200, 280, 360]
    rows = [["Mod", "Description", "Date", "Funding"]] + [[str(i), "AWARD" if i == 1 else "", f"07/{i:02d}/2025", f"${i},000.00"] for i in range(1, 7)]
    top = 160
    for r, cells in enumerate(rows):
        y = top + r * 12
        for c, text in enumerate(cells):
            page.insert_text((columns[c] + 2, y + 9), text, fontsize=7)
    for r in range(len(rows) + 1):
        _hairline(page, columns[0], top + r * 12, columns[-1], top + r * 12 + 0.5)
    for x in columns:
        _hairline(page, x, top, x + 0.5, top + len(rows) * 12)

    result = extract_page_structure(page_number=1, words=native_words(page), extraction_method="native", fitz_page=page)
    fields = {f.label_text: f.raw_value for f in result.fields if f.structural_relation == "ruled_form_row"}
    assert fields["Contractor Name"] == "ORBITAL FIELD SERVICES, LLC"
    assert fields["Contract Type"] == "DIRECT"
    [table] = result.tables
    assert table.headers == ["Mod", "Description", "Date", "Funding"]
    assert len(table.rows) == 6
    assert not [r for r in result.regions if r.region_type == "HEADING"]


def test_original_structure_export_keeps_the_printed_layout_and_values(brief_id: str) -> None:
    from io import BytesIO

    from openpyxl import load_workbook

    response = client.get(f"/api/documents/{brief_id}/original-structure/export.xlsx")
    assert response.status_code == 200
    assert "original structure.xlsx" in response.headers["content-disposition"]
    sheet = load_workbook(BytesIO(response.content)).active
    rows = [[c for c in row] for row in sheet.iter_rows()]
    values = [[c.value for c in row] for row in rows]
    # Every value is text exactly as printed: no dates or numbers made by Excel.
    assert {c.data_type for row in rows for c in row if c.value is not None} == {"s"}
    # One sheet, the document's own columns, nothing added or styled.
    assert len(sheet.parent.sheetnames) == 1
    assert values[0][:4] == ["Item #", "Section", "Fields Extracted", "Value / Details"]
    assert not sheet.merged_cells.ranges
    assert {c.fill.fill_type for row in rows for c in row} == {None}
    assert not any(c.font.bold for row in rows for c in row)
    # The item number and name are written on the item's first row only.
    first = next(i for i, r in enumerate(values) if r[2] == "Contract Number")
    assert values[first][:2] == ["2.", "Contract Information"]
    assert values[first + 1][2] == "Contract Name" and values[first + 1][:2] == [None, None]
    # A printed table sits in place under its printed headers, no extra columns.
    header_row = next(i for i, r in enumerate(values) if r[0] == MOD_HEADERS[0])
    assert [v for v in values[header_row] if v is not None] == MOD_HEADERS


def test_export_placement_puts_numbered_items_under_category() -> None:
    from app.source_structure.original_export import item_parts

    assert item_parts(None, "3. Briefed Through") == ("3.", "Briefed Through", "Briefed Through")
    assert item_parts("1. Contractor Information", "Cage") == ("1.", "Contractor Information", "Cage")
    assert item_parts(None, "Contract Type") == ("", "", "Contract Type")


def test_original_structure_endpoint(brief_id: str) -> None:
    response = client.get(f"/api/documents/{brief_id}/original-structure")
    assert response.status_code == 200
    body = response.json()
    assert body["stats"]["fields"] >= len(expected_fields())
    assert body["stats"]["tables"] == 3
    assert client.get(f"/api/documents/{uuid4()}/original-structure").status_code == 404


def test_rows_and_unextracted_fields_are_reviewed_without_losing_the_printed_value(brief_id: str) -> None:
    layout = client.get(f"/api/documents/{brief_id}/original-structure").json()
    field = next(f for f in _fields(layout) if f["metadata"] is None and f["document_value"])
    table = _tables(layout)[0]
    row = table["rows"][1]
    assert field["record_key"].startswith("field:") and row["record_key"].startswith(f"{table['record_key']}:row:")

    corrected = ["X" + c for c in row["cells"]]
    response = client.post(
        f"/api/documents/{brief_id}/original-structure/review",
        json={"records": [row["record_key"]], "action": "correct", "cells": corrected, "reason": "typo"},
    )
    assert response.status_code == 200 and response.json()["reviewed"] == 1
    response = client.post(
        f"/api/documents/{brief_id}/original-structure/review",
        json={"records": [field["record_key"], "field:999:none:missing:0"], "action": "reject"},
    )
    results = {r["record_key"]: r for r in response.json()["results"]}
    assert results[field["record_key"]]["ok"] and not results["field:999:none:missing:0"]["ok"]

    after = client.get(f"/api/documents/{brief_id}/original-structure").json()
    same_row = next(r for t in _tables(after) for r in t["rows"] if r["record_key"] == row["record_key"])
    assert same_row["cells"] == row["cells"]  # the printed row is untouched
    assert same_row["reviewed_cells"] == corrected and same_row["review_status"] == "Corrected"
    same_field = next(f for f in _fields(after) if f["record_key"] == field["record_key"])
    assert same_field["review_status"] == "Rejected"
    assert same_field["structure_review"]["original_value"] == field["document_value"]

    # Approving the corrected row keeps the correction; history keeps both.
    client.post(f"/api/documents/{brief_id}/original-structure/review", json={"records": [row["record_key"]], "action": "accept"})
    final = next(r for t in _tables(client.get(f"/api/documents/{brief_id}/original-structure").json()) for r in t["rows"] if r["record_key"] == row["record_key"])
    assert final["review_status"] == "Approved" and final["reviewed_cells"] == corrected


def test_a_row_correction_needs_every_column(brief_id: str) -> None:
    row = _tables(client.get(f"/api/documents/{brief_id}/original-structure").json())[0]["rows"][0]
    response = client.post(
        f"/api/documents/{brief_id}/original-structure/review",
        json={"records": [row["record_key"]], "action": "correct", "cells": ["only one"]},
    )
    assert response.json()["results"][0]["ok"] is False


def test_fa30_style_contract_parts_open_sections_and_values_never_do() -> None:
    from app.source_structure.models import StructuredRegion, StructureStats, StructuredSourceDocument

    def region(page: int, y: float, kind: str, text: str) -> StructuredRegion:
        return StructuredRegion(region_id=f"r{page}{y}", region_type=kind, text=text, normalized_text=text.lower(), page=page, bbox=(10, y, 200, y + 10), extraction_method="native")

    structure = StructuredSourceDocument(
        document_id="d", source_type="pdf", extractor_version=0, field_candidates=[], table_candidates=[],
        regions=[
            region(1, 60, "HEADING", "F2X3C34150A001"),  # a requisition number set in bold
            region(1, 80, "HEADING", "SOLICITATION"),
            region(2, 40, "HEADING", "Section A - Solicitation/Contract Form"),
            region(3, 40, "PARAGRAPH", "Section B - Supplies or Services & Prices\nAdditional Information"),
            region(3, 90, "HEADING", "(Dec 2018)"),
            region(3, 120, "HEADING", "Unit Price"),
            region(4, 40, "HEADING", "Section C - Description/Specifications"),
            region(4, 80, "HEADING", "Key Position"),
        ],
        stats=StructureStats(pages=4),
    )
    from app.source_structure.original_layout import _section_headings

    headings = [(title, level) for _, _, title, level in _section_headings(structure, [])]
    assert headings == [
        ("SOLICITATION", 2),
        ("Section A - Solicitation/Contract Form", 1),
        ("Section B - Supplies or Services & Prices", 1),
        ("Section C - Description/Specifications", 1),
        ("Key Position", 2),
    ]


def test_selected_records_export_in_every_format(brief_id: str) -> None:
    layout = client.get(f"/api/documents/{brief_id}/original-structure").json()
    field = _fields(layout)[0]
    row = _tables(layout)[0]["rows"][0]
    for fmt in ("xlsx", "csv", "json"):
        response = client.post(
            f"/api/documents/{brief_id}/original-structure/export-selected",
            json={"records": [field["record_key"], row["record_key"]], "format": fmt},
        )
        assert response.status_code == 200, response.text
    data = response.json()
    assert data["stats"]["fields"] == 1 and data["stats"]["table_rows"] == 1
    csv_text = client.post(
        f"/api/documents/{brief_id}/original-structure/export-selected", json={"records": [field["record_key"]], "format": "csv"},
    ).content.decode("utf-8-sig").splitlines()
    assert csv_text[0] == "Item #,Section,Fields Extracted,Value / Details" and len(csv_text) == 2


def test_a_missing_row_is_added_marked_and_still_needs_approval(brief_id: str) -> None:
    table = _tables(client.get(f"/api/documents/{brief_id}/original-structure").json())[0]
    printed = [r["cells"] for r in table["rows"] if not r.get("added")]
    cells = ["New"] + [""] * (len(table["headers"]) - 1)
    response = client.post(
        f"/api/documents/{brief_id}/original-structure/review",
        json={"records": [table["record_key"]], "action": "add_row", "cells": cells, "reason": "missed by OCR"},
    ).json()
    assert response["reviewed"] == 1
    key = response["results"][0]["record_key"]
    after = next(t for t in _tables(client.get(f"/api/documents/{brief_id}/original-structure").json()) if t["record_key"] == table["record_key"])
    added = next(r for r in after["rows"] if r["record_key"] == key)
    assert added["added"] and added["cells"] == cells and added["review_status"] == "Added"
    assert [r["cells"] for r in after["rows"] if not r.get("added")] == printed
    client.post(f"/api/documents/{brief_id}/original-structure/review", json={"records": [key], "action": "accept"})
    after = next(t for t in _tables(client.get(f"/api/documents/{brief_id}/original-structure").json()) if t["record_key"] == table["record_key"])
    assert next(r for r in after["rows"] if r["record_key"] == key)["review_status"] == "Approved"
    # Adding needs a whole row; a table itself isn't approved.
    bad = client.post(f"/api/documents/{brief_id}/original-structure/review",
                      json={"records": [table["record_key"]], "action": "accept"}).json()
    assert bad["results"][0]["ok"] is False


def test_record_history_lists_every_decision_oldest_first(brief_id: str) -> None:
    layout = client.get(f"/api/documents/{brief_id}/original-structure").json()
    row = next(r for t in _tables(layout) for r in t["rows"] if not r.get("structure_review") and not r.get("added"))
    for action, extra in (("correct", {"cells": ["Z" + c for c in row["cells"]]}), ("accept", {})):
        client.post(f"/api/documents/{brief_id}/original-structure/review",
                    json={"records": [row["record_key"]], "action": action, "reason": action, **extra})
    history = client.get(f"/api/documents/{brief_id}/original-structure/history", params={"record_key": row["record_key"]}).json()
    assert [e["new_status"] for e in history["entries"]] == ["edited", "accepted"]
    assert history["entries"][-1]["previous_value"] == row["cells"]  # the printed row, kept
    empty = client.get(f"/api/documents/{brief_id}/original-structure/history", params={"record_key": "field:9:x:y:0"}).json()
    assert empty["entries"] == []


def _grid(rows: list[list[str]], *, header: list[str] | None = None, method: str = "pdf_ruling_lines"):
    from app.source_structure.models import TableCandidate, TableCell

    return TableCandidate(
        candidate_id="t", region_id="t", page=1, bbox=(0, 0, 100, 100), detection_method=method,
        headers=header or [f"Column {i + 1}" for i in range(len(rows[0]))],
        header_cells=[TableCell(row_index=-1, column_index=i, text=h) for i, h in enumerate(header or [])],
        rows=[[TableCell(row_index=r, column_index=c, text=t) for c, t in enumerate(row)] for r, row in enumerate(rows)],
    )


def test_text_cut_into_a_grid_is_set_aside_and_real_tables_kept() -> None:
    from app.source_structure.original_layout import _is_broken_prose

    empty = _grid([["", "", ""]] * 6)
    split = _grid([["[ List name, addr", "ess, telephone", "and contact for suppl", "iers surveyed"], ["", "", "", ""]] * 2)
    sparse = _grid([["", "Product Service Code: S2", "", "", "", ""]] + [[""] * 6] * 9)
    clauses = _grid([["52.202-1", "Definitions.", "Jun 2020"], ["52.204-7", "System for Award Management.", "Nov 2024"], ["52.204-13", "SAM Maintenance.", "Oct 2018"]], method="pdf_column_alignment")
    printed = _grid([["", "", ""], ["", "", ""]], header=["Mod Number", "Description", "Date"])
    assert _is_broken_prose([empty]) and _is_broken_prose([split]) and _is_broken_prose([sparse])
    assert not _is_broken_prose([clauses])
    assert not _is_broken_prose([printed])  # a printed header is always a table
