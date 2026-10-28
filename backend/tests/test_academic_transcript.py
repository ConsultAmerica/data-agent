"""academic_transcript@1 over fictional transcript layouts.

Each layout runs the real pipeline (upload → pages → extraction → staging
preparation, where the structural recognizer resolves the profile) and must
come out as LOGICAL transcript data: labelled student/program fields,
course rows under the document's own column captions, summaries and
secondary information — each value with source evidence, never a
"Column N" fallback or a raw physical cell.

All institutions, people and courses here are invented; nothing in the
profile names any of them.
"""

from __future__ import annotations

import re
from uuid import uuid4

import fitz
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.database.session import SessionLocal
from app.main import app
from app.models.document import Document
from app.models.document_page import DocumentPage
from app.services.v3_orchestrator import run_and_persist_v3_extraction
from app.source_structure.models import StructuredRegion, StructuredSourceDocument, TableCandidate, TableCell
from app.source_structure.pdf_structure import Word
from app.source_structure.service import table_accounts_for_its_words
from app.staging.labels import humanize_label
from app.staging.preparation import prepare_staging
from app.staging.profiles import transcript_vocabulary as V
from app.staging.profiles.academic_transcript import recognize_transcript

client = TestClient(app)


# --- helpers ---------------------------------------------------------------------------------


def _pdf(draw) -> bytes:
    doc = fitz.open()
    page = doc.new_page(width=612, height=792)
    draw(lambda x, y, s, size=10: page.insert_text((x, y), s, fontsize=size))
    doc.set_metadata({"subject": str(uuid4())})
    return doc.tobytes()


def _workbook(name: str, content: bytes, mime: str = "application/pdf") -> dict:
    if mime == "text/html":
        content += f"<!-- {uuid4()} -->".encode()
    upload = client.post("/api/documents/upload", files={"file": (name, content, mime)})
    assert upload.status_code == 201, upload.text
    document_id = upload.json()["document_id"]
    pages = client.post(f"/api/documents/{document_id}/extract-pages", json={"run_ocr": False})
    assert pages.status_code == 200, pages.text
    database = SessionLocal()
    try:
        document = database.get(Document, document_id)
        rows = list(database.scalars(select(DocumentPage).where(DocumentPage.document_id == document_id)))
        run_and_persist_v3_extraction(database=database, document=document, pages=rows)
        prepare_staging(database, document)
    finally:
        database.close()
    response = client.get(f"/api/documents/{document_id}/staging-workbook")
    assert response.status_code == 200, response.text
    workbook = response.json()
    assert workbook["profile"]["profile_id"] == "academic_transcript", workbook["processing_metadata"]
    return workbook


def _dataset(workbook: dict, dataset_id: str) -> dict:
    return next(d for d in workbook["datasets"] if d["dataset_id"] == dataset_id)


def _fields(workbook: dict, dataset_id: str) -> dict[str, dict]:
    """Display label → record cells, for the field-style datasets."""

    out: dict[str, dict] = {}
    for record in _dataset(workbook, dataset_id)["records"]:
        cells = record["cells"]
        by_suffix = {key.rsplit(".", 1)[1]: cell for key, cell in cells.items()}
        out.setdefault(by_suffix["name"]["value"], {**by_suffix, "_record": record})
    return out


def _value(cells: dict) -> str:
    return cells["value"]["value"]


def _courses(workbook: dict) -> list[dict[str, str]]:
    dataset = _dataset(workbook, "academic_record")
    labels = {c["canonical_field"]: c["display_label"] for c in dataset["columns"]}
    return [
        {labels[k]: c["value"] for k, c in r["cells"].items() if c["value"] not in (None, "")}
        for r in dataset["records"]
    ]


def _assert_business_clean(workbook: dict) -> None:
    """No physical-fallback labels anywhere a business user reads, and
    every staged value carries page-level provenance."""

    for dataset in workbook["datasets"]:
        if dataset["role"] != "business":
            continue
        for column in dataset["columns"]:
            assert not re.match(r"^Column \d+$", column["display_label"]), column
        for record in dataset["records"]:
            for key, cell in record["cells"].items():
                text = str(cell["value"] or "")
                assert not re.search(r"\bColumn \d+\b|\(page \d+\)|raster ruling|same line filler|form fill in", text), (key, text)
                if cell["value"] in (None, "") or key.endswith((".category", ".source_label", ".field_id")):
                    continue
                provenance = cell["provenance"]
                assert provenance and (provenance["source_page"] or (provenance.get("source_locator") or {}).get("dom_path")), (key, text)


