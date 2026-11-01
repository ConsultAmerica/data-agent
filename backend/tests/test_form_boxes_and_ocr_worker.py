"""Ruled forms on raster pages read box by box, blank fillable forms listed
as printed, and page OCR run off the server's GIL."""

from __future__ import annotations

import shutil
import threading
import time
from concurrent.futures import TimeoutError as FutureTimeoutError
from uuid import uuid4

import fitz
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import ocr_worker
from app.source_structure.original_layout import _box_form_repeat
from app.source_structure.pdf_structure import (
    Word,
    _Ids,
    _raster_form_fields,
    build_lines,
    reconcile_box_value,
)
from app.source_structure.raster_tables import RasterGrid, detect_raster_grids

client = TestClient(app)
needs_tesseract = pytest.mark.skipif(shutil.which("tesseract") is None, reason="Tesseract OCR not installed")

# A W-2-like form, in points: rows whose dividers differ (2 boxes, 1, 3, 4).
FRAME = (50.0, 400.0)
ROWS = [100.0, 130.0, 160.0, 190.0, 220.0]
DIVIDERS = [(225.0, 100.0, 130.0), (165.0, 160.0, 190.0), (285.0, 160.0, 190.0), (140.0, 190.0, 220.0),
            (230.0, 190.0, 220.0), (320.0, 190.0, 220.0)]


def _grid(rules=ROWS, dividers=DIVIDERS, extra_rules=(), extra_spans=()) -> RasterGrid:
    left, right = FRAME
    spans = [(left, rules[0], rules[-1]), (right, rules[0], rules[-1]), *dividers, *extra_spans]
    return RasterGrid(
        columns=sorted({x for x, _, _ in spans}),
        top=min(rules[0], *[s[1] for s in extra_spans] or [rules[0]]),
        bottom=max(rules[-1], *[s[2] for s in extra_spans] or [rules[-1]]),
        row_rules=[(left, y, right, y) for y in rules] + list(extra_rules),
        rule_spans=sorted(spans),
    )


def test_a_grid_whose_dividers_change_by_row_is_a_form_of_boxes() -> None:
    boxes = _grid().form_boxes()
    assert boxes is not None
    assert len(boxes) == 2 + 1 + 3 + 4
    assert boxes[0] == (50.0, 100.0, 225.0, 130.0)
    assert boxes[-1] == (320.0, 190.0, 400.0, 220.0)


def test_a_grid_whose_columns_run_the_full_height_is_a_table() -> None:
    columns = [(150.0, ROWS[0], ROWS[-1]), (250.0, ROWS[0], ROWS[-1])]
    assert _grid(dividers=columns).form_boxes() is None


def test_a_screenshots_page_edges_and_toolbar_are_not_the_form() -> None:
    # A PDF viewer's page edges (wider rules) and toolbar icons (short
    # spans above the form) are in the grid too; the form is the largest
    # set of row rules sharing their ends.
    grid = _grid(
        extra_rules=[(10.0, 20.0, 440.0, 20.0), (10.0, 300.0, 440.0, 300.0)],
        extra_spans=[(10.0, 20.0, 300.0), (440.0, 20.0, 300.0), (60.0, 30.0, 45.0), (90.0, 30.0, 45.0)],
    )
    boxes = grid.form_boxes()
    assert boxes is not None and len(boxes) == 10
    assert all(FRAME[0] <= b[0] and b[2] <= FRAME[1] for b in boxes)


def test_a_tables_grid_is_cut_to_its_frame_and_read_cell_by_cell() -> None:
    # A ruled table (columns through every row) inside a screenshot whose
    # page edges and toolbar icons the grid also picked up.
    columns = [(150.0, ROWS[0], ROWS[-1]), (250.0, ROWS[0], ROWS[-1])]
    grid = _grid(
        dividers=columns,
        extra_rules=[(10.0, 20.0, 440.0, 20.0), (10.0, 300.0, 440.0, 300.0)],
        extra_spans=[(10.0, 20.0, 300.0), (440.0, 20.0, 300.0), (60.0, 30.0, 45.0), (90.0, 30.0, 45.0)],
    )
    assert grid.form_boxes() is None
    framed = grid.framed()
    assert framed.columns == [50.0, 150.0, 250.0, 400.0]
    assert (framed.top, framed.bottom) == (ROWS[0], ROWS[-1])
    cells = framed.cells()
    assert len(cells) == 3 * (len(ROWS) - 1)
    assert cells[0] == (50.0, 100.0, 150.0, 130.0)


