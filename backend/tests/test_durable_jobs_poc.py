"""Durable processing proof of concept: crash recovery, no duplicates, page
order, bounded retries."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from app.workflow import durable_jobs as wf

T0 = datetime(2026, 10, 29, 12, 0, tzinfo=timezone.utc)


@pytest.fixture
def db():
    engine = create_engine("sqlite://")
    wf.Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session


def _work(task: wf.Task) -> dict:
    first, last = task.payload["pages"]
    return {"pages": list(range(first, last + 1))}


def test_a_288_page_document_is_processed_in_order_by_several_workers(db) -> None:
    run = wf.enqueue(db, document_id="doc", input_digest="sha-1", page_count=288, batch_pages=25)
    workers = ["w1", "w2", "w3"]
    turn = 0
    while (task := wf.claim(db, workers[turn % 3], now=T0)) is not None:
        assert wf.complete(db, task, workers[turn % 3], _work(task))
        turn += 1
    db.refresh(run)
    assert run.status == "completed"
    pages = [page for result in wf.results(db, run.id) for page in result["pages"]]
    assert pages == list(range(1, 289))  # every page once, in order


def test_enqueue_is_idempotent(db) -> None:
    first = wf.enqueue(db, document_id="doc", input_digest="sha-1", page_count=60, batch_pages=25)
    again = wf.enqueue(db, document_id="doc", input_digest="sha-1", page_count=60, batch_pages=25)
    assert again.id == first.id
    assert db.scalar(select(func.count()).select_from(wf.Task)) == 3


def test_a_crashed_worker_s_batch_is_taken_over_and_its_late_answer_refused(db) -> None:
    run = wf.enqueue(db, document_id="doc", input_digest="sha-2", page_count=50, batch_pages=25)
    lost = wf.claim(db, "crashed-worker", now=T0)
    # The worker dies: no heartbeat, no completion. Before the lease ends
    # nobody else may take the batch…
    assert wf.claim(db, "w2", now=T0 + timedelta(seconds=30)).seq == 1
    assert wf.progress(db, run.id, now=T0 + wf.LEASE + timedelta(seconds=1))["stalled"] == [0]
    # …after it, another worker does.
    taken = wf.claim(db, "w2", now=T0 + wf.LEASE + timedelta(seconds=1))
    assert taken.id == lost.id and taken.attempts == 2
    assert wf.complete(db, taken, "w2", _work(taken))
    # The original worker comes back late: refused, nothing duplicated.
    assert not wf.complete(db, lost, "crashed-worker", {"pages": ["duplicate"]})
    second = db.scalars(select(wf.Task).where(wf.Task.seq == 1)).one()
    assert wf.complete(db, second, "w2", _work(second))
    db.refresh(run)
    assert run.status == "completed"
    assert [r["pages"][0] for r in wf.results(db, run.id)] == [1, 26]
    assert wf.progress(db, run.id)["retries"] == 1


def test_heartbeat_keeps_a_long_batch_from_being_taken(db) -> None:
    wf.enqueue(db, document_id="doc", input_digest="sha-3", page_count=10, batch_pages=10)
    task = wf.claim(db, "w1", now=T0)
    assert wf.heartbeat(db, task, "w1", now=T0 + timedelta(minutes=1, seconds=50))
    assert wf.claim(db, "w2", now=T0 + timedelta(minutes=3)) is None  # still leased
    assert not wf.heartbeat(db, task, "someone-else", now=T0 + timedelta(minutes=3))


def test_a_batch_that_keeps_failing_fails_the_run_after_bounded_attempts(db) -> None:
    run = wf.enqueue(db, document_id="doc", input_digest="sha-4", page_count=10, batch_pages=10)
    for attempt in range(wf.MAX_ATTEMPTS):
        task = wf.claim(db, "w1", now=T0)
        assert task.attempts == attempt + 1
        wf.fail(db, task, "w1", "OCR error")
    assert wf.claim(db, "w1", now=T0) is None
    db.refresh(run)
    assert run.status == "failed"
    assert wf.progress(db, run.id)["failed"] == 1
