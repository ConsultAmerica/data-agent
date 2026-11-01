"""Upload verification, document classification and field label validation
(app/document_validation), across the document matrix in
tests/validation_matrix.py: actual labels and values, not only that a job
completed."""

from __future__ import annotations

import time
from uuid import uuid4

import fitz
import pytest
from fastapi.testclient import TestClient

from app.database.session import SessionLocal
from app.document_validation.association import looks_like_label, skill_label_vocabulary, type_mismatch
from app.document_validation.consistency import tab_export_consistency
from app.document_validation.labels import recognize_label
from app.main import app
from app.models.extraction_job import ExtractionJob
from app.source_structure.original_export import Row, original_rows
from app.document_validation import layout_fields, layout_tables
from validation_matrix import MATRIX, MatrixDocument, fields_by_name, large_pdf, shown_value

client = TestClient(app)


def _upload(content: bytes, name: str, content_type: str = "application/pdf", suffix: str = ".pdf", **params) -> dict:
    response = client.post(
        "/api/documents/upload",
        files={"file": (f"{name}-{uuid4().hex[:6]}{suffix}", content, content_type)},
        params=params,
    )
    return {"status": response.status_code, "body": response.json()}


def _ingest(content: bytes, name: str) -> str:
    uploaded = _upload(content, name)
    assert uploaded["status"] == 201, uploaded
    document_id = uploaded["body"]["document_id"]
    assert client.post(f"/api/documents/{document_id}/extract-pages", json={"run_ocr": False}).status_code == 200
    return document_id


def _report(document_id: str) -> dict:
    response = client.get(f"/api/documents/{document_id}/upload-validation")
    assert response.status_code == 200, response.text
    return response.json()


def _layout(document_id: str) -> dict:
    return client.get(f"/api/documents/{document_id}/original-structure").json()


# ---------------------------------------------------------------- labels


@pytest.mark.parametrize(("printed", "family", "form", "item", "display"), [
    ("2 Enter the Contract Number", "government_contract", True, "2", "Contract Number"),
    ("3 Enter the Solicitation Number", "government_contract", True, "3", "Solicitation Number"),
    ("1 Code of Federal Regulations", "government_contract", True, "1", "Code of Federal Regulations"),
    ("Invoice No.", "invoice", False, "", "Invoice Number"),
    ("P.O. No.", "purchase_order", False, "", "Purchase Order Number"),
    ("Acct. No.", "bank_statement", False, "", "Account Number"),
    ("9. Prime Contractor", "government_contract", False, "9", "Prime Contractor"),
    ("contract_no", None, False, "", "Contract Number"),
])
def test_labels_are_cleaned_and_the_printed_label_is_kept(printed, family, form, item, display) -> None:
    label = recognize_label(printed, family, form=form)
    assert (label.item_number, label.display) == (item, display)
    assert label.printed == printed and label.resolved


@pytest.mark.parametrize(("printed", "family"), [
    ("P.O. Box", "invoice"),  # not a purchase order
    ("Total Due", "invoice"),  # "Due" names the field
    ("Yes / No", None),  # "No" is an answer here
    ("30 Day Notice", None),  # a number that is part of the label
    ("Code of Federal Regulations", None),
])
def test_meaningful_words_are_never_removed(printed, family) -> None:
    assert recognize_label(printed, family).display == printed


def test_aliases_are_document_type_specific_and_meanings_are_kept_apart() -> None:
    # "P.O. No." is written out only where a purchase order is meant.
    assert recognize_label("P.O. No.", None).display == "P.O. Number"
    # A synonym records the meaning; the printed label stays as printed.
    bill_to = recognize_label("Bill To:", "invoice")
    assert (bill_to.display, bill_to.meaning) == ("Bill To", "Customer")
    assert recognize_label("Bill To:", "bank_statement").meaning is None


def test_a_label_that_names_nothing_is_unresolved_not_guessed() -> None:
    for printed in ("Text1", "Check Box3", "undefined", ""):
        assert not recognize_label(printed).resolved


# ---------------------------------------------------------------- association rules


def test_a_label_read_as_a_value_is_recognised() -> None:
    vocabulary = set(skill_label_vocabulary())
    assert looks_like_label("Solicitation Number", vocabulary)
    assert looks_like_label("Contract No.:", vocabulary)
    # Values, even when they're printed captions elsewhere.
    for value in ("FA300224C0008", "Contractor", "Firm Fixed Price", "ALPHA LLC"):
        assert not looks_like_label(value, vocabulary)