def test_a_grid_without_row_rules_is_left_as_detected() -> None:
    grid = RasterGrid(columns=[50.0, 150.0, 250.0], top=100.0, bottom=200.0,
                      rule_spans=[(50.0, 100.0, 200.0), (150.0, 100.0, 200.0), (250.0, 100.0, 200.0)])
    assert grid.framed() is grid
    assert grid.cells() == []


def test_a_drawn_form_image_is_found_as_boxes_and_a_ruled_table_is_not() -> None:
    pytest.importorskip("cv2")
    doc = fitz.open()
    page = doc.new_page(width=450, height=300)
    for y in ROWS:
        page.draw_line((FRAME[0], y), (FRAME[1], y), width=1)
    for x in FRAME:
        page.draw_line((x, ROWS[0]), (x, ROWS[-1]), width=1)
    for x, y0, y1 in DIVIDERS:
        page.draw_line((x, y0), (x, y1), width=1)
    image = fitz.open()
    raster = image.new_page(width=450, height=300)
    raster.insert_image(raster.rect, pixmap=page.get_pixmap(dpi=150))
    grids = detect_raster_grids(raster)
    assert [len(g.form_boxes() or []) for g in grids] == [10]


def _word(text: str, x: float, y: float, height: float) -> Word:
    return Word(text, x, y, x + 6 * len(text), y + height, size=height)


def _form_words() -> list[Word]:
    small, big = 5.0, 9.0
    return [
        # Row 1: "a Employee's SSN" | "d Control number"
        _word("a", 54, 102, small), _word("Employee's", 62, 102, small), _word("SSN", 130, 102, small),
        _word("XXX-XX-4821", 54, 115, big),
        _word("d", 229, 102, small), _word("Control", 237, 102, small), _word("number", 285, 102, small),
        _word("WC-2025-004821", 229, 115, big),
        # Row 2: one box printing two captions side by side.
        _word("e", 54, 132, small), _word("Employee's", 62, 132, small), _word("name", 125, 132, small),
        _word("f", 200, 132, small), _word("Employee's", 208, 132, small), _word("address", 271, 132, small),
        _word("Priya", 54, 145, big), _word("Natarajan", 90, 145, big), _word("—", 150, 145, big),
        _word("118", 204, 145, big), _word("Birchwood", 228, 145, big), _word("Lane", 290, 145, big),
        # Row 3: "1 Wages" | "2 Federal" (no value: printed blank) | "3 Social"
        _word("1", 54, 162, small), _word("Wages", 62, 162, small), _word("$86,420.00", 54, 175, big),
        _word("2", 169, 162, small), _word("Federal", 177, 162, small),
        _word("L7", 289, 162, small), _word("State", 303, 162, small), _word("tax", 337, 162, small),
        _word("$4,732.10", 289, 175, big),
    ]


def _form_fields(page_text: str = ""):
    rows = [ROWS[0], ROWS[1], ROWS[2], ROWS[3]]
    boxes = [(50.0, rows[0], 225.0, rows[1]), (225.0, rows[0], 400.0, rows[1]), (50.0, rows[1], 400.0, rows[2]),
             (50.0, rows[2], 165.0, rows[3]), (165.0, rows[2], 285.0, rows[3]), (285.0, rows[2], 400.0, rows[3])]
    return _raster_form_fields(_Ids(1), 1, build_lines(_form_words()), boxes, "ocr", page_text=page_text)


