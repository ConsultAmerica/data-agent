"""A document's validation report: its processing stages, the file checks,
its type, labels, label-to-value association, completeness, Original File
/ Excel consistency and Oracle mapping readiness.

The report is built from what the workspace already builds (the Original
File layout, business data and validation summary) and is cached until the
document changes: a new page, extraction value, review, type decision or
job. A correction therefore revalidates only what it touches; the file's
own checks and form boxes are read once per file.
"""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
from functools import lru_cache
from pathlib import Path
import threading
import time
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.document_validation import business_fields
from app.document_validation.completeness import completeness_audit
from app.document_validation.consistency import tab_export_consistency
from app.document_validation.file_check import (
    VERSION as FILE_CHECK_VERSION,
    duplicate_check,
    file_status,
    read_form_boxes,
    readability_check,
    verify_stored_file,
)
from app.document_validation.labels import annotate_labels, label_audit
from app.document_validation.readiness import mapping_readiness
from app.models.document import Document
from app.models.document_metadata_field import DocumentMetadataField
from app.models.document_page import DocumentPage
from app.models.extraction_job import ExtractionJob
from app.models.structure_record_review import StructureRecordReview

STAGES = (
    ("uploading", "Uploading"),
    ("file_verified", "File Verified"),
    ("classifying", "Classifying"),
    ("extracting", "Extracting"),
    ("validating", "Validating"),
    ("ready_for_review", "Ready for Review"),
)
# A running job's stage, as the stage it advances.
_JOB_STAGE = {
    "reading_document": "file_verified",
    "verifying_file": "file_verified",
    "rendering_ocr": "extracting",
    "indexing": "extracting",
    "discovering_fields": "extracting",
    "classifying": "classifying",
    "extracting_data": "extracting",
    "validating_results": "validating",
    "v3_classification": "classifying",
}
_JOB_STAGE_LABELS = {
    "reading_document": "Reading the file",
    "verifying_file": "Verifying the file",
    "rendering_ocr": "Reading pages and OCR",
    "indexing": "Indexing pages",
    "discovering_fields": "Finding fields and tables",
    "classifying": "Classifying the document",
    "extracting_data": "Extracting values",
    "validating_results": "Validating values",
    "v3_classification": "Classifying the document",
}
_ACTIVE = ("queued", "processing")

_cache: dict[str, tuple[str, dict[str, Any]]] = {}
_cache_guard = threading.Lock()


def _local_path(document: Document) -> Path | None:
    from app.core.config import get_settings
    from app.services.document_storage import DocumentStorageError, ensure_local_copy

    try:
        return Path(ensure_local_copy(get_settings(), stored_filename=document.stored_filename))
    except (DocumentStorageError, OSError):
        return None


@lru_cache(maxsize=16)
def _form_boxes(path: str, stamp: tuple[int, int]) -> tuple[dict[str, Any], ...] | None:
    boxes = read_form_boxes(path)
    return None if boxes is None else tuple(boxes)


def form_boxes_for(path: Path | None) -> list[dict[str, Any]] | None:
    if path is None or not path.exists():
        return None
    stat = path.stat()
    boxes = _form_boxes(str(path), (stat.st_mtime_ns, stat.st_size))
    return None if boxes is None else list(boxes)


def file_verification(database: Session, document: Document, *, refresh: bool = False,
                      path: Path | None = None, actor: Any = None) -> dict[str, Any]:
    """The stored file's checks, read once per file (kept in the document's
    provenance), plus the live ones: duplicates and OCR readability."""

    from app.services.ingestion_provenance import merge_provenance

    cached = (document.ingestion_provenance or {}).get("file_verification")
    if (
        refresh or not isinstance(cached, dict) or cached.get("version") != FILE_CHECK_VERSION
        or cached.get("checksum") != document.checksum_sha256
    ):
        cached = verify_stored_file(document, path or _local_path(document))
        merge_provenance(document, {"file_verification": cached})
        database.commit()
    duplicates: list[Document] = []
    if document.checksum_sha256:
        from app.core.document_access import scope_documents

        statement = select(Document).where(
            Document.checksum_sha256 == document.checksum_sha256, Document.id != document.id
        )
        # Only documents the caller may see: another workspace's copy is
        # never revealed (as at upload).
        statement = scope_documents(statement, actor) if actor is not None else statement.where(
            Document.owner_workspace == document.owner_workspace
        )
        duplicates = list(database.scalars(statement.limit(10)))
    pages = list(database.scalars(select(DocumentPage).where(DocumentPage.document_id == document.id)))
    checks = list(cached["checks"]) + [duplicate_check(document, duplicates)]
    readable = readability_check(pages)
    if readable is not None:
        checks.append(readable)
    return {"status": file_status(checks), "checks": checks, "facts": cached.get("facts") or {},
            "checked_at": cached.get("checked_at")}


