"""Page-batch processing and finalisation for the Vercel proof of concept.

Reuses the application's own page reading: ``sorted_page_text`` (native
text, byte-identical to PyMuPDF's sorted text), ``detect_ocr_requirement``
(OCR only for pages without usable text), Tesseract through MuPDF's built-in
engine with a bundled ``eng.traineddata`` (no system binary), and the
source-structure extractor for labelled fields and tables. Each page row is
an upsert keyed by (document, page number), so a retried batch rewrites the
same rows instead of adding new ones.
"""

from __future__ import annotations

import os
import time
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.document import Document
from app.models.document_page import DocumentPage


def tessdata_dir() -> str | None:
    configured = os.environ.get("TESSDATA_PREFIX")
    if configured and Path(configured, "eng.traineddata").exists():
        return configured
    bundled = Path(__file__).parent / "tessdata"
    return str(bundled) if (bundled / "eng.traineddata").exists() else None


def process_pages(db: Session, document: Document, pdf_bytes: bytes, first: int, last: int) -> dict:
    """Read pages first..last into document_pages (uncommitted: the caller
    commits them together with the batch's completion)."""

    import fitz

    from app.services.ocr_detection import detect_ocr_requirement
    from app.services.sorted_page_text import sorted_page_text
    from app.source_structure.pdf_structure import extract_page_structure, native_words

    settings = get_settings()
    tessdata = tessdata_dir()
    timings = {"text_ms": 0, "ocr_ms": 0, "structure_ms": 0}
    summary = {"pages": [first, last], "ocr_pages": 0, "ocr_failed": 0, "chars": 0, "fields": 0, "tables": 0}
    existing = {
        row.page_number: row
        for row in db.scalars(
            select(DocumentPage).where(
                DocumentPage.document_id == document.id,
                DocumentPage.page_number.between(first, last),
            )
        )
    }
    with fitz.open("pdf", pdf_bytes) as pdf:
        for number in range(first, last + 1):
            page = pdf[number - 1]
            started = time.perf_counter()
            native = sorted_page_text(page).strip()
            blocks = page.get_text("blocks", sort=True)
            detection = detect_ocr_requirement(page=page, native_text=native, native_blocks=blocks, settings=settings)
            timings["text_ms"] += int((time.perf_counter() - started) * 1000)

            text, method, ocr_ok, ocr_error = native, "native", False, None
            if detection.requires_ocr and settings.ocr_enabled:
                started = time.perf_counter()
                if tessdata is None:
                    ocr_error = "OCR language data (eng.traineddata) is not available."
                else:
                    try:
                        textpage = page.get_textpage_ocr(dpi=settings.ocr_dpi, full=True, language="eng", tessdata=tessdata)
                        text = page.get_text("text", textpage=textpage, sort=True).strip()
                        method, ocr_ok = "ocr", True
                    except Exception as exc:  # noqa: BLE001 - recorded on the page, never silent
                        ocr_error = f"{type(exc).__name__}: {str(exc)[:200]}"
                timings["ocr_ms"] += int((time.perf_counter() - started) * 1000)
                summary["ocr_pages"] += 1
                summary["ocr_failed"] += 0 if ocr_ok else 1
            else:
                started = time.perf_counter()
                structure = extract_page_structure(
                    page_number=number, words=native_words(page), extraction_method="native", fitz_page=page
                )
                summary["fields"] += sum(1 for f in structure.fields if f.acceptance == "accepted")
                summary["tables"] += sum(1 for t in structure.tables if t.acceptance == "accepted")
                timings["structure_ms"] += int((time.perf_counter() - started) * 1000)

            row = existing.get(number) or DocumentPage(document_id=document.id, page_number=number)
            row.page_width, row.page_height = float(page.rect.width), float(page.rect.height)
            row.native_text, row.final_text = native, text
            row.ocr_text = text if method == "ocr" else None
            row.extraction_method = method
            row.requires_ocr = bool(detection.requires_ocr)
            row.ocr_attempted = bool(detection.requires_ocr and settings.ocr_enabled)
            row.ocr_succeeded = ocr_ok
            row.ocr_error = ocr_error
            row.text_length = row.character_count = len(text)
            row.word_count = len(text.split())
            row.extraction_status = "completed" if (method == "native" or ocr_ok) else "failed"
            row.extracted_at = datetime.now(timezone.utc)
            if number not in existing:
                db.add(row)
            summary["chars"] += len(text)
    summary["timings_ms"] = timings
    return summary


def finalize(db: Session, document: Document) -> dict:
    """Document-level steps after every page is read: counts, the
    application's classification and its key-date detection (roles,
    evidence, expiry status). Each step is recorded, never skipped silently."""

    outcome: dict = {}
    pages = list(db.scalars(select(DocumentPage).where(DocumentPage.document_id == document.id)))
    document.processed_page_count = len(pages)
    document.ocr_required_page_count = sum(1 for p in pages if p.requires_ocr)
    document.ocr_completed_page_count = sum(1 for p in pages if p.ocr_succeeded)
    document.processing_status = "completed"
    db.commit()

    started = time.perf_counter()
    try:
        from app.classification.service import record_prediction

        prediction = record_prediction(db, document)
        outcome["classification"] = {"family": prediction.family, "confidence": prediction.confidence}
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        outcome["classification"] = {"error": type(exc).__name__}
    outcome["classification_ms"] = int((time.perf_counter() - started) * 1000)

    started = time.perf_counter()
    try:
        from app.key_dates.service import refresh_key_dates

        rows = refresh_key_dates(db, document)
        outcome["key_dates"] = [
            {"role": r.kind, "label": r.label, "date": str(r.date), "page": r.page, "has_evidence": bool(r.evidence_text)}
            for r in rows
        ]
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        outcome["key_dates"] = {"error": type(exc).__name__}
    outcome["key_dates_ms"] = int((time.perf_counter() - started) * 1000)
    return outcome
