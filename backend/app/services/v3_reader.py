"""Assembles the canonical `NormalizedV3Document` by reading ONLY the
already-persisted V3 tables (docs/v3-implementation-plan.md Phase 10: "UI
and Excel must use the same data" — no re-extraction at read time).
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.document import Document
from app.models.document_attachment import DocumentAttachment
from app.models.document_clause_reference import DocumentClauseReference
from app.models.document_contract_summary import DocumentContractSummary
from app.models.document_funding_line import DocumentFundingLine
from app.models.document_line_item import DocumentLineItem
from app.models.document_metadata_field import DocumentMetadataField
from app.models.document_performance_period import DocumentPerformancePeriod
from app.models.document_qa_review import DocumentQaReview
from app.schemas.v3_document import (
    AllFieldsRow,
    AttachmentRow,
    ClauseRow,
    ClinRow,
    ContractSummaryRow,
    FarReferenceRow,
    FundingRow,
    NormalizedV3Document,
    PerformanceDeliveryRow,
    QaReviewRow,
    RowProvenance,
    SourceDocumentRow,
)
from app.services.extraction_outcome import build_extraction_outcome
from app.services.source_documents_builder import build_source_documents
from app.services.evidence_text import source_text_of


def _all_fields_status(label: str, value: str, stored: str) -> str:
    """Already-persisted rows stay on disk. Indefensible associations are
    not presented as Verified when the workbook or CSV is read."""

    from app.services.all_fields_builder import association_is_defensible

    if stored == "Verified" and not association_is_defensible(label, value or ""):
        return "Needs Review"
    return stored


def _evidence_page(evidence_json: dict | None) -> int:
    if not evidence_json:
        return 1
    page = evidence_json.get("page_number")
    return int(page) if isinstance(page, int) else 1


def _evidence_text(evidence_json: dict | None) -> str:
    if not evidence_json:
        return ""
    return source_text_of(evidence_json)


def _row_provenance(
    kind: str, row_id: int, evidence_json: dict | None, extraction_method: str | None = None
) -> RowProvenance:
    bbox = (evidence_json or {}).get("bbox")
    return RowProvenance(
        row_id=f"{kind}:{row_id}",
        bbox=[float(v) for v in bbox] if isinstance(bbox, list) and len(bbox) == 4 else None,
        bbox_space=(evidence_json or {}).get("bbox_space") or "pdf_points",
        extraction_method=extraction_method,
    )


def _all_fields(database: Session, document: Document) -> list[AllFieldsRow]:
    rows = database.scalars(
        select(DocumentMetadataField)
        .where(
            DocumentMetadataField.document_id == document.id,
            DocumentMetadataField.extraction_source == "v3",
        )
        .order_by(DocumentMetadataField.id)
    )
    return [
        AllFieldsRow(
            category=(row.evidence_json or {}).get("category", "General"),
            normalized_field=row.label,
            value=row.value,
            source_file=document.original_filename,
            source_page=_evidence_page(row.evidence_json),
            evidence=_evidence_text(row.evidence_json),
            extraction_method=row.extraction_method,
            qa_status=_all_fields_status(row.label, row.value, (row.evidence_json or {}).get("qa_status", "Needs Review")),
            row_provenance=_row_provenance(
                "field", row.id, row.evidence_json, row.extraction_method
            ),
        )
        for row in rows
    ]


def _clins(database: Session, document_id: str) -> list[ClinRow]:
    rows = database.scalars(
        select(DocumentLineItem)
        .where(DocumentLineItem.document_id == document_id)
        .order_by(DocumentLineItem.row_index)
    )
    result: list[ClinRow] = []
    for row in rows:
        max_quantity = row.max_quantity_text
        if max_quantity is None and row.quantity is not None:
            max_quantity = str(row.quantity)
        result.append(
            ClinRow(
                clin=row.clin or "",
                option_base=row.option_base,
                description=row.description or None,
                pricing_type=row.pricing_type,
                max_quantity=max_quantity,
                unit=row.unit,
                unit_price=row.unit_price,
                max_amount=row.amount,
                status=row.status,
                fob=row.fob,
                purchase_request=row.purchase_request,
                psc=row.psc,
                pop_start=row.pop_start,
                pop_end=row.pop_end,
                ship_to=row.ship_to,
                dodaac=row.dodaac,
                source_page=_evidence_page(row.evidence_json),
                evidence=_evidence_text(row.evidence_json),
                qa_status=row.qa_status,
                row_provenance=_row_provenance("clin", row.id, row.evidence_json, "table"),
            )
        )
    return result


def _funding(database: Session, document_id: str) -> list[FundingRow]:
    rows = database.scalars(
        select(DocumentFundingLine)
        .where(DocumentFundingLine.document_id == document_id)
        .order_by(DocumentFundingLine.row_index)
    )
    return [
        FundingRow(
            funding_level=row.funding_level,
            clin=row.clin,
            funding_status=row.funding_status,
            amount=row.amount,
            accounting_appropriation=row.accounting_appropriation,
            purchase_request=row.purchase_request,
            source_page=_evidence_page(row.evidence_json),
            evidence=_evidence_text(row.evidence_json),
            qa_status=row.qa_status,
            row_provenance=_row_provenance("funding", row.id, row.evidence_json),
        )
        for row in rows
    ]


def _performance_delivery(
    database: Session, document_id: str
) -> list[PerformanceDeliveryRow]:
    rows = database.scalars(
        select(DocumentPerformancePeriod)
        .where(DocumentPerformancePeriod.document_id == document_id)
        .order_by(DocumentPerformancePeriod.row_index)
    )
    return [
        PerformanceDeliveryRow(
            record_type=row.record_type or row.period_label,
            clin=row.clin,
            start=row.start_date,
            end_timing=row.end_timing or row.end_date,
            location_destination=row.location_destination,
            requirement=row.requirement,
            source_page=_evidence_page(row.evidence_json),
            evidence=_evidence_text(row.evidence_json),
            qa_status=row.qa_status,
            row_provenance=_row_provenance("performance", row.id, row.evidence_json),
        )
        for row in rows
    ]


def _attachments(database: Session, document_id: str) -> list[AttachmentRow]:
    rows = database.scalars(
        select(DocumentAttachment)
        .where(DocumentAttachment.document_id == document_id)
        .order_by(DocumentAttachment.row_index)
    )
    return [
        AttachmentRow(
            attachment_reference=row.attachment_reference,
            title_description=row.title_description,
            included_in_portfolio=row.included_in_portfolio,
            source_page=_evidence_page(row.evidence_json),
            evidence=_evidence_text(row.evidence_json),
            qa_status=row.qa_status,
            row_provenance=_row_provenance("attachment", row.id, row.evidence_json),
        )
        for row in rows
    ]


def _clause_rows(database: Session, document_id: str) -> list[DocumentClauseReference]:
    return list(
        database.scalars(
            select(DocumentClauseReference)
            .where(DocumentClauseReference.document_id == document_id)
            .order_by(DocumentClauseReference.row_index)
        )
    )


def _to_clause_row(row: DocumentClauseReference) -> ClauseRow:
    return ClauseRow(
        regulation=row.clause_family,
        clause_number=row.clause_number,
        clause_title=row.title or None,
        alternate_deviation=row.alternate or row.deviation,
        effective_date=row.effective_date,
        incorporation_type=row.incorporation_type,
        source_page=_evidence_page(row.evidence_json),
        evidence=_evidence_text(row.evidence_json),
        qa_status=row.qa_status,
        row_provenance=_row_provenance("clause", row.id, row.evidence_json),
    )


def _to_far_reference_row(row: DocumentClauseReference) -> FarReferenceRow:
    return FarReferenceRow(
        far_reference=f"{row.clause_family} {row.clause_number}".strip(),
        reference_type=row.reference_type,
        subject_context=row.subject_context,
        source_page=_evidence_page(row.evidence_json),
        evidence=_evidence_text(row.evidence_json),
        contract_clause=row.contract_clause,
        qa_status=row.qa_status,
        row_provenance=_row_provenance("clause", row.id, row.evidence_json),
    )


def _contract_summary(
    database: Session, document_id: str, document: Document
) -> ContractSummaryRow | None:
    row = database.scalars(
        select(DocumentContractSummary).where(
            DocumentContractSummary.document_id == document_id
        )
    ).first()
    if row is None:
        return None
    return ContractSummaryRow(
        contract_number=row.contract_number,
        solicitation_rfp=row.solicitation_rfp,
        contract_vehicle=row.contract_vehicle,
        agency_office=row.agency_office,
        contractor=row.contractor,
        award_date=row.award_date,
        ceiling_max_aggregate=row.ceiling_max_aggregate,
        minimum_guarantee=row.minimum_guarantee,
        base_period=row.base_period,
        options=row.options,
        max_duration=row.max_duration,
        task_order_range=row.task_order_range,
        naics=row.naics,
        size_standard=row.size_standard,
        source_file=row.source_file or document.original_filename,
        source_page=row.source_page,
        evidence=row.evidence,
        qa_status=row.qa_status,
        field_provenance=dict(row.field_provenance_json or {}),
    )


def _qa_review(database: Session, document_id: str) -> list[QaReviewRow]:
    rows = database.scalars(
        select(DocumentQaReview)
        .where(DocumentQaReview.document_id == document_id)
        .order_by(DocumentQaReview.row_index)
    )
    return [
        QaReviewRow(
            qa_check=row.qa_check, result=row.result, details=row.details, action=row.action
        )
        for row in rows
    ]


def _source_documents(database: Session, document: Document) -> list[SourceDocumentRow]:
    rows = build_source_documents(database=database, document=document)
    result = [
        SourceDocumentRow(
            source_document=row.source_document,
            role=row.role,
            pages=row.pages,
            extraction_status=row.extraction_status,
        )
        for row in rows
    ]
    # Files embedded inside this PDF (e.g. a PDF Portfolio's real documents)
    # are part of the source set even though nothing has extracted them yet.
    v3_record = (document.ingestion_provenance or {}).get("v3_extraction") or {}
    inspection = v3_record.get("source_inspection") or {}
    for item in inspection.get("embedded_files") or []:
        result.append(
            SourceDocumentRow(
                source_document=str(item.get("name")),
                role=f"Embedded in {document.original_filename}",
                pages=0,
                extraction_status="Not extracted (embedded file)",
            )
        )
    return result


def get_normalized_v3_document(
    database: Session, document_id: str
) -> NormalizedV3Document:
    document = database.get(Document, document_id)
    if document is None:
        raise ValueError(f"Document {document_id} not found.")

    clause_rows = _clause_rows(database, document_id)
    clauses = [
        _to_clause_row(row)
        for row in clause_rows
        if row.clause_family in ("FAR", "GSAR") and row.citation_context == "listing"
    ]
    dfars = [_to_clause_row(row) for row in clause_rows if row.clause_family == "DFARS"]
    far_references = [
        _to_far_reference_row(row)
        for row in clause_rows
        if row.citation_context == "incidental"
    ]

    normalized = NormalizedV3Document(
        document_id=document.id,
        document_filename=document.original_filename,
        all_fields=_all_fields(database, document),
        clins=_clins(database, document_id),
        funding=_funding(database, document_id),
        performance_delivery=_performance_delivery(database, document_id),
        attachments=_attachments(database, document_id),
        clauses=clauses,
        far_references=far_references,
        dfars=dfars,
        source_documents=_source_documents(database, document),
        qa_review=_qa_review(database, document_id),
        contract_summary=_contract_summary(database, document_id, document),
    )
    normalized.extraction_outcome = build_extraction_outcome(
        normalized, document.ingestion_provenance
    )
    return normalized
