"""Durable processing on Vercel Queues (push mode).

Each message names one page batch of a durable run (app/workflow/
durable_jobs.py), or the run's finalisation. Delivery is at-least-once, so
every handler is idempotent:

- a batch is claimed with a lease; a duplicate delivery of a batch that is
  done is acknowledged, one whose lease is live elsewhere is retried later;
- the batch's page rows commit **together with** its completion — a worker
  that lost its lease commits nothing;
- finalisation runs once (a conditional job-status update elects one).

Nothing depends on the HTTP request that started the job: the run, its
tasks and their checkpoints live in Postgres, and the queue redelivers a
message whose handler crashed or timed out.
"""

from __future__ import annotations

import os
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select, update

from app.database.session import SessionLocal
from app.models.document import Document
from app.models.extraction_job import ExtractionJob
from app.workflow import durable_jobs as wf

import poc_processing
import poc_storage

TOPIC = "dataomatix-page-batches"
BATCH_PAGES = int(os.environ.get("POC_BATCH_PAGES", "25"))
CONCURRENCY = int(os.environ.get("POC_CONCURRENCY", "3"))
wf.LEASE = timedelta(seconds=int(os.environ.get("POC_LEASE_SECONDS", "120")))
HEARTBEAT_SECONDS = max(5, int(wf.LEASE.total_seconds() // 4))


class RetryLater(Exception):
    def __init__(self, seconds: float) -> None:
        super().__init__(f"retry in {seconds:.0f}s")
        self.seconds = seconds


# --- dispatch (replaceable in tests) -------------------------------------------

async def _send(payload: dict, key: str) -> None:
    from vercel.queue import send

    await send(TOPIC, payload, idempotency_key=key)


DISPATCH = _send


async def dispatch_batch(run_id: str, seq: int, attempt: int = 0) -> None:
    await DISPATCH({"kind": "batch", "run_id": run_id, "seq": seq}, f"{run_id}:{seq}:{attempt}")


async def dispatch_finalize(run_id: str) -> None:
    await DISPATCH({"kind": "finalize", "run_id": run_id}, f"{run_id}:finalize")


# --- the PDF, read once per instance --------------------------------------------

_pdf_cache: dict[str, bytes] = {}


def _pdf_bytes(document: Document) -> bytes:
    data = _pdf_cache.get(document.checksum_sha256)
    if data is None:
        data = poc_storage.storage().get(document.stored_filename)
        _pdf_cache.clear()  # one document per instance at a time is plenty
        _pdf_cache[document.checksum_sha256] = data
    return data


# --- handlers ---------------------------------------------------------------------

def _job_for(db, run: wf.Run) -> ExtractionJob | None:
    return db.get(ExtractionJob, run.job_id) if run.job_id else None


def handle_batch(run_id: str, seq: int) -> str:
    """Process one batch. Returns what happened; raises RetryLater when the
    message should come back later, any other exception to let the queue
    retry (the task is released for another attempt first)."""

    worker = f"w-{uuid.uuid4().hex[:12]}"
    db = SessionLocal()
    try:
        task, state = wf.claim_task(db, run_id, seq, worker)
        if task is None:
            if state == "leased":
                held = db.scalars(select(wf.Task).where(wf.Task.run_id == run_id, wf.Task.seq == seq)).one()
                remaining = (wf._aware(held.lease_expires_at) - datetime.now(timezone.utc)).total_seconds()
                raise RetryLater(max(5.0, remaining + 1))
            return state  # done / failed / cancelled / missing: acknowledge
        run = db.get(wf.Run, run_id)
        document = db.get(Document, run.document_id)
        job = _job_for(db, run)
        if job is not None and job.status == "queued":
            job.status, job.started_at = "processing", datetime.now(timezone.utc)
        if job is not None:
            job.stage, job.heartbeat_at = "reading_pages", datetime.now(timezone.utc)
        db.commit()

        # Keep the lease (and the job's heartbeat) alive during a long batch.
        stop = threading.Event()

        def beat() -> None:
            beat_db = SessionLocal()
            try:
                while not stop.wait(HEARTBEAT_SECONDS):
                    wf.heartbeat(beat_db, task, worker)
                    if run.job_id:
                        beat_db.execute(
                            update(ExtractionJob).where(ExtractionJob.id == run.job_id)
                            .values(heartbeat_at=datetime.now(timezone.utc))
                            .execution_options(synchronize_session=False)
                        )
                        beat_db.commit()
            finally:
                beat_db.close()

        beater = threading.Thread(target=beat, daemon=True)
        beater.start()
        started = time.perf_counter()
        try:
            first, last = task.payload["pages"]
            result = poc_processing.process_pages(db, document, _pdf_bytes(document), first, last)
            result["batch_ms"] = int((time.perf_counter() - started) * 1000)
            result["worker"] = worker
        except Exception as exc:
            stop.set()
            db.rollback()
            wf.fail(db, task, worker, f"{type(exc).__name__}: {str(exc)[:300]}")
            _sync_job(db, run_id)
            raise
        finally:
            stop.set()
            beater.join(timeout=2)
        if not wf.complete(db, task, worker, result):
            return "lease_lost"  # another worker owns this batch now; nothing was written
        _sync_job(db, run_id)
        return "done"
    finally:
        db.close()


def _sync_job(db, run_id: str) -> None:
    """Mirror the run's progress on the application job."""

    run = db.get(wf.Run, run_id)
    job = _job_for(db, run)
    if job is None:
        return
    progress = wf.progress(db, run_id)
    job.retry_count = progress["retries"]
    job.heartbeat_at = datetime.now(timezone.utc)
    if run.status == "failed":
        tasks = list(db.scalars(select(wf.Task).where(wf.Task.run_id == run_id, wf.Task.status == "failed")))
        job.status = "failed"
        job.error_message = "; ".join(f"pages {t.payload['pages'][0]}–{t.payload['pages'][1]}: {t.error}" for t in tasks)[:2000]
        job.completed_at = datetime.now(timezone.utc)
    elif run.status == "completed":
        job.stage = "finalizing"
    db.commit()


def handle_finalize(run_id: str) -> str:
    db = SessionLocal()
    try:
        run = db.get(wf.Run, run_id)
        if run is None or run.status != "completed":
            return "not_ready"
        # Exactly one finaliser: the one that moves the job out of processing.
        elected = db.execute(
            update(ExtractionJob)
            .where(ExtractionJob.id == run.job_id, ExtractionJob.status == "processing")
            .values(status="finalizing", stage="finalizing", heartbeat_at=datetime.now(timezone.utc))
            .execution_options(synchronize_session=False)
        ).rowcount
        db.commit()
        if elected != 1:
            return "already_finalized"
        document = db.get(Document, run.document_id)
        started = time.perf_counter()
        outcome = poc_processing.finalize(db, document)
        job = db.get(ExtractionJob, run.job_id)
        batches = wf.results(db, run_id)
        totals = {
            key: sum(batch.get(key, 0) for batch in batches)
            for key in ("ocr_pages", "ocr_failed", "chars", "fields", "tables")
        }
        timings = {
            key: sum(batch.get("timings_ms", {}).get(key, 0) for batch in batches)
            for key in ("text_ms", "ocr_ms", "structure_ms")
        }
        created = wf._aware(job.created_at)
        total_ms = int((datetime.now(timezone.utc) - created).total_seconds() * 1000) if created else None
        job.result_json = {
            "pages": document.page_count,
            "batches": len(batches),
            "records": totals,
            "finalize": outcome,
            "metrics": {
                "total_ms": total_ms,
                "queue_wait_ms": int((wf._aware(job.started_at) - created).total_seconds() * 1000) if job.started_at and created else None,
                "stage_cpu_ms": {**timings, "finalize_ms": int((time.perf_counter() - started) * 1000)},
                "batch_ms": [batch.get("batch_ms") for batch in batches],
                "retries": wf.progress(db, run_id)["retries"],
            },
        }
        job.status, job.stage, job.progress = "complete", "complete", 100
        job.completed_at = datetime.now(timezone.utc)
        db.commit()
        return "finalized"
    finally:
        db.close()


# --- the subscriber (registered in pyproject.toml) ------------------------------
# Defined at module level: Vercel discovers @subscribe functions in this
# module at build time, and the SDK's registry needs the function to live on.

try:
    from vercel.queue import RetryAfter, subscribe
except ImportError:  # the queue SDK is optional for local tools
    subscribe = None

if subscribe is not None:

    @subscribe(topic=TOPIC, consumer_group="pages", max_concurrency=CONCURRENCY, max_attempts=wf.MAX_ATTEMPTS + 2)
    async def on_message(payload: dict[str, Any]) -> None:
        from starlette.concurrency import run_in_threadpool

        try:
            if payload.get("kind") == "finalize":
                await run_in_threadpool(handle_finalize, payload["run_id"])
                return
            state = await run_in_threadpool(handle_batch, payload["run_id"], int(payload["seq"]))
        except RetryLater as later:
            raise RetryAfter(later.seconds) from later
        if state == "done":
            db = SessionLocal()
            try:
                run = db.get(wf.Run, payload["run_id"])
                completed = run is not None and run.status == "completed"
            finally:
                db.close()
            if completed:
                await dispatch_finalize(payload["run_id"])