def _fingerprint(database: Session, document: Document) -> str:
    from app.models.document_classification import DocumentClassification

    digest = hashlib.sha256()
    digest.update(repr((document.checksum_sha256, document.processed_page_count, document.processing_status,
                        document.page_count)).encode())
    for row in database.execute(
        select(DocumentMetadataField.id, DocumentMetadataField.value, DocumentMetadataField.review_status,
               DocumentMetadataField.human_approved)
        .where(DocumentMetadataField.document_id == document.id).order_by(DocumentMetadataField.id)
    ):
        digest.update(repr(tuple(row)).encode())
    digest.update(repr(database.execute(
        select(func.count(StructureRecordReview.id), func.max(StructureRecordReview.updated_at))
        .where(StructureRecordReview.document_id == document.id)
    ).one()).encode())
    digest.update(repr(database.execute(
        select(func.max(DocumentClassification.id)).where(DocumentClassification.document_id == document.id)
    ).scalar()).encode())
    digest.update(repr(database.execute(
        select(func.count(DocumentPage.id)).where(DocumentPage.document_id == document.id)
    ).scalar()).encode())
    for job in _jobs(database, document):
        digest.update(repr((job.id, job.status, job.stage)).encode())
    return digest.hexdigest()


def _jobs(database: Session, document: Document) -> list[ExtractionJob]:
    return list(database.scalars(
        select(ExtractionJob).where(ExtractionJob.document_id == document.id).order_by(ExtractionJob.id.desc()).limit(10)
    ))


def entities(layout: dict[str, Any]) -> dict[str, Any]:
    """The contracts a document holds: every distinct value printed under
    a Contract Number label, as a field or a table column."""

    from app.source_structure.original_layout import metadata_concept

    found: list[str] = []

    def add(value: Any) -> None:
        text = str(value or "").strip()
        if text and any(ch.isdigit() for ch in text) and text not in found:
            found.append(text)

    for section in layout.get("sections") or []:
        for item in section["items"]:
            if item.get("form_duplicate"):
                continue
            if item["kind"] == "field":
                if metadata_concept(item.get("field_name") or item.get("label") or "") == "Contract Number":
                    add(item.get("effective_value") or item.get("document_value"))
            else:
                for column, header in enumerate(item.get("headers") or []):
                    if metadata_concept(header) == "Contract Number":
                        for row in item["rows"]:
                            add((row.get("reviewed_cells") or row["cells"])[column] if column < len(row["cells"]) else "")
    return {"contracts": found}


def _failure(job: ExtractionJob) -> dict[str, Any]:
    failure = dict((job.result_json or {}).get("failure") or {})
    failure.setdefault("message", job.error_message or "The job failed")
    failure.setdefault("stage", job.stage)
    failure.setdefault("reason", "interrupted" if "Interrupted" in (job.error_message or "") else "unexpected_error")
    failure.setdefault("retryable", failure["reason"] not in ("file_invalid", "document_missing"))
    failure["job_id"] = job.id
    failure["job_type"] = job.job_type
    failure["retry_count"] = job.retry_count
    return failure


