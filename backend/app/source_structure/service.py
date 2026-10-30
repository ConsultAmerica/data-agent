"""Builds, persists and loads a document's StructuredSourceDocument.

Per page, the best available geometry is used:
    native PDF text  → PyMuPDF words/spans (PDF points)
    scanned/OCR page → the persisted OCR word layer, transformed to PDF
                       points (ocr_geometry) — no new OCR pass
    HTML             → the DOM of the stored file
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from collections import Counter
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.document import Document
from app.models.document_page import DocumentPage
from app.models.document_source_structure import DocumentSourceStructure
from app.services.document_storage import DocumentStorageError, ensure_local_copy
from app.source_structure.html_structure import extract_html_structure
from app.source_structure.models import StructuredSourceDocument, TableCandidate
from app.source_structure.ocr_geometry import coordinate_space_for
from app.source_structure.table_continuity import annotate_geometry, link_continuations
from app.source_structure.pdf_structure import (
    Word,
    extract_page_structure,
    native_words,
    ocr_words,
)
from app.source_structure.reading_order import reconstruct_page

# Bump whenever extraction rules change; stored structures from an older
# version are rebuilt on next use.
EXTRACTOR_VERSION = 13  # 13: two-column form groups judged by column distance (right-aligned item numbers); lettered section headings ("A.  General Information") printed as two runs; 12: form rows written on drawn underlines (ruled_form_row) with their group caption; 11: per-line font sizes on text regions; 10: two-column pages (sidebar + main column) read column by column; 9: flowing documents (DOCX) read every laid-out page; 8: narrative regions keep their full text (up to 20,000 characters), read as document sections; 7: raster tables split rows at printed row rules; 6: OCR-pass disagreement (ocr_contested) on fields/cells/regions; 5: OCR word confidence on fields/cells/regions, background-suppressed OCR fusion; 2: continuation metadata, quality flags; 3: typography block breaks, address blocks with Attn lines; 4: invoice-fixture fixes (abbreviation labels, skew-aware OCR rows, fused/above headers, multi-pair runs), whitespace/filler label pairing, identifier typing, OCR caps headings

_HTML_SUFFIXES = {".html", ".htm"}
_RASTER_SUFFIXES = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"}
# Row/cell regions duplicate what TableCandidate cells already carry; they
# are not persisted to keep the stored artifact compact.
_TRANSIENT_REGION_TYPES = {"TABLE_ROW", "TABLE_CELL"}
_MAX_REJECTED_TABLE_ROWS = 5


def _source_type(document: Document) -> str:
    suffix = Path(document.stored_filename or "").suffix.lower()
    if suffix in _HTML_SUFFIXES:
        return "html"
    if suffix in _RASTER_SUFFIXES:
        return "image"
    return "pdf"


def _build_pdf(document: Document, pages: list[DocumentPage], file_path: Path | None, result: StructuredSourceDocument) -> None:
    import fitz

    settings = get_settings()
    fitz_doc = None
    if file_path is not None:
        try:
            if result.source_type == "image":
                from app.services.file_processors.image_processor import _ensure_fitz_readable

                file_path = _ensure_fitz_readable(file_path)
            fitz_doc = fitz.open(str(file_path))
        except Exception as exc:  # noqa: BLE001
            result.warnings.append(f"Could not open source file for geometry ({exc}).")

    # A flowing document (DOCX, ODT …) is stored as fewer pages than MuPDF
    # lays it out in: the pages past the stored ones flow on below the last
    # stored page, so none of its text is lost.
    flowing = (
        fitz_doc is not None
        and not fitz_doc.is_pdf
        and result.source_type != "image"
        and bool(pages)
        and fitz_doc.page_count > len(pages)
    )
    try:
        for index, page in enumerate(pages):
            fitz_page = None
            if fitz_doc is not None and 0 <= page.page_number - 1 < fitz_doc.page_count:
                fitz_page = fitz_doc[page.page_number - 1]
            words, method = page_words(page, fitz_page, settings.ocr_dpi)
            if flowing and index == len(pages) - 1 and method == "native" and fitz_page is not None:
                words = words + _flowed_words(fitz_doc, first=len(pages), offset=fitz_page.rect.height)
            if not words:
                continue
            grids = []
            if method == "ocr" and fitz_page is not None:
                from app.source_structure.raster_tables import detect_raster_grids

                grids = detect_raster_grids(fitz_page)
            structure = extract_page_structure(
                page_number=page.page_number,
                words=words,
                extraction_method=method,
                fitz_page=fitz_page,
                raster_grids=grids,
            )
            page_height = page.page_height or (fitz_page.rect.height if fitz_page else None)
            for table in structure.tables:
                annotate_geometry(table, page_height)
            result.regions.extend(structure.regions)
            result.field_candidates.extend(structure.fields)
            result.table_candidates.extend(structure.tables)
        link_continuations(result.table_candidates)
    finally:
        if fitz_doc is not None:
            fitz_doc.close()


def _flowed_words(fitz_doc, *, first: int, offset: float) -> list[Word]:
    """Words of laid-out pages `first`… stacked below `offset` points, in
    one coordinate space (each page continues below the one before)."""

    from dataclasses import replace

    words: list[Word] = []
    for number in range(first, fitz_doc.page_count):
        page = fitz_doc[number]
        words.extend(replace(word, y0=word.y0 + offset, y1=word.y1 + offset) for word in native_words(page))
        offset += page.rect.height
    return words


def page_words(page: DocumentPage, fitz_page, ocr_dpi: float) -> tuple[list[Word], str]:
    """A page's positioned words in PDF points: native text when present,
    else the persisted OCR word layer (no new OCR pass)."""

    words: list[Word] = native_words(fitz_page) if fitz_page is not None else []
    if len(words) < 3 and page.ocr_layout_json:
        space = coordinate_space_for(
            page.ocr_layout_json,
            page_width_pt=page.page_width or (fitz_page.rect.width if fitz_page else 612.0),
            page_height_pt=page.page_height or (fitz_page.rect.height if fitz_page else 792.0),
            ocr_dpi=ocr_dpi,
        )
        if space is not None:
            return ocr_words(page.ocr_layout_json, space), "ocr"
    return words, "native"


def _open_source_pdf(document: Document, source_type: str, warnings: list[str]):
    import fitz

    try:
        file_path = ensure_local_copy(get_settings(), stored_filename=document.stored_filename)
    except DocumentStorageError as exc:
        warnings.append(f"Source file unavailable ({exc}).")
        return None
    try:
        if source_type == "image":
            from app.services.file_processors.image_processor import _ensure_fitz_readable

            file_path = _ensure_fitz_readable(file_path)
        return fitz.open(str(file_path))
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"Could not open source file for geometry ({exc}).")
        return None


def page_transcript(database: Session, document: Document, page_number: int) -> dict:
    """Reading-order transcript of one page (reading_order.py): headings,
    paragraphs and tables, each line carrying its words' page-space boxes.
    HTML has no geometry: its readable DOM text is split into paragraphs."""

    page = database.scalars(
        select(DocumentPage).where(
            DocumentPage.document_id == document.id, DocumentPage.page_number == page_number
        )
    ).first()
    if page is None:
        raise LookupError(f"Page {page_number} not found.")
    source_type = _source_type(document)
    warnings: list[str] = []
    result = {
        "document_id": document.id,
        "page_number": page_number,
        "source_type": source_type,
        "extraction_method": "dom" if source_type == "html" else None,
        "word_count": 0,
        "page_width": page.page_width,
        "page_height": page.page_height,
        "blocks": [],
        # spatial: words with page boxes (highlightable) · text_only: text
        # without positions · none: no text at all.
        "positioning": "none",
        "warnings": warnings,
    }
    if source_type == "html":
        text = page.final_text or ""
        paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
        result["blocks"] = [
            {
                "kind": "paragraph",
                "text": p,
                "bbox": None,
                "lines": [{"text": line, "bbox": None, "words": []} for line in p.splitlines()],
                "table": None,
            }
            for p in paragraphs
        ]
        result["word_count"] = len(text.split())
        result["positioning"] = "text_only" if text.strip() else "none"
        return result

    fitz_doc = _open_source_pdf(document, source_type, warnings)
    try:
        fitz_page = (
            fitz_doc[page_number - 1] if fitz_doc is not None and 0 <= page_number - 1 < fitz_doc.page_count else None
        )
        words, method = page_words(page, fitz_page, get_settings().ocr_dpi)
        if fitz_page is not None:
            result["page_width"] = result["page_width"] or fitz_page.rect.width
            result["page_height"] = result["page_height"] or fitz_page.rect.height
    finally:
        if fitz_doc is not None:
            fitz_doc.close()
    if not words:
        # No positioned words (e.g. an OCR route that returned text only):
        # show the engine's text, cleaned, as a text-only transcript. No
        # boxes are invented, so nothing here can be highlighted.
        text = page.final_text or ""
        result["positioning"] = "text_only" if text.strip() else "none"
        result["extraction_method"] = page.extraction_method or method
        result["word_count"] = len(text.split())
        result["blocks"] = _text_only_blocks(text)
        if text.strip():
            warnings.append(
                "Source positioning was not available for this page. Transcript text is shown below; "
                "source highlighting is unavailable."
            )
        return result

    structure = get_or_build_source_structure(database, document)
    tables = [
        t for t in structure.table_candidates
        if t.page == page_number and table_accounts_for_its_words(t, words)
    ]
    result["positioning"] = "spatial"
    result["extraction_method"] = method
    result["word_count"] = len(words)
    result["blocks"] = [block.as_dict() for block in reconstruct_page(words, tables)]
    return result


def table_accounts_for_its_words(table: TableCandidate, words: list[Word], minimum: float = 0.85) -> bool:
    """Whether a detected table's cells hold the words printed inside it.

    Reading-order text renders an accepted table in place of the words it
    covers. A ruled grid that lost or merged words (a page border read as
    one giant table, boxes that split sentences) must not replace them —
    the words are then read as ordinary lines instead."""

    if not table.bbox or table.extraction_method == "dom":
        return True
    x0, y0, x1, y1 = table.bbox
    inside = [
        w for w in words
        if x0 - 2 <= (w.x0 + w.x1) / 2 <= x1 + 2 and y0 - 2 <= (w.y0 + w.y1) / 2 <= y1 + 2
    ]
    if len(inside) < 4:
        return True
    tokens = Counter(
        token.lower()
        for row in [table.header_cells, *table.rows]
        for cell in row
        for token in cell.text.split()
    )
    matched = 0
    for word in inside:
        key = word.text.lower()
        if tokens[key] > 0:
            tokens[key] -= 1
            matched += 1
    return matched >= minimum * len(inside)


def document_page_words(database: Session, document: Document) -> list[tuple[int, list[Word], str]]:
    """Every page's positioned words in PDF points — (page number, words,
    "native" | "ocr") — from the same sources the structure uses. HTML
    documents have none."""

    if _source_type(document) == "html":
        return []
    pages = list(
        database.scalars(
            select(DocumentPage).where(DocumentPage.document_id == document.id).order_by(DocumentPage.page_number)
        )
    )
    fitz_doc = _open_source_pdf(document, _source_type(document), [])
    try:
        result = []
        for page in pages:
            fitz_page = (
                fitz_doc[page.page_number - 1]
                if fitz_doc is not None and 0 <= page.page_number - 1 < fitz_doc.page_count
                else None
            )
            words, method = page_words(page, fitz_page, get_settings().ocr_dpi)
            result.append((page.page_number, words, method))
        return result
    finally:
        if fitz_doc is not None:
            fitz_doc.close()


def _text_only_blocks(text: str) -> list[dict]:
    """Engine text as paragraphs: layout padding collapsed to a column gap,
    lines without any letter or digit (OCR specks, rules) dropped."""

    paragraphs: list[list[str]] = [[]]
    for raw in text.splitlines():
        line = re.sub(r" {2,}", "   ", raw.strip())
        if not re.search(r"[A-Za-z0-9]", line):
            if paragraphs[-1]:
                paragraphs.append([])
            continue
        paragraphs[-1].append(line)
    return [
        {
            "kind": "paragraph",
            "text": "\n".join(lines),
            "bbox": None,
            "lines": [{"text": line, "bbox": None, "words": []} for line in lines],
            "table": None,
        }
        for lines in paragraphs
        if lines
    ]


def _build_html(file_path: Path | None, result: StructuredSourceDocument) -> None:
    if file_path is None:
        result.warnings.append("HTML source file unavailable; no structure extracted.")
        return
    extractor = extract_html_structure(file_path.read_bytes())
    result.regions.extend(extractor.regions)
    result.field_candidates.extend(extractor.fields)
    for table in extractor.tables:
        annotate_geometry(table, None)
    result.table_candidates.extend(extractor.tables)


def build_source_structure(database: Session, document: Document) -> StructuredSourceDocument:
    started = time.perf_counter()
    pages = list(
        database.scalars(
            select(DocumentPage)
            .where(DocumentPage.document_id == document.id)
            .order_by(DocumentPage.page_number)
        )
    )
    result = StructuredSourceDocument(
        document_id=document.id,
        source_type=_source_type(document),
        extractor_version=EXTRACTOR_VERSION,
    )
    file_path: Path | None
    try:
        file_path = ensure_local_copy(get_settings(), stored_filename=document.stored_filename)
    except DocumentStorageError as exc:
        file_path = None
        result.warnings.append(f"Source file unavailable ({exc}).")

    if result.source_type == "html":
        _build_html(file_path, result)
    else:
        _build_pdf(document, pages, file_path, result)

    result.stats.pages = len(pages) if result.source_type != "html" else 0
    result.stats.regions_by_type = dict(Counter(r.region_type for r in result.regions))
    result.stats.field_candidates = dict(Counter(f.acceptance for f in result.field_candidates))
    result.stats.table_candidates = dict(Counter(t.acceptance for t in result.table_candidates))
    result.stats.duration_ms = int((time.perf_counter() - started) * 1000)
    return result


def _compact(structure: StructuredSourceDocument) -> dict:
    compact = structure.model_copy(deep=True)
    compact.regions = [r for r in compact.regions if r.region_type not in _TRANSIENT_REGION_TYPES]
    for table in compact.table_candidates:
        if table.acceptance != "accepted":
            table.rows = table.rows[:_MAX_REJECTED_TABLE_ROWS]
    return compact.model_dump(mode="json")


# Stored beside the structure: what it was built from (see
# source_structure_inputs_fingerprint).
_FINGERPRINT_KEY = "_input_fingerprint"


def source_structure_inputs_fingerprint(database: Session, document: Document) -> str:
    """Everything build_source_structure reads: the stored file, each page's
    size and OCR layout, the OCR DPI and the extractor version. Equal
    fingerprints mean a rebuild would produce the same structure."""

    digest = hashlib.sha256()
    for part in (
        EXTRACTOR_VERSION,
        document.checksum_sha256,
        document.stored_filename,
        document.content_type,
        get_settings().ocr_dpi,
    ):
        digest.update(f"{part}\x1f".encode())
    rows = database.execute(
        select(
            DocumentPage.page_number,
            DocumentPage.page_width,
            DocumentPage.page_height,
            DocumentPage.ocr_layout_json,
        )
        .where(DocumentPage.document_id == document.id)
        .order_by(DocumentPage.page_number)
    )
    for number, width, height, layout in rows:
        digest.update(f"{number}|{width}|{height}|".encode())
        digest.update(json.dumps(layout, sort_keys=True, default=str).encode())
        digest.update(b"\x1e")
    return digest.hexdigest()


def stored_source_structure_is_current(database: Session, document: Document) -> bool:
    """True when the stored structure was built by this extractor from the
    document's current inputs, so rebuilding it would change nothing."""

    record = database.scalars(
        select(DocumentSourceStructure).where(DocumentSourceStructure.document_id == document.id)
    ).first()
    if record is None or record.extractor_version != EXTRACTOR_VERSION:
        return False
    stored = (record.payload_json or {}).get(_FINGERPRINT_KEY)
    return bool(stored) and stored == source_structure_inputs_fingerprint(database, document)


