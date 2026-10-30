"""Where a job's time went: queue wait, each stage's duration and share,
OCR pages, AI calls (count, failures, retries, latency) and records written.

Durations come from time.perf_counter (monotonic) inside the runner; the
queue wait is the only wall-clock figure (job created → runner started).
Nothing here reads or logs document content.
"""

from __future__ import annotations

import statistics
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.observability import log_event
from app.models.document_page import DocumentPage
from app.models.extraction_job import ExtractionJob
from app.models.recognition_run import RecognitionRun

# Stage keys that are totals or aliases of other stages, not stages of
# their own (kept in stage_timings_ms for older readers).
_ALIASES = {"ocr_ms", "pages_ocr_ms", "table_detection_ms", "discovery_ms"}


def queue_wait_ms(job: ExtractionJob) -> int | None:
    created = job.created_at
    if created is None:
        return None
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    return max(0, int((datetime.now(timezone.utc) - created).total_seconds() * 1000))


def ai_usage(database: Session, job_id: int) -> dict[str, Any]:
    runs = list(
        database.scalars(
            select(RecognitionRun).where(RecognitionRun.extraction_job_id == job_id).order_by(RecognitionRun.id)
        )
    )
    durations = [run.duration_ms for run in runs if run.duration_ms is not None]
    # A retry: an errored call followed by another call of the same method.
    retries = sum(
        1 for before, after in zip(runs, runs[1:]) if before.status == "error" and before.method == after.method
    )
    by_method: dict[str, int] = {}
    for run in runs:
        by_method[run.method or "unknown"] = by_method.get(run.method or "unknown", 0) + 1
    return {
        "calls": len(runs),
        "succeeded": sum(1 for run in runs if run.status == "ok"),
        "failed": sum(1 for run in runs if run.status == "error"),
        "retries": retries,
        "total_ms": sum(durations),
        "median_ms": int(statistics.median(durations)) if durations else 0,
        "max_ms": max(durations, default=0),
        "by_method": by_method,
    }


def ocr_pages(database: Session, document_id: str) -> int:
    return sum(
        1
        for attempted in database.scalars(
            select(DocumentPage.ocr_attempted).where(DocumentPage.document_id == document_id)
        )
        if attempted
    )


def stage_breakdown(stage_timings: dict[str, int], total_ms: int) -> list[dict[str, Any]]:
    stages = [(key.removesuffix("_ms"), ms) for key, ms in stage_timings.items() if key not in _ALIASES and ms]
    # Time outside every measured stage (bookkeeping commits, provenance),
    # shown so the stages always add up to the total.
    unmeasured = total_ms - sum(ms for _, ms in stages)
    if unmeasured > 0:
        stages.append(("unmeasured", unmeasured))
    return [
        {"stage": stage, "ms": ms, "percent": round(100 * ms / total_ms, 1) if total_ms else 0.0}
        for stage, ms in sorted(stages, key=lambda item: -item[1])
    ]


def job_metrics(
    database: Session,
    job: ExtractionJob,
    *,
    total_ms: int,
    queue_ms: int | None,
    startup_ms: int,
    stage_timings: dict[str, int],
    records: dict[str, int],
) -> dict[str, Any]:
    metrics = {
        "total_ms": total_ms,
        "queue_wait_ms": queue_ms,
        "worker_startup_ms": startup_ms,
        "stages": stage_breakdown(stage_timings, total_ms),
        "ocr_pages": ocr_pages(database, job.document_id),
        "ai": ai_usage(database, job.id),
        "records": records,
    }
    for stage in metrics["stages"]:
        log_event("job_stage_timing", stage=stage["stage"], duration_ms=stage["ms"], percent=stage["percent"], job_type=job.job_type)
    return metrics
