"""A contract brief laid out like a real one (section labels, sub-labels and
underlined values, a Q&A list, a summary table and a modifications table
that continues across pages). Every name, number and amount is made up."""

from __future__ import annotations

import fitz

# Proportions of the printed form: captions, sub-captions, then values.
LEFT, SUB, VALUE, RIGHT = 60, 220, 336, 548
ANSWER = 420  # value column of the Q&A list on page 3

# (section label, [(sub-label, value)]) in document order; "" = no sub-label.
GENERAL = [
    ("1. Contractor Information", [
        ("Legal Entity", "ORBITAL FIELD SERVICES, LLC"),
        ("Abbreviated Legal Entity", "OFSL"),
        ("Business Size", "HUBZone"),
        ("Cage", "7QRT2"),
    ]),
    ("2. Contract Information", [
        ("Contract Number", "C05550001"),
        ("Contract Name", "OFS JV HORIZON"),
        ("Oracle Project Number", "90TTSC026C0002"),
        ("Date of Award", "07/01/2025"),
        ("Security Classification Level", "Secret"),
        ("DPAS Rating", "DO"),
    ]),
    ("3. Briefed Through", [("", "MOD#12 - 07/15/2026")]),
    ("4. Contract Type", [("", "DIRECT")]),
    ("5. Contract Exercised Value", [("", "$12,345,678.90")]),
    ("6. Contract Potential Value", [("", "$23,456,789.01")]),
    ("7. Period of Performance", [("", "07/01/2025 -")]),
    ("8. Company Role", [("", "Prime")]),
    ("9a. Prime Contractor", [("", "")]),
    ("9b. Prime Contract No.", [("", "")]),
    ("10. Acquisition Agency", [
        ("Agency", "DOD Space Force"), ("Address", ""), ("Point of Contact", ""), ("Email", ""), ("Phone", ""),
    ]),
    ("11. Cognizant DCAA Office", [
        ("Agency", ""), ("Address", ""), ("Point of Contact", ""), ("Email", ""), ("Phone", ""),
    ]),
    ("12. Cognizant ACO", [
        ("Agency", "ACO POC information"), ("Address", ""), ("Point of Contact", ""), ("Email", ""), ("Phone", ""),
    ]),
    ("13. Procurement Regulations", [("", "FAR")]),
    ("14. Cost Accounting Standards (CAS)", [("", "52.230-2")]),
    ("15. Truth in Negotiation Act (TINA)", [("", "52.215-12")]),
    ("16. Is Earned Value Management System (EVMS) reporting required?", [("", "YES")]),
    ("17. Are labor category qualifications required?", [("", "NO")]),
]

QUESTIONS = [
    ("19. Contract clauses incorporated by reference", "YES"),
    ("20. If this is a Time and Material (T&M) or fixed unit price contract?", "YES"),
    ("21. If this is a cost sharing contract, identify the terms of the cost sharing agreement.", "NO"),
    ("22. Does the contract contain a level of effort clause?", "YES"),
    ("23. Does the contract contain ceilings on the indirect rates?", "YES"),
    ("    If yes, identify the limitations.", "$40,000,000.00"),
    ("24. Is Facilities Capital Cost of Money (FCCM) allowable on this contract?", "NO"),
    ("25. Does the contract contain the FAR Penalty Clause (FAR 52.242-3)?", "YES"),
    ("26. Does the contract contain pre-contract or cost allowance restrictions?", "NO"),
    ("27. Does the contract contain restrictions on overtime (FAR 52.222-2)?", "YES"),
    ("28. Does the contract contain restrictions or special requirements for subcontracts?", "YES"),
    ("    If yes, identify the relevant portions.", "Onsite work"),
    ("29. Identify any costs made specifically unallowable by the terms of the contract.", "NO"),
    ("30. Identify any profit or fee provisions in the contract.", "YES"),
    ("31. Identify any other special provisions/limitations specified in the contract.", "Fee plus travel"),
]

SUMMARY_HEADERS = ["Period Name", "Exercised?", "Start", "End", "Cost Value", "Fee Value", "Total Value", "Funding"]
SUMMARY_ROWS = [
    ["Base", "Y", "07/01/2025", "", "$0.00", "$0.00", "$11,111,111.11", "$11,111,111.11"],
    ["OPTION YEAR", "N", "07/01/2026", "", "$0.00", "$0.00", "$2,222,222.22", "$2,222,222.22"],
]

MOD_HEADERS = ["Mod Number", "Mod Description", "Effective Date", "Funding Change", "Total Funding",
               "Cost Ceiling Value", "Fee Ceiling Value", "Total Contract Value", "Exercised Contract Value"]
MOD_COUNT = 82
MOD_ROWS_FIRST_PAGE = 36


def mod_rows(count: int = MOD_COUNT) -> list[list[str]]:
    rows = []
    for number in range(1, count + 1):
        funding = 1_000_000 + number * 12_345.67
        rows.append([
            str(number),
            "AWARD" if number == 1 else (f"TO{5000 + number}" if number % 3 else ""),
            f"08/{(number % 28) + 1:02d}/2025",
            f"${funding:,.2f}",
            f"${funding * 1.1:,.2f}",
            f"${8_000_000 + number * 1000:,.2f}",
            "$0.00",
            f"${9_000_000 + number * 1000:,.2f}",
            "$0.00",
        ])
    return rows


ACCRUAL_ROWS = [
    ["1", "", "08/13/2025", "$5,000,000.00", "$5,000,000.00", "$5,000,000.00", "$0.00", "$5,000,000.00", "$0.00"],
    ["2", "ASSOCIATED", "08/13/2025", "$5,000,000.00", "$5,000,000.00", "$5,000,000.00", "$0.00", "$5,000,000.00", "$0.00"],
]