def build_and_persist_source_structure(
    database: Session, document: Document
) -> StructuredSourceDocument:
    structure = build_source_structure(database, document)
    record = database.scalars(
        select(DocumentSourceStructure).where(DocumentSourceStructure.document_id == document.id)
    ).first()
    if record is None:
        record = DocumentSourceStructure(document_id=document.id)
        database.add(record)
    record.extractor_version = EXTRACTOR_VERSION
    record.source_type = structure.source_type
    record.payload_json = {
        **_compact(structure),
        _FINGERPRINT_KEY: source_structure_inputs_fingerprint(database, document),
    }
    database.commit()
    return structure


def load_source_structure(database: Session, document_id: str) -> StructuredSourceDocument | None:
    record = database.scalars(
        select(DocumentSourceStructure).where(DocumentSourceStructure.document_id == document_id)
    ).first()
    if record is None or record.extractor_version != EXTRACTOR_VERSION:
        return None
    return StructuredSourceDocument.model_validate(record.payload_json)


def get_or_build_source_structure(
    database: Session, document: Document
) -> StructuredSourceDocument:
    """Stored structure when current; otherwise (older extraction, or an
    extractor upgrade) rebuilt and stored."""

    return load_source_structure(database, document.id) or build_and_persist_source_structure(
        database, document
    )
