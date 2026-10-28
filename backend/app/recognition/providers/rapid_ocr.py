"""RapidOCR (PaddleOCR models on ONNX Runtime) — local OCR that needs no
system install: `pip install rapidocr-onnxruntime` and it runs in-process,
offline, with its models bundled in the wheel.

Used for scanned pages and photos (passports, licences, cheques, receipts)
when Tesseract isn't installed (app/recognition/page_ocr.py), or always
with OCR_ENGINE=rapidocr. It is local, so policy never blocks it: a
passport image is read on this machine and goes nowhere else.

RapidOCR reports text lines with a polygon and a score; words are spread
across their line's box in proportion to their length, which is accurate
enough for highlighting and line-level grounding.
"""

from __future__ import annotations

import asyncio
import importlib.util
import threading
from importlib import metadata
from io import BytesIO
from pathlib import Path

from app.recognition.layout import Line, PageLayout, Word
from app.recognition.providers.base import ProviderError, ProviderUnavailable
from app.recognition.types import ModelInfo, RecognitionRequest, RecognitionResult, UsageRecord

PACKAGE = "rapidocr_onnxruntime"
PDF_RENDER_DPI = 200

_engine = None
_engine_lock = threading.Lock()


def available() -> bool:
    return importlib.util.find_spec(PACKAGE) is not None


def _get_engine():
    """One engine per process: loading the models takes seconds."""

    global _engine
    with _engine_lock:
        if _engine is None:
            from rapidocr_onnxruntime import RapidOCR

            _engine = RapidOCR()
        return _engine


def _run(image: bytes):
    engine = _get_engine()
    # The engine isn't documented as thread-safe; pages are read one at a time.
    with _engine_lock:
        result, _ = engine(image)
    return result or []


def _image_bytes(request: RecognitionRequest) -> bytes:
    path = Path(request.file_path)
    if request.mime_type == "application/pdf" or path.suffix.lower() == ".pdf":
        import fitz

        with fitz.open(path) as pdf:
            number = (request.pages or (1,))[0]
            return pdf[number - 1].get_pixmap(dpi=PDF_RENDER_DPI).tobytes("png")
    return path.read_bytes()


def to_page(lines, width: float, height: float) -> PageLayout:
    """RapidOCR lines ([polygon, text, score]) → a provider-neutral page."""

    page = PageLayout(1, width, height, "ocr_pixels")
    for polygon, text, score in lines:
        text = (text or "").strip()
        if not text:
            continue
        xs = [float(point[0]) for point in polygon]
        ys = [float(point[1]) for point in polygon]
        x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
        confidence = float(score) if score is not None else None
        tokens = text.split()
        span = max(1, len(text))
        words, cursor = [], 0
        for token in tokens:
            start = text.index(token, cursor)
            cursor = start + len(token)
            words.append(
                Word(
                    token,
                    (x0 + (x1 - x0) * start / span, y0, x0 + (x1 - x0) * cursor / span, y1),
                    confidence,
                )
            )
        page.words.extend(words)
        page.lines.append(Line(text, (x0, y0, x1, y1), tuple(words), confidence))
    return page


class RapidOcrProvider:
    provider_id = "rapidocr"
    locality = "local"
    capabilities = frozenset({"ocr", "layout"})

    def configured(self, settings) -> tuple[bool, str]:
        if not available():
            return False, "rapidocr-onnxruntime is not installed (pip install rapidocr-onnxruntime)."
        return True, "RapidOCR on ONNX Runtime, runs locally"

    def model_info(self) -> ModelInfo:
        version = None
        if available():
            try:
                version = metadata.version("rapidocr-onnxruntime")
            except metadata.PackageNotFoundError:
                version = None
        return ModelInfo(self.provider_id, model="rapidocr-onnxruntime", version=version, region="local")

    async def recognize(self, request: RecognitionRequest) -> RecognitionResult:
        if not available():
            raise ProviderUnavailable("rapidocr-onnxruntime is not installed.")
        image = _image_bytes(request)
        try:
            from PIL import Image

            with Image.open(BytesIO(image)) as picture:
                width, height = picture.size
            lines = await asyncio.to_thread(_run, image)
        except Exception as exc:  # noqa: BLE001 - surfaced as a provider failure
            raise ProviderError(f"RapidOCR failed: {exc}") from exc
        page = to_page(lines, float(width), float(height))
        return RecognitionResult(self.model_info(), "ok", pages=[page], usage=UsageRecord(pages=1))
