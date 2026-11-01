from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException

from app.core.auth import ActorContext, get_current_actor
from app.core.document_access import can_access_document
from app.models.document import Document
from sqlalchemy.orm import Session

from app.database.dependencies import get_database
from app.models.extraction_job import ExtractionJob
from app.schemas.extraction_job import (
    ExtractionJobResponse,
    StartExtractionJobRequest,
)
from sqlalchemy import select

from app.services.job_recovery import ACTIVE_STATUSES, is_orphaned, mark_interrupted
from app.services.extraction_job_runner import (
    run_extraction_job,
    run_in_worker_thread,
    run_processing_job,
)

# Document-scoped job creation, mounted at /api/documents alongside the
# existing synchronous endpoints (which remain unchanged).
router = APIRouter()

# The plain /v1/jobs/{job_id} status endpoint the spec calls for.
v1_router = APIRouter()


def _active_job(database: Session, document_id: str, job_type: str) -> ExtractionJob | None:
    """A job of this type already running for the document: starting
    another would read the same pages twice. A job whose worker is gone is
    marked interrupted instead."""

    for job in database.scalars(
        select(ExtractionJob).where(
            ExtractionJob.document_id == document_id,
            ExtractionJob.job_type == job_type,
            ExtractionJob.status.in_(ACTIVE_STATUSES),
        )
    ):
        if is_orphaned(job):
            mark_interrupted(job)
            database.commit()
            continue
        return job
    return None


def _to_response(job: ExtractionJob) -> ExtractionJobResponse:
    return ExtractionJobResponse(
        id=job.id,
        document_id=job.document_id,
        job_type=job.job_type,
        status=job.status,
        stage=job.stage,
        progress=job.progress,
        error_message=job.error_message,
        retry_count=job.retry_count,
        result=job.result_json,
        created_at=job.created_at,
        started_at=job.started_at,
        completed_at=job.completed_at,
    )


@router.post(
    "/{document_id}/jobs/process",
    response_model=ExtractionJobResponse,
    status_code=202,
)
async def start_processing_job(
    document_id: str,
    background_tasks: BackgroundTasks,
    database: Session = Depends(get_database),
) -> ExtractionJobResponse:
    document = database.get(Document, document_id)

    if document is None:
        raise HTTPException(status_code=404, detail="Document not found.")

    running = _active_job(database, document_id, "processing")
    if running is not None:
        return _to_response(running)

    job = ExtractionJob(document_id=document_id, job_type="processing")
    database.add(job)
    database.commit()
    database.refresh(job)

    background_tasks.add_task(run_in_worker_thread, run_processing_job, job.id)

    return _to_response(job)


@router.post(
    "/{document_id}/jobs/extract",
    response_model=ExtractionJobResponse,
    status_code=202,
)
async def start_extraction_job(
    document_id: str,
    request: StartExtractionJobRequest,
    background_tasks: BackgroundTasks,
    database: Session = Depends(get_database),
) -> ExtractionJobResponse:
    document = database.get(Document, document_id)

    if document is None:
        raise HTTPException(status_code=404, detail="Document not found.")

    running = _active_job(database, document_id, "extraction")
    if running is not None:
        return _to_response(running)

    # What was asked for, so a retry repeats it.
    job = ExtractionJob(
        document_id=document_id, job_type="extraction",
        result_json={"request": {"target_ids": list(request.target_ids), "use_ai_fallback": request.use_ai_fallback}},
    )
    database.add(job)
    database.commit()
    database.refresh(job)

    background_tasks.add_task(
        run_in_worker_thread,
        run_extraction_job,
        job.id,
        request.target_ids,
        request.use_ai_fallback,
    )

    return _to_response(job)


@v1_router.get(
    "/{job_id}",
    response_model=ExtractionJobResponse,
)
async def get_job(
    job_id: int,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(get_current_actor),
) -> ExtractionJobResponse:
    job = database.get(ExtractionJob, job_id)

    if job is None:
        raise HTTPException(status_code=404, detail="Job not found.")

    # Job ids are sequential: the job is only visible to whoever may see
    # its document (core/document_access.py).
    document = database.get(Document, job.document_id)
    if document is None or not can_access_document(actor, document):
        raise HTTPException(status_code=404, detail="Job not found.")

    if is_orphaned(job):
        mark_interrupted(job)
        database.commit()

    return _to_response(job)


@v1_router.post(
    "/{job_id}/retry",
    response_model=ExtractionJobResponse,
    status_code=202,
)
async def retry_job(
    job_id: int,
    background_tasks: BackgroundTasks,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(get_current_actor),
) -> ExtractionJobResponse:
    """Run a failed job again, as a new job counting the retry. Pages and
    fields already read are reused (the runners reuse finished artifacts),
    and stored values are replaced, never duplicated."""

    job = database.get(ExtractionJob, job_id)
    document = database.get(Document, job.document_id) if job is not None else None
    if job is None or document is None or not can_access_document(actor, document):
        raise HTTPException(status_code=404, detail="Job not found.")
    if is_orphaned(job):
        mark_interrupted(job)
        database.commit()
    if job.status != "failed":
        raise HTTPException(status_code=409, detail=f"Only a failed job can be retried; this one is {job.status}.")
    failure = (job.result_json or {}).get("failure") or {}
    if failure.get("retryable") is False:
        raise HTTPException(status_code=409, detail=f"Retrying won't help: {job.error_message}")
    running = _active_job(database, job.document_id, job.job_type)
    if running is not None:
        return _to_response(running)
    request = (job.result_json or {}).get("request") or {}
    if job.job_type == "extraction" and not request.get("target_ids"):
        raise HTTPException(status_code=409, detail="This job didn't record what it extracted: start the extraction again.")
    retry = ExtractionJob(
        document_id=job.document_id, job_type=job.job_type, retry_count=(job.retry_count or 0) + 1,
        result_json={"retry_of": job.id, **({"request": request} if request else {})},
    )
    database.add(retry)
    database.commit()
    database.refresh(retry)
    if retry.job_type == "processing":
        background_tasks.add_task(run_in_worker_thread, run_processing_job, retry.id)
    else:
        background_tasks.add_task(
            run_in_worker_thread, run_extraction_job, retry.id,
            list(request.get("target_ids") or []), bool(request.get("use_ai_fallback", True)),
        )
    return _to_response(retry)