def test_a_value_that_isnt_its_labels_type_is_found() -> None:
    assert type_mismatch("Date Issued", "W912DY-24-R-0001") == "invalid_date"
    assert type_mismatch("Total Amount", "Net thirty") == "invalid_number"
    for label, value in (("Date Issued", "21 Apr 2023"), ("Total Amount", "$1,200.00"), ("Invoice Date", "N/A"),
                         ("Total Number of Pages", "12"), ("Effective Date", "NOV 2021")):
        assert type_mismatch(label, value) is None, (label, value)


# ---------------------------------------------------------------- upload refusals


def test_a_corrupt_pdf_is_refused_with_its_cause() -> None:
    uploaded = _upload(b"%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntruncated", "corrupt")
    assert uploaded["status"] in (400, 422)
    # The actual cause, not a generic failure.
    detail = str(uploaded["body"]["detail"]).lower()
    assert any(word in detail for word in ("corrupt", "malformed", "no pages", "any pages")), detail


def test_a_password_protected_pdf_is_refused_with_its_cause() -> None:
    doc = fitz.open()
    doc.new_page().insert_text((72, 72), "Confidential")
    content = doc.tobytes(encryption=fitz.PDF_ENCRYPT_AES_256, user_pw="secret", owner_pw="owner")
    uploaded = _upload(content, "locked")
    assert uploaded["status"] in (400, 422)
    assert "password" in str(uploaded["body"]).lower() or "encrypt" in str(uploaded["body"]).lower()


def test_a_file_that_isnt_what_its_extension_says_is_refused() -> None:
    assert _upload(b"MZ\x90\x00 not a pdf at all", "fake")["status"] == 400


def test_zip_and_email_uploads_stay_refused() -> None:
    assert _upload(b"PK\x03\x04" + b"\x00" * 40, "bundle", "application/zip", ".zip")["status"] in (400, 415, 422)
    eml = b"From: a@example.com\r\nTo: b@example.com\r\nSubject: Invoice\r\n\r\nPlease find attached."
    assert _upload(eml, "mail", "message/rfc822", ".eml")["status"] in (400, 415, 422)


def test_a_duplicate_upload_is_held_and_then_flagged() -> None:
    content = large_pdf(2)
    first = _ingest(content, "dup")
    held = _upload(content, "dup")
    assert held["status"] in (200, 201) and held["body"]["status"] == "duplicate_pending"
    second = _upload(content, "dup", allow_duplicate="true")
    assert second["status"] in (200, 201), second
    report = _report(second["body"]["document_id"])
    duplicate = next(c for c in report["file"]["checks"] if c["code"] == "duplicate")
    assert duplicate["status"] == "warning"
    assert first in {d["id"] for d in duplicate["documents"]}


# ---------------------------------------------------------------- tab / Excel consistency


def test_a_difference_between_the_tab_and_the_export_is_reported() -> None:
    document_id = _ingest(MATRIX[0].build(), "consistency")
    layout = _layout(document_id)
    assert tab_export_consistency(layout)["status"] == "consistent"
    rows = original_rows(layout)
    # A table row lost on the way to the workbook, and a value changed.
    table_row = next(i for i, r in enumerate(rows) if r.kind == "table_row")
    field_row = next(i for i, r in enumerate(rows) if r.kind == "field")
    tampered = [r for i, r in enumerate(rows) if i != table_row]
    tampered[field_row] = Row("field", [rows[field_row].values[0], rows[field_row].values[1], "changed"])
    result = tab_export_consistency(layout, rows=tampered)
    failed = {c["key"] for c in result["checks"] if c["status"] == "inconsistent"}
    assert result["status"] == "inconsistent"
    assert {"tables", "field_values"} <= failed


# ---------------------------------------------------------------- jobs


