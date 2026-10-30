"""Vercel API proof of concept, run locally on SQLite and local storage.

Run from backend/: python -m pytest ../poc/vercel-api/tests -q
"""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT.parents[1] / "backend"
_tmp = tempfile.mkdtemp(prefix="poc-")
os.environ.update(
    DATABASE_URL=f"sqlite:///{_tmp}/poc.db",
    APP_ENV="development",
    RBAC_ENFORCED="true",  # anonymous callers get the workspace role, as on the live service
    POC_LOCAL_STORAGE=f"{_tmp}/storage",
    POC_ADMIN_KEY="test-admin-key",
    POC_BATCH_PAGES="2",
    POC_LEASE_SECONDS="2",
)
os.environ.setdefault("TESSDATA_PREFIX", str(ROOT / "tessdata"))
sys.path[:0] = [str(ROOT), str(BACKEND), str(BACKEND / "tests")]

import fitz  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import func, select  # noqa: E402

import poc_api  # noqa: E402
import poc_queue  # noqa: E402
from app.database.session import SessionLocal  # noqa: E402
from app.models.document_page import DocumentPage  # noqa: E402
from app.workflow import durable_jobs as wf  # noqa: E402
from contract_brief_fixture import contract_brief_pdf  # noqa: E402

client = TestClient(poc_api.app)
SENT: list[tuple[dict, str]] = []


async def _collect(payload: dict, key: str) -> None:
    SENT.append((payload, key))


poc_queue.DISPATCH = _collect
WS = {"X-Workspace-Token": "a" * 40}
OTHER = {"X-Workspace-Token": "b" * 40}


@pytest.fixture(scope="module", autouse=True)
def migrated():
    response = client.post("/admin/migrate", headers={"X-Admin-Key": "test-admin-key"})
    assert response.status_code == 200, response.text
    assert response.json()["after"]["tables"] >= 60


def _scanned_pdf() -> bytes:
    """The contract brief with one more page that is only an image of text."""

    doc = fitz.open("pdf", contract_brief_pdf())
    picture = fitz.open()
    page = picture.new_page()
    page.insert_text((72, 100), "Invoice Number: INV-77310", fontsize=14)
    page.insert_text((72, 130), "Amount Due: $1,234.50", fontsize=14)
    # A grey scan at 150 dpi, as office scanners produce (small enough to upload).
    image = page.get_pixmap(dpi=150, colorspace=fitz.csGRAY).tobytes("png")
    scan = doc.new_page()
    scan.insert_image(scan.rect, stream=image)
    return doc.tobytes()


def _upload(content: bytes, headers=WS, name="brief.pdf"):
    return client.post("/api/documents/upload", files={"file": (name, content, "application/pdf")}, headers=headers)


def _deliver_all() -> None:
    """Deliver queued messages like the queue would (one at a time)."""

    while SENT:
        payload, _ = SENT.pop(0)
        if payload["kind"] == "batch":
            state = poc_queue.handle_batch(payload["run_id"], payload["seq"])
            db = SessionLocal()
            run = db.get(wf.Run, payload["run_id"])
            if state == "done" and run.status == "completed":
                SENT.append(({"kind": "finalize", "run_id": run.id}, "f"))
            db.close()
        else:
            poc_queue.handle_finalize(payload["run_id"])


def _pages(document_id: str) -> list[int]:
    db = SessionLocal()
    try:
        return list(db.scalars(select(DocumentPage.page_number).where(DocumentPage.document_id == document_id).order_by(DocumentPage.page_number)))
    finally:
        db.close()


def test_health_reports_runtime_database_storage_and_ocr() -> None:
    body = client.get("/health").json()
    assert body["database"]["ok"] and body["database"]["alembic_version"]
    assert body["storage"] == "LocalStorage" and body["ocr"]["language_data"] is True
    assert body["libreoffice"] in (True, False)