# --- layouts ---------------------------------------------------------------------------------


def _university(t) -> None:
    t(190, 50, "NORTHFIELD STATE UNIVERSITY", 16)
    t(190, 70, "12 College Road, Rivertown, RT 40012")
    t(150, 84, "Phone: (555) 010-2233")
    t(330, 84, "Email: records@northfield.example")
    t(220, 112, "ACADEMIC TRANSCRIPT", 13)
    t(50, 140, "Name"); t(150, 140, ":"); t(165, 140, "Avery Quinn")
    t(320, 140, "Program / Degree Name"); t(450, 140, ":"); t(462, 140, "Bachelor of Arts in")
    t(462, 153, "Applied Economics")
    t(50, 172, "Student ID"); t(150, 172, ":"); t(165, 172, "NSU-2020-0417")
    t(320, 172, "Year of Graduation"); t(450, 172, ":"); t(462, 172, "2024")
    t(50, 192, "Date of Birth"); t(150, 192, ":"); t(165, 192, "3 March 2002")
    y = 232
    t(50, y, "Semester"); t(120, y, "Course Code"); t(220, y, "Course Title"); t(430, y, "Credits"); t(500, y, "Grade")
    rows = [
        ("I", "ECN101", "Principles of Microeconomics", "3", "A"),
        ("I", "MTH110", "Calculus for Economists", "4", "B+"),
        ("II", "ECN205", "Public Finance and", "4", "A-"),
    ]
    for i, (sem, code, title, credits, grade) in enumerate(rows):
        yy = 252 + 20 * i
        t(55, yy, sem); t(120, yy, code); t(220, yy, title); t(438, yy, credits); t(505, yy, grade)
    t(220, 252 + 20 * 2 + 11, "Fiscal Policy")
    t(55, 318, "II"); t(120, 318, "ECN230"); t(220, 318, "Econometrics"); t(438, 318, "4"); t(505, 318, "B")
    t(50, 380, "Cumulative GPA: 3.62 / 4.00")
    t(360, 410, "Date of Issue"); t(450, 410, ":"); t(462, 410, "12 June 2024")
    t(50, 450, "This transcript is invalid unless signed and sealed by the Registrar.")
    t(60, 490, "Registrar")


def test_university_transcript_is_logical_student_program_and_course_data():
    wb = _workbook(f"transcript-{uuid4()}.pdf", _pdf(_university))
    _assert_business_clean(wb)

    student = _fields(wb, "student_program")
    assert _value(student["Student Name"]) == "Avery Quinn"
    assert student["Student Name"]["source_label"]["value"] == "Name"
    assert _value(student["Student ID"]) == "NSU-2020-0417"
    assert _value(student["Date of Birth"]) == "3 March 2002"
    assert _value(student["Graduation Year"]) == "2024"
    assert _value(student["Institution"]) == "NORTHFIELD STATE UNIVERSITY"

    # A value wrapped onto a second line is ONE logical value; its physical
    # pieces are kept for provenance.
    program = student["Program / Degree"]
    assert _value(program) == "Bachelor of Arts in Applied Economics"
    assert program["source_label"]["value"] == "Program / Degree Name"
    assert program["value"]["review_status"] == "Verified"
    pieces = [c["raw_value"] for c in program["_record"]["source_columns"] if c["raw_header"] == "value"]
    assert pieces == ["Bachelor of Arts in", "Applied Economics"]
    bbox = program["value"]["provenance"]["source_bbox"]
    assert bbox and bbox[3] - bbox[1] > 15  # spans both lines

    courses = _courses(wb)
    assert [c["Course Code"] for c in courses] == ["ECN101", "MTH110", "ECN205", "ECN230"]
    assert courses[2]["Course Title"] == "Public Finance and Fiscal Policy"
    assert courses[0] == {
        "Semester": "I", "Course Code": "ECN101", "Course Title": "Principles of Microeconomics",
        "Credits": "3", "Grade": "A",
    }

    summary = _fields(wb, "academic_summary")
    assert _value(summary["Cumulative GPA"]) == "3.62 / 4.00"

    other = _fields(wb, "other_information")
    assert _value(other["Institution Phone"]) == "(555) 010-2233"
    assert _value(other["Institution Email"]) == "records@northfield.example"
    assert _value(other["Institution Address"]) == "12 College Road, Rivertown, RT 40012"
    assert _value(other["Issue Date"]) == "12 June 2024"
    assert other["Issue Date"]["category"]["value"] == V.CERTIFICATION
    assert "invalid unless signed" in _value(other["Certification Statement"])
    assert _value(other["Signatory"]) == "Registrar"

    # All Fields flattens logical fields; courses as "Course N / <column>".
    all_fields = {
        r["cells"]["transcript.field.name"]["value"]: (r["cells"]["transcript.field.value"]["value"], r["cells"]["transcript.field.category"]["value"])
        for r in _dataset(wb, "all_fields")["records"]
    }
    assert all_fields["Student Name"] == ("Avery Quinn", "Student Information")
    assert all_fields["Program / Degree"] == ("Bachelor of Arts in Applied Economics", "Program Information")
    assert all_fields["Course 1 / Course Code"] == ("ECN101", "Academic Record")
    assert all_fields["Course 3 / Course Title"] == ("Public Finance and Fiscal Policy", "Academic Record")
    assert all_fields["Cumulative GPA"] == ("3.62 / 4.00", "Academic Summary")