def test_a_failed_job_is_retried_once_as_a_new_job_and_an_active_job_isnt_duplicated() -> None:
    document_id = _ingest(large_pdf(1), "jobs")
    database = SessionLocal()
    try:
        failed = ExtractionJob(
            document_id=document_id, job_type="processing", status="failed", stage="rendering_ocr",
            error_message="OCR engine crashed",
            result_json={"failure": {"stage": "rendering_ocr", "reason": "extraction_failed", "retryable": True,
                                     "message": "OCR engine crashed"}},
        )
        blocked = ExtractionJob(
            document_id=document_id, job_type="processing", status="failed", stage="verifying_file",
            error_message="The PDF is password-protected",
            result_json={"failure": {"stage": "verifying_file", "reason": "file_invalid", "retryable": False}},
        )
        database.add_all([failed, blocked])
        database.commit()
        failed_id, blocked_id = failed.id, blocked.id
    finally:
        database.close()

    report = _report(document_id)
    stage = next(s for s in report["processing"]["stages"] if s["status"] == "failed")
    assert stage["failure"]["reason"] == "file_invalid" and stage["failure"]["retryable"] is False

    assert client.post(f"/v1/jobs/{blocked_id}/retry").status_code == 409
    retried = client.post(f"/v1/jobs/{failed_id}/retry")
    assert retried.status_code == 202, retried.text
    body = retried.json()
    assert body["retry_count"] == 1 and body["result"]["retry_of"] == failed_id
    finished = client.get(f"/v1/jobs/{body['id']}").json()
    assert finished["status"] == "complete", finished
    # Its stages, in order, with the new ones recorded.
    stages = [entry["stage"] for entry in finished["result"]["stage_history"]]
    assert stages[0] == "reading_document" and "classifying" in stages and stages[-1] == "complete"
    assert "verifying_file" in stages or finished["result"].get("pages_reused")
    # The retry reused the pages already read: no page is stored twice.
    pages = client.get(f"/api/documents/{document_id}/progress").json()
    assert pages["page_total"] == 1

    database = SessionLocal()
    try:
        running = ExtractionJob(document_id=document_id, job_type="processing", status="processing", stage="indexing")
        database.add(running)
        database.commit()
        running_id = running.id
    finally:
        database.close()
    again = client.post(f"/api/documents/{document_id}/jobs/process")
    assert again.json()["id"] == running_id


def test_a_job_failure_records_where_and_why() -> None:
    from app.services.extraction_job_runner import FileVerificationError, failure_reason
    from app.services.document_storage import DocumentStorageError

    assert failure_reason(FileVerificationError("locked")) == ("file_invalid", False)
    assert failure_reason(DocumentStorageError("gone")) == ("source_unavailable", True)
    assert failure_reason(TimeoutError()) == ("timeout", True)
    assert failure_reason(RuntimeError("boom")) == ("unexpected_error", True)


# ---------------------------------------------------------------- the document matrix


def _prepared(doc: MatrixDocument) -> str:
    document_id = _ingest(doc.build(), doc.name)
    if doc.decide:
        # A reviewer's type correction, then targeted revalidation.
        decided = client.post(f"/api/documents/{document_id}/classification/decision",
                              json={"action": "override", "family": doc.decide, "apply": True})
        assert decided.status_code == 200, decided.text
    return document_id


@pytest.fixture(scope="module")
def matrix() -> dict[str, tuple[str, dict, dict]]:
    out = {}
    for doc in MATRIX:
        document_id = _prepared(doc)
        out[doc.name] = (document_id, _report(document_id), _layout(document_id))
    return out


@pytest.mark.parametrize("doc", MATRIX, ids=[d.name for d in MATRIX])
def test_every_document_passes_through_verification_classification_and_validation(doc: MatrixDocument, matrix) -> None:
    document_id, report, layout = matrix[doc.name]
    # File verification and every stage, in order.
    assert report["file"]["status"] in ("verified", "warning")
    assert [s["key"] for s in report["processing"]["stages"]] == [
        "uploading", "file_verified", "classifying", "extracting", "validating", "ready_for_review"]
    assert all(s["status"] == "done" for s in report["processing"]["stages"]), report["processing"]
    # The type is right, or it's held for review — never a confident wrong type.
    classification = report["classification"]
    if doc.decide:
        assert classification["decided"] and classification["family"] == doc.decide
    elif doc.families is not None and classification["family"] not in doc.families:
        assert classification["status"] != "classified", classification
    # Readiness is one of the three states, with its note.
    assert report["readiness"]["state"] in ("ready", "ready_with_warnings", "review_required")
    assert "doesn't confirm that an Oracle target is configured" in report["readiness"]["note"]
    # The Original File tab and its Excel export agree.
    assert report["consistency"]["status"] == "consistent", [
        c for c in report["consistency"]["checks"] if c["status"] != "consistent"]


