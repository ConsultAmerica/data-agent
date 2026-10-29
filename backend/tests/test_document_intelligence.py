"""Increment 6B.1: document intelligence — classification, date
intelligence and lifecycle status (app/key_dates/lifecycle.py,
app/key_dates/intelligence.py, GET /{id}/intelligence)."""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from app.database.session import SessionLocal
from app.key_dates.detector import _from_text, document_convention, is_ambiguous
from app.key_dates.lifecycle import DateCandidate, evaluate
from app.models.document_metadata_field import DocumentMetadataField
from demo.synthetic import passport_pdf
from tests.test_key_dates import _staged, _text_pdf, client

TODAY = date(2026, 10, 29)


def c(kind: str, when: date | None, **extra) -> DateCandidate:
    return DateCandidate(kind=kind, date=when, original_text=when.isoformat() if when else None, source="text",
                         page=1, evidence=None, confidence=0.9, **extra)


def status(family, candidates, warning_days=30):
    return evaluate(family, candidates, today=TODAY, warning_days=warning_days)


# ── lifecycle rules ──────────────────────────────────────────────────


def test_expired_expiring_today_active_and_not_yet_effective() -> None:
    assert status("passport", [c("expiry", TODAY - timedelta(days=1))]).status == "expired"
    assert status("passport", [c("expiry", TODAY)]).status == "expires_today"
    soon = status("insurance_policy", [c("expiry", TODAY + timedelta(days=20))])
    assert (soon.status, soon.days_remaining) == ("expiring_soon", 20)
    assert status("insurance_policy", [c("expiry", TODAY + timedelta(days=45))]).status == "active"
    # The warning window is configurable (30 / 60 / 90).
    assert status("insurance_policy", [c("expiry", TODAY + timedelta(days=45))], warning_days=60).status == "expiring_soon"
    future = status("contract", [c("effective", TODAY + timedelta(days=10)), c("period_end", TODAY + timedelta(days=400))])
    assert future.status == "not_yet_effective" and future.start.kind == "effective"


def test_documents_that_dont_expire_are_not_applicable() -> None:
    invoice = status("invoice", [c("due", TODAY - timedelta(days=5)), c("issue", TODAY - timedelta(days=35))])
    assert invoice.status == "not_applicable"
    assert invoice.payment_due is not None and invoice.end is None
    assert any("payment date, not an expiry" in r for r in invoice.reasons)
    assert status("academic_transcript", [c("issue", TODAY)]).status == "not_applicable"


def test_missing_expiration_is_reported_and_expected_ones_say_so() -> None:
    passport = status("passport", [c("issue", TODAY - timedelta(days=100))])
    assert passport.status == "no_expiration_date"
    assert "normally states one" in passport.reasons[0]
    assert status("generic_business", []).status == "no_expiration_date"


def test_conflicting_or_ambiguous_dates_need_review_instead_of_a_silent_choice() -> None:
    conflict = status("passport", [c("expiry", date(2031, 4, 15)), c("expiry", date(2032, 4, 15))])
    assert conflict.status == "needs_review"
    assert "Conflicting expiration dates: 2031-04-15, 2032-04-15." == conflict.review_required[0]
    ambiguous = c("expiry", date(2027, 3, 4), ambiguous=True, interpretations=["2027-03-04", "2027-04-03"])
    ambiguous.original_text = "03/04/2027"
    result = status("insurance_policy", [ambiguous])
    assert result.status == "needs_review"
    assert "could be 2027-03-04 or 2027-04-03" in result.review_required[0]


def test_an_approved_date_wins_and_settles_a_conflict_or_ambiguity() -> None:
    approved = c("expiry", date(2032, 4, 15), approved=True)
    resolved = status("passport", [c("expiry", date(2031, 4, 15)), c("expiry", date(2032, 4, 15)), approved])
    assert resolved.status == "active" and resolved.end.approved


def test_contract_end_uses_the_base_period_not_option_periods() -> None:
    base = c("period_end", TODAY + timedelta(days=200))
    option = c("period_end", TODAY + timedelta(days=900), option=True)
    result = status("government_contract", [c("award", TODAY - timedelta(days=30)), base, option])
    assert result.end is base and result.status == "active" and result.start.kind == "award"
    only_options = status("government_contract", [option])
    assert only_options.status == "needs_review"