def _unit_transcript(t) -> None:
    t(230, 50, "LAKESIDE UNIVERSITY", 16)
    t(240, 75, "ACADEMIC TRANSCRIPT", 12)
    t(60, 110, "Names:"); t(160, 110, "MORGAN ELLIS KARANJA")
    t(60, 128, "Admission No:"); t(160, 128, "11/20457")
    t(60, 146, "Faculty"); t(160, 146, "School of Business")
    t(60, 164, "Course"); t(160, 164, "BACHELOR OF COMMERCE")
    t(400, 197, "CONTACT")
    t(60, 208, "UNIT CODE"); t(160, 208, "UNIT NAME"); t(405, 208, "HOURS"); t(480, 208, "GRADE")
    for i, (code, name, hours, grade) in enumerate(
        [("BCM 101", "Principles of Accounting", "35", "A"), ("BCM 102", "Business Law", "35", "B"), ("BCM 201", "Corporate Finance", "35", "C")]
    ):
        y = 226 + 14 * i
        t(60, y, code); t(160, y, name); t(410, y, hours); t(484, y, grade)
    t(60, 300, "Recommendation")
    t(60, 314, "PASS")
    t(60, 350, "KEY TO GRADING SYSTEM")
    t(60, 366, "A 70 - 100 Excellent")
    t(60, 380, "B 60 - 69 Good")


def test_unit_transcript_keeps_the_documents_own_column_captions():
    wb = _workbook(f"unit-transcript-{uuid4()}.pdf", _pdf(_unit_transcript))
    _assert_business_clean(wb)

    student = _fields(wb, "student_program")
    assert _value(student["Student Name"]) == "MORGAN ELLIS KARANJA"
    assert _value(student["Admission Number"]) == "11/20457"
    # source label exact, display label professional
    assert student["Admission Number"]["source_label"]["value"] == "Admission No"
    assert _value(student["Faculty / School"]) == "School of Business"
    assert _value(student["Program / Degree"]) == "BACHELOR OF COMMERCE"

    dataset = _dataset(wb, "academic_record")
    captions = [c["display_label"] for c in dataset["columns"] if any(r["cells"][c["canonical_field"]]["value"] for r in dataset["records"])]
    assert captions == ["Unit Code", "Unit Name", "Contact Hours", "Grade"]
    assert _courses(wb)[1] == {"Unit Code": "BCM 102", "Unit Name": "Business Law", "Contact Hours": "35", "Grade": "B"}
    # "Recommendation / PASS" is not a course row.
    assert all("PASS" not in c.values() for c in _courses(wb))

    other = _fields(wb, "other_information")
    assert _value(other["Recommendation"]) == "PASS"
    grading = [r for r in _dataset(wb, "other_information")["records"] if r["cells"]["transcript.other_information.category"]["value"] == V.GRADING]
    assert [r["cells"]["transcript.other_information.value"]["value"] for r in grading] == ["A 70 - 100 Excellent", "B 60 - 69 Good"]


