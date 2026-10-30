"""Where processing and extraction time goes, from the metrics recorded on
recent jobs (app/services/job_metrics.py). Reads job timings only, never
document content.

    python scripts/pipeline_timing_report.py [--jobs 50]
"""

from __future__ import annotations

import argparse
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select  # noqa: E402

from app.database.session import SessionLocal  # noqa: E402
from app.models.extraction_job import ExtractionJob  # noqa: E402


def _median(values: list[float]) -> float:
    return statistics.median(values) if values else 0.0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jobs", type=int, default=50, help="recent completed jobs of each type")
    args = parser.parse_args()

    database = SessionLocal()
    for job_type in ("processing", "extraction"):
        jobs = [
            job for job in database.scalars(
                select(ExtractionJob)
                .where(ExtractionJob.job_type == job_type, ExtractionJob.status == "complete")
                .order_by(ExtractionJob.id.desc())
                .limit(args.jobs * 4)
            )
            if (job.result_json or {}).get("metrics")
        ][: args.jobs]
        print(f"\n== {job_type}: {len(jobs)} jobs with metrics")
        if not jobs:
            continue
        metrics = [job.result_json["metrics"] for job in jobs]
        totals = [m["total_ms"] for m in metrics]
        print(f"total      median {_median(totals) / 1000:.2f}s  max {max(totals) / 1000:.2f}s")
        waits = [m["queue_wait_ms"] for m in metrics if m.get("queue_wait_ms") is not None]
        print(f"queue wait median {_median(waits):.0f}ms  max {max(waits, default=0)}ms")
        print(f"startup    median {_median([m['worker_startup_ms'] for m in metrics]):.0f}ms")
        stages: dict[str, list[int]] = {}
        shares: dict[str, list[float]] = {}
        for m in metrics:
            for stage in m["stages"]:
                stages.setdefault(stage["stage"], []).append(stage["ms"])
                shares.setdefault(stage["stage"], []).append(stage["percent"])
        print(f"{'stage':34} {'median ms':>10} {'max ms':>8} {'median %':>9} {'jobs':>5}")
        for name in sorted(stages, key=lambda key: -_median(stages[key])):
            values = stages[name]
            print(f"{name:34} {_median(values):>10.0f} {max(values):>8} {_median(shares[name]):>8.1f}% {len(values):>5}")
        ai = [m["ai"] for m in metrics]
        print(
            f"AI calls   total {sum(a['calls'] for a in ai)}  succeeded {sum(a['succeeded'] for a in ai)}  "
            f"failed {sum(a['failed'] for a in ai)}  retries {sum(a['retries'] for a in ai)}  "
            f"median latency {_median([a['median_ms'] for a in ai if a['calls']]):.0f}ms  max {max((a['max_ms'] for a in ai), default=0)}ms"
        )
        print(f"OCR pages  total {sum(m['ocr_pages'] for m in metrics)}")
        records: dict[str, int] = {}
        for m in metrics:
            for key, value in (m.get("records") or {}).items():
                records[key] = records.get(key, 0) + value
        print("records    " + "  ".join(f"{key} {value}" for key, value in records.items()))


if __name__ == "__main__":
    main()