def processing_stages(database: Session, document: Document, *, file: dict[str, Any] | None,
                      classified: bool, validated: bool) -> dict[str, Any]:
    """The six stages from what has actually happened; progress is the
    number of stages done, and pages read when pages are being read."""

    jobs = _jobs(database, document)
    active = next((j for j in jobs if j.status in _ACTIVE), None)
    latest = jobs[0] if jobs else None
    failed = latest if latest is not None and latest.status == "failed" else None
    pages_read = database.execute(
        select(func.count(DocumentPage.id)).where(DocumentPage.document_id == document.id)
    ).scalar() or 0
    extracted = pages_read > 0 or document.processing_status in ("completed", "completed_with_warnings")

    state: dict[str, dict[str, Any]] = {key: {"key": key, "label": label, "status": "pending", "detail": ""} for key, label in STAGES}
    state["uploading"].update(status="done", detail=f"Uploaded {document.uploaded_at:%Y-%m-%d %H:%M} UTC" if document.uploaded_at else "")
    if file is not None:
        state["file_verified"].update(
            status="failed" if file["status"] == "failed" else "done",
            detail=next((c["detail"] for c in file["checks"] if c["status"] == "failed"), "")
            or ("Verified with warnings" if file["status"] == "warning" else "Verified"),
        )
    if classified:
        state["classifying"].update(status="done")
    if extracted:
        state["extracting"].update(
            status="done",
            detail=f"{pages_read} of {document.page_count or pages_read} pages read",
        )
    if validated and extracted:
        state["validating"].update(status="done")
    if active is not None:
        key = _JOB_STAGE.get(active.stage or "", "extracting")
        detail = _JOB_STAGE_LABELS.get(active.stage or "", "Queued" if active.status == "queued" else "Processing")
        if key == "extracting" and document.page_count:
            detail += f" · {document.processed_page_count or pages_read} of {document.page_count} pages"
        state[key].update(status="active", detail=detail, job_id=active.id)
        # Validation waits for the running stage.
        if key != "validating":
            state["validating"].update(status="pending")
    elif failed is not None:
        failure = _failure(failed)
        key = _JOB_STAGE.get(failure.get("stage") or "", "extracting")
        if failure.get("reason") == "file_invalid":
            key = "file_verified"
        state[key].update(status="failed", detail=failure["message"], failure=failure)
    if all(state[k]["status"] == "done" for k, _ in STAGES[:-1]):
        state["ready_for_review"].update(status="done")
    stages = [state[key] for key, _ in STAGES]
    timings = {}
    for job in jobs[:3]:
        for entry in (job.result_json or {}).get("stage_history") or []:
            if entry.get("duration_ms") is not None:
                timings.setdefault(f"{job.job_type}:{entry['stage']}", entry["duration_ms"])
    return {
        "stages": stages,
        "completed": sum(1 for s in stages if s["status"] == "done"),
        "total": len(stages),
        "failed": any(s["status"] == "failed" for s in stages),
        "job_durations_ms": timings,
    }


