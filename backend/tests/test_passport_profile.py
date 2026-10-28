"""passport@1 end to end over synthetic (ICAO "Utopia") passports."""

from __future__ import annotations

from datetime import date
from uuid import uuid4

import fitz
from fastapi.testclient import TestClient

from app.database.session import SessionLocal
from app.main import app
from app.models.document import Document
from app.staging.preparation import prepare_staging
from demo.synthetic import passport_pdf

client = TestClient(app)


def _workbook(content: bytes) -> dict:
    pdf = fitz.open("pdf", content)
    pdf.set_metadata({"subject": str(uuid4())})
    upload = client.post("/api/documents/upload", files={"file": (f"passport-{uuid4()}.pdf", pdf.tobytes(), "application/pdf")})
    assert upload.status_code == 201, upload.text
    document_id = upload.json()["document_id"]
    assert client.post(f"/api/documents/{document_id}/extract-pages", json={"run_ocr": False}).status_code == 200
    database = SessionLocal()
    try:
        prepare_staging(database, database.get(Document, document_id))
    finally:
        database.close()
    body = client.get(f"/api/documents/{document_id}/staging-workbook").json()
    body["_document_id"] = document_id
    return body


def _rows(workbook: dict, dataset_id: str) -> list[dict]:
    dataset = next(d for d in workbook["datasets"] if d["dataset_id"] == dataset_id)
    return [{k: v for k, v in r["cells"].items()} for r in dataset["records"]]


def _by_field(workbook: dict) -> dict[str, dict]:
    return {r["passport.field.name"]["value"]: r for r in _rows(workbook, "passport_data")}


def test_valid_passport_is_recognized_and_consistent() -> None:
    wb = _workbook(passport_pdf())
    assert wb["profile"]["profile_id"] == "passport"
    fields = _by_field(wb)
    number = fields["Passport No."]
    assert number["passport.field.printed"]["value"] == "UT4410275"
    assert number["passport.field.mrz"]["value"] == "UT4410275"
    assert number["passport.field.consistency"]["value"] == "Match"
    assert number["passport.field.printed"]["review_status"] == "Verified"
    assert number["passport.field.printed"]["provenance"]["source_page"] == 1
    assert number["passport.field.printed"]["provenance"]["source_bbox"]
    assert fields["Date of Birth"]["passport.field.mrz"]["value"] == "1990-08-12"
    assert fields["Date of Birth"]["passport.field.consistency"]["value"] == "Match"
    assert fields["Surname"]["passport.field.consistency"]["value"] == "Match"
    assert fields["Given Names"]["passport.field.consistency"]["value"] == "Match"
    assert fields["Nationality"]["passport.field.consistency"]["value"] == "Not comparable"
    assert fields["Place of Birth"]["passport.field.printed"]["value"] == "ZENITH"

    checks = {r["passport.check.name"]["value"]: r["passport.check.result"]["value"] for r in _rows(wb, "mrz_checks")}
    assert checks["Composite check digit"] == "PASS"
    assert set(checks.values()) == {"PASS"}

    validity = _rows(wb, "validity")[0]
    assert validity["passport.validity.expiry_date"]["value"] == "2032-04-15"
    assert validity["passport.validity.status"]["value"] == "Valid"
    assert validity["passport.validity.mrz_format"]["value"] == "TD3"


def test_discrepancies_between_printed_and_mrz_need_review() -> None:
    wb = _workbook(passport_pdf(discrepancy=True))
    fields = _by_field(wb)
    for name in ("Passport No.", "Date of Birth"):
        row = fields[name]
        assert row["passport.field.consistency"]["value"] == "Mismatch", name
        assert row["passport.field.printed"]["review_status"] == "Needs Review"
        assert row["passport.field.mrz"]["review_status"] == "Needs Review"
    assert fields["Surname"]["passport.field.consistency"]["value"] == "Match"
    qa = {r["qa.check"]["value"] for r in _rows(wb, "qa_review")}
    assert {"Consistency: Passport No.", "Consistency: Date of Birth"} <= qa


def test_expired_passport_is_flagged() -> None:
    wb = _workbook(passport_pdf(expiry=date(2024, 1, 31)))
    validity = _rows(wb, "validity")[0]
    assert validity["passport.validity.status"]["value"] == "Expired"
    assert validity["passport.validity.expiry_date"]["review_status"] == "Needs Review"


