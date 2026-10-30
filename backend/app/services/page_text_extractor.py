from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from dataclasses import dataclass
import ctypes
import gc
import sys
import time

import fitz

from app.services.sorted_page_text import sorted_page_text
from app.core.config import Settings
from app.core.observability import log_event
from app.services.ocr_detection import (
    OCRDetection,
    detect_ocr_requirement,
)


def _run_with_timeout(fn, timeout_seconds: float):
    """Run a native (non-interruptible) call with a wall-clock bound.

    MuPDF's OCR is a direct C call — it has no timeout parameter of its
    own, so a hang there (e.g. a broken tessdata path some builds treat
    as a slow retry loop instead of a fast failure) would otherwise block
    the calling thread forever. A timed-out call's thread is abandoned
    (Python cannot forcibly kill it), but the caller recovers immediately
    instead of hanging the whole request.
    """

    executor = ThreadPoolExecutor(max_workers=1)
    future = executor.submit(fn)
    try:
        return future.result(timeout=timeout_seconds)
    finally:
        # wait=False: on timeout, don't block here waiting for a hung
        # native call to finish — let the orphaned thread run its course.
        executor.shutdown(wait=False)


# Ceiling on the long side of an OCR raster, independent of page size or
# DPI metadata. A page's point-dimensions can be wrong or absent (a
# multi-frame TIFF with no resolution tag, a malformed PDF, ...); without
# this, get_textpage_ocr()/get_pixmap() render at settings.ocr_dpi against
# whatever the page claims its size is, and an oversized page can allocate
# a raster large enough to OOM the process.
#
# 4200px (the original value) covered Letter/A4/Legal at a full 300 DPI,
# but on Render's free-tier single worker, back-to-back OCR-heavy
# requests still accumulated enough peak memory to OOM the request
# immediately *after* a capped-but-large page finished (see 59871a6's
# malloc_trim mitigation — it helped but didn't fully close the gap).
# 3300px covers Letter exactly at 300 DPI (zero clamping on the most
# common real-world case) while giving ~38% less peak raster area than
# 4200px for anything larger, trading a barely-perceptible DPI reduction
# on A4/Legal scans for materially lower peak memory.
MAX_OCR_RASTER_DIMENSION_PX = 3300


def _release_native_memory() -> None:
    """Return freed OCR buffers to the OS after each page.

    PIL/MuPDF/Tesseract allocate large native buffers per page (a capped
    raster is still several MB). CPython's GC frees the Python-level
    references, but glibc's allocator doesn't hand that memory back to
    the OS on its own — on a long-lived single worker process, repeated
    large OCR allocations can ratchet up RSS across requests even though
    each one is individually bounded (see MAX_OCR_RASTER_DIMENSION_PX
    above), until a memory-constrained host OOMs. gc.collect() first so
    there's something for malloc_trim to actually release.
    """
    gc.collect()
    if sys.platform != "linux":
        return
    try:
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except OSError:
        pass


def _bounded_ocr_dpi(page: fitz.Page, requested_dpi: int) -> int:
    long_side_pt = max(page.rect.width, page.rect.height)
    if long_side_pt <= 0:
        return requested_dpi
    max_dpi_for_cap = MAX_OCR_RASTER_DIMENSION_PX * 72.0 / long_side_pt
    return max(1, min(requested_dpi, int(max_dpi_for_cap)))


@dataclass(frozen=True)
class TextBlockData:
    block_index: int
    block_type: str
    text: str

    x0: float
    y0: float
    x1: float
    y1: float

    extraction_method: str


@dataclass(frozen=True)
class PageExtractionData:
    page_number: int
    page_label: str | None

    page_width: float
    page_height: float

    native_text: str
    ocr_text: str | None
    final_text: str

    extraction_method: str

    detection: OCRDetection

    ocr_attempted: bool
    ocr_succeeded: bool
    ocr_error: str | None

    blocks: list[TextBlockData]
    ocr_layout: dict | None = None
    preprocess_applied: list[str] | None = None