def _high_school_panels(t) -> None:
    t(200, 40, "Official High School Transcript", 13)
    t(60, 70, "Student Information"); t(330, 70, "School Information")
    t(40, 88, "Full Name: Riley Tran"); t(310, 88, "Name: Maple Grove Academy")
    t(40, 102, "Date of Birth: 04/11/2005"); t(310, 102, "Graduation Date: June 5, 2023")
    t(40, 116, "Phone Number: (555) 014-7788"); t(310, 116, "Phone Number: (555) 014-9900")
    t(40, 150, "9th Grade"); t(200, 150, "2019-2020"); t(310, 150, "10th Grade"); t(470, 150, "2020-2021")
    for x in (40, 310):
        t(x, 166, "Course Title"); t(x + 160, 166, "Credits"); t(x + 210, 166, "Grade")
    for i, (left, right) in enumerate([(("Algebra 1", "1.0", "B"), ("Geometry", "1.0", "A-")), (("Biology", "1.0", "A"), ("Chemistry", "1.0", "B+"))]):
        y = 182 + 14 * i
        for x, (title, credits, grade) in ((40, left), (310, right)):
            t(x, y, title); t(x + 165, y, credits); t(x + 213, y, grade)
    t(40, 260, "Cumulative GPA: 3.45")


def test_side_by_side_grade_panels_and_student_vs_school_context():
    wb = _workbook(f"hs-transcript-{uuid4()}.pdf", _pdf(_high_school_panels))
    _assert_business_clean(wb)

    student = _fields(wb, "student_program")
    assert _value(student["Student Name"]) == "Riley Tran"
    assert _value(student["Institution"]) == "Maple Grove Academy"  # "Name:" under School Information
    assert _value(student["Phone"]) == "(555) 014-7788"
    assert _value(student["Graduation Date"]) == "June 5, 2023"
    other = _fields(wb, "other_information")
    assert _value(other["Institution Phone"]) == "(555) 014-9900"

    courses = {c["Course Title"]: c for c in _courses(wb)}
    assert courses["Algebra 1"]["Grade Level"] == "9th Grade"
    assert courses["Algebra 1"]["Academic Year"] == "2019-2020"
    assert courses["Chemistry"] == {
        "Academic Year": "2020-2021", "Grade Level": "10th Grade", "Course Title": "Chemistry", "Credits": "1.0", "Grade": "B+",
    }
    assert _value(_fields(wb, "academic_summary")["Cumulative GPA"]) == "3.45"


def _district(t) -> None:
    t(60, 40, "Transcript of Student Progress", 12)
    t(60, 60, "Pine Valley Unified School District")
    t(60, 74, "Cedar Ridge High School")
    t(60, 88, "88 Orchard Lane")
    t(60, 102, "Pine Valley, CA 90001")
    t(60, 130, "March 3, 2022")
    t(60, 150, "Doe, Sam"); t(400, 150, "Class of 2025")
    t(300, 175, "Student ID"); t(400, 175, "State ID")
    t(300, 189, "0045512"); t(400, 189, "0045512")
    t(120, 215, "Crs ID"); t(170, 215, "Course Title"); t(330, 215, "Mark"); t(370, 215, "Attempt"); t(430, 215, "Complete")
    t(60, 231, "North Hills Summer School (01-2222)  Hill Town, CA")
    for y, row in ((245, ("1101", "English Skills", "A", "5.00", "5.00")), (259, ("1102", "Math Skills", "B", "5.00", "5.00"))):
        for x, value in zip((120, 170, 333, 372, 432), row):
            t(x, y, value)
    t(170, 273, "Credit Attempted: 10.00"); t(300, 273, "Credit Completed: 10.00"); t(430, 273, "Academic GPA: 3.50")
    t(60, 287, "Cedar Ridge High School (01-3333)  Pine Valley, CA")
    for y, row in ((301, ("0301", "English 9", "C", "5.00", "5.00")), (315, ("0607", "Algebra", "B-", "5.00", "5.00"))):
        for x, value in zip((120, 170, 333, 372, 432), row):
            t(x, y, value)
    t(170, 329, "Credit Attempted: 10.00"); t(300, 329, "Credit Completed: 10.00"); t(430, 329, "Academic GPA: 2.35")
    t(250, 350, "Total Credit: 20.00")
    t(380, 390, "CREDIT SUMMARY")
    t(320, 406, "Subject Area"); t(420, 406, "Credit Req'd"); t(500, 406, "Completed")
    t(320, 420, "English"); t(430, 420, "40.00"); t(505, 420, "10.00")
    t(320, 434, "Mathematics"); t(430, 434, "30.00"); t(505, 434, "5.00")


