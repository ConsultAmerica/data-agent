"""Builders for the three demo documents (all fictional):

* a passport data page (printed zone + ICAO TD3 MRZ with real check
  digits), optionally with a deliberate printed/MRZ discrepancy;
* an academic transcript with terms, credits, grades and a stated GPA;
* a supplier invoice with a PO number, lines, tax and totals.

Native-text PDFs, so the demo runs without OCR installed.
"""

from __future__ import annotations

from datetime import date

import fitz

from app.validators.mrz import check_digit

MONTHS = ("JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC")


def _pad(text: str, length: int) -> str:
    return (text + "<" * length)[:length]


def td3_mrz(*, doc_number: str, issuing_state: str, surname: str, given_names: str, nationality: str,
            birth: date, sex: str, expiry: date, personal: str = "") -> tuple[str, str]:
    name = _pad(surname.upper().replace(" ", "<") + "<<" + given_names.upper().replace(" ", "<"), 39)
    line1 = _pad("P<" + issuing_state + name, 44)
    number = _pad(doc_number, 9)
    dob = birth.strftime("%y%m%d")
    exp = expiry.strftime("%y%m%d")
    optional = _pad(personal, 14)
    body = (
        number + str(check_digit(number)) + nationality + dob + str(check_digit(dob)) + sex
        + exp + str(check_digit(exp)) + optional + str(check_digit(optional))
    )
    composite = body[0:10] + body[13:20] + body[21:43]
    return line1, body + str(check_digit(composite))


def _viz_date(d: date) -> str:
    return f"{d.day:02d} {MONTHS[d.month - 1]} {d.year}"


def passport_pdf(*, discrepancy: bool = False, expiry: date = date(2032, 4, 15)) -> bytes:
    """A Utopia passport data page. With `discrepancy`, the printed date of
    birth and passport number differ from what the MRZ encodes."""

    holder = dict(doc_number="UT4410275", issuing_state="UTO", surname="ERIKSSON", given_names="ANNA MARIA",
                  nationality="UTO", birth=date(1990, 8, 12), sex="F", expiry=expiry)
    line1, line2 = td3_mrz(**holder)
    printed_birth = date(1990, 8, 21) if discrepancy else holder["birth"]
    printed_number = "UT4410257" if discrepancy else holder["doc_number"]

    doc = fitz.open()
    page = doc.new_page(width=612, height=792)

    def t(x, y, text, size=9, font="helv"):
        page.insert_text((x, y), text, fontsize=size, fontname=font)

    t(200, 70, "UTOPIA", 16)
    t(200, 92, "PASSPORT / PASSEPORT", 12)
    page.draw_rect(fitz.Rect(60, 120, 180, 280), color=(0.6, 0.6, 0.6))
    t(85, 205, "[photo]")
    t(200, 140, "Type", 7); t(260, 140, "Code of Issuing State", 7); t(420, 140, "Passport No.", 7)
    t(200, 154, "P", 10); t(260, 154, "UTO", 10); t(420, 154, printed_number, 10)
    t(200, 180, "Surname / Nom", 7)
    t(200, 194, holder["surname"], 10)
    t(200, 220, "Given names / Prenoms", 7)
    t(200, 234, holder["given_names"], 10)
    t(200, 260, "Nationality", 7)
    t(200, 274, "UTOPIAN", 10)
    t(200, 300, "Date of birth", 7); t(420, 300, "Sex", 7)
    t(200, 314, _viz_date(printed_birth), 10); t(420, 314, holder["sex"], 10)
    t(200, 340, "Place of birth", 7)
    t(200, 354, "ZENITH", 10)
    t(200, 380, "Date of issue", 7); t(420, 380, "Authority", 7)
    t(200, 394, _viz_date(date(expiry.year - 10, expiry.month, expiry.day)), 10); t(420, 394, "PASSPORT OFFICE", 10)
    t(200, 420, "Date of expiry", 7)
    t(200, 434, _viz_date(expiry), 10)
    t(40, 700, line1, 11, "cour")
    t(40, 718, line2, 11, "cour")
    doc.set_metadata({"title": "Specimen passport (fictional)", "subject": f"demo-passport-{discrepancy}-{expiry}"})
    return doc.tobytes()


# --- transcript --------------------------------------------------------------------------

TRANSCRIPT_COURSES = (
    ("Fall 2022", "CS101", "Introduction to Programming", 4, "A"),
    ("Fall 2022", "MTH120", "Calculus I", 4, "B+"),
    ("Fall 2022", "ENG105", "Academic Writing", 3, "A-"),
    ("Spring 2023", "CS150", "Data Structures", 4, "A"),
    ("Spring 2023", "MTH130", "Calculus II", 4, "B"),
    ("Spring 2023", "PHY101", "General Physics I", 3, "B+"),
)