def convert_blocks(
    raw_blocks: list[tuple],
    *,
    extraction_method: str,
) -> list[TextBlockData]:
    converted: list[TextBlockData] = []

    for block_index, block in enumerate(raw_blocks):
        if len(block) < 7:
            continue

        x0, y0, x1, y1, text, _, block_type = block[:7]

        text_value = str(text).strip()

        if not text_value:
            continue

        readable_block_type = (
            "text" if block_type == 0 else "image"
        )

        converted.append(
            TextBlockData(
                block_index=block_index,
                block_type=readable_block_type,
                text=text_value,
                x0=float(x0),
                y0=float(y0),
                x1=float(x1),
                y1=float(y1),
                extraction_method=extraction_method,
            )
        )

    return converted


def get_page_label(
    document: fitz.Document,
    page_number: int,
) -> str | None:
    try:
        labels = document.get_page_labels()

        if not labels:
            return None

        return document[page_number - 1].get_label() or None

    except Exception:
        return None


def extract_page(
    *,
    document: fitz.Document,
    page_index: int,
    settings: Settings,
    run_ocr: bool,
    force_ocr: bool = False,
    page_ocr=None,
) -> PageExtractionData:
    page = document.load_page(page_index)
    page_number = page_index + 1

    # Same text as page.get_text("text", sort=True), several times faster.
    native_text = sorted_page_text(page).strip()

    native_blocks = page.get_text(
        "blocks",
        sort=True,
    )

    detection = detect_ocr_requirement(
        page=page,
        native_text=native_text,
        native_blocks=native_blocks,
        settings=settings,
    )

    log_event(
        "ocr_detection",
        stage="rendering_ocr",
        page=page_number,
        requires_ocr=detection.requires_ocr,
        force_ocr=force_ocr,
        native_chars=len(native_text),
        image_count=detection.image_count,
        reasons=detection.reasons[:5],
    )

    native_block_data = convert_blocks(
        native_blocks,
        extraction_method="native",
    )

    ocr_text: str | None = None
    ocr_attempted = False
    ocr_succeeded = False
    ocr_error: str | None = None
    ocr_layout_payload: dict | None = None
    preprocess_tags: list[str] = []
    ocr_text_page = None

    final_text = native_text
    final_blocks = native_block_data
    extraction_method = "native"

    should_run_ocr = (
        run_ocr
        and settings.ocr_enabled
        and (force_ocr or detection.requires_ocr)
    )

    # Per-page OCR pass report (timings, whether the enhanced pass ran),
    # stored with the word layout for QA and performance review.
    ocr_passes: dict = {}

    # Pluggable OCR (app/recognition/page_ocr.py): a configured, policy-
    # approved external engine reads the page image first. Its boxes are in
    # that image's pixel space, like Tesseract's. If it returns nothing,
    # the built-in Tesseract path below runs unchanged.
    external_ocr = False
    if should_run_ocr and page_ocr is not None:
        ocr_attempted = True
        layout_dpi = min(_bounded_ocr_dpi(page, settings.ocr_dpi), 220)
        pixmap = page.get_pixmap(dpi=layout_dpi)
        external_layout = page_ocr.ocr(pixmap.tobytes("png"), page_number=page_number)
        if external_layout is not None and external_layout.lines:
            external_ocr = True
            ocr_succeeded = True
            ocr_text = "\n".join(line.text for line in external_layout.lines)
            if force_ocr or len(ocr_text) > len(native_text):
                scale = 72.0 / layout_dpi
                final_text = ocr_text
                final_blocks = [
                    TextBlockData(
                        block_index=index,
                        block_type="text",
                        text=line.text,
                        x0=line.x0 * scale,
                        y0=line.y0 * scale,
                        x1=line.x1 * scale,
                        y1=line.y1 * scale,
                        extraction_method="ocr",
                    )
                    for index, line in enumerate(external_layout.lines)
                ]
                extraction_method = "ocr"
            ocr_layout_payload = external_layout.to_json()
            ocr_layout_payload["preprocess"] = [f"engine:{page_ocr.engine_id}"]
            ocr_layout_payload["ocr_passes"] = {"engine": page_ocr.engine_id}
            ocr_layout_payload["coordinate_space"] = {
                "unit": "px",
                "dpi": layout_dpi,
                "image_width": pixmap.width,
                "image_height": pixmap.height,
                "deskew_degrees": 0.0,
            }
            log_event(
                "ocr_external",
                stage="rendering_ocr",
                status="ok",
                page=page_number,
                ocr_engine=page_ocr.engine_id,
                word_count=len(external_layout.words),
            )

    if should_run_ocr and not external_ocr:
        ocr_attempted = True
        mupdf_started = time.perf_counter()

        try:
            tessdata = (
                str(settings.tessdata_path)
                if settings.tessdata_path
                else None
            )

            effective_dpi = _bounded_ocr_dpi(
                page, settings.ocr_dpi
            )

            if effective_dpi != settings.ocr_dpi:
                log_event(
                    "ocr_dpi_clamped",
                    stage="rendering_ocr",
                    page=page_number,
                    requested_dpi=settings.ocr_dpi,
                    effective_dpi=effective_dpi,
                    page_width_pt=page.rect.width,
                    page_height_pt=page.rect.height,
                )

            ocr_text_page = _run_with_timeout(
                lambda: page.get_textpage_ocr(
                    language=settings.ocr_language,
                    dpi=effective_dpi,
                    full=True,
                    tessdata=tessdata,
                ),
                settings.ocr_page_timeout_seconds,
            )

            ocr_passes["text_ocr_ms"] = int((time.perf_counter() - mupdf_started) * 1000)
            ocr_text = page.get_text(
                "text",
                textpage=ocr_text_page,
                sort=True,
            ).strip()

            ocr_blocks = page.get_text(
                "blocks",
                textpage=ocr_text_page,
                sort=True,
            )

            ocr_block_data = convert_blocks(
                ocr_blocks,
                extraction_method="ocr",
            )

            prefer_ocr = force_ocr or len(ocr_text) > len(native_text)

            if prefer_ocr and ocr_text:
                final_text = ocr_text
                final_blocks = ocr_block_data
                extraction_method = "ocr"
                ocr_succeeded = True

            elif ocr_text:
                final_text = native_text
                final_blocks = native_block_data
                extraction_method = "native"
                ocr_succeeded = True

            log_event(
                "ocr_mupdf",
                stage="rendering_ocr",
                status="ok" if ocr_text else "empty",
                page=page_number,
                ocr_engine="mupdf_tesseract",
                duration_ms=int((time.perf_counter() - mupdf_started) * 1000),
                text_chars=len(ocr_text or ""),
                tessdata_set=bool(tessdata),
            )

        except FutureTimeoutError:
            ocr_error = (
                f"MuPDF OCR exceeded {settings.ocr_page_timeout_seconds}s "
                "and was abandoned."
            )
            log_event(
                "ocr_mupdf",
                stage="rendering_ocr",
                status="timeout",
                error_category="Timeout",
                page=page_number,
                ocr_engine="mupdf_tesseract",
                duration_ms=int((time.perf_counter() - mupdf_started) * 1000),
                timeout_seconds=settings.ocr_page_timeout_seconds,
            )
        except Exception as exc:
            ocr_error = str(exc)
            log_event(
                "ocr_mupdf",
                stage="rendering_ocr",
                status="error",
                error_category=type(exc).__name__,
                page=page_number,
                ocr_engine="mupdf_tesseract",
                duration_ms=int((time.perf_counter() - mupdf_started) * 1000),
            )

        # Raster / scanned pages: if MuPDF OCR yielded nothing, try
        # pytesseract directly against a rendered pixmap.
        if (force_ocr or not final_text.strip()) and not (
            ocr_text and ocr_text.strip()
        ):
            try:
                from app.services.embedded_image_ocr import ocr_image_bytes

                pixmap = page.get_pixmap(
                    dpi=_bounded_ocr_dpi(page, settings.ocr_dpi)
                )
                fallback = ocr_image_bytes(
                    pixmap.tobytes("png"),
                    language=settings.ocr_language,
                    timeout_seconds=settings.ocr_page_timeout_seconds,
                    page_number=page_number,
                )
                if fallback:
                    ocr_text = fallback
                    final_text = fallback
                    final_blocks = [
                        TextBlockData(
                            block_index=0,
                            block_type="text",
                            text=fallback,
                            x0=0.0,
                            y0=0.0,
                            x1=float(page.rect.width),
                            y1=float(page.rect.height),
                            extraction_method="ocr",
                        )
                    ]
                    extraction_method = "ocr"
                    ocr_succeeded = True
                    ocr_error = None
            except Exception as exc:
                if ocr_error is None:
                    ocr_error = str(exc)

        if ocr_attempted and not (final_text or "").strip():
            if ocr_error is None:
                ocr_error = "OCR executed but produced no extractable text."
            ocr_succeeded = False
            log_event(
                "ocr_empty_result",
                stage="rendering_ocr",
                status="warning",
                page=page_number,
                force_ocr=force_ocr,
                requires_ocr=detection.requires_ocr,
                error_type=ocr_error[:120],
            )

        # Additive word/line geometry for layout association. Does not
        # replace final_text from the stable MuPDF/pytesseract string path.
        if ocr_succeeded and (final_text or "").strip():
            try:
                from app.services.image_preprocess import preprocess_scan_image
                from app.services.ocr_word_layer import extract_ocr_layout

                layout_dpi = min(
                    _bounded_ocr_dpi(page, settings.ocr_dpi),
                    220,
                )
                pixmap = page.get_pixmap(dpi=layout_dpi)
                png_bytes = pixmap.tobytes("png")
                prepared = preprocess_scan_image(png_bytes)
                preprocess_tags = list(prepared.applied)
                if prepared.skipped_reason:
                    preprocess_tags.append(f"skip:{prepared.skipped_reason}")
                pass_started = time.perf_counter()
                layout = extract_ocr_layout(
                    prepared.image_bytes,
                    language=settings.ocr_language,
                    timeout_seconds=min(
                        45, int(settings.ocr_page_timeout_seconds or 45)
                    ),
                )
                ocr_passes["primary_layout_ms"] = int((time.perf_counter() - pass_started) * 1000)
                # PASS 1 above is a complete, usable result on its own.
                # PASS 2 (watermark-suppressed copy) is only an enhancement:
                # when it fails or times out, pass 1 stands unchanged and the
                # page is marked so QA can say enhanced OCR was unavailable.
                if layout is not None:
                    from app.services.image_preprocess import suppress_light_background
                    from app.services.ocr_word_layer import layout_score

                    suppressed = suppress_light_background(prepared.image_bytes)
                    if suppressed is None:
                        ocr_passes["enhancement"] = "not_needed"
                    else:
                        pass_started = time.perf_counter()
                        alternative = extract_ocr_layout(
                            suppressed,
                            language=settings.ocr_language,
                            timeout_seconds=min(45, int(settings.ocr_page_timeout_seconds or 45)),
                        )
                        ocr_passes["enhanced_layout_ms"] = int((time.perf_counter() - pass_started) * 1000)
                        if alternative is None:
                            ocr_passes["enhancement"] = "unavailable"
                            preprocess_tags.append("enhanced_ocr_unavailable")
                        else:
                            from app.services.ocr_word_layer import fuse_layouts

                            pass_started = time.perf_counter()
                            primary, secondary = (
                                (alternative, layout)
                                if layout_score(alternative) > layout_score(layout)
                                else (layout, alternative)
                            )
                            layout = fuse_layouts(primary, secondary)
                            ocr_passes["fusion_ms"] = int((time.perf_counter() - pass_started) * 1000)
                            ocr_passes["enhancement"] = "applied"
                            ocr_passes["contested_words"] = sum(1 for w in layout.words if w.contested)
                            preprocess_tags.append("background_suppressed_fused")
                if layout is not None and layout.words:
                    ocr_layout_payload = layout.to_json()
                    ocr_layout_payload["preprocess"] = preprocess_tags
                    ocr_layout_payload["ocr_passes"] = ocr_passes
                    # Lets OCR pixel boxes be mapped back to PDF points
                    # (app/source_structure/ocr_geometry.py).
                    deskew = next(
                        (
                            float(tag.split("_", 1)[1])
                            for tag in prepared.applied
                            if tag.startswith("deskew_")
                        ),
                        0.0,
                    )
                    ocr_layout_payload["coordinate_space"] = {
                        "unit": "px",
                        "dpi": layout_dpi,
                        "image_width": pixmap.width,
                        "image_height": pixmap.height,
                        "deskew_degrees": deskew,
                    }
                    log_event(
                        "ocr_word_layout",
                        stage="rendering_ocr",
                        status="ok",
                        page=page_number,
                        word_count=len(layout.words),
                        line_count=len(layout.lines),
                        mean_conf=layout.mean_word_confidence,
                    )
            except Exception as exc:
                # Without this layer the page has text but no positions:
                # the transcript degrades to text-only and structure
                # extraction has nothing to work with — log why.
                log_event(
                    "ocr_word_layout",
                    stage="rendering_ocr",
                    status="error",
                    page=page_number,
                    error_category=type(exc).__name__,
                    error=str(exc)[:500],
                )

            # The separate pytesseract pass can fail (e.g. time out on a
            # slow CPU) after MuPDF's OCR already found every word and its
            # box. Reuse those positions — no second OCR run — so the page
            # never ends up with text but no geometry.
            if ocr_layout_payload is None and ocr_text_page is not None and extraction_method == "ocr":
                try:
                    from app.services.ocr_word_layer import layout_from_textpage_words

                    layout_dpi = min(_bounded_ocr_dpi(page, settings.ocr_dpi), 220)
                    scale = layout_dpi / 72.0
                    textpage_layout = layout_from_textpage_words(
                        page.get_text("words", textpage=ocr_text_page), scale=scale
                    )
                    if textpage_layout is not None:
                        ocr_layout_payload = textpage_layout.to_json()
                        ocr_layout_payload["preprocess"] = ["source:mupdf_textpage"]
                        # The word-layer pass failed: positions come from the
                        # text OCR with no word confidence (values stay Needs
                        # Review), and no enhancement ran.
                        ocr_layout_payload["ocr_passes"] = {**ocr_passes, "primary_layout": "unavailable", "enhancement": "unavailable"}
                        ocr_layout_payload["coordinate_space"] = {
                            "unit": "px",
                            "dpi": layout_dpi,
                            "image_width": round(page.rect.width * scale),
                            "image_height": round(page.rect.height * scale),
                            "deskew_degrees": 0.0,
                        }
                        log_event(
                            "ocr_word_layout",
                            stage="rendering_ocr",
                            status="fallback_mupdf_textpage",
                            page=page_number,
                            word_count=len(textpage_layout.words),
                        )
                except Exception as exc:  # noqa: BLE001 — text stays; only positions are missing
                    log_event(
                        "ocr_word_layout",
                        stage="rendering_ocr",
                        status="error",
                        page=page_number,
                        error_category=type(exc).__name__,
                        error=str(exc)[:500],
                    )

        _release_native_memory()

    log_event(
        "page_text_extracted",
        stage="rendering_ocr",
        page=page_number,
        extraction_method=extraction_method,
        ocr_attempted=ocr_attempted,
        ocr_succeeded=ocr_succeeded,
        page_text_chars=len(final_text or ""),
        has_ocr_error=bool(ocr_error),
    )

    return PageExtractionData(
        page_number=page_number,
        page_label=get_page_label(
            document,
            page_number,
        ),
        page_width=float(page.rect.width),
        page_height=float(page.rect.height),
        native_text=native_text,
        ocr_text=ocr_text,
        final_text=final_text,
        extraction_method=extraction_method,
        detection=detection,
        ocr_attempted=ocr_attempted,
        ocr_succeeded=ocr_succeeded,
        ocr_error=ocr_error,
        blocks=final_blocks,
        ocr_layout=ocr_layout_payload,
        preprocess_applied=preprocess_tags or None,
    )