def test_district_transcript_sub_sections_term_totals_and_requirements():
    wb = _workbook(f"district-transcript-{uuid4()}.pdf", _pdf(_district))
    _assert_business_clean(wb)

    student = _fields(wb, "student_program")
    assert _value(student["District"]) == "Pine Valley Unified School District"
    assert _value(student["Institution"]) == "Cedar Ridge High School"
    assert _value(student["Graduation Year"]) == "2025"
    assert student["Graduation Year"]["source_label"]["value"] == "Class of"
    assert _value(student["Student ID"]) == "0045512"
    assert _value(student["State ID"]) == "0045512"
    other = _fields(wb, "other_information")
    # The letterhead address ends at the dated line; the student's own
    # lines are never folded into it.
    assert _value(other["Institution Address"]) == "88 Orchard Lane Pine Valley, CA 90001"

    courses = _courses(wb)
    assert [c["Course Code"] for c in courses] == ["1101", "1102", "0301", "0607"]
    assert courses[0]["Section"].startswith("North Hills Summer School")
    assert courses[2]["Section"].startswith("Cedar Ridge High School")
    assert courses[0]["Credits Attempted"] == "5.00" and courses[0]["Credits Completed"] == "5.00"
    assert courses[3]["Mark"] == "B-"

    summary = [
        (r["cells"]["transcript.academic_summary.name"]["value"], r["cells"]["transcript.academic_summary.value"]["value"], r["cells"]["transcript.academic_summary.scope"]["value"])
        for r in _dataset(wb, "academic_summary")["records"]
    ]
    term_gpas = [(value, scope) for name, value, scope in summary if name == "Term GPA"]
    assert [v for v, _ in term_gpas] == ["3.50", "2.35"]
    assert term_gpas[0][1].startswith("North Hills Summer School")
    assert ("Total Credits", "20.00", None) in summary

    requirements = {
        r["cells"]["transcript.other_information.name"]["value"]: r["cells"]["transcript.other_information.value"]["value"]
        for r in _dataset(wb, "other_information")["records"]
        if r["cells"]["transcript.other_information.category"]["value"] == V.REQUIREMENTS
    }
    assert requirements["English"] == "Credit Req'd: 40.00 · Completed: 10.00"


def _year_groups(t) -> None:
    t(60, 40, "Brookside Learning Academy", 14); t(430, 40, "Transcript", 14)
    t(60, 58, "40 River St"); t(200, 58, "(555) 018-4400")
    t(60, 70, "Brookside, ID 83000")
    y = 100
    for year, rows in (("2020-2021", [("Algebra I", "94 (A)", "3", "4.00"), ("Earth Science", "88 (B)", "3", "3.00")]),
                       ("2021-2022: 10th Grade", [("Biology", "91 (A)", "3", "4.00"), ("Spanish I", "85 (B)", "3", "3.00")])):
        t(40, y, year); t(380, y, year.split(":")[0])
        t(40, y + 16, "Course"); t(320, y + 16, "Grade"); t(390, y + 16, "Credits"); t(460, y + 16, "Points")
        for i, (course, grade, credits, points) in enumerate(rows):
            yy = y + 32 + 14 * i
            t(40, yy, course); t(320, yy, grade); t(400, yy, credits); t(462, yy, points)
        y += 90
    t(40, 300, "GPA: 3.50"); t(160, 300, "Total credits earned: 12")
    t(40, 320, "Degree Plan: Science Focus")
    t(40, 350, "Notable Awards")
    t(40, 364, "Regional Science Fair Finalist")
    t(40, 400, "To the best of my knowledge, this record is complete and accurate as of: May 2, 2023.")
    t(200, 460, "School Representative")


