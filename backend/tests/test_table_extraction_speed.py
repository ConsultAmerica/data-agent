"""Table extraction for large PDFs: one open document per run, a cheap
ruled-grid pre-check, and parallel prefetch — all with unchanged output."""

from __future__ import annotations

from pathlib import Path

import fitz

from app.services.generic_table_extractor import (
    PARALLEL_MIN_PAGES,
    PageTableExtractor,
    extract_page_tables,
    page_may_have_ruled_table,
    prefetch_page_tables,
)


def _pdf(tmp_path: Path, *, grid_pages: set[int], pages: int = 3) -> Path:
    document = fitz.open()
    for number in range(1, pages + 1):
        page = document.new_page()
        page.insert_text((50, 50), f"Page {number} narrative text without any table.", fontsize=10)
        if number in grid_pages:
            # A 3-column, 3-row ruled table.
            x, y, width, height = 60, 100, 120, 24
            for row in range(4):
                page.draw_line((x, y + row * height), (x + 3 * width, y + row * height))
            for column in range(4):
                page.draw_line((x + column * width, y), (x + column * width, y + 3 * height))
            cells = [["Item", "Qty", "Amount"], ["Widget", "2", "10.00"], ["Gadget", "1", "5.00"]]
            for r, row_values in enumerate(cells):
                for c, value in enumerate(row_values):
                    page.insert_text((x + c * width + 6, y + r * height + 16), value, fontsize=10)
    path = tmp_path / "doc.pdf"
    document.save(path)
    return path


def test_pages_without_a_ruled_grid_skip_the_table_pass(tmp_path) -> None:
    path = _pdf(tmp_path, grid_pages={2})
    with fitz.open(path) as document:
        assert not page_may_have_ruled_table(document[0])
        assert page_may_have_ruled_table(document[1])


def test_one_open_document_gives_the_same_tables_as_per_page_opening(tmp_path) -> None:
    path = _pdf(tmp_path, grid_pages={1, 3})
    with fitz.open(path) as document, PageTableExtractor(path) as extractor:
        reused = {n: extractor.page_tables(n, document[n - 1]) for n in (1, 2, 3)}
    for number in (1, 2, 3):
        opened = extract_page_tables(path, number)
        assert [(t["headers"], t["rows"]) for t in reused[number]] == [(t["headers"], t["rows"]) for t in opened]
    assert reused[1] and reused[1][0]["headers"] == ["Item", "Qty", "Amount"]
    assert reused[2] == []


def test_small_documents_do_not_start_worker_processes(tmp_path) -> None:
    path = _pdf(tmp_path, grid_pages={1})
    assert prefetch_page_tables(path, [1, 2, 3]) == {}


def test_parallel_prefetch_matches_sequential_reading(tmp_path) -> None:
    pages = PARALLEL_MIN_PAGES + 2
    path = _pdf(tmp_path, grid_pages=set(range(1, pages + 1, 3)), pages=pages)
    prefetched = prefetch_page_tables(path, list(range(1, pages + 1)))
    if not prefetched:  # one CPU: the sequential path is used instead
        return
    with fitz.open(path) as document, PageTableExtractor(path) as extractor:
        for number in range(1, pages + 1):
            expected = extractor.page_tables(number, document[number - 1])
            assert [(t["headers"], t["rows"]) for t in prefetched[number]] == [(t["headers"], t["rows"]) for t in expected]