# ── date detection ───────────────────────────────────────────────────


def test_effective_start_and_expiration_dates_keep_their_original_text() -> None:
    found = {d.kind: d for d in _from_text([
        (1, "Effective Date: January 15, 2026"),
        (1, "Coverage start date: 2026-02-01"),
        (2, "Policy Expiration Date: 2027-01-31"),
        (2, "Date of award: 12/20/2025"),
    ])}
    assert found["effective"].date == date(2026, 1, 15) and found["effective"].details["original_text"] == "January 15, 2026"
    assert found["start"].date == date(2026, 2, 1)
    assert found["expiry"].date == date(2027, 1, 31) and found["expiry"].page == 2
    assert found["award"].date == date(2025, 12, 20)


def test_a_period_gives_its_start_and_end() -> None:
    found = _from_text([(1, "Period of performance: 01/15/2026 through 01/14/2027")])
    kinds = {d.kind: d.date for d in found}
    assert kinds == {"start": date(2026, 1, 15), "period_end": date(2027, 1, 14)}


def test_ambiguous_numeric_dates_are_flagged_with_both_readings() -> None:
    assert is_ambiguous("03/04/2026") and not is_ambiguous("04/04/2026") and not is_ambiguous("25/04/2026")
    assert not is_ambiguous("15.04.2026")
    [found] = _from_text([(1, "Expiration date: 03/04/2027")])
    assert found.details["ambiguous"] is True
    assert found.details["interpretations"] == ["2027-03-04", "2027-04-03"]


def test_document_context_resolves_ambiguity_only_when_it_agrees() -> None:
    assert document_convention([(1, "Issued 25/04/2026"), (1, "Expires 03/04/2027")]) == "day_first"
    assert document_convention([(1, "Issued 04/25/2026")]) == "month_first"
    assert document_convention([(1, "25/04/2026 and 04/25/2026")]) is None
    assert document_convention([(1, "03/04/2027")]) is None


# ── API ──────────────────────────────────────────────────────────────


