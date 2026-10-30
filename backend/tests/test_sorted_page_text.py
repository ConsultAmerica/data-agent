"""sorted_page_text returns exactly page.get_text("text", sort=True)."""

from __future__ import annotations

import fitz
import pytest

from app.services.sorted_page_text import sorted_page_text
from contract_brief_fixture import contract_brief_pdf
from invoice_fixtures import long_invoice_pdf


def _layouts() -> list[tuple[str, bytes]]:
    doc = fitz.open()
    two_columns = doc.new_page()
    for row in range(40):
        two_columns.insert_text((60, 60 + row * 16), f"Left column line {row} with   gaps", fontsize=9)
        two_columns.insert_text((330, 62 + row * 16), f"Right {row}", fontsize=11)
    mixed = doc.new_page()
    for row, size in enumerate([6, 8, 10, 14, 20, 7, 9]):
        mixed.insert_text((50 + row * 7, 80 + row * 30), f"Size {size} heading and value {row * 1.5}", fontsize=size)
    doc.new_page()  # blank: no words
    jitter = doc.new_page()
    for index, offset in enumerate([0, 1.2, 2.8, 3.1, 0.4, 5.0]):
        jitter.insert_text((60 + index * 80, 100 + offset), f"w{index}", fontsize=10)
    layouts = doc.tobytes()
    return [("layouts", layouts), ("contract brief", contract_brief_pdf()), ("invoice", long_invoice_pdf(120))]


@pytest.mark.parametrize("name,content", _layouts(), ids=lambda value: value if isinstance(value, str) else "")
def test_identical_to_pymupdf(name: str, content: bytes) -> None:
    with fitz.open("pdf", content) as doc:
        for page in doc:
            assert sorted_page_text(page) == page.get_text("text", sort=True), f"{name} page {page.number + 1}"
