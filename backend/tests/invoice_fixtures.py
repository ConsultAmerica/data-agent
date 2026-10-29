"""A long, multi-page invoice for export tests: 500 numbered lines, the
table header repeated on each page, totals on the last page."""

from __future__ import annotations

from decimal import Decimal

import fitz


def long_invoice_pdf(lines: int = 500, *, invoice_number: str = "INV-500", marker: str = "") -> bytes:
    doc = fitz.open()
    rows = [
        (f"{index:04d}", f"Part {index:04d} — cable assembly, type “Ω{index % 7}”", (index % 5) + 1, Decimal(f"{(index % 90) + 10}.25"))
        for index in range(1, lines + 1)
    ]
    per_page = 45
    page = None
    y = 0.0

    def t(x, yy, text, size=9.0):
        page.insert_text((x, yy), text, fontsize=size)

    for start in range(0, len(rows), per_page):
        page = doc.new_page(width=612, height=792)
        if start == 0:
            t(60, 50, "Northwind Industrial Parts", 14)
            t(420, 50, "INVOICE", 16)
            t(380, 80, "Invoice Number:"); t(480, 80, invoice_number)
            t(380, 95, "Invoice Date:"); t(480, 95, "2026-10-02")
            t(380, 110, "Due Date:"); t(480, 110, "2026-11-01")
            t(380, 125, "Currency:"); t(480, 125, "USD")
            t(60, 95, "Bill To:"); t(60, 110, "Consult America Demo Corp.")
            y = 160
        else:
            y = 60
        t(60, y, "Item"); t(110, y, "Description"); t(380, y, "Qty"); t(420, y, "Unit Price"); t(500, y, "Amount")
        for item, description, qty, price in rows[start:start + per_page]:
            y += 13
            t(60, y, item); t(110, y, description); t(380, y, str(qty)); t(420, y, f"{price:,.2f}"); t(500, y, f"{qty * price:,.2f}")
    subtotal = sum(qty * price for _, _, qty, price in rows)
    y += 30
    t(400, y, "Subtotal:"); t(500, y, f"{subtotal:,.2f}")
    t(400, y + 15, "Total Due:"); t(500, y + 15, f"{subtotal:,.2f}")
    doc.set_metadata({"title": "Long invoice (fictional)", "subject": f"long-invoice-{invoice_number}-{marker}"})
    return doc.tobytes()
