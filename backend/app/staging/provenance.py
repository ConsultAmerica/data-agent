"""Helpers adapters use to build CellProvenance consistently."""

from __future__ import annotations

from pathlib import Path

from app.models.document import Document
from app.staging.models import CellProvenance, SourceLocator, SourceType

_SOURCE_TYPE_BY_SUFFIX: dict[str, SourceType] = {
    ".pdf": "pdf",
    ".html": "html",
    ".htm": "html",
    ".xml": "xml",
    ".docx": "docx",
    ".doc": "docx",
    ".xlsx": "xlsx",
    ".xls": "xlsx",
    ".xlsm": "xlsx",
    ".ods": "xlsx",
    ".csv": "xlsx",
    ".tsv": "xlsx",
    ".txt": "text",
    ".json": "text",
    ".eml": "text",
    ".rtf": "text",
    ".png": "image",
    ".jpg": "image",
    ".jpeg": "image",
    ".tif": "image",
    ".tiff": "image",
    ".bmp": "image",
    ".webp": "image",
}


def source_type_of(document: Document) -> SourceType:
    suffix = Path(document.stored_filename or document.original_filename or "").suffix.lower()
    return _SOURCE_TYPE_BY_SUFFIX.get(suffix, "text")


def anchor_from_evidence(evidence: str | None) -> str | None:
    """Text that locates a record on its page. Form-field evidence is
    rendered as "LABEL -> VALUE" (not literal page text), so its anchor is
    the label; otherwise the evidence's first line."""

    if not evidence:
        return None
    if " -> " in evidence:
        label = evidence.split(" -> ", 1)[0].strip()
        return label or None
    first_line = next((line.strip() for line in evidence.splitlines() if line.strip()), "")
    return first_line[:80] or None


def make_provenance(
    document: Document,
    *,
    page: int | None,
    evidence: str | None,
    bbox: list[float] | tuple[float, ...] | None = None,
    extraction_method: str | None = None,
    region_id: str | None = None,
    anchor: str | None = None,
    locator: SourceLocator | None = None,
    source_type: SourceType | None = None,
) -> CellProvenance:
    return CellProvenance(
        source_document_id=document.id,
        source_filename=document.original_filename,
        source_type=source_type or source_type_of(document),
        source_page=page,
        source_bbox=tuple(float(v) for v in bbox) if bbox and len(bbox) == 4 else None,
        evidence_text=evidence or None,
        extraction_method=extraction_method,
        source_locator=locator,
        source_region_id=region_id,
        anchor_text=anchor if anchor is not None else anchor_from_evidence(evidence),
    )


def system_provenance(document: Document) -> CellProvenance:
    return CellProvenance(
        source_document_id=document.id,
        source_filename=document.original_filename,
        source_type="system",
        extraction_method="system",
    )
