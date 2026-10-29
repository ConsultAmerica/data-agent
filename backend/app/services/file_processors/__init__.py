from pathlib import Path

from app.core.errors import UNSUPPORTED_FILE_TYPE
from app.services.document_extraction import DocumentExtractionError
from app.services.file_processors.docx_processor import DocxProcessor
from app.services.file_processors.image_processor import ImageProcessor
from app.services.file_processors.legacy_office_processor import (
    LegacyOfficeProcessor,
)
from app.services.file_processors.native_page_processor import (
    NativePageProcessor,
)
from app.services.file_processors.pdf_processor import PdfProcessor
from app.services.security_validation import SUPPORTED_TYPE_LABEL

_PDF = PdfProcessor()
_DOCX = DocxProcessor()
_IMAGE = ImageProcessor()
_NATIVE = NativePageProcessor()
_LEGACY = LegacyOfficeProcessor()

_PROCESSORS = {
    ".pdf": _PDF,
    ".docx": _DOCX,
    ".xlsx": _NATIVE,
    ".xlsm": _NATIVE,
    ".ods": _NATIVE,
    ".pptx": _NATIVE,
    ".txt": _NATIVE,
    ".csv": _NATIVE,
    ".tsv": _NATIVE,
    ".json": _NATIVE,
    ".eml": _NATIVE,
    ".html": _NATIVE,
    ".htm": _NATIVE,
    ".xml": _NATIVE,
    ".rtf": _NATIVE,
    ".png": _IMAGE,
    ".jpg": _IMAGE,
    ".jpeg": _IMAGE,
    ".tif": _IMAGE,
    ".tiff": _IMAGE,
    ".bmp": _IMAGE,
    ".webp": _IMAGE,
    ".doc": _LEGACY,
    ".xls": _LEGACY,
    ".ppt": _LEGACY,
}


def get_processor(file_path: Path):
    processor = _PROCESSORS.get(file_path.suffix.lower())

    if processor is None:
        raise DocumentExtractionError(
            "This file type is not supported. "
            f"Upload one of: {SUPPORTED_TYPE_LABEL}.",
            code=UNSUPPORTED_FILE_TYPE,
        )

    return processor
