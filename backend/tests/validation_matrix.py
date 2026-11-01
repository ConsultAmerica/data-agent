"""The upload-validation test matrix: one representative document per
supported type and per source shape (digital, scanned, fillable, mixed,
multipage, multiple contracts, ambiguous labels), each with the labels and
values a correct extraction must show.

Used by tests/test_upload_validation.py and by
scripts/upload_validation_metrics.py (label accuracy, false positives and
negatives, coverage and timing for the report). Every document is built
here, so expected values are known exactly; none comes from a real
customer file.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

import fitz

from app.document_validation import layout_fields
from app.source_structure.original_export import field_value

Line = tuple[str, str]


def fields_by_name(layout: dict) -> dict[str, dict]:
    """A layout's fields by every name they go by: printed, field name and
    recognized display label."""

    names: dict[str, dict] = {}
    for f in layout_fields(layout):
        info = f.get("label_info") or {}
        for name in (f.get("label"), f.get("field_name"), info.get("display")):
            if name:
                names.setdefault(name.rstrip(":"), f)
    return names


def shown_value(field: dict) -> str:
    """The value the Original File shows (a ticked box reads Selected)."""

    return field_value(field)
Table = tuple[str, list[str], list[list[str]]]


def labelled_pdf(title: str, lines: list[Line], tables: list[Table] = (), *, pages: int = 1,
                 prose: str | None = None) -> bytes:
    """A digital page: a title, "Label: value" lines and ruled tables (the
    last page holds the tables when there are several pages)."""

    doc = fitz.open()
    page = doc.new_page(width=612, height=792)
    y = 60
    page.insert_text((72, y), title, fontsize=15, fontname="hebo")
    y += 14
    for label, value in lines:
        y += 18
        page.insert_text((72, y), label, fontsize=10, fontname="hebo")
        page.insert_text((260, y), value, fontsize=10, fontname="helv")
    for heading, headers, rows in tables:
        y += 28
        page.insert_text((72, y), heading, fontsize=12, fontname="hebo")
        top, height = y + 10, 20
        xs = [72 + i * (468 // len(headers)) for i in range(len(headers))] + [540]
        for r in range(len(rows) + 2):
            page.draw_line((xs[0], top + r * height), (xs[-1], top + r * height), width=0.6)
        for x in xs:
            page.draw_line((x, top), (x, top + (len(rows) + 1) * height), width=0.6)
        for c, text in enumerate(headers):
            page.insert_text((xs[c] + 4, top + 14), text, fontsize=9, fontname="hebo")
        for r, row in enumerate(rows, start=1):
            for c, text in enumerate(row):
                page.insert_text((xs[c] + 4, top + r * height + 14), text, fontsize=9, fontname="helv")
        y = top + (len(rows) + 1) * height + 6
    if prose:
        page.insert_textbox(fitz.Rect(72, y + 20, 540, 760), prose, fontsize=9, fontname="helv")
    for number in range(2, pages + 1):
        extra = doc.new_page(width=612, height=792)
        extra.insert_text((72, 60), f"{title} — page {number}", fontsize=11, fontname="hebo")
        extra.insert_textbox(fitz.Rect(72, 80, 540, 760),
                             f"Continuation text for page {number}. " * 20, fontsize=9, fontname="helv")
    data = doc.tobytes()
    doc.close()
    return data


@dataclass
class MatrixDocument:
    name: str
    build: Callable[[], bytes]
    # Families a correct classification may give (None: any, it's a shape test).
    families: tuple[str, ...] | None
    # Printed label → the display label the engine must give it.
    labels: dict[str, str] = field(default_factory=dict)
    # Field name (as printed / displayed) → the value extraction must show.
    values: dict[str, str] = field(default_factory=dict)
    # Tables: heading → (column count, row count).
    tables: dict[str, tuple[int, int]] = field(default_factory=dict)
    tags: tuple[str, ...] = ()
    filename: str = ""
    content_type: str = "application/pdf"
    # A family to set by a reviewer's decision before checking (manual correction).
    decide: str | None = None


def _invoice() -> bytes:
    return labelled_pdf("INVOICE", [
        ("Supplier:", "Acme Supplies Inc."),
        ("Invoice No.:", "INV-1001"),
        ("Invoice Date:", "01/15/2025"),
        ("P.O. No.:", "PO-7788"),
        ("Due Date:", "02/14/2025"),
        ("Bill To:", "Globex Corporation"),
        ("Total Due:", "$1,250.00"),
    ], [("Invoice Lines", ["Description", "Qty", "Unit Price", "Amount"],
         [["Widget A", "10", "$50.00", "$500.00"], ["Widget B", "15", "$50.00", "$750.00"]])],
        prose="Payment terms: Net 30. Please remit payment to Acme Supplies Inc. Thank you for your business.")


def _purchase_order() -> bytes:
    return labelled_pdf("PURCHASE ORDER", [
        ("P.O. No.:", "PO-2025-0042"),
        ("PO Date:", "03/01/2025"),
        ("Supplier:", "Northwind Traders"),
        ("Buyer:", "Contoso Ltd"),
        ("Ship To:", "100 Main Street, Springfield, IL 62701"),
        ("Order Total:", "$3,400.00"),
    ], [("Order Lines", ["Line", "Item", "Quantity", "Unit Price", "Extended"],
         [["1", "Laptop stand", "20", "$70.00", "$1,400.00"], ["2", "Monitor arm", "25", "$80.00", "$2,000.00"]])],
        prose="This purchase order is subject to the buyer's standard terms and conditions of purchase.")


def _bank_statement() -> bytes:
    return labelled_pdf("BANK STATEMENT", [
        ("Account Holder:", "Jane Doe"),
        ("Acct. No.:", "000123456789"),
        ("Statement Period:", "01/01/2025 - 01/31/2025"),
        ("Opening Balance:", "$5,000.00"),
        ("Closing Balance:", "$5,750.00"),
    ], [("Transactions", ["Date", "Description", "Debit", "Credit", "Balance"],
         [["01/05/2025", "Payroll deposit", "", "$1,000.00", "$6,000.00"],
          ["01/20/2025", "Utility payment", "$250.00", "", "$5,750.00"]])],
        prose="Deposits and withdrawals for the statement period. Member FDIC. Checking account summary.")


def _financial_statement() -> bytes:
    return labelled_pdf("TRIAL BALANCE", [
        ("Reporting Entity:", "Acme Holdings LLC"),
        ("Reporting Period:", "Fiscal Year Ended 12/31/2024"),
    ], [("Trial Balance", ["Account", "Debit", "Credit", "Balance"],
         [["1000 Cash", "$12,000.00", "", "$12,000.00"], ["2000 Accounts Payable", "", "$4,000.00", "($4,000.00)"],
          ["3000 Retained Earnings", "", "$8,000.00", "($8,000.00)"]])],
        prose="Financial statement: balance sheet accounts, total debits equal total credits. General ledger trial balance.")


def _passport() -> bytes:
    return labelled_pdf("PASSPORT", [
        ("Surname:", "DOE"),
        ("Given Names:", "JOHN"),
        ("Passport No.:", "X1234567"),
        ("Nationality:", "UNITED STATES OF AMERICA"),
        ("Date of Birth:", "15 Jan 1985"),
        ("Date of Expiry:", "14 Jan 2030"),
    ], prose="P<USADOE<<JOHN<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<\nX1234567<0USA8501151M3001146<<<<<<<<<<<<<<04")


def _receipt() -> bytes:
    return labelled_pdf("RECEIPT", [
        ("Merchant:", "Corner Cafe"),
        ("Transaction Date:", "03/02/2025"),
        ("Tax:", "$1.20"),
        ("Total:", "$15.70"),
    ], [("Items", ["Item", "Qty", "Price"], [["Latte", "2", "$9.00"], ["Muffin", "1", "$5.50"]])],
        prose="Thank you for your purchase. Card payment approved. Receipt total includes sales tax.")


def _far_document() -> bytes:
    return labelled_pdf("FEDERAL ACQUISITION REGULATION", [
        ("Regulation:", "FAR Part 52"),
        ("Clause Number:", "52.204-21"),
        ("Clause Title:", "Basic Safeguarding of Covered Contractor Information Systems"),
        ("Effective Date:", "NOV 2021"),
    ], prose=("52.204-21 Basic Safeguarding of Covered Contractor Information Systems (NOV 2021). "
              "(a) Definitions. As used in this clause, covered contractor information system means an information "
              "system that is owned or operated by a contractor. (b) Safeguarding requirements and procedures. "
              "52.212-4 Contract Terms and Conditions—Commercial Products. 52.219-8 Utilization of Small Business Concerns."))


def _commercial_contract() -> bytes:
    return labelled_pdf("MASTER SERVICES AGREEMENT", [
        ("Agreement Number:", "MSA-2025-001"),
        ("Effective Date:", "January 1, 2025"),
        ("Supplier:", "Blue Ocean Consulting LLC"),
        ("Customer:", "Contoso Ltd"),
        ("Term:", "24 months"),
        ("Contract Value:", "$250,000.00"),
    ], prose=("This Master Services Agreement is entered into by and between the parties. The Supplier shall perform "
              "the services described in each statement of work. Term and termination: this agreement remains in "
              "effect for the term stated above. Governing law. Confidentiality. Indemnification. Limitation of liability."))


def _ambiguous_contract() -> bytes:
    """The value printed beside Contract Number is the next label: the
    contract number box was left empty."""

    return labelled_pdf("AWARD/CONTRACT", [
        ("Contract Number:", "Solicitation Number"),
        ("Solicitation Number:", "W912DY-24-R-0001"),
        ("Contractor:", "Alpha Federal Services LLC"),
        ("Date Issued:", "W912DY-24-R-0001"),
    ], prose="This contract incorporates FAR 52.212-4 and FAR 52.204-21 by reference. Contracting officer signature.")


def _shared_identifier_contract() -> bytes:
    return labelled_pdf("AWARD/CONTRACT", [
        ("Contract Number:", "FA8501-24-C-0042"),
        ("Solicitation Number:", "FA8501-24-C-0042"),
        ("Contractor:", "Beta Systems Inc."),
    ], prose="This contract incorporates FAR 52.212-4 by reference. Contracting officer signature.")


def _scanned_invoice() -> bytes:
    from fixtures.ingestion_ground_truth import image_only_pdf_from_png, render_ground_truth_image

    return image_only_pdf_from_png(render_ground_truth_image(
        "INVOICE", {"Invoice Number": "INV-2026-8914", "Invoice Date": "02/03/2026", "Total": "$412.50"}))


def _mixed() -> bytes:
    from fixtures.ingestion_ground_truth import mixed_native_and_scanned_pdf, render_ground_truth_image

    return mixed_native_and_scanned_pdf(
        native_text="INVOICE  Invoice No.: INV-3003",
        scanned_png=render_ground_truth_image("Remittance", {"Amount Paid": "$90.00"}),
    )


def _multipage() -> bytes:
    return labelled_pdf("INVOICE", [("Invoice No.:", "INV-5005"), ("Total Due:", "$99.00")], pages=6)


def blank_box_form() -> bytes:
    """A fillable form with one filled box, one blank box and an unticked choice."""

    doc = fitz.open()
    page = doc.new_page(width=612, height=792)
    page.insert_text((72, 60), "SOLICITATION, OFFER AND AWARD", fontsize=14, fontname="hebo")

    def box(label, value, rect, kind=fitz.PDF_WIDGET_TYPE_TEXT):
        widget = fitz.Widget()
        widget.field_type = kind
        widget.field_name = f"f{len(list(page.widgets() or []))}"
        widget.field_label = label
        widget.rect = fitz.Rect(*rect)
        widget.field_value = value
        page.add_widget(widget)

    box("2 Enter the Contract Number", "FA300224C0008", (72, 110, 220, 124))
    box("3 Enter the Solicitation Number", "", (230, 110, 380, 124))
    box('4 Click here to select, "Sealed Bid (IFB)" for the Type of Solicitation', False, (400, 110, 410, 120),
        fitz.PDF_WIDGET_TYPE_CHECKBOX)
    data = doc.tobytes()
    doc.close()
    return data


def large_pdf(pages: int = 300) -> bytes:
    doc = fitz.open()
    for number in range(1, pages + 1):
        page = doc.new_page(width=612, height=792)
        page.insert_text((72, 60), f"SECTION {number}", fontsize=12, fontname="hebo")
        if number == 1:
            page.insert_text((72, 90), "Contract No.:", fontsize=10, fontname="hebo")
            page.insert_text((260, 90), "FA300224C0008", fontsize=10, fontname="helv")
        page.insert_textbox(fitz.Rect(72, 110, 540, 760), f"Clause text on page {number}. " * 30, fontsize=9, fontname="helv")
    data = doc.tobytes()
    doc.close()
    return data


def _sf33() -> bytes:
    from test_original_structure import _filled_form_pdf

    return _filled_form_pdf()


def _sf33_ruled() -> bytes:
    from test_original_structure import _ruled_form_pdf

    return _ruled_form_pdf()


def _two_contracts() -> bytes:
    from test_original_structure import _two_contracts_pdf

    return _two_contracts_pdf()


MATRIX: list[MatrixDocument] = [
    MatrixDocument(
        "invoice_digital", _invoice, ("invoice",),
        labels={"Invoice No.": "Invoice Number", "P.O. No.": "Purchase Order Number", "Total Due": "Total Due",
                "Bill To": "Bill To"},
        values={"Invoice No.": "INV-1001", "Invoice Date": "01/15/2025", "P.O. No.": "PO-7788", "Total Due": "$1,250.00"},
        tables={"Invoice Lines": (4, 2)}, tags=("digital", "native_table"),
    ),
    MatrixDocument(
        "purchase_order", _purchase_order, ("purchase_order",),
        labels={"P.O. No.": "Purchase Order Number", "PO Date": "PO Date"},
        values={"P.O. No.": "PO-2025-0042", "PO Date": "03/01/2025", "Order Total": "$3,400.00"},
        tables={"Order Lines": (5, 2)}, tags=("digital", "native_table"),
    ),
    MatrixDocument(
        "bank_statement", _bank_statement, ("bank_statement", "statement"),
        labels={"Acct. No.": "Account Number", "Opening Balance": "Opening Balance"},
        values={"Acct. No.": "000123456789", "Opening Balance": "$5,000.00", "Closing Balance": "$5,750.00"},
        tables={"Transactions": (5, 2)}, tags=("digital", "native_table"),
    ),
    MatrixDocument(
        "financial_statement", _financial_statement, ("financial_statement", "financial_report"),
        labels={"Reporting Entity": "Reporting Entity"},
        values={"Reporting Entity": "Acme Holdings LLC", "Reporting Period": "Fiscal Year Ended 12/31/2024"},
        tables={"Trial Balance": (4, 3)}, tags=("digital", "native_table"),
    ),
    MatrixDocument(
        "passport", _passport, ("passport", "identity_card"),
        labels={"Passport No.": "Passport Number", "Date of Expiry": "Date of Expiry"},
        values={"Passport No.": "X1234567", "Date of Birth": "15 Jan 1985", "Date of Expiry": "14 Jan 2030"},
        tags=("digital",),
    ),
    MatrixDocument(
        "receipt", _receipt, ("receipt", "invoice"),
        labels={"Transaction Date": "Transaction Date"},
        values={"Merchant": "Corner Cafe", "Transaction Date": "03/02/2025", "Total": "$15.70"},
        tables={"Items": (3, 2)}, tags=("digital", "native_table"),
    ),
    MatrixDocument(
        "far_document", _far_document, ("far_regulation", "government_contract", "regulation"),
        labels={"Clause Number": "Clause Number"},
        values={"Clause Number": "52.204-21", "Effective Date": "NOV 2021"},
        tags=("digital",),
    ),
    MatrixDocument(
        "commercial_contract", _commercial_contract,
        ("contract", "master_services_agreement", "supplier_agreement", "government_contract"),
        labels={"Agreement Number": "Agreement Number"},
        values={"Agreement Number": "MSA-2025-001", "Effective Date": "January 1, 2025", "Contract Value": "$250,000.00"},
        tags=("digital",),
    ),
    MatrixDocument(
        "sf33_fillable", _sf33, None,
        labels={"2 Enter the Contract Number": "Contract Number", "3 Enter the Solicitation Number": "Solicitation Number",
                "1 Enter the Rating for this solicitation, offer, and award": "Rating"},
        values={"Contract Number": "FA300224C0008", "Solicitation Number": "FA300223R00090009", "Rating": "DO-C3"},
        tags=("fillable", "checkbox", "duplicate_text"),
    ),
    MatrixDocument("sf33_ruled_form", _sf33_ruled, None, tags=("fillable", "checkbox", "form_table")),
    MatrixDocument(
        "two_contracts", _two_contracts, None,
        values={"Vendor Name": "ALPHA LLC", "Contract No.": "A-100", "Agreement Number": "B-200"},
        tags=("multiple_contracts", "native_table"),
    ),
    MatrixDocument(
        "ambiguous_association", _ambiguous_contract, None, decide="government_contract",
        values={"Solicitation Number": "W912DY-24-R-0001"}, tags=("ambiguous",),
    ),
    MatrixDocument(
        "shared_identifier", _shared_identifier_contract, None, decide="government_contract",
        values={"Contract Number": "FA8501-24-C-0042"}, tags=("ambiguous",),
    ),
    MatrixDocument("scanned_invoice", _scanned_invoice, None, tags=("scanned", "image")),
    MatrixDocument("mixed_pages", _mixed, None, tags=("mixed",)),
    MatrixDocument(
        "multipage_invoice", _multipage, None,
        values={"Invoice No.": "INV-5005"}, tags=("multipage",),
    ),
    MatrixDocument("blank_form_boxes", blank_box_form, None, values={"Contract Number": "FA300224C0008"},
                   tags=("fillable", "blank_boxes", "checkbox")),
]
