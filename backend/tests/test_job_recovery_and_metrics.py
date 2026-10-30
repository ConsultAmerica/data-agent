"""Stalled workers are detected by heartbeat, re-running a job doesn't
duplicate records or undo review, and job timings add up."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.database.session import SessionLocal
from app.main import app
from app.models.document_metadata_field import DocumentMetadataField
from app.models.extraction_job import ExtractionJob
from app.services.job_metrics import stage_breakdown
from app.services.job_recovery import STALE_HEARTBEAT_AFTER, STALE_JOB_AFTER, is_orphaned
from contract_brief_fixture import contract_brief_pdf

client = TestClient(app)
NOW = datetime(2026, 10, 29, 12, 0, tzinfo=timezone.utc)


def _job(**fields) -> ExtractionJob:
    return ExtractionJob(document_id="d", job_type="processing", status="processing", created_at=NOW - timedelta(minutes=1), **fields)


def test_a_silent_heartbeat_marks_the_job_stalled_within_minutes() -> None:
    alive = _job(started_at=NOW - timedelta(minutes=20), heartbeat_at=NOW - timedelta(seconds=30))
    stalled = _job(started_at=NOW - timedelta(minutes=5), heartbeat_at=NOW - STALE_HEARTBEAT_AFTER - timedelta(seconds=1))
    assert not is_orphaned(alive, NOW)  # long-running but beating
    assert is_orphaned(stalled, NOW)  # minutes, not half an hour
    # Jobs from before the heartbeat keep the age rule.
    assert not is_orphaned(_job(started_at=NOW - timedelta(minutes=10)), NOW)
    assert is_orphaned(_job(started_at=NOW - STALE_JOB_AFTER - timedelta(seconds=1)), NOW)
    finished = _job(started_at=NOW - timedelta(hours=2), heartbeat_at=NOW - timedelta(hours=2))
    finished.status = "complete"
    assert not is_orphaned(finished, NOW)


def _process_and_extract() -> tuple[str, dict, dict]:
    body = client.post("/api/documents/upload", files={"file": ("brief-jobs.pdf", contract_brief_pdf(), "application/pdf")}).json()
    document_id = body["document_id"]
    job_id = body.get("processing_job_id") or client.post(f"/api/documents/{document_id}/jobs/process").json()["id"]
    processing = client.get(f"/v1/jobs/{job_id}").json()
    targets = client.get(f"/api/documents/{document_id}/targets").json()["targets"]
    ids = [t["id"] for t in targets if t.get("source_examples") and t["target_type"] not in {"clause", "section", "obligation"}]
    extraction = client.get(f"/v1/jobs/{client.post(f'/api/documents/{document_id}/jobs/extract', json={'target_ids': ids}).json()['id']}").json()
    return document_id, processing, extraction


def test_jobs_beat_and_report_timings_that_add_up() -> None:
    document_id, processing, extraction = _process_and_extract()
    for job in (processing, extraction):
        assert job["status"] == "complete"
        metrics = job["result"]["metrics"]
        assert metrics["queue_wait_ms"] is not None and metrics["queue_wait_ms"] >= 0
        assert sum(stage["ms"] for stage in metrics["stages"]) == metrics["total_ms"]
        assert {"calls", "succeeded", "failed", "retries"} <= set(metrics["ai"])
    names = {stage["stage"] for stage in processing["result"]["metrics"]["stages"]}
    assert "document_page_loading" in names and "classification" in names
    database = SessionLocal()
    try:
        beats = database.scalars(select(ExtractionJob.heartbeat_at).where(ExtractionJob.document_id == document_id)).all()
    finally:
        database.close()
    assert all(beat is not None for beat in beats)


def test_breakdown_shows_unmeasured_time_and_ignores_aliases() -> None:
    stages = stage_breakdown({"a_ms": 600, "b_ms": 300, "ocr_ms": 600, "discovery_ms": 5}, 1000)
    assert [(s["stage"], s["ms"]) for s in stages] == [("a", 600), ("b", 300), ("unmeasured", 100)]
    assert stages[0]["percent"] == 60.0


def test_re_running_extraction_neither_duplicates_records_nor_undoes_review() -> None:
    document_id, _, _ = _process_and_extract()
    database = SessionLocal()
    try:
        count = lambda: database.scalar(select(func.count()).select_from(DocumentMetadataField).where(DocumentMetadataField.document_id == document_id))  # noqa: E731
        before = count()
        field = database.scalars(select(DocumentMetadataField).where(DocumentMetadataField.document_id == document_id, DocumentMetadataField.value != "")).first()
        assert field is not None
        reviewed = client.post(
            f"/api/documents/{document_id}/metadata-fields/by-id/{field.id}/review",
            json={"action": "edit", "value": "Reviewer value", "changed_by": "Test Reviewer"},
        )
        assert reviewed.status_code == 200, reviewed.text

        targets = client.get(f"/api/documents/{document_id}/targets").json()["targets"]
        ids = [t["id"] for t in targets if t.get("source_examples") and t["target_type"] not in {"clause", "section", "obligation"}]
        again = client.post(f"/api/documents/{document_id}/jobs/extract", json={"target_ids": ids}).json()
        assert client.get(f"/v1/jobs/{again['id']}").json()["status"] == "complete"

        database.expire_all()
        assert count() == before
        kept = database.scalars(
            select(DocumentMetadataField).where(DocumentMetadataField.document_id == document_id, DocumentMetadataField.field_key == field.field_key)
        ).all()
        assert any(row.value == "Reviewer value" and row.review_status == "edited" for row in kept)
    finally:
        database.close()