@pytest.mark.parametrize("doc", [d for d in MATRIX if d.labels or d.values or d.tables], ids=lambda d: d.name)
def test_labels_values_and_tables_are_the_documents_own(doc: MatrixDocument, matrix) -> None:
    _, _, layout = matrix[doc.name]
    fields = list(layout_fields(layout))
    for printed, display in doc.labels.items():
        field = next((f for f in fields if (f.get("label_info") or {}).get("printed", "").rstrip(":") == printed), None)
        assert field is not None, f"{printed!r} not found among {[f['label'] for f in fields]}"
        assert field["label_info"]["display"] == display
        # The printed wording stays on the record.
        assert field["label"].rstrip(":") == printed
    names = fields_by_name(layout)
    for name, value in doc.values.items():
        assert name in names, f"{name!r} not found among {sorted(names)}"
        assert shown_value(names[name]) == value
    tables = {t.get("title"): t for t in list(layout_tables(layout)) if not t.get("form_duplicate")}
    for title, (columns, rows) in doc.tables.items():
        table = tables.get(title) or next((t for t in tables.values() if len(t["headers"]) == columns), None)
        assert table is not None, f"table {title!r} not found among {list(tables)}"
        assert (len(table["headers"]), table["row_count"]) == (columns, rows)


def test_a_fillable_sf33_keeps_every_filled_box_with_its_item_number(matrix) -> None:
    _, report, layout = matrix["sf33_fillable"]
    measures = {m["key"]: m for m in report["completeness"]["measures"]}
    assert (measures["form_fields"]["source"], measures["form_fields"]["represented"]) == (6, 6)
    assert measures["checkboxes"]["status"] == "complete"
    assert report["file"]["facts"]["filled_form_boxes"] == 6
    names = fields_by_name(layout)
    # Contract and solicitation numbers are separate fields with their own values.
    assert shown_value(names["Contract Number"]) == "FA300224C0008"
    assert shown_value(names["Solicitation Number"]) == "FA300223R00090009"
    assert names["Contract Number"]["label_info"]["item_number"] == "2"
    assert shown_value(names["Negotiated (RFP)"]) == "Selected"
    # The page text repeating a box's value is not a second field.
    assert [shown_value(f) for f in list(layout_fields(layout))].count("FA300224C0008") == 1


def test_a_ruled_sf33_reads_selected_and_unselected_boxes_and_its_form_tables(matrix) -> None:
    _, report, layout = matrix["sf33_ruled_form"]
    measures = {m["key"]: m for m in report["completeness"]["measures"]}
    assert measures["form_fields"]["status"] == "complete"
    assert measures["checkboxes"]["represented"] == measures["checkboxes"]["source"] >= 2
    choices = {f["field_name"]: f.get("choice") for f in list(layout_fields(layout)) if f.get("form_state")}
    assert choices["Negotiated (RFP)"] == "Selected" and choices["Sealed Bid (IFB)"] == "Not Selected"
    titles = {t.get("title") for t in list(layout_tables(layout)) if t.get("form_table")}
    assert {"Table of Contents", "Acknowledgment of Amendments"} <= titles
    # The grid read over the form's ruled cells is shown as the form's boxes, in both views.
    assert any(t.get("form_duplicate") for t in list(layout_tables(layout)))
    assert report["consistency"]["status"] == "consistent"


def test_blank_boxes_are_blank_in_the_source_not_missing(matrix) -> None:
    _, report, layout = matrix["blank_form_boxes"]
    measures = {m["key"]: m for m in report["completeness"]["measures"]}
    # One filled box, represented; the empty one isn't counted as omitted.
    assert (measures["form_fields"]["source"], measures["form_fields"]["represented"]) == (1, 1)
    assert report["file"]["facts"]["form_boxes"] == 3
    assert measures["checkboxes"]["detail"] == "0 selected, 1 not selected"
    assert report["completeness"]["status"] == "complete"


def test_a_label_read_as_a_value_is_never_assigned_to_a_critical_field(matrix) -> None:
    document_id, report, _ = matrix["ambiguous_association"]
    business = client.get(f"/api/documents/{document_id}/business-data").json()
    fields = {f["key"]: f for s in business["sections"] for f in s["fields"]}
    contract = fields["contract_number"]
    # Not "Solicitation Number": no value is chosen, the candidate is kept.
    assert contract["value"] is None
    assert "Solicitation Number" in [c["value"] for c in contract["candidates"]]
    assert "value_is_label" in [i["code"] for i in contract["issues"]]
    assert fields["solicitation_number"]["value"] == "W912DY-24-R-0001"
    assert report["readiness"]["state"] == "review_required"
    blockers = {c["key"] for c in report["readiness"]["checks"] if c["status"] == "blocker"}
    assert "identifiers" in blockers
    validation = client.get(f"/api/documents/{document_id}/validation-summary").json()
    association = next(g for g in validation["groups"] if g["kind"] == "incorrect_association")
    assert any("is a label" in i["message"] for i in association["issues"])


