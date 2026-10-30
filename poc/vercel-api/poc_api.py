"""Dataomatix API — Vercel proof of concept (Increment 7.2).

A minimal FastAPI app on the Vercel Python runtime, running the
application's own code (``app`` package: auth, models, page reading,
durable jobs) with a slim dependency set:

    GET  /health                                  runtime, database, storage, OCR
    POST /api/documents/upload                    private Blob + document row (≤ 4.5 MB body)
    POST /api/documents/{id}/jobs/process         persistent job + durable run → queue
    GET  /v1/jobs/{id}                            persisted progress (same contract + detail)
    POST /v1/jobs/{id}/cancel | /retry
    GET  /api/documents/{id}/file-link → /file    short-lived signed access
    POST /admin/identity | /admin/migrate         explicit, key-protected (never at cold start)

Authentication and authorization are the application's: Bearer service
key / Entra token, or the anonymous browser workspace (X-Workspace-Token),
with documents outside the caller's workspace answering 404.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import platform
import shutil
import uuid
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, File, Header, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response
from sqlalchemy import func, inspect, select, text, update
from sqlalchemy.orm import Session

from app.core.auth import ActorContext, require_permission
from app.core.document_access import can_access_document
from app.database.dependencies import get_database
from app.database.session import engine
from app.models.document import Document
from app.models.extraction_job import ExtractionJob
from app.workflow import durable_jobs as wf

import poc_processing
import poc_queue
import poc_storage

app = FastAPI(title="Dataomatix API (Vercel proof of concept)")

# Vercel's request body limit is 4.5 MB; leave room for multipart overhead.
MAX_UPLOAD_BYTES = int(os.environ.get("POC_MAX_UPLOAD_BYTES", str(4_300_000)))
PIPELINE_VERSION = "poc-7.2-1"
LEGACY_OFFICE = {".doc", ".xls", ".ppt"}


def _admin(x_admin_key: str | None) -> None:
    expected = os.environ.get("POC_ADMIN_KEY")
    if not expected or not x_admin_key or not hmac.compare_digest(expected, x_admin_key):
        raise HTTPException(status_code=403, detail="Admin key required.")


def _identity() -> dict:
    """Non-secret facts that tell databases apart."""

    with engine.connect() as connection:
        dialect = engine.dialect.name
        facts: dict = {"dialect": dialect}
        if dialect == "postgresql":
            row = connection.execute(text("select current_database(), version(), current_setting('ssl', true)")).one()
            facts.update(database=row[0], server=row[1].split(",")[0], ssl=row[2])
        tables = set(inspect(connection).get_table_names())
        facts["tables"] = len(tables)
        facts["alembic_version"] = (
            connection.execute(text("select version_num from alembic_version")).scalar() if "alembic_version" in tables else None
        )
        for table in ("documents", "extraction_jobs", "document_metadata_fields", "oracle_mapping_profiles"):
            facts[f"rows_{table}"] = connection.execute(text(f"select count(*) from {table}")).scalar() if table in tables else None
    return facts


@app.get("/health")
async def health() -> dict:
    try:
        database = {"ok": True, **await run_in_threadpool(_identity)}
    except Exception as exc:  # noqa: BLE001 - reported, not raised
        database = {"ok": False, "error": type(exc).__name__}
    return {
        "status": "ok" if database["ok"] else "degraded",
        "service": "dataomatix-api-poc",
        "git_sha": os.environ.get("VERCEL_GIT_COMMIT_SHA", "local"),
        "python": platform.python_version(),
        "database": database,
        "storage": type(poc_storage.storage()).__name__,
        "ocr": {"engine": "tesseract (MuPDF built-in)", "language_data": poc_processing.tessdata_dir() is not None},
        "libreoffice": shutil.which("soffice") is not None,
        "queue": {"topic": poc_queue.TOPIC, "batch_pages": poc_queue.BATCH_PAGES, "concurrency": poc_queue.CONCURRENCY},
    }


@app.post("/admin/identity")
async def admin_identity(x_admin_key: str | None = Header(default=None)) -> dict:
    _admin(x_admin_key)
    return await run_in_threadpool(_identity)


@app.post("/admin/migrate")
async def admin_migrate(x_admin_key: str | None = Header(default=None)) -> dict:
    """Apply the application's Alembic migrations, then the durable-run
    tables. Explicit and key-protected; never on cold start."""

    _admin(x_admin_key)
    before = await run_in_threadpool(_identity)

    def migrate() -> None:
        from app.database.migrate import run_alembic_upgrade

        run_alembic_upgrade()
        wf.Base.metadata.create_all(bind=engine)

    await run_in_threadpool(migrate)
    return {"before": before, "after": await run_in_threadpool(_identity)}


# --- documents ---------------------------------------------------------------------

@app.post("/api/documents/upload", status_code=201)
async def upload(
    file: UploadFile = File(...),
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.upload")),
) -> dict:
    name = file.filename or "document.pdf"
    extension = os.path.splitext(name)[1].lower()
    if extension in LEGACY_OFFICE:
        raise HTTPException(
            status_code=415,
            detail="Legacy Office files (.doc, .xls, .ppt) need LibreOffice conversion, which this runtime doesn't have. "
            "Upload a PDF, or use the existing service for this file.",
        )
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"Files over {MAX_UPLOAD_BYTES // 1_000_000} MB need direct-to-storage upload.")
    if not data.startswith(b"%PDF"):
        raise HTTPException(status_code=415, detail="Only PDF files are accepted by this proof of concept.")

    import fitz

    try:
        with fitz.open("pdf", data) as pdf:
            page_count, encrypted = pdf.page_count, pdf.needs_pass
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=422, detail="The PDF could not be read.") from exc
    if encrypted:
        raise HTTPException(status_code=422, detail="Encrypted PDFs are not accepted.")

    document_id = str(uuid.uuid4())
    stored = await run_in_threadpool(poc_storage.storage().put, poc_storage.object_name(document_id), data, "application/pdf")
    document = Document(
        id=document_id,
        original_filename=name[:255],
        stored_filename=stored,
        content_type="application/pdf",
        size_bytes=len(data),
        checksum_sha256=hashlib.sha256(data).hexdigest(),
        page_count=page_count,
        encrypted=False,
        status="uploaded",
        processing_status="not_processed",
        owner_workspace=actor.workspace,
    )
    database.add(document)
    database.commit()
    return {
        "document_id": document.id,
        "original_filename": document.original_filename,
        "size_bytes": document.size_bytes,
        "checksum_sha256": document.checksum_sha256,
        "page_count": page_count,
        "uploaded_at": document.uploaded_at.isoformat(),
        "processing_status": document.processing_status,
    }


def _document(database: Session, actor: ActorContext, document_id: str) -> Document:
    document = database.get(Document, document_id)
    if document is None or not can_access_document(actor, document):
        raise HTTPException(status_code=404, detail="Document not found.")
    return document


@app.get("/api/documents/{document_id}/file-link")
async def file_link(
    document_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> dict:
    _document(database, actor, document_id)
    token = poc_storage.sign_link(document_id)
    return {"url": f"/api/documents/{document_id}/file?token={token}", "expires_in": poc_storage.LINK_SECONDS}


@app.get("/api/documents/{document_id}/file")
async def file(document_id: str, token: str, database: Session = Depends(get_database)) -> Response:
    if not poc_storage.verify_link(document_id, token):
        raise HTTPException(status_code=403, detail="This link is invalid or has expired.")
    document = database.get(Document, document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found.")
    data = await run_in_threadpool(poc_storage.storage().get, document.stored_filename)
    return Response(data, media_type=document.content_type, headers={"Cache-Control": "private, no-store"})


# --- jobs ----------------------------------------------------------------------------

@app.post("/api/documents/{document_id}/jobs/process", status_code=202)
async def start_processing(
    document_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("extraction.run")),
) -> dict:
    document = _document(database, actor, document_id)
    key = f"{document.checksum_sha256}:{PIPELINE_VERSION}"
    existing = database.scalars(select(wf.Run).where(wf.Run.idempotency_key == f"{document.id}:{key}")).first()
    if existing is not None and existing.job_id:
        # The same input was already started: return that job, never a second run.
        return _job_view(database, database.get(ExtractionJob, existing.job_id))

    # One transaction: the job and its durable run exist together or not at all.
    job = ExtractionJob(document_id=document.id, job_type="processing", status="queued", stage="queued", progress=0)
    database.add(job)
    database.flush()
    run = wf.enqueue(
        database, document_id=document.id, input_digest=key, page_count=document.page_count,
        batch_pages=poc_queue.BATCH_PAGES, job_id=job.id, commit=False,
    )
    document.processing_status = "processing"
    database.commit()

    tasks = list(database.scalars(select(wf.Task.seq).where(wf.Task.run_id == run.id).order_by(wf.Task.seq)))
    for seq in tasks:
        try:
            await poc_queue.dispatch_batch(run.id, seq)
        except Exception:  # noqa: BLE001 - status polls re-dispatch what didn't go out
            break
    return _job_view(database, job)


def _job_and_run(database: Session, actor: ActorContext, job_id: int) -> tuple[ExtractionJob, wf.Run | None]:
    job = database.get(ExtractionJob, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found.")
    document = database.get(Document, job.document_id)
    if document is None or not can_access_document(actor, document):
        raise HTTPException(status_code=404, detail="Job not found.")
    run = database.scalars(select(wf.Run).where(wf.Run.job_id == job.id)).first()
    return job, run


def _state(job: ExtractionJob, run: wf.Run | None, progress: dict, document: Document | None) -> str:
    if job.status == "cancelled" or (run is not None and run.status == "cancelled"):
        return "cancelled"
    if run is not None and run.status == "failed":
        return "partially_complete" if progress["done"] else "failed"
    if job.status == "failed":
        return "failed"
    if job.status == "complete":
        return "completed" if document is not None and document.approved_at else "ready_for_review"
    if progress["stalled"]:
        return "interrupted"  # a worker stopped; its batch is re-dispatched automatically
    if job.status == "queued" and not progress["done"]:
        return "queued"
    return "processing"


LEGACY_STATUS = {
    "queued": "queued", "processing": "processing", "interrupted": "processing",
    "ready_for_review": "complete", "completed": "complete",
    "failed": "failed", "partially_complete": "failed", "cancelled": "failed",
}


def _job_view(database: Session, job: ExtractionJob) -> dict:
    run = database.scalars(select(wf.Run).where(wf.Run.job_id == job.id)).first()
    progress = wf.progress(database, run.id) if run else {"batches": 0, "done": 0, "failed": 0, "retries": 0, "stalled": []}
    document = database.get(Document, job.document_id)
    pages_done = 0
    if run is not None:
        for result in wf.results(database, run.id):
            first, last = result["pages"]
            pages_done += last - first + 1
    state = _state(job, run, progress, document)
    return {
        "id": job.id,
        "document_id": job.document_id,
        "job_type": job.job_type,
        # The existing contract (queued | processing | complete | failed)…
        "status": LEGACY_STATUS[state],
        # …and the full state the queue shows.
        "state": state,
        "stage": job.stage,
        "progress": job.progress,
        "pages_done": pages_done,
        "pages_total": document.page_count if document else None,
        "batches": {"done": progress["done"], "total": progress["batches"], "failed": progress["failed"]},
        "retry_count": progress["retries"],
        "stalled_batches": progress["stalled"],
        "last_progress_at": job.heartbeat_at.isoformat() if job.heartbeat_at else None,
        "error_message": job.error_message or ("Cancelled." if state == "cancelled" else None),
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "started_at": job.started_at.isoformat() if job.started_at else None,
        "completed_at": job.completed_at.isoformat() if job.completed_at else None,
        "result": job.result_json,
    }


@app.get("/v1/jobs/{job_id}")
async def get_job(
    job_id: int,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> dict:
    job, run = _job_and_run(database, actor, job_id)
    view = _job_view(database, job)
    if run is not None and run.status == "running":
        # Safety net: a batch whose worker stopped (lease expired) or whose
        # message never went out is dispatched again (new idempotency key).
        tasks = list(database.scalars(select(wf.Task).where(wf.Task.run_id == run.id, wf.Task.seq.in_(view["stalled_batches"]))))
        for task in tasks:
            try:
                await poc_queue.dispatch_batch(run.id, task.seq, attempt=task.attempts)
            except Exception:  # noqa: BLE001
                break
    elif run is not None and run.status == "completed" and job.status == "processing":
        await poc_queue.dispatch_finalize(run.id)
    return view


@app.post("/v1/jobs/{job_id}/cancel")
async def cancel_job(
    job_id: int,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("extraction.run")),
) -> dict:
    job, run = _job_and_run(database, actor, job_id)
    if job.status in ("complete", "failed", "cancelled"):
        raise HTTPException(status_code=409, detail=f"The job is already {job.status}.")
    if run is not None:
        wf.cancel(database, run.id)
    job.status, job.stage = "cancelled", "cancelled"
    job.completed_at = datetime.now(timezone.utc)
    database.commit()
    return _job_view(database, job)


@app.post("/v1/jobs/{job_id}/retry")
async def retry_job(
    job_id: int,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("extraction.run")),
) -> dict:
    """Retry only what didn't finish: failed or cancelled batches go back to
    pending; completed batches keep their results (no repeated work)."""

    job, run = _job_and_run(database, actor, job_id)
    if run is None or run.status not in ("failed", "cancelled"):
        raise HTTPException(status_code=409, detail="Only a failed or cancelled job can be retried.")
    database.execute(
        update(wf.Task)
        .where(wf.Task.run_id == run.id, wf.Task.status.in_(("failed", "cancelled")))
        .values(status="pending", attempts=0, error=None)
        .execution_options(synchronize_session=False)
    )
    run.status, run.error = "running", None
    job.status, job.stage, job.error_message, job.completed_at = "processing", "retrying", None, None
    database.commit()
    pending = list(database.scalars(select(wf.Task.seq).where(wf.Task.run_id == run.id, wf.Task.status == "pending")))
    for seq in pending:
        await poc_queue.dispatch_batch(run.id, seq, attempt=1000 + int(datetime.now(timezone.utc).timestamp()))
    return _job_view(database, job)


@app.get("/v1/jobs/{job_id}/diagnostics")
async def job_diagnostics(
    job_id: int,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> dict:
    """Per-batch state for the queue's View diagnostics (no document text)."""

    job, run = _job_and_run(database, actor, job_id)
    tasks = list(database.scalars(select(wf.Task).where(wf.Task.run_id == run.id).order_by(wf.Task.seq))) if run else []
    return {
        "job": _job_view(database, job),
        "run": {"id": run.id, "status": run.status, "error": run.error} if run else None,
        "batches": [
            {
                "seq": t.seq, "pages": t.payload["pages"], "status": t.status, "attempts": t.attempts,
                "lease_expires_at": t.lease_expires_at.isoformat() if t.lease_expires_at else None,
                "error": t.error,
                "result": {k: v for k, v in (t.result or {}).items() if k != "worker"},
            }
            for t in tasks
        ],
    }