def test_each_box_is_its_caption_over_its_value() -> None:
    fields = {f.label_text: f for f in _form_fields()}
    assert fields["a Employee's SSN"].raw_value == "XXX-XX-4821"
    assert fields["a Employee's SSN"].box_code == "a"
    assert fields["d Control number"].raw_value == "WC-2025-004821"
    assert fields["1 Wages"].raw_value == "$86,420.00"
    assert all(f.structural_relation == "ruled_form_box" and f.acceptance == "accepted" for f in fields.values())


def test_two_captions_in_one_box_split_its_value_under_them() -> None:
    fields = {f.label_text: f.raw_value for f in _form_fields()}
    assert fields["e Employee's name"] == "Priya Natarajan"
    assert fields["f Employee's address"] == "118 Birchwood Lane"


def test_an_empty_box_is_kept_blank_and_a_misread_code_is_mended() -> None:
    fields = {f.label_text: f for f in _form_fields()}
    assert fields["2 Federal"].raw_value == "" and fields["2 Federal"].acceptance == "accepted"
    # OCR read box 17's code as "L7".
    assert fields["17 State tax"].box_code == "17"
    assert fields["17 State tax"].raw_value == "$4,732.10"


def test_box_fields_keep_the_forms_row_order() -> None:
    codes = [f.box_code for f in _form_fields()]
    assert codes == ["a", "d", "e", "f", "1", "2", "17"]


def test_a_value_the_readings_agree_on_is_not_contested() -> None:
    assert reconcile_box_value(["$1,253.09", "$1,253.09"], "") == ("$1,253.09", False)


def test_the_page_text_settles_a_misread_currency_sign() -> None:
    # The box crop read "$" as "5", the page pass as "3"; the page text holds "$86,420.00".
    value, contested = reconcile_box_value(["586,420.00", "386,420.00"], "1 Wages\n$86,420.00     $14,290.15")
    assert value == "$86,420.00"
    assert contested


def test_without_support_the_boxs_own_reading_stands_and_is_contested() -> None:
    assert reconcile_box_value(["MAM-MM-4821", "XXK-XK-4821"], "") == ("MAM-MM-4821", True)


def test_a_figure_read_as_a_label_on_a_box_form_page_is_hidden() -> None:
    repeat = _box_form_repeat({"label": "Xax-kk-4621", "effective_value": "WC-2025-004821"}, [])
    assert repeat and repeat["code"] == "value_as_label"


def test_two_words_of_one_printed_line_are_not_a_label_and_value() -> None:
    lines = ["2025 | Department of the Treasury— Internal Revenue Service"]
    repeat = _box_form_repeat({"label": "Revenue", "effective_value": "Service"}, lines)
    assert repeat and repeat["code"] == "form_text"
    assert _box_form_repeat({"label": "Employer", "effective_value": "ACME Corp"}, lines) is None


def _blank_form_pdf() -> bytes:
    """A fillable form nobody filled in: numbered captions, empty boxes and
    an unticked choice, plus captions printed side by side that a text
    reader pairs up ("REQUISITION NUMBER" → "8. ADDRESS OFFER TO")."""

    doc = fitz.open()
    page = doc.new_page(width=612, height=300)
    for y in (40, 80, 120):
        page.draw_line((20, y), (592, y), width=0.5)
    page.draw_line((300, 40), (300, 120), width=0.5)
    page.insert_text((24, 50), "2. CONTRACT NUMBER", fontsize=7)
    page.insert_text((304, 50), "3. SOLICITATION NUMBER", fontsize=7)
    page.insert_text((24, 90), "6. REQUISITION/PURCHASE NUMBER", fontsize=7)
    page.insert_text((304, 90), "8. ADDRESS OFFER TO (If other than item 7)", fontsize=7)
    for label, rect in (("2 Enter the Contract Number", (24, 56, 296, 76)),
                        ("3 Enter the Solicitation Number", (304, 56, 588, 76)),
                        ("6 Enter the Requisition/Purchase Number", (24, 96, 296, 116))):
        widget = fitz.Widget()
        widget.field_type = fitz.PDF_WIDGET_TYPE_TEXT
        widget.field_name = f"f{len(list(page.widgets() or []))}"
        widget.field_label = label
        widget.rect = fitz.Rect(*rect)
        page.add_widget(widget)
    return doc.tobytes()


