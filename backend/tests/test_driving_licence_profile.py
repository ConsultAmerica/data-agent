"""driving_licence@1: US (abbreviated labels) and EU (numbered fields)
cards are recognised, read and date-checked."""

from __future__ import annotations

from datetime import date
from uuid import uuid4

import fitz
from fastapi.testclient import TestClient

from app.database.session import SessionLocal
from app.main import app
from app.models.document import Document
from app.staging.preparation import prepare_staging
from app.staging.profiles.driving_licence import licence_date

client = TestClient(app)


def _card(lines: list[tuple[float, float, str]]) -> bytes:
    pdf = fitz.open()
    page = pdf.new_page(width=612, height=400)
    for x, y, text in lines:
        page.insert_text((x, y), text, fontsize=10, fontname="helv")
    pdf.set_metadata({"subject": str(uuid4())})
    return pdf.tobytes()


def us_licence(expiry: str = "01/15/2031") -> bytes:
    return _card([
        (40, 40, "STATE OF UTOPIA  DRIVER LICENSE"),
        (40, 70, "DL  D1234567"),
        (40, 90, "CLASS  C"),
        (300, 90, "END  NONE"),
        (40, 110, "LN  RIVERA"),
        (40, 130, "FN  SOFIA ANN"),
        (40, 150, "DOB  03/22/1994"),
        (300, 150, "SEX  F"),
        (40, 170, "ISS  01/15/2023"),
        (300, 170, "EXP  " + expiry),
        (40, 190, "HGT  5-06"),
        (300, 190, "EYES  BRN"),
        (40, 210, "RSTR  B"),
        (40, 230, "ADDRESS  12 OAK AVE, SPRINGFIELD"),
    ])


def eu_licence() -> bytes:
    return _card([
        (40, 40, "DRIVING LICENCE"),
        (40, 70, "1. MUSTERMANN"),
        (40, 90, "2. ERIKA"),
        (40, 110, "3. 12.08.1985"),
        (40, 130, "4a. 05.03.2020"),
        (300, 130, "4b. 04.03.2035"),
        (40, 150, "4c. STADT UTOPIA"),
        (40, 170, "5. B072RRE2I55"),
        (40, 190, "9. AM/B/L"),
    ])


def _workbook(content: bytes) -> dict:
    upload = client.post("/api/documents/upload", files={"file": (f"licence-{uuid4()}.pdf", content, "application/pdf")})
    assert upload.status_code == 201, upload.text
    document_id = upload.json()["document_id"]
    assert client.post(f"/api/documents/{document_id}/extract-pages", json={"run_ocr": False}).status_code == 200
    database = SessionLocal()
    try:
        prepare_staging(database, database.get(Document, document_id))
    finally:
        database.close()
    return client.get(f"/api/documents/{document_id}/staging-workbook").json()


def _rows(workbook: dict, dataset_id: str) -> list[dict]:
    dataset = next(d for d in workbook["datasets"] if d["dataset_id"] == dataset_id)
    return [r["cells"] for r in dataset["records"]]


def _fields(workbook: dict) -> dict[str, str]:
    return {r["licence.field.name"]["value"]: r["licence.field.value"]["value"] for r in _rows(workbook, "licence_data")}


def test_us_licence_is_recognised_and_read() -> None:
    wb = _workbook(us_licence())
    assert wb["profile"]["profile_id"] == "driving_licence"
    fields = _fields(wb)
    assert fields["Licence Number"] == "D1234567"
    assert fields["Surname"] == "RIVERA"
    assert fields["Given Names"] == "SOFIA ANN"
    assert fields["Date of Birth"] == "03/22/1994"
    assert fields["Issue Date"] == "01/15/2023"
    assert fields["Expiry Date"] == "01/15/2031"
    assert fields["Class / Categories"] == "C"
    assert fields["Sex"] == "F"
    assert fields["Eye Colour"] == "BRN"
    assert fields["Restrictions"] == "B"
    assert fields["Address"] == "12 OAK AVE, SPRINGFIELD"
    checks = {r["licence.check.name"]["value"]: r["licence.check.result"]["value"] for r in _rows(wb, "licence_checks")}
    assert set(checks.values()) == {"PASS"}
    validity = _rows(wb, "validity")[0]
    assert validity["licence.validity.status"]["value"] == "Valid"
    assert validity["licence.validity.expiry_date"]["value"] == "2031-01-15"
    assert validity["licence.validity.issue_date"]["value"] == "2023-01-15"
    # Printed dates are found on the card, so they are not held for review.
    dates = {r["licence.field.name"]["value"]: r["licence.field.value"]["review_status"] for r in _rows(wb, "licence_data")}
    assert dates["Date of Birth"] == dates["Expiry Date"] == "Verified"


def test_eu_numbered_fields_are_read() -> None:
    wb = _workbook(eu_licence())
    assert wb["profile"]["profile_id"] == "driving_licence"
    fields = _fields(wb)
    assert fields["Surname"] == "MUSTERMANN"
    assert fields["Given Names"] == "ERIKA"
    assert fields["Date of Birth"] == "12.08.1985"
    assert fields["Issue Date"] == "05.03.2020"
    assert fields["Expiry Date"] == "04.03.2035"
    assert fields["Issuing Authority"] == "STADT UTOPIA"
    assert fields["Licence Number"] == "B072RRE2I55"
    assert fields["Class / Categories"] == "AM/B/L"


def test_expired_licence_needs_review() -> None:
    wb = _workbook(us_licence(expiry="01/15/2024"))
    validity = _rows(wb, "validity")[0]
    assert validity["licence.validity.status"]["value"] == "Expired"
    assert validity["licence.validity.expiry_date"]["review_status"] == "Needs Review"


def test_licence_dates_read_us_and_eu_forms() -> None:
    assert licence_date("03/22/1994") == date(1994, 3, 22)
    assert licence_date("12.08.1985") == date(1985, 8, 12)
    assert licence_date("15 JAN 2031") == date(2031, 1, 15)
    assert licence_date("NONE") is None


def test_each_value_keeps_the_label_it_was_printed_under() -> None:
    wb = _workbook(us_licence())
    labels = {r["licence.field.name"]["value"]: r["licence.field.label"]["value"] for r in _rows(wb, "licence_data")}
    assert labels["Sex"] == "SEX"
    assert labels["Expiry Date"] == "EXP"
    assert labels["Class / Categories"] == "CLASS"
    assert labels["Endorsements"] == "END"
