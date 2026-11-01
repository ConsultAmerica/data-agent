"""Accuracy of upload validation over the document matrix: classification,
label accuracy, value accuracy, table accuracy, association false positives
and negatives, coverage and processing time.

Always asserts the thresholds below. With UPLOAD_VALIDATION_METRICS set to a
file path, also writes the measurements there as JSON
(scripts/upload_validation_metrics.py prints them as tables).
"""

from __future__ import annotations

import json
import os
import time
from uuid import uuid4

from fastapi.testclient import TestClient

from app.main import app
from app.document_validation import layout_fields, layout_tables
from validation_matrix import MATRIX, fields_by_name, large_pdf, shown_value

client = TestClient(app)

# Documents built to hold a wrong-box value, and the issue each must raise.
_EXPECTED_ISSUES = {
    "ambiguous_association": {"value_is_label"},
    "shared_identifier": {"shared_identifier"},
}


def _measure(doc) -> dict:
    started = time.perf_counter()
    upload = client.post("/api/documents/upload",
                         files={"file": (f"{doc.name}-{uuid4().hex[:6]}.pdf", doc.build(), "application/pdf")})
    document_id = upload.json()["document_id"]
    client.post(f"/api/documents/{document_id}/extract-pages", json={"run_ocr": False})
    if doc.decide:
        client.post(f"/api/documents/{document_id}/classification/decision",
                    json={"action": "override", "family": doc.decide, "apply": True})
    ingest_ms = int((time.perf_counter() - started) * 1000)
    started = time.perf_counter()
    report = client.get(f"/api/documents/{document_id}/upload-validation").json()
    validate_ms = int((time.perf_counter() - started) * 1000)
    layout = client.get(f"/api/documents/{document_id}/original-structure").json()
    business = client.get(f"/api/documents/{document_id}/business-data").json()

    fields = list(layout_fields(layout))
    labels_ok = sum(
        1 for printed, display in doc.labels.items()
        if any((f.get("label_info") or {}).get("printed", "").rstrip(":") == printed
               and f["label_info"]["display"] == display for f in fields)
    )
    names = fields_by_name(layout)
    values_ok = sum(1 for name, value in doc.values.items() if name in names and shown_value(names[name]) == value)
    tables = [t for t in layout_tables(layout) if not t.get("form_duplicate")]
    tables_ok = sum(
        1 for title, (columns, rows) in doc.tables.items()
        if any((t.get("title") == title or len(t["headers"]) == columns)
               and (len(t["headers"]), t["row_count"]) == (columns, rows) for t in tables)
    )
    codes = {i["code"] for s in business.get("sections") or [] for f in s.get("fields") or [] for i in f.get("issues") or []}
    codes |= {i.get("code") for i in (report["association"] or {}).get("issues") or [] if i.get("code")}
    association_codes = codes & {"value_is_label", "shared_identifier", "invalid_date", "invalid_number"}
    expected = _EXPECTED_ISSUES.get(doc.name, set())
    classification = report["classification"] or {}
    correct_type = (
        classification.get("decided") or doc.families is None or classification.get("family") in doc.families
    )
    return {
        "document": doc.name,
        "tags": list(doc.tags),
        "family": classification.get("family"),
        "classification_status": classification.get("status"),
        "confidence": classification.get("confidence"),
        "type_correct": bool(correct_type),
        "type_held_for_review": not correct_type and classification.get("status") != "classified",
        "labels": [labels_ok, len(doc.labels)],
        "values": [values_ok, len(doc.values)],
        "tables": [tables_ok, len(doc.tables)],
        "fields": len(fields),
        "labels_resolved": [report["labels"]["resolved"], report["labels"]["total"]],
        "completeness": report["completeness"]["status"],
        "coverage": {m["key"]: [m["represented"], m["source"]] for m in report["completeness"]["measures"]
                     if m["status"] in ("complete", "gaps")},
        "consistency": report["consistency"]["status"],
        "readiness": report["readiness"]["state"],
        "association_found": sorted(association_codes),
        "association_expected": sorted(expected),
        "false_negatives": sorted(expected - association_codes),
        # A wrong-box finding on a document built without one.
        "false_positives": sorted(association_codes - expected) if doc.name not in _EXPECTED_ISSUES else [],
        "ingest_ms": ingest_ms,
        "validate_ms": validate_ms,
        "report_timings_ms": report["timings_ms"],
    }


def test_upload_validation_accuracy_over_the_matrix() -> None:
    rows = [_measure(doc) for doc in MATRIX]

    started = time.perf_counter()
    upload = client.post("/api/documents/upload",
                         files={"file": (f"large-{uuid4().hex[:6]}.pdf", large_pdf(288), "application/pdf")})
    document_id = upload.json()["document_id"]
    client.post(f"/api/documents/{document_id}/extract-pages", json={"run_ocr": False})
    large_ingest_ms = int((time.perf_counter() - started) * 1000)
    started = time.perf_counter()
    large = client.get(f"/api/documents/{document_id}/upload-validation").json()
    large_validate_ms = int((time.perf_counter() - started) * 1000)
    started = time.perf_counter()
    client.get(f"/api/documents/{document_id}/upload-validation")
    large_cached_ms = int((time.perf_counter() - started) * 1000)

    totals = {key: [sum(r[key][0] for r in rows), sum(r[key][1] for r in rows)] for key in ("labels", "values", "tables")}
    summary = {
        "documents": len(rows),
        "label_accuracy": totals["labels"],
        "value_accuracy": totals["values"],
        "table_accuracy": totals["tables"],
        "types_correct": sum(r["type_correct"] for r in rows),
        "types_held_for_review": sum(r["type_held_for_review"] for r in rows),
        "types_wrong_and_confident": sum(1 for r in rows if not r["type_correct"] and not r["type_held_for_review"]),
        "false_positives": sum(len(r["false_positives"]) for r in rows),
        "false_negatives": sum(len(r["false_negatives"]) for r in rows),
        "consistent_exports": sum(r["consistency"] == "consistent" for r in rows),
        "large_document": {
            "pages": 288, "ingest_ms": large_ingest_ms, "validate_ms": large_validate_ms, "cached_ms": large_cached_ms,
            "report_timings_ms": large["timings_ms"],
            "pages_represented": next(m["represented"] for m in large["completeness"]["measures"] if m["key"] == "pages"),
        },
    }
    out = os.environ.get("UPLOAD_VALIDATION_METRICS")
    if out:
        with open(out, "w", encoding="utf-8") as handle:
            json.dump({"summary": summary, "documents": rows}, handle, indent=2)

    assert summary["label_accuracy"][0] == summary["label_accuracy"][1], [r for r in rows if r["labels"][0] < r["labels"][1]]
    assert summary["value_accuracy"][0] == summary["value_accuracy"][1], [r for r in rows if r["values"][0] < r["values"][1]]
    assert summary["table_accuracy"][0] == summary["table_accuracy"][1]
    assert summary["types_wrong_and_confident"] == 0, rows
    assert summary["false_negatives"] == 0, rows
    assert summary["consistent_exports"] == len(rows)
    assert summary["large_document"]["pages_represented"] == 288
