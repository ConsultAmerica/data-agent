from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field


class ExistingDocumentSummary(BaseModel):
    document_id: UUID
    original_filename: str
    size_bytes: int
    uploaded_at: datetime
    file_available: bool


class EmbeddedFileSummary(BaseModel):
    filename: str
    size_bytes: int
    # None when the embedded file can't be opened as a PDF.
    page_count: int | None = None


class UploadedDocumentResponse(BaseModel):
    document_id: UUID
    original_filename: str
    status: str
    content_type: str
    size_bytes: int = Field(ge=1)
    checksum_sha256: str | None = None
    page_count: int = Field(ge=1)
    encrypted: bool
    uploaded_at: datetime
    message: str
    duplicate: bool = False
    existing_document: ExistingDocumentSummary | None = None
    embedded_files: list[EmbeddedFileSummary] | None = None
    pipeline_log: list[str] = Field(default_factory=list)
    approved_by: str | None = None
    approved_at: datetime | None = None
    promoted_by: str | None = None
    promoted_at: datetime | None = None
    source_status: Literal["available", "missing"] = "available"
    size_tier: str = "small"
    prefer_background: bool = False
    processing_job_id: int | None = None
    ingestion_provenance: dict | None = None
    # True when the client should open an existing document without
    # re-running page extraction (duplicate → "Use existing").
    reused_existing: bool = False
    # Intake tags given at upload (GET /documents/{id} only; null otherwise).
    agency: str | None = None
    contracting_officer: str | None = None
    # Sensitivity class (GET /documents/{id}); null until classified.
    data_class: str | None = None
    data_class_source: str | None = None


class ResolveDuplicateRequest(BaseModel):
    action: Literal["use_existing", "upload_anyway"]
    original_filename: str | None = None
    existing_document_id: UUID | None = None


class SelectPortfolioFileRequest(BaseModel):
    filename: str


class DocumentSummaryResponse(BaseModel):
    document_id: str
    original_filename: str
    document_type: str | None
    status: Literal["processing", "review_required", "completed", "failed"]
    confidence: float | None
    uploaded_at: datetime
    page_count: int
    fields_extracted: int
    last_updated: datetime
    counterparty: str | None = None
    effective_date: str | None = None
    expiration_date: str | None = None
    contract_value: str | None = None
    relationship: str | None = None
    repository_status: Literal[
        "not_approved", "approved", "repository"
    ] = "not_approved"
    # Whether the original PDF can still be opened for Source Verification
    # (local cache or Supabase backup). Surfaces older DB rows whose file
    # disappeared before remote backup existed.
    source_status: Literal["available", "missing"] = "available"
    # The persisted staging resolution (app/staging/document_labels.py):
    # what the document is listed as. None until it has been staged.
    profile_id: str | None = None
    profile_label: str | None = None
    type_label: str | None = None
    staging_status: Literal["staged", "not_staged"] = "not_staged"
    # The broad category the resolved type is grouped under
    # (app/staging/document_categories.py); "unclassified" until staged.
    category: str = "unclassified"
    category_label: str = "Not yet classified"
    # Intake tagging from the upload (models/document_intake.py); all None
    # for a document uploaded without intake fields.
    agency: str | None = None
    contracting_officer: str | None = None
    batch_id: str | None = None
    intake_status: Literal["draft", "submitted", "rejected"] | None = None


class DocumentSearchResponse(BaseModel):
    documents: list[DocumentSummaryResponse]
    total: int


class CategoryCount(BaseModel):
    category: str
    label: str
    count: int


class DocumentStatusCountsResponse(BaseModel):
    total: int
    # Computed summary status -> count, over the same capped scan window
    # /search uses for status filters.
    by_status: dict[str, int]
    # Category -> count, over every matching document (not capped).
    by_category: dict[str, int] = Field(default_factory=dict)
    # The same counts with labels, in display order (categories with none left out).
    categories: list[CategoryCount] = Field(default_factory=list)


class HierarchyNode(BaseModel):
    document_id: str
    title: str
    document_number: str | None = None
    document_type: str | None = None
    relationship_type: str | None = None
    relationship_status: str | None = None
    children: list["HierarchyNode"] = Field(default_factory=list)


class DocumentHierarchyResponse(BaseModel):
    roots: list[HierarchyNode]
