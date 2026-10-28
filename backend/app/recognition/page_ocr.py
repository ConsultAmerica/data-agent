"""Pluggable OCR for scanned pages (services/page_text_extractor.py).

OCR_ENGINE=tesseract (default) changes nothing: no engine is resolved and
the built-in Tesseract path runs. Any other engine is used only when it is
configured AND policy allows this document's data class (at upload a
document is usually unclassified — see app/recognition/policy.py). The
page is sent as the same image Tesseract would read, so the engine's
word boxes are in that image's pixel space and every downstream geometry
consumer works unchanged. A failed or refused page falls back to Tesseract.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
import tempfile
import time
import uuid
from pathlib import Path

from sqlalchemy.orm import Session

from app.core.observability import log_event
from app.recognition.layout import PageLayout
from app.recognition.policy import classify_for_policy, decide_external_processing
from app.recognition.types import RecognitionRequest
from app.services.ocr_word_layer import OcrLayout, OcrLine, OcrWord
from app.services.processing_versions import EXTRACTION_PROCESSOR_VERSION

logger = logging.getLogger(__name__)


def layout_to_ocr(page: PageLayout, engine: str) -> OcrLayout | None:
    """A provider's page (ocr_pixels) as the OcrLayout the pipeline stores.
    Words are assigned to the line whose box contains their centre."""

    if not page.words:
        return None
    lines_src = page.lines or []
    buckets: dict[int, list] = {i: [] for i in range(len(lines_src))}
    loose = []
    for word in page.words:
        cx, cy = (word.bbox[0] + word.bbox[2]) / 2, (word.bbox[1] + word.bbox[3]) / 2
        index = next(
            (i for i, line in enumerate(lines_src)
             if line.bbox[0] - 1 <= cx <= line.bbox[2] + 1 and line.bbox[1] - 1 <= cy <= line.bbox[3] + 1),
            None,
        )
        (buckets[index] if index is not None else loose).append(word)

    groups = [ws for ws in buckets.values() if ws]
    # Words no line claimed: their own lines, split where the top edge
    # moves by more than half a word height.
    loose_groups: list[list] = []
    for word in sorted(loose, key=lambda w: (w.bbox[1], w.bbox[0])):
        height = max(1.0, word.bbox[3] - word.bbox[1])
        if loose_groups and abs(loose_groups[-1][-1].bbox[1] - word.bbox[1]) <= height / 2:
            loose_groups[-1].append(word)
        else:
            loose_groups.append([word])
    groups.extend(loose_groups)

    words_out: list[OcrWord] = []
    lines_out: list[OcrLine] = []
    for line_num, group in enumerate(sorted(groups, key=lambda ws: (min(w.bbox[1] for w in ws), min(w.bbox[0] for w in ws)))):
        group = sorted(group, key=lambda w: w.bbox[0])
        ocr_words = [
            OcrWord(
                text=w.text, conf=w.confidence if w.confidence is not None else 0.0,
                x0=w.bbox[0], y0=w.bbox[1], x1=w.bbox[2], y1=w.bbox[3],
                block_num=0, line_num=line_num, word_num=i,
            )
            for i, w in enumerate(group)
        ]
        words_out.extend(ocr_words)
        confs = [w.conf for w in ocr_words]
        lines_out.append(
            OcrLine(
                text=" ".join(w.text for w in ocr_words),
                conf=sum(confs) / len(confs),
                x0=min(w.x0 for w in ocr_words), y0=min(w.y0 for w in ocr_words),
                x1=max(w.x1 for w in ocr_words), y1=max(w.y1 for w in ocr_words),
                words=ocr_words,
            )
        )
    known = [w.confidence for w in page.words if w.confidence is not None]
    return OcrLayout(
        words=words_out,
        lines=lines_out,
        mean_word_confidence=sum(known) / len(known) if known else None,
        engine=engine,
    )


class PageOcrEngine:
    """Runs one external provider on rendered page images, recording a
    RecognitionRun per page."""

    def __init__(self, provider, *, database: Session, document, data_class: str, timeout_s: float = 120.0):
        self.provider = provider
        self.database = database
        self.document = document
        self.data_class = data_class
        self.timeout_s = timeout_s
        self.run_id = str(uuid.uuid4())

    @property
    def engine_id(self) -> str:
        return self.provider.provider_id

    def ocr(self, png_bytes: bytes, *, page_number: int) -> OcrLayout | None:
        started = time.perf_counter()
        status, error_kind, result = "error", None, None
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / f"page-{page_number}.png"
            path.write_bytes(png_bytes)
            request = RecognitionRequest(
                document_id=self.document.id,
                run_id=self.run_id,
                profile_key=None,
                data_class=self.data_class,
                deadline_s=self.timeout_s,
                file_path=str(path),
                mime_type="image/png",
            )
            try:
                result = asyncio.run(asyncio.wait_for(self.provider.recognize(request), self.timeout_s))
                status = "ok"
            except Exception as exc:  # noqa: BLE001 - the page falls back to Tesseract
                error_kind = type(exc).__name__[:20]
                logger.warning("External OCR (%s) failed on page %s: %s", self.engine_id, page_number, exc)
        self._record(page_number, status, error_kind, started, result)
        if result is None or not result.pages:
            return None
        return layout_to_ocr(result.pages[0], self.engine_id)

    def _record(self, page_number, status, error_kind, started, result) -> None:
        from app.models.recognition_run import RecognitionRun

        usage = result.usage if result is not None else None
        info = result.model if result is not None else self.provider.model_info()
        self.database.add(
            RecognitionRun(
                run_id=self.run_id,
                document_id=self.document.id,
                provider_id=self.engine_id[:40],
                model=info.model and str(info.model)[:80],
                model_version=info.version and str(info.version)[:40],
                locality=self.provider.locality,
                method=f"page_ocr:{page_number}",
                status=status,
                error_kind=error_kind,
                data_class=self.data_class,
                pipeline_version=EXTRACTION_PROCESSOR_VERSION,
                duration_ms=int((time.perf_counter() - started) * 1000),
                pages=usage.pages if usage else None,
                estimated_cost_usd=usage.estimated_cost_usd if usage else None,
            )
        )


def resolve_page_ocr_engine(database: Session, document, settings) -> PageOcrEngine | None:
    """The configured external OCR engine for this document, or None for
    the built-in Tesseract path (the default)."""

    name = (getattr(settings, "ocr_engine", "tesseract") or "tesseract").strip().lower()
    if name == "tesseract":
        # No Tesseract binary on this machine: scanned pages and photos would
        # get no text at all (and so no document type). Read them with the
        # local RapidOCR engine instead, when it is installed.
        from app.recognition.providers import rapid_ocr

        if shutil.which("tesseract") is not None or not rapid_ocr.available():
            return None
        log_event("page_ocr_engine", stage="rendering_ocr", status="tesseract_missing_fallback", engine="rapidocr")
        # Local and needs no settings: built directly, not via the registry
        # (which also constructs every cloud/LLM client — seconds, per document).
        return PageOcrEngine(
            rapid_ocr.RapidOcrProvider(), database=database, document=document,
            data_class=classify_for_policy(database, document),
        )
    from app.recognition.registry import build_providers

    provider = build_providers(settings).get(name)
    if provider is None or "ocr" not in provider.capabilities:
        log_event("page_ocr_engine", stage="rendering_ocr", status="unknown_engine", engine=name)
        return None
    configured, detail = provider.configured(settings)
    if not configured:
        log_event("page_ocr_engine", stage="rendering_ocr", status="not_configured", engine=name)
        return None
    data_class = classify_for_policy(database, document)
    decision = decide_external_processing(
        database, data_class=data_class, provider_ids=[provider.provider_id], settings=settings
    )
    if not decision.allowed:
        from app.models.recognition_run import RecognitionRun

        database.add(
            RecognitionRun(
                run_id=str(uuid.uuid4()),
                document_id=document.id,
                provider_id=provider.provider_id,
                locality=provider.locality,
                method="page_ocr",
                status="blocked_by_policy",
                data_class=data_class,
                policy_reason=decision.reason,
                pipeline_version=EXTRACTION_PROCESSOR_VERSION,
            )
        )
        log_event("page_ocr_engine", stage="rendering_ocr", status="blocked_by_policy", engine=name)
        return None
    return PageOcrEngine(provider, database=database, document=document, data_class=data_class)
