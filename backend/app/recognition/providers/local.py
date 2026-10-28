"""Local engines: the PDF's own text layer, Tesseract, and the MRZ parser.
Nothing here leaves the machine."""

from __future__ import annotations

import asyncio
import re
import shutil

from app.recognition.layout import Line, PageLayout, Word
from app.recognition.providers.base import IMAGE_TYPES, PDF_TYPES, ProviderUnavailable
from app.recognition.types import (
    EvidenceSpan,
    FieldCandidate,
    ModelInfo,
    RecognitionRequest,
    RecognitionResult,
    UsageRecord,
)


def _page_indexes(document, pages: tuple[int, ...] | None) -> list[int]:
    wanted = pages or tuple(range(1, document.page_count + 1))
    return [p - 1 for p in wanted if 1 <= p <= document.page_count]


class NativeTextProvider:
    """Words and lines from the PDF's own text layer (PyMuPDF), in PDF
    points. No layer (scans, images) → an empty result, not an error."""

    provider_id = "native_text"
    locality = "local"
    capabilities = frozenset({"text", "layout"})

    def configured(self, settings) -> tuple[bool, str]:
        return True, "built in"

    def model_info(self) -> ModelInfo:
        import fitz

        return ModelInfo(self.provider_id, model="pymupdf", version=fitz.VersionBind)

    async def recognize(self, request: RecognitionRequest) -> RecognitionResult:
        return await asyncio.to_thread(self._recognize, request)

    def _recognize(self, request: RecognitionRequest) -> RecognitionResult:
        import fitz

        if request.mime_type not in PDF_TYPES:
            return RecognitionResult(self.model_info(), "skipped", warnings=["No PDF text layer."])
        pages: list[PageLayout] = []
        with fitz.open(request.file_path) as document:
            for index in _page_indexes(document, request.pages):
                page = document.load_page(index)
                lines: dict[tuple[int, int], list[Word]] = {}
                for x0, y0, x1, y1, text, block, line, _ in page.get_text("words", sort=True):
                    lines.setdefault((block, line), []).append(Word(text, (x0, y0, x1, y1)))
                layout = PageLayout(index + 1, page.rect.width, page.rect.height, "pdf_points")
                for words in lines.values():
                    layout.words.extend(words)
                    layout.lines.append(
                        Line(
                            " ".join(w.text for w in words),
                            (
                                min(w.bbox[0] for w in words),
                                min(w.bbox[1] for w in words),
                                max(w.bbox[2] for w in words),
                                max(w.bbox[3] for w in words),
                            ),
                            tuple(words),
                        )
                    )
                pages.append(layout)
        status = "ok" if any(p.words for p in pages) else "partial"
        return RecognitionResult(self.model_info(), status, pages=pages, usage=UsageRecord(pages=len(pages)))


