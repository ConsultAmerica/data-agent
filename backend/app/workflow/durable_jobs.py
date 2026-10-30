"""Durable, lease-based document processing — proof of concept (Increment
7.1). Not wired into the app: it runs on its own tables and metadata, so
it changes no existing schema. It validates the design in
docs/vnext-13-increment-7-1-migration-audit.md:

- A run per document (idempotency key: no second run for the same input).
- One task per page batch, in page order (``seq``).
- A worker claims a task with a time-limited lease; a crashed worker's
  lease expires and another worker takes the batch over.
- Completing requires the current lease, so a late answer from a worker
  that lost its lease is refused and cannot write a duplicate.
- Each task's result is its checkpoint; the run's output is the results in
  page order. Attempts are bounded; a task that keeps failing fails the run.

Any host can run the workers — a container, a scheduled function, or a
queue consumer — because all state lives in the database.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import uuid4

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, or_, select, update
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column

MAX_ATTEMPTS = 3
LEASE = timedelta(minutes=2)


class Base(DeclarativeBase):
    pass


class Run(Base):
    __tablename__ = "wf_runs"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    document_id: Mapped[str] = mapped_column(String(36))
    idempotency_key: Mapped[str] = mapped_column(String(120), unique=True)
    status: Mapped[str] = mapped_column(String(20), default="running")  # running | completed | failed | cancelled
    # The application job this run carries out (extraction_jobs.id), if any.
    job_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)


class Task(Base):
    __tablename__ = "wf_tasks"
    __table_args__ = (UniqueConstraint("run_id", "seq"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("wf_runs.id"))
    seq: Mapped[int] = mapped_column(Integer)
    payload: Mapped[dict] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending | leased | done | failed
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    lease_owner: Mapped[str | None] = mapped_column(String(64), nullable=True)
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime | None) -> datetime | None:
    return value.replace(tzinfo=timezone.utc) if value is not None and value.tzinfo is None else value


def enqueue(
    db: Session, *, document_id: str, input_digest: str, page_count: int, batch_pages: int, job_id: int | None = None, commit: bool = True
) -> Run:
    """The run for this exact input; created once (same key → same run)."""

    key = f"{document_id}:{input_digest}"
    existing = db.scalars(select(Run).where(Run.idempotency_key == key)).first()
    if existing is not None:
        return existing
    run = Run(document_id=document_id, idempotency_key=key, job_id=job_id)
    db.add(run)
    db.flush()
    for seq, first in enumerate(range(1, page_count + 1, batch_pages)):
        db.add(Task(run_id=run.id, seq=seq, payload={"pages": [first, min(first + batch_pages - 1, page_count)]}))
    if commit:
        db.commit()
    return run


def claim(db: Session, worker: str, *, now: datetime | None = None) -> Task | None:
    """Lease the next runnable task (pending, or leased with an expired
    lease) in page order. The conditional UPDATE makes the claim atomic: of
    two workers racing for a task, exactly one gets it."""

    now = now or _now()
    runnable = or_(Task.status == "pending", (Task.status == "leased") & (Task.lease_expires_at < now))
    running = select(Run.id).where(Run.status == "running")
    query = select(Task).where(runnable, Task.run_id.in_(running)).order_by(Task.run_id, Task.seq)
    for task in db.scalars(query):
        claimed = db.execute(
            update(Task)
            .where(Task.id == task.id, runnable, Task.attempts == task.attempts)
            .values(status="leased", lease_owner=worker, lease_expires_at=now + LEASE, attempts=Task.attempts + 1)
            .execution_options(synchronize_session=False)
        ).rowcount
        db.commit()
        if claimed == 1:
            db.refresh(task)
            if task.attempts > MAX_ATTEMPTS:
                return _give_up(db, task, "attempts exhausted (worker kept stopping)")
            return task
    return None


def claim_task(db: Session, run_id: str, seq: int, worker: str, *, now: datetime | None = None) -> tuple[Task | None, str]:
    """Lease one named batch (a queue message names its batch). Returns the
    task, or None with why: "done" / "failed" / "cancelled" (nothing left to
    do — acknowledge), "leased" (another worker holds a live lease — retry
    later), "missing"."""

    now = now or _now()
    task = db.scalars(select(Task).where(Task.run_id == run_id, Task.seq == seq)).first()
    if task is None:
        return None, "missing"
    if task.status in ("done", "failed", "cancelled"):
        return None, task.status
    run = db.get(Run, run_id)
    if run is None or run.status != "running":
        return None, "cancelled" if run is not None and run.status == "cancelled" else (run.status if run else "missing")
    runnable = or_(Task.status == "pending", (Task.status == "leased") & (Task.lease_expires_at < now))
    claimed = db.execute(
        update(Task)
        .where(Task.id == task.id, runnable, Task.attempts == task.attempts)
        .values(status="leased", lease_owner=worker, lease_expires_at=now + LEASE, attempts=Task.attempts + 1)
        .execution_options(synchronize_session=False)
    ).rowcount
    db.commit()
    db.refresh(task)
    if claimed != 1:
        return None, task.status
    if task.attempts > MAX_ATTEMPTS:
        _give_up(db, task, "attempts exhausted (worker kept stopping)")
        return None, "failed"
    return task, "leased"


def heartbeat(db: Session, task: Task, worker: str, *, now: datetime | None = None) -> bool:
    """Extend the lease while working on a long batch; False if it was lost."""

    now = now or _now()
    extended = db.execute(
        update(Task)
        .where(Task.id == task.id, Task.status == "leased", Task.lease_owner == worker)
        .values(lease_expires_at=now + LEASE)
        .execution_options(synchronize_session=False)
    ).rowcount
    db.commit()
    return extended == 1


def complete(db: Session, task: Task, worker: str, result: dict) -> bool:
    """Record the batch's result — only while still holding its lease. The
    caller's own writes for the batch (made in this session, uncommitted)
    commit with it, or roll back with it when the lease was lost."""

    done = db.execute(
        update(Task)
        .where(Task.id == task.id, Task.status == "leased", Task.lease_owner == worker)
        .values(status="done", result=result, lease_owner=None, lease_expires_at=None)
        .execution_options(synchronize_session=False)
    ).rowcount
    if done != 1:
        db.rollback()
        return False
    db.commit()
    _settle(db, task.run_id)
    return True


def fail(db: Session, task: Task, worker: str, error: str) -> None:
    db.refresh(task)
    if task.status != "leased" or task.lease_owner != worker:
        return
    if task.attempts >= MAX_ATTEMPTS:
        _give_up(db, task, error)
        return
    task.status, task.lease_owner, task.lease_expires_at, task.error = "pending", None, None, error
    db.commit()


def _give_up(db: Session, task: Task, error: str) -> None:
    task.status, task.lease_owner, task.lease_expires_at, task.error = "failed", None, None, error
    db.commit()
    _settle(db, task.run_id)
    return None


def _settle(db: Session, run_id: str) -> None:
    run = db.get(Run, run_id)
    if run.status != "running":
        return
    statuses = list(db.scalars(select(Task.status).where(Task.run_id == run_id)))
    if "failed" in statuses:
        run.status, run.error = "failed", "a batch failed after its last attempt"
    elif all(status == "done" for status in statuses):
        run.status = "completed"
    db.commit()


def cancel(db: Session, run_id: str) -> None:
    """Stop the run: no further batches are claimed; a batch in progress may
    finish, but its result no longer changes the run's state."""

    run = db.get(Run, run_id)
    if run is not None and run.status == "running":
        run.status = "cancelled"
        db.execute(
            update(Task)
            .where(Task.run_id == run_id, Task.status == "pending")
            .values(status="cancelled")
            .execution_options(synchronize_session=False)
        )
        db.commit()


def results(db: Session, run_id: str) -> list[dict]:
    """The checkpoints of completed batches, in page order."""

    return [t.result for t in db.scalars(select(Task).where(Task.run_id == run_id, Task.status == "done").order_by(Task.seq))]


def progress(db: Session, run_id: str, *, now: datetime | None = None) -> dict:
    now = now or _now()
    tasks = list(db.scalars(select(Task).where(Task.run_id == run_id)))
    stalled = [t.seq for t in tasks if t.status == "leased" and _aware(t.lease_expires_at) < now]
    return {
        "batches": len(tasks),
        "done": sum(t.status == "done" for t in tasks),
        "failed": sum(t.status == "failed" for t in tasks),
        "retries": sum(max(0, t.attempts - 1) for t in tasks),
        "stalled": stalled,
    }