def test_year_grouped_tables_summary_awards_and_certification():
    wb = _workbook(f"year-transcript-{uuid4()}.pdf", _pdf(_year_groups))
    _assert_business_clean(wb)

    courses = _courses(wb)
    assert [c["Course Title"] for c in courses] == ["Algebra I", "Earth Science", "Biology", "Spanish I"]
    assert courses[0]["Academic Year"] == "2020-2021" and "Grade Level" not in courses[0]
    assert courses[2]["Academic Year"] == "2021-2022" and courses[2]["Grade Level"] == "10th Grade"
    assert courses[3] == {
        "Academic Year": "2021-2022", "Grade Level": "10th Grade", "Course Title": "Spanish I",
        "Grade": "85 (B)", "Credits": "3", "Grade Points": "3.00",
    }
    summary = _fields(wb, "academic_summary")
    assert _value(summary["Cumulative GPA"]) == "3.50"
    assert _value(summary["Total Credits"]) == "12"
    assert _value(_fields(wb, "student_program")["Degree Plan"]) == "Science Focus"
    assert _value(_fields(wb, "student_program")["Institution"]) == "Brookside Learning Academy"

    other = _dataset(wb, "other_information")["records"]
    by_category = {}
    for record in other:
        by_category.setdefault(record["cells"]["transcript.other_information.category"]["value"], []).append(
            record["cells"]["transcript.other_information.value"]["value"]
        )
    assert by_category[V.HONORS] == ["Regional Science Fair Finalist"]
    assert any("complete and accurate" in v for v in by_category[V.CERTIFICATION])
    assert "School Representative" in by_category[V.CERTIFICATION]
    assert "40 River St Brookside, ID 83000" in by_category[V.INSTITUTION]
    assert "(555) 018-4400" in by_category[V.INSTITUTION]


_HTML = b"""<html><body>
<h1>Harbor College</h1><h2>Official Transcript</h2>
<p><b>Student Name:</b> Casey Lin</p>
<p><b>Student ID:</b> HC-7781</p>
<table><thead><tr><th>Course Code</th><th>Course Title</th><th>Credits</th><th>Grade</th></tr></thead>
<tbody><tr><td>BIO110</td><td>Cell Biology</td><td>4</td><td>A</td></tr>
<tr><td>CHM120</td><td>General Chemistry</td><td>4</td><td>B+</td></tr></tbody></table>
<p><b>Cumulative GPA:</b> 3.55</p>
</body></html>"""


def test_html_transcript_reads_the_dom():
    wb = _workbook(f"transcript-{uuid4()}.html", _HTML, "text/html")
    _assert_business_clean(wb)
    student = _fields(wb, "student_program")
    assert _value(student["Student Name"]) == "Casey Lin"
    assert _value(student["Student ID"]) == "HC-7781"
    assert student["Student ID"]["value"]["provenance"]["source_type"] == "html"
    assert _courses(wb)[1] == {"Course Code": "CHM120", "Course Title": "General Chemistry", "Credits": "4", "Grade": "B+"}
    assert _value(_fields(wb, "academic_summary")["Cumulative GPA"]) == "3.55"


# --- unit level --------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("label", "display"),
    [
        ("Certificate No.", "Certificate Number"),
        ("Registration No.", "Registration Number"),
        ("Roll No.", "Roll Number"),
        ("Attempt(s)", "Attempt"),
        ("UNIT CODE", "Unit Code"),
        ("Student ID#:", "Student ID"),
        ("DTP", "DTP"),
        ("Date of Birth", "Date of Birth"),
    ],
)
def test_display_labels_are_humanized_wording(label, display):
    assert humanize_label(label) == display


def test_vocabulary_names_relational_and_phrase_labels_neutrally():
    assert V.field_spec("whose date of birth is").display_label == "Date of Birth"
    assert V.field_spec("son/daughter of").display_label == "Parent / Guardian Name"
    assert V.field_spec("Registration No.").display_label == "Registration Number"


def _word(text: str, x0: float, y: float) -> Word:
    return Word(text, x0, y, x0 + 6 * len(text), y + 10, 10)