def test_two_identifiers_with_one_value_need_review(matrix) -> None:
    _, report, _ = matrix["shared_identifier"]
    review = {f["label"] for f in report["association"]["needs_review"]}
    assert review == {"Contract Number", "Solicitation Number"}
    assert report["readiness"]["state"] == "review_required"


def test_a_document_with_several_contracts_is_flagged_for_isolation(matrix) -> None:
    _, report, _ = matrix["two_contracts"]
    assert report["entities"]["contracts"] == ["A-100", "B-200", "C-300"]
    isolation = next(c for c in report["readiness"]["checks"] if c["key"] == "isolation")
    assert isolation["status"] == "warning" and "3 contracts" in isolation["detail"]


def test_scanned_and_mixed_pages_are_told_apart_and_unread_pages_arent_claimed(matrix) -> None:
    _, scanned, _ = matrix["scanned_invoice"]
    assert scanned["file"]["facts"]["content"] == "scanned"
    readable = next(m for m in scanned["completeness"]["measures"] if m["key"] == "readable_pages")
    # OCR wasn't run here: the page is a gap, not counted as extracted.
    assert readable["status"] == "gaps" and readable["missing"] == [{"page": 1, "reason": "Needs OCR"}]
    assert scanned["completeness"]["status"] == "gaps"
    readability = next(c for c in scanned["file"]["checks"] if c["code"] == "readability")
    assert readability["status"] == "warning"

    _, mixed, _ = matrix["mixed_pages"]
    assert mixed["file"]["facts"]["content"] == "mixed"
    assert mixed["file"]["facts"]["scanned_pages"] == [2]


def test_every_page_of_a_multipage_document_is_accounted_for(matrix) -> None:
    _, report, _ = matrix["multipage_invoice"]
    pages = next(m for m in report["completeness"]["measures"] if m["key"] == "pages")
    assert (pages["source"], pages["represented"], pages["status"]) == (6, 6, "complete")


def test_a_correction_revalidates_only_what_changed(matrix) -> None:
    document_id, first, layout = matrix["invoice_digital"]
    again = _report(document_id)
    assert again["cached"] is True
    field = next(f for f in list(layout_fields(layout)) if f["label"].startswith("Due Date"))
    reviewed = client.post(f"/api/documents/{document_id}/original-structure/review", json={
        "records": [field["record_key"]], "action": "correct", "value": "02/15/2025", "reason": "Typo"})
    assert reviewed.status_code == 200, reviewed.text
    after = _report(document_id)
    assert after["cached"] is False
    # The file's own checks weren't read again.
    assert after["file"]["checked_at"] == first["file"]["checked_at"]
    revalidated = client.post(f"/api/documents/{document_id}/upload-validation/revalidate", json={"parts": ["file"]}).json()
    assert revalidated["revalidated"] == ["file"] and revalidated["file"]["checked_at"] != first["file"]["checked_at"]


def test_a_processing_job_records_the_file_and_classification_stages() -> None:
    document_id = _upload(MATRIX[0].build(), "job-stages")["body"]["document_id"]
    started = client.post(f"/api/documents/{document_id}/jobs/process")
    assert started.status_code == 202
    job = client.get(f"/v1/jobs/{started.json()['id']}").json()
    assert job["status"] == "complete", job
    stages = [entry["stage"] for entry in job["result"]["stage_history"]]
    assert stages[:3] == ["reading_document", "verifying_file", "rendering_ocr"]
    assert stages.index("classifying") < stages.index("complete")
    assert "file_verification_ms" in job["result"]["stage_timings_ms"]
    report = _report(document_id)
    assert report["file"]["status"] == "verified"
    assert all(s["status"] == "done" for s in report["processing"]["stages"])
    assert any(key.startswith("processing:") for key in report["processing"]["job_durations_ms"])


def test_a_large_document_is_validated_with_its_pages_accounted_for() -> None:
    started = time.perf_counter()
    document_id = _ingest(large_pdf(300), "large")
    ingest_s = time.perf_counter() - started
    started = time.perf_counter()
    report = _report(document_id)
    validate_s = time.perf_counter() - started
    pages = next(m for m in report["completeness"]["measures"] if m["key"] == "pages")
    assert (pages["source"], pages["represented"]) == (300, 300)
    assert report["file"]["facts"]["pages"] == 300
    assert report["consistency"]["status"] == "consistent"
    # A second look is the cached report.
    started = time.perf_counter()
    assert _report(document_id)["cached"] is True
    cached_s = time.perf_counter() - started
    assert validate_s < 60 and cached_s < validate_s, (ingest_s, validate_s, cached_s)