def _build(database: Session, document: Document, *, refresh_file: bool = False, actor: Any = None) -> dict[str, Any]:
    from app.api.classification import _state
    from app.classification.service import current
    from app.services.document_storage import DocumentStorageError
    from app.skills.business_data import build_business_data
    from app.skills.validation import validation_summary
    from app.source_structure.original_layout import original_layout_for, structure_for

    timings: dict[str, int] = {}

    def timed(name: str, started: float) -> None:
        timings[name] = int((time.perf_counter() - started) * 1000)

    started = time.perf_counter()
    path = _local_path(document)
    file = file_verification(database, document, refresh=refresh_file, path=path, actor=actor)
    timed("file_ms", started)

    classified = current(database, document.id) is not None
    pages = list(database.scalars(
        select(DocumentPage).where(DocumentPage.document_id == document.id).order_by(DocumentPage.page_number)
    ))
    def partial(headline: str | None = None) -> dict[str, Any]:
        """Only the file and the stages: nothing extracted to validate yet."""

        stages = processing_stages(database, document, file=file, classified=classified, validated=False)
        failed = stages["failed"] or headline is not None
        return {
            "document_id": document.id, "generated_at": datetime.now(timezone.utc).isoformat(),
            "processing": stages, "file": file, "classification": None, "labels": None, "association": None,
            "completeness": None, "consistency": None, "entities": {"contracts": []}, "readiness": None,
            "summary": {"state": "failed" if failed else "processing",
                        "headline": headline or ("Processing failed" if failed else "Not extracted yet")},
            "timings_ms": timings,
        }

    if not pages:
        return partial()
    started = time.perf_counter()
    try:
        layout = original_layout_for(database, document)
        structure = structure_for(database, document)
    except DocumentStorageError as exc:
        return partial(f"The source file isn't available: {exc}")
    timed("layout_ms", started)

    started = time.perf_counter()
    state = _state(database, document).model_dump(mode="json")
    family = state.get("family")
    annotate_labels(layout, family)
    business = build_business_data(layout, state)
    validation = validation_summary(business, layout)
    labels = label_audit(layout)
    timed("labels_ms", started)

    started = time.perf_counter()
    completeness = completeness_audit(document, pages, layout, structure, form_boxes_for(path), business)
    timed("completeness_ms", started)

    started = time.perf_counter()
    consistency = tab_export_consistency(layout)
    timed("consistency_ms", started)

    found = entities(layout)
    association_groups = [g for g in validation["groups"] if g["kind"] in ("incorrect_association", "invalid_date", "invalid_number")]
    fields = business_fields(business)
    association = {
        "fields": {
            status: sum(1 for f in fields if f.get("association") == status)
            for status in ("confirmed", "matched", "needs_review", "unresolved")
        },
        "needs_review": [
            {"key": f["key"], "label": f["label"], "value": f.get("value"), "page": f.get("page"),
             "candidates": [c["value"] for c in f.get("candidates") or [] if c.get("value")][:5],
             "issues": [i["message"] for i in f.get("issues") or []][:3]}
            for f in fields if f.get("association") == "needs_review"
        ],
        "issues": [i for g in association_groups for i in g["issues"]][:50],
        "issue_count": sum(len(g["issues"]) for g in association_groups),
    }
    classification = {
        key: state.get(key) for key in (
            "family", "family_label", "document_class", "document_class_label", "subtype", "confidence",
            "confidence_level", "status", "review_status", "decided", "method", "evidence", "thresholds")
    }
    classification["candidates"] = [
        {"family": c["family"], "family_label": c.get("label"), "score": c.get("score"),
         "subtype": c.get("subtype"), "evidence": (c.get("evidence") or [])[:2]}
        for c in (state.get("candidates") or [])[:4]
    ]
    classification["review_required"] = not state.get("decided") and state.get("status") == "review_required"
    # The type isn't forced: a strong alternative is offered for a person to confirm.
    high = (state.get("thresholds") or {}).get("high", 0.85)
    classification["suggested"] = next(
        (c for c in classification["candidates"][1:]
         if not state.get("decided") and state.get("status") != "classified" and (c["score"] or 0) >= high),
        None,
    )
    readiness = mapping_readiness(
        file=file, classification=state, business=business, validation=validation, labels=labels,
        completeness=completeness, entities=found, layout_stats=layout.get("stats") or {},
    )
    stages = processing_stages(database, document, file=file, classified=True, validated=True)
    if stages["failed"]:
        headline, summary_state = "Processing failed", "failed"
    elif readiness["state"] == "review_required":
        headline, summary_state = "Review required before mapping", "review_required"
    elif readiness["state"] == "ready_with_warnings" or completeness["status"] == "gaps":
        headline, summary_state = "Ready for review, with warnings", "warnings"
    else:
        headline, summary_state = "Ready for review", "ready"
    return {
        "document_id": document.id,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "processing": stages,
        "file": file,
        "classification": classification,
        "labels": labels,
        "association": association,
        "completeness": completeness,
        "consistency": consistency,
        "entities": found,
        "readiness": readiness,
        "summary": {"state": summary_state, "headline": headline},
        "timings_ms": timings,
    }


def document_validation(database: Session, document: Document, *, refresh_file: bool = False,
                        actor: Any = None) -> dict[str, Any]:
    """The report, rebuilt only when the document changed (or the file's
    checks are asked for again)."""

    fingerprint = _fingerprint(database, document)
    with _cache_guard:
        hit = _cache.get(document.id)
    if hit is not None and hit[0] == fingerprint and not refresh_file:
        return {**hit[1], "cached": True}
    started = time.perf_counter()
    report = _build(database, document, refresh_file=refresh_file, actor=actor)
    report["timings_ms"]["total_ms"] = int((time.perf_counter() - started) * 1000)
    # The building may itself record a classification: key the cache on
    # the state after it.
    fingerprint = _fingerprint(database, document)
    with _cache_guard:
        _cache[document.id] = (fingerprint, report)
    _record_snapshot(database, document, report)
    return {**report, "cached": False}


def _record_snapshot(database: Session, document: Document, report: dict[str, Any]) -> None:
    """The outcome in the document's provenance, for lists and audits."""

    from app.services.ingestion_provenance import merge_provenance

    readiness = report.get("readiness") or {}
    snapshot = {
        "state": report["summary"]["state"],
        "readiness": readiness.get("state"),
        "file": report["file"]["status"],
        "completeness": (report.get("completeness") or {}).get("status"),
        "consistency": (report.get("consistency") or {}).get("status"),
        "generated_at": report["generated_at"],
        "timings_ms": report["timings_ms"],
    }
    if (document.ingestion_provenance or {}).get("validation") != snapshot:
        merge_provenance(document, {"validation": snapshot})
        database.commit()


def forget(document_id: str) -> None:
    with _cache_guard:
        _cache.pop(document_id, None)