def intelligence(document_id: str, **params) -> dict:
    response = client.get(f"/api/documents/{document_id}/intelligence", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def test_passport_is_classified_identity_and_expires_from_its_mrz() -> None:
    body = intelligence(_staged(passport_pdf(expiry=date(2032, 4, 15)), "passport.pdf"))
    assert body["classification"]["document_type"] == "passport"
    assert body["classification"]["category_label"].lower().startswith("identity")
    assert body["classification"]["engine_version"]
    expiration = body["lifecycle_dates"]["expiration"]
    assert (expiration["date_type"], expiration["normalized_date"], expiration["source"]) == ("expiration_date", "2032-04-15", "mrz")
    assert expiration["page"] == 1 and expiration["evidence_text"]
    assert body["lifecycle"]["status"] in {"active", "expiring_soon"}


def test_bank_statement_and_invoice_are_finance_documents_without_expiry() -> None:
    statement = intelligence(_staged(_text_pdf([
        "FIRST NATIONAL BANK", "ACCOUNT STATEMENT", "Statement period: 09/01/2026 through 09/30/2026",
        "Beginning balance 1,000.00", "Total deposits 500.00", "Total withdrawals 200.00", "Ending balance 1,300.00",
    ]), "statement.pdf"))
    assert statement["classification"]["document_type"] == "statement"
    assert statement["lifecycle"]["status"] == "not_applicable"

    invoice = intelligence(_staged(_text_pdf([
        "INVOICE", "Invoice Number: INV-2291", "Invoice Date: 2026-09-01", "Payment due date: 2026-10-01",
        "Bill To: Acme Corp", "Subtotal 100.00", "Tax 8.00", "Total Due 108.00",
    ]), "invoice.pdf"))
    assert invoice["classification"]["document_type"] == "invoice"
    assert invoice["lifecycle"]["status"] == "not_applicable"
    assert invoice["lifecycle_dates"]["expiration"] is None
    assert invoice["lifecycle_dates"]["payment_due"]["normalized_date"] == "2026-10-01"


def test_unknown_documents_need_confirmation_and_say_why() -> None:
    body = intelligence(_staged(_text_pdf(["Notes from the planning meeting", "We discussed lunch options."]), "notes.pdf"))
    assert body["classification"]["requires_confirmation"] is True
    assert "isn't calibrated" in body["review_required"][0]


def test_ambiguous_expiry_is_flagged_with_no_normalized_date() -> None:
    body = intelligence(_staged(_text_pdf(["CERTIFICATE OF INSURANCE", "Policy Expiration Date: 03/04/2031"]), "coi.pdf"))
    candidate = next(d for d in body["date_candidates"] if d["date_type"] == "expiration_date")
    assert candidate["validation_status"] == "ambiguous" and candidate["normalized_date"] is None
    assert candidate["original_text"] == "03/04/2031"
    assert body["lifecycle"]["status"] == "needs_review"


def test_human_review_is_preserved_across_re_detection_and_used_for_lifecycle() -> None:
    document_id = _staged(_text_pdf(["CERTIFICATE OF INSURANCE", "Policy Expiration Date: 03/04/2031"]), "coi2.pdf")
    database = SessionLocal()
    try:
        database.add(DocumentMetadataField(
            document_id=document_id, field_group="Dates", field_key="expiration_date", label="Expiration Date",
            value="2031-04-03", confidence=0.9, extraction_method="label_value", evidence_json={"page_number": 1},
            verified=True, human_approved=True, review_status="edited", original_value="03/04/2031",
            extraction_source="contract",
        ))
        database.commit()
    finally:
        database.close()
    assert client.post(f"/api/documents/{document_id}/key-dates/refresh").status_code == 200
    body = intelligence(document_id)
    approved = [d for d in body["date_candidates"] if d["review_status"] == "approved"]
    assert approved and approved[0]["normalized_date"] == "2031-04-03"
    # The extracted (ambiguous) value is still reported, separately.
    assert any(d["review_status"] == "not_reviewed" and d["validation_status"] == "ambiguous" for d in body["date_candidates"])
    assert body["lifecycle_dates"]["expiration"]["review_status"] == "approved"
    assert body["lifecycle"]["status"] == "active"


def test_warning_period_is_30_60_or_90() -> None:
    document_id = _staged(_text_pdf(["CERTIFICATE OF INSURANCE", f"Policy Expiration Date: {(date.today() + timedelta(days=45)).isoformat()}"]), "coi3.pdf")
    assert intelligence(document_id)["lifecycle"]["status"] == "active"
    assert intelligence(document_id, warning_days=60)["lifecycle"]["status"] == "expiring_soon"
    assert client.get(f"/api/documents/{document_id}/intelligence", params={"warning_days": 45}).status_code == 422


def test_document_list_shows_lifecycle_and_filters_expired() -> None:
    expired_id = _staged(passport_pdf(expiry=date(2024, 1, 31)), "expired-passport.pdf")
    client.get(f"/api/documents/{expired_id}/intelligence")
    listed = client.get("/api/documents/search", params={"lifecycle": "expired", "limit": 100}).json()["documents"]
    row = next(d for d in listed if d["document_id"] == expired_id)
    assert row["lifecycle_status"] == "expired" and row["lifecycle_end_date"] == "2024-01-31" and row["file_format"] == "pdf"
    assert all(d["lifecycle_status"] == "expired" for d in listed)


def test_an_ambiguous_expiry_is_never_counted_as_expired_or_shown_as_a_date() -> None:
    document_id = _staged(_text_pdf(["CERTIFICATE OF INSURANCE", "Policy Expiration Date: 03/04/2024"]), "coi-old.pdf")
    body = client.get(f"/api/documents/{document_id}/key-dates").json()
    assert body["expiry"]["status"] == "ambiguous" and body["expiry"]["ambiguous"] is True
    assert body["expiry"]["original_text"] == "03/04/2024"
    assert body["expiry"]["interpretations"] == ["2024-03-04", "2024-04-03"]
    expired = {r["document_id"] for r in client.get("/api/key-dates", params={"status": "expired"}).json()}
    assert document_id not in expired
    listed = client.get("/api/documents/search", params={"lifecycle": "needs_review", "limit": 100}).json()["documents"]
    row = next(d for d in listed if d["document_id"] == document_id)
    assert row["lifecycle_end_date"] is None and row["lifecycle_review"] is True