def test_upload_stores_privately_under_an_id_not_the_filename() -> None:
    response = _upload(contract_brief_pdf(), name="Contract - FA30.pdf")
    assert response.status_code == 201, response.text
    body = response.json()
    db = SessionLocal()
    from app.models.document import Document

    document = db.get(Document, body["document_id"])
    assert document.stored_filename == f"documents/{body['document_id']}.pdf"
    assert "FA30" not in document.stored_filename
    assert len(document.checksum_sha256) == 64 and document.owner_workspace
    db.close()
    assert _upload(b"x" * 10, name="old.doc").status_code == 415
    assert _upload(b"%PDF" + b"0" * (poc_api.MAX_UPLOAD_BYTES + 10)).status_code == 413


def test_signed_links_are_short_lived_and_workspace_scoped() -> None:
    document_id = _upload(contract_brief_pdf()).json()["document_id"]
    assert client.get(f"/api/documents/{document_id}/file-link", headers=OTHER).status_code == 404
    link = client.get(f"/api/documents/{document_id}/file-link", headers=WS).json()["url"]
    assert client.get(link).content.startswith(b"%PDF")
    tampered = link[:-1] + ("A" if link[-1] != "A" else "B")  # a different signature
    assert client.get(tampered).status_code == 403
    import poc_storage

    expired = poc_storage.sign_link(document_id, now=time.time() - 3600)
    assert client.get(f"/api/documents/{document_id}/file?token={expired}").status_code == 403


def test_a_job_is_created_without_processing_and_only_once() -> None:
    document_id = _upload(contract_brief_pdf()).json()["document_id"]
    SENT.clear()
    first = client.post(f"/api/documents/{document_id}/jobs/process", headers=WS).json()
    assert first["state"] == "queued" and first["pages_done"] == 0  # nothing ran in the request
    assert len(SENT) == 3  # 6 pages in batches of 2
    again = client.post(f"/api/documents/{document_id}/jobs/process", headers=WS).json()
    assert again["id"] == first["id"] and len(SENT) == 3  # same run, nothing re-sent
    assert client.get(f"/v1/jobs/{first['id']}", headers=OTHER).status_code == 404
    SENT.clear()


def test_processing_reads_every_page_in_order_with_ocr_only_where_needed() -> None:
    document_id = _upload(_scanned_pdf()).json()["document_id"]
    job = client.post(f"/api/documents/{document_id}/jobs/process", headers=WS).json()
    _deliver_all()
    view = client.get(f"/v1/jobs/{job['id']}", headers=WS).json()
    assert view["state"] == "ready_for_review" and view["status"] == "complete"
    assert view["pages_done"] == view["pages_total"] == 7
    assert _pages(document_id) == list(range(1, 8))
    records = view["result"]["records"]
    assert records["ocr_pages"] == 1 and records["ocr_failed"] == 0
    # Every non-blank labelled value of the form (blank blanks are kept but not accepted).
    assert records["fields"] >= 39 and records["tables"] >= 3
    db = SessionLocal()
    scan = db.scalars(select(DocumentPage).where(DocumentPage.document_id == document_id, DocumentPage.page_number == 7)).one()
    assert scan.extraction_method == "ocr" and "INV-77310" in scan.final_text
    db.close()
    assert "classification" in view["result"]["finalize"]


def test_an_interrupted_worker_is_recovered_without_duplicates() -> None:
    document_id = _upload(contract_brief_pdf()).json()["document_id"]
    SENT.clear()
    job = client.post(f"/api/documents/{document_id}/jobs/process", headers=WS).json()
    run_id = SENT[0][0]["run_id"]
    SENT.clear()
    db = SessionLocal()
    # A worker takes batch 0 and dies (the function is killed mid-batch).
    lost, _ = wf.claim_task(db, run_id, 0, "dying-worker")
    db.close()
    time.sleep(2.2)  # its lease (2 s here) runs out
    view = client.get(f"/v1/jobs/{job['id']}", headers=WS).json()
    assert view["state"] == "interrupted" and view["stalled_batches"] == [0]
    assert [p["seq"] for p, _ in SENT] == [0]  # the poll re-dispatched it
    for seq in (1, 2):
        SENT.append(({"kind": "batch", "run_id": run_id, "seq": seq}, "x"))
    _deliver_all()
    # The dying worker's late commit is refused.
    db = SessionLocal()
    assert not wf.complete(db, lost, "dying-worker", {"pages": [1, 2]})
    db.close()
    view = client.get(f"/v1/jobs/{job['id']}", headers=WS).json()
    assert view["state"] == "ready_for_review" and view["retry_count"] == 1
    assert _pages(document_id) == list(range(1, 7))  # every page exactly once