def test_altered_mrz_fails_check_digits() -> None:
    content = passport_pdf()
    pdf = fitz.open("pdf", content)
    page = pdf[0]
    # Overwrite the second MRZ line with one whose document number was altered.
    from demo.synthetic import td3_mrz

    _, good = td3_mrz(doc_number="UT4410275", issuing_state="UTO", surname="ERIKSSON", given_names="ANNA MARIA",
                      nationality="UTO", birth=date(1990, 8, 12), sex="F", expiry=date(2032, 4, 15))
    tampered = "UT4410276" + good[9:]
    page.add_redact_annot(fitz.Rect(30, 705, 600, 722))
    page.apply_redactions()
    page.insert_text((40, 718), tampered, fontsize=11, fontname="cour")
    wb = _workbook(pdf.tobytes())
    checks = {r["passport.check.name"]["value"]: r["passport.check.result"]["value"] for r in _rows(wb, "mrz_checks")}
    assert checks["Document number check digit"] == "FAIL"
    assert checks["Composite check digit"] == "FAIL"
    number = _by_field(wb)["Passport No."]
    assert number["passport.field.mrz"]["review_status"] == "Needs Review"


def test_values_on_the_label_line_are_read() -> None:
    """Many scans and card layouts print "Surname: DOE" on one line."""

    from demo.synthetic import td3_mrz

    line1, line2 = td3_mrz(doc_number="UT7700112", issuing_state="UTO", surname="OKAFOR", given_names="CHIDI",
                           nationality="UTO", birth=date(1988, 2, 3), sex="M", expiry=date(2033, 6, 30))
    pdf = fitz.open()
    page = pdf.new_page(width=612, height=500)
    for y, text in ((40, "PASSPORT"), (70, "Passport No.: UT7700112"), (90, "Surname: OKAFOR"),
                    (110, "Given names: CHIDI"), (130, "Date of birth: 03 FEB 1988"), (150, "Sex: M"),
                    (170, "Date of expiry: 30 JUN 2033")):
        page.insert_text((40, y), text, fontsize=10, fontname="helv")
    page.insert_text((40, 420), line1, fontsize=11, fontname="cour")
    page.insert_text((40, 438), line2, fontsize=11, fontname="cour")
    wb = _workbook(pdf.tobytes())
    assert wb["profile"]["profile_id"] == "passport"
    fields = _by_field(wb)
    assert fields["Passport No."]["passport.field.printed"]["value"] == "UT7700112"
    assert fields["Surname"]["passport.field.printed"]["value"] == "OKAFOR"
    assert fields["Surname"]["passport.field.consistency"]["value"] == "Match"
    assert fields["Date of Birth"]["passport.field.consistency"]["value"] == "Match"
    assert fields["Date of Expiry"]["passport.field.consistency"]["value"] == "Match"


def test_ocr_photo_layout_reads_despite_garbled_labels_and_merged_rows() -> None:
    """A phone photo read by OCR: labels misread ("Sumame", "Date of th",
    "Oate of Expy"), a tall title merging two rows into one line, value
    rows touching their labels, and labels the profile doesn't know
    ("Tracking Number") beside a known one. Synthetic values."""

    from collections import namedtuple

    from app.staging.profiles.passport import _Line, _read_viz

    W = namedtuple("W", "text x0 y0 x1 y1")

    def line(*words):
        return _Line(1, [W(*w) for w in words], "ocr")

    lines = [
        line(("REPUBLICOF", 25, 269, 93, 277), ("Type", 117, 269, 126, 275), ("Country", 153, 269, 168, 275),
             ("Code", 170, 269, 178, 275), ("Passport", 233, 269, 249, 275), ("Number", 252, 269, 264, 275)),
        line(("UTOPIA", 23, 277, 93, 292), ("Sumame", 116, 282, 134, 288), ("P", 119, 274, 126, 282),
             ("UTO", 155, 274, 173, 283), ("XY1234567", 235, 274, 281, 283)),
        line(("DOE", 118, 286, 169, 297)),
        line(("Given", 117, 295, 128, 301), ("Names", 130, 295, 142, 301)),
        line(("PASSPORT", 40, 298, 90, 306), ("JANE", 117, 299, 140, 306)),
        line(("Date", 116, 321, 125, 327), ("of", 127, 321, 131, 327), ("th", 133, 321, 138, 327),
             ("Citizenship", 160, 321, 182, 327), ("Number", 184, 321, 198, 327)),
        line(("10APR1990", 118, 326, 160, 333), ("12345-6789", 162, 326, 210, 333)),
        line(("Oate", 116, 372, 125, 378), ("of", 127, 372, 131, 378), ("Expy", 133, 372, 142, 378),
             ("Tracking", 160, 372, 178, 378), ("Number", 180, 372, 194, 378)),
        line(("25APR2030", 118, 377, 160, 384), ("11901807759", 162, 377, 210, 384)),
    ]
    readings = {key: reading.value for key, reading in _read_viz(lines).items()}
    assert readings["document_type"] == "P"
    assert readings["issuing_state"] == "UTO"
    assert readings["document_number"] == "XY1234567"
    assert readings["surname"] == "DOE"
    assert readings["given_names"] == "JANE"
    assert readings["birth_date"] == "10APR1990"
    assert readings["expiry_date"] == "25APR2030"
