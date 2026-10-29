"""Document-level ingestion provenance for Universal Document Ingestion RC."""

from __future__ import annotations

from typing import Any

from app.models.document import Document


def empty_provenance(*, source_format: str, size_tier: str) -> dict[str, Any]:
    return {
        "source_format": source_format.lstrip(".").lower(),
        "processor": None,
        "conversion_used": False,
        "converted_format": None,
        "ocr_used": False,
        "ocr_pages": [],
        "page_count": 0,
        "size_tier": size_tier,
        "processing_mode": "sync",
        "processing_job_id": None,
        "page_text_chars": 0,
        "targets_discovered": None,
        "empty_extraction_warning": None,
    }


def merge_provenance(document: Document, updates: dict[str, Any]) -> dict[str, Any]:
    current = dict(getattr(document, "ingestion_provenance", None) or {})
    current.update({key: value for key, value in updates.items() if value is not None})
    document.ingestion_provenance = current
    return current


def processor_label_for_extension(extension: str, *, conversion_used: bool = False) -> str:
    ext = extension.lower().lstrip(".")
    if conversion_used:
        targets = {"doc": "docx", "xls": "xlsx", "ppt": "pptx"}
        converted = targets.get(ext, "ooxml")
        return f"libreoffice_to_{converted}"
    mapping = {
        "pdf": "pdf_native",
        "docx": "docx_native",
        "xlsx": "xlsx_native",
        "xlsm": "xlsx_native",
        "ods": "ods_native",
        "pptx": "pptx_native",
        "txt": "text_native",
        "csv": "csv_native",
        "tsv": "csv_native",
        "json": "json_native",
        "html": "html_native",
        "htm": "html_native",
        "xml": "xml_native",
        "rtf": "rtf_native",
        "png": "image_ocr",
        "jpg": "image_ocr",
        "jpeg": "image_ocr",
        "tif": "image_ocr",
        "tiff": "image_ocr",
        "bmp": "image_ocr",
        "webp": "image_ocr",
        "doc": "libreoffice_to_docx",
        "xls": "libreoffice_to_xlsx",
        "ppt": "libreoffice_to_pptx",
    }
    return mapping.get(ext, f"{ext}_adapter")
