import asyncio
import contextlib
from datetime import datetime, timedelta, timezone

from app.models.extraction_job import ExtractionJob

INTERRUPTED_MESSAGE = "Interrupted by a server restart."

# Jobs run in-process, so a job is only orphaned once its process is gone.
# During a rolling deploy the old instance keeps running its jobs while the
# new one boots, so "queued/processing at startup" does not mean orphaned.
# Only a job older than any plausible run is treated as dead.
STALE_JOB_AFTER = timedelta(minutes=30)
# A running job beats every HEARTBEAT_SECONDS; one silent this long has lost
# its worker (crash, out-of-memory restart). An old instance finishing its
# jobs during a rolling deploy keeps beating, so it isn't mistaken for dead.
HEARTBEAT_SECONDS = 20
STALE_HEARTBEAT_AFTER = timedelta(minutes=3)

ACTIVE_STATUSES = ("queued", "processing")


def _as_utc(value: datetime) -> datetime:
    # SQLite hands back naive datetimes; everything is stored in UTC.
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def is_orphaned(job: ExtractionJob, now: datetime | None = None) -> bool:
    if job.status not in ACTIVE_STATUSES:
        return False
    now = now or datetime.now(timezone.utc)
    heartbeat = getattr(job, "heartbeat_at", None)
    if heartbeat is not None:
        return now - _as_utc(heartbeat) > STALE_HEARTBEAT_AFTER
    # No heartbeat yet: queued, or started by code that didn't beat.
    began = job.started_at or job.created_at
    if began is None:
        return False
    return now - _as_utc(began) > STALE_JOB_AFTER


def mark_interrupted(job: ExtractionJob, now: datetime | None = None) -> None:
    job.status = "failed"
    job.error_message = INTERRUPTED_MESSAGE
    job.completed_at = now or datetime.now(timezone.utc)


def _touch(job_id: int) -> None:
    from sqlalchemy import update

    from app.database.session import SessionLocal

    database = SessionLocal()
    try:
        database.execute(
            update(ExtractionJob)
            .where(ExtractionJob.id == job_id, ExtractionJob.status.in_(ACTIVE_STATUSES))
            .values(heartbeat_at=datetime.now(timezone.utc))
        )
        database.commit()
    except Exception:  # noqa: BLE001 - a missed beat is retried on the next one
        database.rollback()
    finally:
        database.close()


def start_heartbeat(job_id: int) -> "asyncio.Task[None]":
    """Beat for this job until stopped. Runs on the job's event loop, so it
    keeps beating while long stages run in the thread pool; each beat uses
    its own short session off the loop."""

    async def beat() -> None:
        while True:
            await asyncio.to_thread(_touch, job_id)
            await asyncio.sleep(HEARTBEAT_SECONDS)

    return asyncio.get_running_loop().create_task(beat())


async def stop_heartbeat(task: "asyncio.Task[None] | None") -> None:
    if task is None:
        return
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