class TesseractProvider:
    """Tesseract word layer (services/ocr_word_layer.py) on each page
    rendered at `dpi`, in OCR pixel space."""

    provider_id = "tesseract"
    locality = "local"
    capabilities = frozenset({"ocr", "layout"})

    def __init__(self, *, language: str = "eng", dpi: int = 220, timeout_seconds: int = 45):
        self.language = language
        self.dpi = dpi
        self.timeout_seconds = timeout_seconds

    def configured(self, settings) -> tuple[bool, str]:
        if not getattr(settings, "ocr_enabled", True):
            return False, "OCR is disabled (OCR_ENABLED=false)."
        if shutil.which("tesseract") is None:
            return False, "The tesseract binary is not installed."
        return True, "tesseract on PATH"

    def model_info(self) -> ModelInfo:
        version = None
        try:
            import pytesseract

            version = str(pytesseract.get_tesseract_version())
        except Exception:  # noqa: BLE001 - version is informational
            pass
        return ModelInfo(self.provider_id, model=f"tesseract:{self.language}", version=version)

    async def recognize(self, request: RecognitionRequest) -> RecognitionResult:
        return await asyncio.to_thread(self._recognize, request)

    def _images(self, request: RecognitionRequest):
        import fitz

        if request.mime_type in IMAGE_TYPES:
            yield 1, open(request.file_path, "rb").read()
            return
        with fitz.open(request.file_path) as document:
            for index in _page_indexes(document, request.pages):
                yield index + 1, document.load_page(index).get_pixmap(dpi=self.dpi).tobytes("png")

    def _recognize(self, request: RecognitionRequest) -> RecognitionResult:
        from PIL import Image
        import io

        from app.services.ocr_word_layer import extract_ocr_layout

        pages: list[PageLayout] = []
        for number, png in self._images(request):
            layout = extract_ocr_layout(png, language=self.language, timeout_seconds=self.timeout_seconds)
            if layout is None:
                raise ProviderUnavailable("Tesseract produced no layout (missing or failed).")
            width, height = Image.open(io.BytesIO(png)).size
            page = PageLayout(number, width, height, "ocr_pixels", dpi=self.dpi)
            for line in layout.lines:
                words = tuple(Word(w.text, (w.x0, w.y0, w.x1, w.y1), w.conf) for w in line.words)
                page.words.extend(words)
                page.lines.append(Line(line.text, (line.x0, line.y0, line.x1, line.y1), words, line.conf))
            pages.append(page)
        return RecognitionResult(self.model_info(), "ok", pages=pages, usage=UsageRecord(pages=len(pages)))


_MRZ_CANDIDATE = re.compile(r"^[A-Z0-9<]{28,46}$")

MRZ_FIELDS = {
    "identity.document_code": "document_code",
    "identity.issuing_state": "issuing_state",
    "identity.surname": "surname",
    "identity.given_names": "given_names",
    "identity.document_number": "document_number",
    "identity.nationality": "nationality",
    "identity.birth_date": "birth_date_raw",
    "identity.sex": "sex",
    "identity.expiry_date": "expiry_date_raw",
}


class MrzProvider:
    """Specialist: finds a machine-readable zone in text already read by
    an earlier step (native or OCR) and parses it (validators/mrz.py).
    Values are as printed in the MRZ; check-digit results are reported
    as warnings and lower the confidence — never corrected."""

    provider_id = "mrz"
    locality = "local"
    capabilities = frozenset({"fields:identity", "mrz"})

    def configured(self, settings) -> tuple[bool, str]:
        return True, "built in"

    def model_info(self) -> ModelInfo:
        return ModelInfo(self.provider_id, model="icao-9303", version="1")

    async def recognize(self, request: RecognitionRequest) -> RecognitionResult:
        from app.validators.mrz import parse_mrz

        for prior in request.prior:
            for page in prior.pages:
                lines = [re.sub(r"\s+", "", line.text).upper() for line in page.lines]
                for start in range(len(lines)):
                    for size in (3, 2):
                        block = lines[start:start + size]
                        if len(block) < size or not all(_MRZ_CANDIDATE.match(l) for l in block):
                            continue
                        parsed = parse_mrz("\n".join(block))
                        if parsed is None:
                            continue
                        return self._result(parsed, page.page, "\n".join(block))
        return RecognitionResult(self.model_info(), "skipped", warnings=["No machine-readable zone found."])

    def _result(self, parsed, page: int, block: str) -> RecognitionResult:
        confidence = 0.99 if parsed.check_digits_valid else 0.5
        evidence = [EvidenceSpan(page=page, text=block)]
        fields = [
            FieldCandidate(raw_label=f"MRZ {attr}", value=value, canonical_field=canonical,
                           confidence=confidence, evidence=list(evidence))
            for canonical, attr in MRZ_FIELDS.items()
            if (value := getattr(parsed, attr))
        ]
        failed = [check.name for check in parsed.checks if not check.passed]
        warnings = [f"MRZ {parsed.format}: check digits " + ("valid" if not failed else f"FAILED ({', '.join(failed)})")]
        return RecognitionResult(self.model_info(), "ok", fields=fields, warnings=warnings)
