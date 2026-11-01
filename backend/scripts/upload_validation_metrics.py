"""Measure upload validation over the test matrix and print the results.

Runs tests/test_upload_validation_metrics.py (in the test suite's own
database, never the dev database) and prints its measurements: label,
value and table accuracy, classification, association false positives and
negatives, coverage and timings.

    python scripts/upload_validation_metrics.py [--json out.json]
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", help="Also keep the measurements in this file")
    args = parser.parse_args()
    out = Path(args.json) if args.json else Path(tempfile.mkdtemp()) / "upload-validation-metrics.json"
    env = {**os.environ, "UPLOAD_VALIDATION_METRICS": str(out)}
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "tests/test_upload_validation_metrics.py"],
        cwd=ROOT, env=env,
    )
    if not out.exists():
        print("No measurements were written.")
        return result.returncode or 1
    data = json.loads(out.read_text(encoding="utf-8"))
    summary = data["summary"]
    print("\nDocument            Type (status, conf)                    Labels Values Tables Coverage  Excel       Readiness            Assoc. found         FP FN  ms")
    for r in data["documents"]:
        kind = f"{r['family']} ({r['classification_status']}, {r['confidence'] if r['confidence'] is not None else '-'})"
        print(
            f"{r['document']:<19} {kind[:38]:<38} {r['labels'][0]}/{r['labels'][1]:<4} {r['values'][0]}/{r['values'][1]:<4} "
            f"{r['tables'][0]}/{r['tables'][1]:<4} {r['completeness']:<9} {r['consistency']:<11} {r['readiness']:<20} "
            f"{','.join(r['association_found']) or '-':<20} {len(r['false_positives']):<2} {len(r['false_negatives']):<2} "
            f"{r['ingest_ms']}+{r['validate_ms']}"
        )
    print("\n" + json.dumps(summary, indent=2))
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