def _chrome(page: fitz.Page, number: int, total: int) -> None:
    page.insert_text((260, 30), "COMPANY PROPRIETARY", fontsize=8)
    page.insert_text((LEFT, 52), "ORBITAL FIELD SERVICES, JV BU", fontsize=8)
    page.insert_text((LEFT, 62), "100 EXAMPLE DRIVE, SUITE 1", fontsize=8)
    page.insert_text((LEFT, 72), "SPRINGFIELD, ST 00000", fontsize=8)
    page.insert_text((LEFT, 770), "07/01/2026", fontsize=7)
    page.insert_text((480, 770), f"Page {number} of {total}", fontsize=7)


def _heading(page: fitz.Page, y: float, text: str) -> None:
    page.draw_rect(fitz.Rect(LEFT, y - 11, RIGHT, y + 4), color=None, fill=(1, 1, 0.6))
    page.insert_text((250, y), text, fontsize=10)


def _value(page: fitz.Page, y: float, text: str, x: float = VALUE) -> None:
    if text:
        page.insert_text((x, y), text, fontsize=9)
    page.draw_line(fitz.Point(x, y + 3), fitz.Point(RIGHT, y + 3), width=0.5)


def _table(page: fitz.Page, top: float, headers: list[str] | None, rows: list[list[str]], widths: list[float]) -> float:
    x0, height = 50, 12
    xs = [x0]
    for width in widths:
        xs.append(xs[-1] + width)
    y = top
    for line in ([headers] if headers else []) + rows:
        # Headers wrap onto two lines ("Mod / Number"), as printed.
        row_height = height * 2 if line is headers else height
        for index, text in enumerate(line):
            rect = fitz.Rect(xs[index], y, xs[index + 1], y + row_height)
            page.draw_rect(rect, width=0.4, fill=(0.55, 0.55, 0.55) if line is headers else None)
            written = page.insert_textbox(rect + (2, 1, -2, 0), text, fontsize=6)
            assert written >= 0, f"cell text does not fit: {text!r}"
        y += row_height
    return y


def contract_brief_pdf() -> bytes:
    doc = fitz.open()
    total = 6
    for _ in range(total):
        doc.new_page(width=612, height=792)
    pages = [doc[index] for index in range(total)]
    for number, page in enumerate(pages, start=1):
        _chrome(page, number, total)

    page = pages[0]
    _heading(page, 100, "A. General Information")
    y = 125
    for label, items in GENERAL:
        page.insert_text((LEFT, y), label, fontsize=8 if len(label) > 40 else 9)
        for index, (sub, value) in enumerate(items):
            if sub:
                page.insert_text((SUB, y), sub, fontsize=8)
            _value(page, y, value)
            y += 14 if index < len(items) - 1 else 18
    page = pages[1]
    page.insert_text((LEFT, 100), "18. Brief Statement of Scope of Work", fontsize=9)
    _value(page, 100, "OFS SOW")

    page = pages[2]
    _heading(page, 100, "B. Contract Clauses and Special Provisions")
    y = 122
    for label, value in QUESTIONS:
        page.insert_text((LEFT, y), label, fontsize=7.5)
        _value(page, y, value, x=ANSWER)
        y += 17
    _heading(page, y + 8, "Contract Summary")
    _table(page, y + 22, SUMMARY_HEADERS, SUMMARY_ROWS, [66, 50, 56, 50, 62, 56, 76, 76])

    widths = [40, 70, 54, 62, 62, 66, 52, 62, 58]
    page = pages[3]
    _heading(page, 100, "C. Summary of Contract Modifications")
    y = 122
    for label, value in [("Contractor Name", "ORBITAL FIELD SERVICES, LLC"), ("Contract Name", "OFS JV HORIZON"),
                         ("Contract Number", "C05550001"), ("Oracle Project Number", "OFS Demo-Opp-202"),
                         ("Contract Type", "DIRECT"), ("Mod Description", "")]:
        page.insert_text((LEFT, y), label, fontsize=9)
        _value(page, y, value, x=200)
        y += 14
    rows = mod_rows()
    _table(page, y + 8, MOD_HEADERS, rows[:MOD_ROWS_FIRST_PAGE], widths)
    page = pages[4]
    # Continued from page 4 without repeating the header row, as printed.
    _table(page, 90, None, rows[MOD_ROWS_FIRST_PAGE:], widths)

    page = pages[5]
    y = 100
    for label, value in [("Contractor Name", ""), ("Contract Name", "OFS ACCRUALS"), ("Contract Number", "C05550001.00.9999"),
                         ("Oracle Project Number", ""), ("Contract Type", "DIRECT"), ("Mod Description", "ADDING ASSOCIATED PROJECT")]:
        page.insert_text((LEFT, y), label, fontsize=9)
        _value(page, y, value, x=200)
        y += 14
    _table(page, y + 8, MOD_HEADERS, ACCRUAL_ROWS, widths)

    content = doc.tobytes()
    doc.close()
    return content


def expected_fields() -> list[tuple[str, str, str]]:
    """(section, label, value) for every labelled value, in document order."""

    out: list[tuple[str, str, str]] = []
    for label, items in GENERAL:
        for sub, value in items:
            out.append((label, sub or label, value))
    out.append(("18. Brief Statement of Scope of Work", "18. Brief Statement of Scope of Work", "OFS SOW"))
    for label, value in QUESTIONS:
        out.append(("B. Contract Clauses and Special Provisions", label.strip(), value))
    return out