def test_a_blank_fillable_form_lists_its_boxes_and_hides_its_wording_read_as_pairs() -> None:
    response = client.post(
        "/api/documents/upload", files={"file": (f"blank-form-{uuid4().hex[:6]}.pdf", _blank_form_pdf(), "application/pdf")}
    )
    assert response.status_code == 201, response.text
    document_id = response.json()["document_id"]
    assert client.post(f"/api/documents/{document_id}/extract-pages", json={"run_ocr": False}).status_code == 200
    layout = client.get(f"/api/documents/{document_id}/original-structure").json()
    fields = [i for s in layout["sections"] for i in s["items"] if i["kind"] == "field"]
    shown = [f for f in fields if not f.get("form_duplicate")]
    names = {f["field_name"]: f for f in shown}
    assert {"Contract Number", "Solicitation Number", "Requisition/Purchase Number"} <= set(names)
    assert all(names[n]["blank"] for n in ("Contract Number", "Solicitation Number", "Requisition/Purchase Number"))
    # No shown field takes another caption's wording as its value.
    assert not any("ADDRESS OFFER" in (f.get("effective_value") or "").upper() for f in shown)


def _scanned_page_pdf(words: str) -> fitz.Document:
    """A one-page PDF holding only an image of printed text (a scan)."""

    source = fitz.open()
    page = source.new_page(width=420, height=160)
    page.insert_text((20, 50), words, fontsize=16)
    page.insert_text((20, 90), "Invoice Number: INV-2025-0042", fontsize=16)
    scan = fitz.open()
    scan.new_page(width=420, height=160).insert_image(fitz.Rect(0, 0, 420, 160), pixmap=page.get_pixmap(dpi=200))
    return scan


@needs_tesseract
def test_page_ocr_in_the_worker_matches_mupdfs_own_ocr() -> None:
    document = _scanned_page_pdf("Federal Reserve Bank of New York")
    page = document[0]
    expected = page.get_textpage_ocr(language="eng", dpi=300, full=True)
    expected_text = page.get_text("text", textpage=expected, sort=True)
    try:
        text, blocks, words = ocr_worker.ocr_page(document, 0, language="eng", dpi=300, tessdata=None, timeout_seconds=60)
    finally:
        ocr_worker.shutdown()
    assert text == expected_text
    assert "INV-2025-0042" in text
    assert words and all(len(w) >= 5 for w in words)


@needs_tesseract
def test_page_ocr_leaves_the_server_responsive() -> None:
    document = _scanned_page_pdf("The quick brown fox jumps over the lazy dog " * 2)
    gaps: list[float] = []
    stop = threading.Event()

    def tick() -> None:
        last = time.perf_counter()
        while not stop.is_set():
            time.sleep(0.01)
            now = time.perf_counter()
            gaps.append(now - last)
            last = now

    ticker = threading.Thread(target=tick)
    ticker.start()
    try:
        ocr_worker.ocr_page(document, 0, language="eng", dpi=400, tessdata=None, timeout_seconds=60)
    finally:
        stop.set()
        ticker.join()
        ocr_worker.shutdown()
    # In-process, MuPDF held the GIL for the whole page.
    assert max(gaps) < 0.5


@needs_tesseract
def test_an_overrunning_page_is_stopped_and_the_next_page_still_reads() -> None:
    document = _scanned_page_pdf("Timeout check")
    try:
        with pytest.raises(FutureTimeoutError):
            ocr_worker.ocr_page(document, 0, language="eng", dpi=300, tessdata=None, timeout_seconds=0.001)
        text, _, _ = ocr_worker.ocr_page(document, 0, language="eng", dpi=300, tessdata=None, timeout_seconds=60)
        assert "INV-2025-0042" in text
    finally:
        ocr_worker.shutdown()


def test_the_worker_stops_after_the_last_document_using_it() -> None:
    ocr_worker.begin()
    ocr_worker.begin()
    ocr_worker._worker()
    ocr_worker.end()
    assert ocr_worker._executor is not None  # one document still reading
    ocr_worker.end()
    assert ocr_worker._executor is None
