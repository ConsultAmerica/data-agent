"""Key dates / expiry detection for any document (MRZ, contract schedule,
labelled text), status on read, and the portfolio view. All synthetic."""

from __future__ import annotations

from datetime import date, timedelta
from uuid import uuid4

import fitz
import pytest
from fastapi.testclient import TestClient

from app.database.session import SessionLocal
from app.key_dates.detector import _from_text, parse_date_text
from app.main import app
from app.models.document import Document
from app.staging.preparation import prepare_staging
from demo.synthetic import passport_pdf

client = TestClient(app)


def _staged(content: bytes, name: str = "doc.pdf") -> str:
    pdf = fitz.open("pdf", content)
    pdf.set_metadata({"subject": str(uuid4())})
    upload = client.post("/api/documents/upload", files={"file": (f"{uuid4()}-{name}", pdf.tobytes(), "application/pdf")})
    assert upload.status_code == 201, upload.text
    document_id = upload.json()["document_id"]
    assert client.post(f"/api/documents/{document_id}/extract-pages", json={"run_ocr": False}).status_code == 200
    database = SessionLocal()
    try:
        prepare_staging(database, database.get(Document, document_id))
    finally:
        database.close()
    return document_id


def _text_pdf(lines: list[str]) -> bytes:
    pdf = fitz.open()
    page = pdf.new_page()
    for i, line in enumerate(lines):
        page.insert_text((60, 80 + 18 * i), line, fontsize=10)
    return pdf.tobytes()


@pytest.mark.parametrize(
    ("line", "kind", "expected"),
    [
        ("Expiration Date: 04/15/2031", "expiry", date(2031, 4, 15)),
        ("Valid until 31 December 2027", "valid_until", date(2027, 12, 31)),
        ("VALID THRU 08/27", "valid_until", date(2027, 8, 31)),
        ("This agreement automatically renews on March 1, 2027.", "renewal", date(2027, 3, 1)),
        ("Termination Date: 2028-06-30", "termination", date(2028, 6, 30)),
        ("Period of Performance: 01/01/2026 through 12/31/2026", "period_end", date(2026, 12, 31)),
        ("Policy expires on 15.04.2031", "expiry", date(2031, 4, 15)),
    ],
)
def test_labelled_dates_in_text(line, kind, expected) -> None:
    found = {(k.kind, k.date) for k in _from_text([(1, line)])}
    assert (kind, expected) in found


def test_a_date_on_the_next_line_belongs_to_the_label() -> None:
    found = _from_text([(1, "Date of expiry"), (1, "15 APR 2032")])
    assert [(k.kind, k.date) for k in found] == [("expiry", date(2032, 4, 15))]


def test_unlabelled_dates_are_not_key_dates() -> None:
    assert _from_text([(1, "Meeting held on 12 March 2026 at the office.")]) == []


def test_ambiguous_numeric_dates_read_month_first_unless_impossible() -> None:
    assert parse_date_text("04/05/2030", kind="expiry")[0] == date(2030, 4, 5)
    assert parse_date_text("25/05/2030", kind="expiry")[0] == date(2030, 5, 25)


def test_passport_expiry_comes_from_the_mrz() -> None:
    document_id = _staged(passport_pdf(), "passport.pdf")
    body = client.get(f"/api/documents/{document_id}/key-dates").json()
    expiry = body["expiry"]
    assert (expiry["kind"], expiry["date"], expiry["source"]) == ("expiry", "2032-04-15", "mrz")
    assert expiry["confidence"] >= 0.99 and expiry["status"] == "upcoming"


def test_expired_and_expiring_documents_in_the_portfolio() -> None:
    soon = date.today() + timedelta(days=30)
    expired_id = _staged(passport_pdf(expiry=date(2024, 1, 31)), "old-passport.pdf")
    expiring_id = _staged(_text_pdf(["CERTIFICATE OF INSURANCE", f"Policy Expiration Date: {soon.strftime('%m/%d/%Y')}"]), "coi.pdf")

    expired = {r["document_id"] for r in client.get("/api/key-dates", params={"status": "expired"}).json()}
    expiring = {r["document_id"] for r in client.get("/api/key-dates", params={"status": "expiring"}).json()}
    assert expired_id in expired and expiring_id in expiring
    row = next(r for r in client.get("/api/key-dates", params={"status": "expiring"}).json() if r["document_id"] == expiring_id)
    assert row["days_remaining"] == 30 and row["page"] == 1 and "Expiration Date" in row["evidence_text"]


def test_workspace_callers_only_see_their_own_key_dates() -> None:
    from unittest.mock import patch

    from app.core.config import get_settings

    _staged(passport_pdf(expiry=date(2024, 2, 1)), "other.pdf")
    settings = get_settings().model_copy(update={"rbac_enforced": True, "public_workspace_access": True})
    with patch("app.core.auth.get_settings", return_value=settings):
        rows = client.get("/api/key-dates", headers={"X-Workspace-Token": "a" * 64}).json()
    assert rows == []