def test_extracted_text_never_shows_a_table_that_lost_its_words():
    words = [_word(w, 10 + 60 * i, 20) for i, w in enumerate(["Semester", "Course", "Code", "Title"])] + [
        _word(w, 10 + 60 * i, 40) for i, w in enumerate(["I", "ENG101", "English", "Composition"])
    ]
    complete = TableCandidate(
        candidate_id="t1", region_id="r1", page=1, bbox=(0, 0, 400, 60), detection_method="raster_ruling_lines",
        headers=["Semester", "Course Code", "Title"],
        header_cells=[TableCell(row_index=-1, column_index=0, text="Semester Course Code Title")],
        rows=[[TableCell(row_index=0, column_index=0, text="I ENG101 English Composition")]],
    )
    assert table_accounts_for_its_words(complete, words)
    lossy = complete.model_copy(update={"header_cells": [], "rows": [[TableCell(row_index=0, column_index=0, text="English")]]})
    assert not table_accounts_for_its_words(lossy, words)


def test_recognizer_needs_academic_structure():
    statement = StructuredSourceDocument(
        document_id="d", source_type="pdf", extractor_version=0,
        regions=[
            StructuredRegion(region_id="h", region_type="HEADING", text="STATEMENT OF ACCOUNT", normalized_text=""),
            StructuredRegion(region_id="p", region_type="PARAGRAPH", text="Item Description Quantity Unit Price Amount", normalized_text=""),
        ],
    )
    assert recognize_transcript(statement).score == 0.0
    transcript = statement.model_copy(
        update={
            "regions": [
                StructuredRegion(region_id="h", region_type="HEADING", text="ACADEMIC TRANSCRIPT", normalized_text=""),
                StructuredRegion(region_id="p", region_type="PARAGRAPH", text="Semester Course Code Course Title Credits Grade", normalized_text=""),
            ]
        }
    )
    assert recognize_transcript(transcript).score >= 0.6


# --- credit and GPA arithmetic (DI: transcript validation) ---------------------------------


def _checks(wb: dict) -> dict[str, dict]:
    rows = _dataset(wb, "academic_checks")["records"]
    return {r["cells"]["transcript.check.name"]["value"]: {k.split(".")[-1]: v["value"] for k, v in r["cells"].items()} for r in rows}


def test_credits_and_gpa_are_recalculated_on_the_printed_scale():
    from demo.synthetic import transcript_pdf

    wb = _workbook(f"transcript-{uuid4()}.pdf", transcript_pdf())
    checks = _checks(wb)
    assert checks["Total credits"]["result"] == "PASS"
    gpa = checks["Cumulative GPA"]
    assert (gpa["computed"], gpa["stated"], gpa["result"]) == ("3.555", "3.55", "PASS")
    assert "printed on the transcript" in gpa["details"]
    summary = _fields(wb, "academic_summary")
    assert summary["Cumulative GPA"]["value"]["review_status"] == "Verified"


def test_a_wrong_stated_gpa_or_credit_total_needs_review():
    from demo.synthetic import transcript_pdf

    wb = _workbook(f"transcript-{uuid4()}.pdf", transcript_pdf(stated_gpa="3.72", stated_credits="25"))
    checks = _checks(wb)
    assert checks["Cumulative GPA"]["result"] == "REVIEW"
    assert "3.55" in checks["Cumulative GPA"]["details"]
    assert checks["Total credits"]["result"] == "REVIEW"
    summary = _fields(wb, "academic_summary")
    assert summary["Cumulative GPA"]["value"]["review_status"] == "Needs Review"
    assert summary["Total Credits"]["value"]["review_status"] == "Needs Review"


def test_gpa_is_not_recalculated_without_a_known_scale():
    from app.staging.profile import RawRecord
    from app.staging.profiles.transcript_checks import academic_checks

    courses = [RawRecord("c1", {"credits": "4", "grade": "Distinction"}), RawRecord("c2", {"credits": "3", "grade": "Merit"})]
    rows = {r.values["check"]: r.values for r in academic_checks(courses, [], "")}
    assert rows["Cumulative GPA"]["result"] == "NOT CHECKED"


def test_us_scale_is_assumed_only_for_letter_grades():
    from app.staging.profile import RawRecord
    from app.staging.profiles.transcript_checks import academic_checks

    courses = [RawRecord("c1", {"credits": "3", "grade": "A"}), RawRecord("c2", {"credits": "3", "grade": "B"})]
    summary = [RawRecord("s", {"field_id": "transcript.summary.cumulative_gpa", "value": "3.50"})]
    rows = {r.values["check"]: r.values for r in academic_checks(courses, summary, "")}
    assert rows["Cumulative GPA"]["result"] == "PASS"
    assert "assumed" in rows["Cumulative GPA"]["details"]