def test_duplicate_deliveries_change_nothing() -> None:
    document_id = _upload(contract_brief_pdf()).json()["document_id"]
    SENT.clear()
    job = client.post(f"/api/documents/{document_id}/jobs/process", headers=WS).json()
    duplicates = list(SENT)
    _deliver_all()
    before = client.get(f"/v1/jobs/{job['id']}", headers=WS).json()
    for payload, _ in duplicates:
        assert poc_queue.handle_batch(payload["run_id"], payload["seq"]) == "done"
    assert poc_queue.handle_finalize(duplicates[0][0]["run_id"]) == "already_finalized"
    after = client.get(f"/v1/jobs/{job['id']}", headers=WS).json()
    assert after["result"] == before["result"] and _pages(document_id) == list(range(1, 7))


def test_cancel_stops_work_and_retry_finishes_only_what_remained() -> None:
    document_id = _upload(contract_brief_pdf()).json()["document_id"]
    SENT.clear()
    job = client.post(f"/api/documents/{document_id}/jobs/process", headers=WS).json()
    payload, _ = SENT.pop(0)
    poc_queue.handle_batch(payload["run_id"], payload["seq"])  # batch 0 done
    cancelled = client.post(f"/v1/jobs/{job['id']}/cancel", headers=WS).json()
    assert cancelled["state"] == "cancelled" and cancelled["status"] == "failed"
    _deliver_all()  # the remaining messages arrive after cancel: no effect
    assert _pages(document_id) == [1, 2]
    retried = client.post(f"/v1/jobs/{job['id']}/retry", headers=WS).json()
    assert retried["state"] in ("processing", "queued")
    assert sorted(p["seq"] for p, _ in SENT) == [1, 2]  # batch 0 isn't repeated
    _deliver_all()
    assert client.get(f"/v1/jobs/{job['id']}", headers=WS).json()["state"] == "ready_for_review"
    assert _pages(document_id) == list(range(1, 7))
    diagnostics = client.get(f"/v1/jobs/{job['id']}/diagnostics", headers=WS).json()
    assert [b["status"] for b in diagnostics["batches"]] == ["done", "done", "done"]


def test_end_to_end_through_the_vercel_queue_sdk() -> None:
    """The real subscriber, fed by Vercel's embedded queue service."""

    from vercel.queue.embedded import embedded_queue_service

    document_id = _upload(contract_brief_pdf()).json()["document_id"]

    outbox: list[tuple[dict, str]] = []

    async def to_outbox(payload: dict, key: str) -> None:
        # The app runs on TestClient's own event loop; messages are handed
        # to the queue client on the test's loop below.
        outbox.append((payload, key))

    async def scenario() -> dict:
        async with embedded_queue_service() as service:
            queue_client = service.get_async_client()
            poc_queue.DISPATCH = to_outbox
            try:
                job = await asyncio.to_thread(lambda: client.post(f"/api/documents/{document_id}/jobs/process", headers=WS).json())
                view = job
                for _ in range(1200):
                    while outbox:
                        payload, key = outbox.pop(0)
                        await queue_client.send(poc_queue.TOPIC, payload, idempotency_key=key)
                    service.dispatcher.wake()
                    await asyncio.sleep(0.05)
                    view = await asyncio.to_thread(lambda: client.get(f"/v1/jobs/{job['id']}", headers=WS).json())
                    if view["state"] in ("ready_for_review", "failed"):
                        return view
                return view
            finally:
                poc_queue.DISPATCH = _collect

    view = asyncio.run(scenario())
    assert view["state"] == "ready_for_review", view
    assert _pages(document_id) == list(range(1, 7))
