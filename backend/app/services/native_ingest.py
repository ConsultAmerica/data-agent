"""Persist native-parser output as DocumentPage rows (common page model)."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID

from sqlalchemy import insert
from sqlalchemy.orm import Session

from app.models.document_page import DocumentPage
from app.models.page_text_block import PageTextBlock
from app.parsers.docx_parser import parse_docx
from app.parsers.office_text_parsers import (
    parse_csv_file,
    parse_html_file,
    parse_plain_text,
    parse_pptx_slides,
    parse_rtf_file,
    parse_xml_file,
    parse_xlsx_sheets,
)
from app.services.security_validation import UploadTypeSpec


def ingest_native_document(
    database: Session,
    document_id: UUID | str,
    file_path: Path,
    spec: UploadTypeSpec,
) -> int:
    """Ingest native text/tables. Returns page count written."""

    doc_id = str(document_id)
    kind = spec.kind
    ocr_used = False

    if kind == "docx":
        parsed = parse_docx(str(file_path))
        text_parts = list(parsed["paragraphs"])
        for table in parsed["tables"]:
            for row in table:
                text_parts.append(" | ".join(row))
        final_text = "\n".join(text_parts)
        ocr_used = bool(parsed.get("ocr_used"))
        _store_page(
            database=database,
            document_id=doc_id,
            page_number=1,
            page_label=None,
            paragraphs=parsed["paragraphs"],
            tables=parsed["tables"],
            final_text=final_text,
            extraction_method="native+ocr" if ocr_used else "native",
            ocr_used=ocr_used,
        )
        _stamp_document_ocr(database, doc_id, ocr_used=ocr_used, page_count=1)
        return 1

    if kind == "xlsx":
        sheets = parse_xlsx_sheets(file_path)
        if not sheets:
            sheets = [
                {
                    "name": "Sheet1",
                    "paragraphs": [],
                    "tables": [],
                    "text": "",
                }
            ]
        for index, sheet in enumerate(sheets, start=1):
            _store_page(
                database=database,
                document_id=doc_id,
                page_number=index,
                page_label=sheet["name"],
                paragraphs=sheet["paragraphs"],
                tables=sheet["tables"],
                final_text=sheet["text"],
            )
        _stamp_document_ocr(
            database, doc_id, ocr_used=False, page_count=len(sheets)
        )
        return len(sheets)

    if kind == "pptx":
        slides = parse_pptx_slides(file_path)
        if not slides:
            slides = [
                {
                    "name": "Slide 1",
                    "paragraphs": [],
                    "tables": [],
                    "text": "",
                    "ocr_used": False,
                }
            ]
        ocr_used = any(slide.get("ocr_used") for slide in slides)
        for index, slide in enumerate(slides, start=1):
            slide_ocr = bool(slide.get("ocr_used"))
            _store_page(
                database=database,
                document_id=doc_id,
                page_number=index,
                page_label=slide["name"],
                paragraphs=slide["paragraphs"],
                tables=slide["tables"],
                final_text=slide["text"],
                extraction_method="native+ocr" if slide_ocr else "native",
                ocr_used=slide_ocr,
            )
        _stamp_document_ocr(
            database, doc_id, ocr_used=ocr_used, page_count=len(slides)
        )
        return len(slides)

    if kind == "csv":
        parsed = parse_csv_file(file_path)
    elif kind == "html":
        parsed = parse_html_file(file_path)
    elif kind == "xml":
        parsed = parse_xml_file(file_path)
    elif kind == "rtf":
        parsed = parse_rtf_file(file_path)
    elif kind == "text":
        parsed = parse_plain_text(file_path)
    else:
        raise ValueError(f"No native ingest for kind={kind}")

    _store_page(
        database=database,
        document_id=doc_id,
        page_number=1,
        page_label=None,
        paragraphs=parsed["paragraphs"],
        tables=parsed["tables"],
        final_text=parsed["text"],
    )
    _stamp_document_ocr(database, doc_id, ocr_used=False, page_count=1)
    return 1


def _stamp_document_ocr(
    database: Session,
    document_id: str,
    *,
    ocr_used: bool,
    page_count: int,
) -> None:
    from app.models.document import Document

    document = database.get(Document, document_id)
    if document is None:
        return
    provenance = dict(document.ingestion_provenance or {})
    provenance["ocr_used"] = ocr_used
    provenance["page_count"] = page_count
    if ocr_used:
        provenance["ocr_pages"] = list(
            range(1, page_count + 1)
        )  # container-level; refined later if needed
    document.ingestion_provenance = provenance


def _store_page(
    *,
    database: Session,
    document_id: str,
    page_number: int,
    page_label: str | None,
    paragraphs: list[str],
    tables: list,
    final_text: str,
    extraction_method: str = "native",
    ocr_used: bool = False,
) -> None:
    page_record = DocumentPage(
        document_id=document_id,
        page_number=page_number,
        page_label=page_label,
        native_text=final_text if not ocr_used else "",
        ocr_text=final_text if ocr_used else None,
        final_text=final_text,
        tables_json=tables or None,
        has_tables=bool(tables),
        has_form_fields=False,
        is_scanned=ocr_used,
        text_length=len(final_text),
        extraction_method=extraction_method,
        requires_ocr=False,
        ocr_attempted=ocr_used,
        ocr_succeeded=ocr_used,
        character_count=len(final_text),
        word_count=len(final_text.split()),
        text_block_count=len(paragraphs),
        image_count=1 if ocr_used else 0,
        text_coverage_ratio=1.0 if final_text.strip() else 0.0,
        image_coverage_ratio=0.8 if ocr_used else 0.0,
        page_width=0.0,
        page_height=0.0,
        extraction_status="completed",
        extracted_at=datetime.now(timezone.utc),
    )

    database.add(page_record)
    database.flush()

    if paragraphs:
        # One bulk INSERT: a long HTML or Office file has tens of thousands
        # of paragraphs, and building an ORM object for each took seconds.
        database.execute(
            insert(PageTextBlock),
            [
                {
                    "document_page_id": page_record.id,
                    "block_index": index,
                    "block_type": "text",
                    "text": paragraph,
                    "x0": 0.0,
                    "y0": 0.0,
                    "x1": 0.0,
                    "y1": 0.0,
                    "extraction_method": extraction_method,
                }
                for index, paragraph in enumerate(paragraphs)
            ],
        )