def transcript_pdf(*, stated_gpa: str = "3.55", stated_credits: str = "22") -> bytes:
    """Six courses, 22 credits, GPA 3.55 (78.2 / 22) on the printed 4.0 scale. Pass a
    different stated GPA/credits to demonstrate a discrepancy."""

    doc = fitz.open()
    page = doc.new_page(width=612, height=792)

    def t(x, y, text, size=10):
        page.insert_text((x, y), text, fontsize=size)

    t(190, 50, "RIVERBEND INSTITUTE OF TECHNOLOGY", 14)
    t(240, 72, "OFFICIAL ACADEMIC TRANSCRIPT", 11)
    t(60, 105, "Student Name:"); t(170, 105, "Jordan Ellis Avery")
    t(60, 122, "Student ID:"); t(170, 122, "RIT-2022-0815")
    t(60, 139, "Program:"); t(170, 139, "Bachelor of Science in Computer Science")
    t(60, 156, "Date of Birth:"); t(170, 156, "14 February 2004")
    y = 190
    t(60, y, "Term"); t(150, y, "Course Code"); t(240, y, "Course Title"); t(450, y, "Credits"); t(510, y, "Grade")
    for term, code, title, credits, grade in TRANSCRIPT_COURSES:
        y += 18
        t(60, y, term); t(150, y, code); t(240, y, title); t(450, y, str(credits)); t(510, y, grade)
    y += 40
    t(60, y, "Total Credits:"); t(170, y, stated_credits)
    t(60, y + 17, "Cumulative GPA:"); t(170, y + 17, stated_gpa)
    t(60, y + 50, "Grading Scale: A = 4.0, A- = 3.7, B+ = 3.3, B = 3.0, B- = 2.7, C+ = 2.3, C = 2.0, D = 1.0, F = 0.0", 8)
    t(60, y + 80, "Issue Date:"); t(170, y + 80, "30 June 2023")
    t(60, y + 97, "Registrar:"); t(170, y + 97, "Office of the Registrar")
    doc.set_metadata({"title": "Demo transcript (fictional)", "subject": f"demo-transcript-{stated_gpa}-{stated_credits}"})
    return doc.tobytes()


# --- invoice -----------------------------------------------------------------------------


def invoice_pdf(*, supplier: str = "Northwind Office Supply Co.", po_number: str = "PO-4500012345",
                address: str = "1200 Harbor Way, Suite 400, Seattle, WA 98101",
                invoice_number: str = "NW-20481") -> bytes:
    lines = (
        ("Ergonomic office chair", 4, 289.00),
        ("Standing desk frame", 2, 415.50),
        ("Monitor arm, dual", 4, 96.25),
    )
    subtotal = sum(q * p for _, q, p in lines)
    tax = round(subtotal * 0.0825, 2)
    total = round(subtotal + tax, 2)

    doc = fitz.open()
    page = doc.new_page(width=612, height=792)

    def t(x, y, text, size=10):
        page.insert_text((x, y), text, fontsize=size)

    t(60, 60, supplier, 15)
    t(60, 78, address, 9)
    t(60, 92, "billing@northwind-supply.example", 9)
    t(420, 60, "INVOICE", 18)
    t(380, 100, "Invoice Number:"); t(480, 100, invoice_number)
    t(380, 117, "Invoice Date:"); t(480, 117, "10/02/2026")
    t(380, 134, "Due Date:"); t(480, 134, "11/01/2026")
    t(380, 151, "PO Number:"); t(480, 151, po_number)
    t(380, 168, "Currency:"); t(480, 168, "USD")
    t(60, 130, "Bill To:")
    t(60, 147, "Consult America Demo Corp.")
    t(60, 164, "77 Main Street, Austin, TX 78701")
    y = 220
    t(60, y, "Description"); t(330, y, "Qty"); t(390, y, "Unit Price"); t(480, y, "Amount")
    for description, qty, price in lines:
        y += 18
        t(60, y, description); t(330, y, str(qty)); t(390, y, f"{price:,.2f}"); t(480, y, f"{qty * price:,.2f}")
    y += 36
    t(390, y, "Subtotal:"); t(480, y, f"{subtotal:,.2f}")
    t(390, y + 17, "Sales Tax (8.25%):"); t(480, y + 17, f"{tax:,.2f}")
    t(390, y + 34, "Total Due:"); t(480, y + 34, f"{total:,.2f}")
    t(60, y + 80, "Payment terms: Net 30", 9)
    doc.set_metadata({"title": "Demo invoice (fictional)", "subject": f"demo-invoice-{invoice_number}-{po_number}"})
    return doc.tobytes()
