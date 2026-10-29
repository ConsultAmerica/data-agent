from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.universal_extraction import SourceEvidence


ReviewStatusLiteral = Literal[
    "pending",
    "accepted",
    "edited",
    "rejected",
    "unknown",
]

ReviewActionLiteral = Literal[
    "accept",
    "edit",
    "reject",
    "mark_unknown",
    # Save a corrected value without approving it (it stays pending).
    "correct",
]

# Audit read models take `action: str`: the log holds field review actions
# plus document-level events (approve, promote, delete), and one unexpected
# historical row must not break the whole audit page.


DocumentTypeLiteral = Literal[
    "Master Services Agreement",
    "NDA",
    "Supplier Agreement",
    "Purchase Agreement",
    "Professional Services Agreement",
    "Software Agreement",
    "SaaS Agreement",
    "Lease",
    "Statement of Work",
    "Amendment",
    "Change Order",
    "Purchase Order",
    "Service Level Agreement",
    "License Agreement",
    "Consulting Agreement",
    "Construction Agreement",
    "Government Contract",
    "Subcontract",
    "Other",
]


DocumentStatusLiteral = Literal[
    "Original",
    "Amendment",
    "Renewal",
    "Supporting Document",
    "Unknown",
]


class ContractClassification(BaseModel):
    document_type: DocumentTypeLiteral = "Other"

    industry: str | None = None

    contract_side: Literal[
        "buy_side",
        "sell_side",
        "unknown",
    ] = "unknown"

    language: str | None = None

    document_status: DocumentStatusLiteral = "Unknown"

    confidence: float = Field(
        default=0.0,
        ge=0,
        le=1,
    )


class ClassificationUpdateRequest(BaseModel):
    document_type: DocumentTypeLiteral | None = None
    contract_side: Literal["buy_side", "sell_side", "unknown"] | None = (
        None
    )
    language: str | None = None
    changed_by: str = Field(min_length=1, max_length=120)


class ClassificationHistoryEntry(BaseModel):
    field_changed: str
    previous_value: str | None = None
    new_value: str | None = None
    changed_by: str
    changed_at: datetime


class FailedValidationRule(BaseModel):
    rule: str
    label: str
    detail: str | None = None


class ValidationOverride(BaseModel):
    reason: str
    reviewer: str
    at: str
    failed_rules: list[str] = Field(default_factory=list)
    messages: list[str] = Field(default_factory=list)


class FieldValidationSummary(BaseModel):
    """Validation as recorded by extraction (or re-run on a correction)."""

    # passed | failed | skipped | not_run
    status: str = "not_run"
    failed_rules: list[FailedValidationRule] = Field(default_factory=list)
    messages: list[str] = Field(default_factory=list)
    # Only when extraction stored one; never invented.
    suggested_value: str | None = None
    # A failed validation blocks an ordinary approval (an override needs a reason).
    blocking: bool = False
    override: ValidationOverride | None = None


class MetadataFieldResult(BaseModel):
    # Immutable primary key — preferred address for Accept/Edit/Reject.
    id: int | None = None

    field_group: str
    field_key: str
    label: str

    value: str

    confidence: float = Field(ge=0, le=1)

    # Rows in document_metadata_fields come from several extractors
    # (contract metadata, target extraction, V3 all-fields), each with its
    # own method vocabulary, so this mirrors the free-form DB column.
    extraction_method: str = Field(min_length=1, max_length=40)

    extraction_source: str = "contract"

    evidence: SourceEvidence

    verified: bool = False

    review_status: ReviewStatusLiteral = "pending"

    original_value: str = ""

    # Machine extraction (evidence.machine_value → original_value → value).
    # Distinct from `value`, which is the authoritative effective value.
    extracted_value: str = ""

    validation: FieldValidationSummary | None = None


class FieldReviewRequest(BaseModel):
    action: ReviewActionLiteral

    value: str | None = None

    changed_by: str = Field(min_length=1, max_length=120)

    # Approving a value whose validation failed needs an explicit reason;
    # it is recorded on the field and in the audit log.
    override_reason: str | None = Field(default=None, max_length=500)


class AcceptAllRequest(BaseModel):
    changed_by: str | None = Field(default=None, max_length=120)
    # Default: only low-risk pending values (review_routing.low_risk_blockers).
    # Accepting flagged values too is an admin override and needs a reason.
    include_flagged: bool = False
    override_reason: str | None = Field(default=None, max_length=500)


class FieldAuditEntry(BaseModel):
    action: str

    metadata_field_id: int | None = None

    previous_value: str | None = None
    new_value: str | None = None
    previous_status: str | None = None
    new_status: str | None = None
    reason: str | None = None
    request_id: str | None = None
    actor_id: str | None = None
    actor_type: str | None = None
    actor_role: str | None = None

    changed_by: str
    changed_at: datetime


class GlobalAuditEntry(BaseModel):
    document_id: str
    document_filename: str
    field_key: str

    action: str

    previous_value: str | None = None
    new_value: str | None = None
    previous_status: str | None = None
    new_status: str | None = None
    reason: str | None = None
    request_id: str | None = None
    actor_id: str | None = None
    actor_type: str | None = None
    actor_role: str | None = None

    changed_by: str
    changed_at: datetime


class GlobalAuditLogResponse(BaseModel):
    entries: list[GlobalAuditEntry]
    total: int


RelationshipStatusLiteral = Literal[
    "pending",
    "confirmed",
    "rejected",
    "manual",
]


class DetectedRelationship(BaseModel):
    parent_document_id: str
    parent_document_title: str
    parent_document_number: str | None = None

    relationship_type: str

    confidence: float = Field(ge=0, le=1)

    matched_on: Literal[
        "contract_number",
        "contract_title",
    ]

    status: RelationshipStatusLiteral = "pending"

    reasons: list[str] = Field(default_factory=list)
    detection_method: Literal["automatic", "manual"] = "automatic"


class ContractAnalysisResponse(BaseModel):
    document_id: str

    classification: ContractClassification

    metadata_fields: list[MetadataFieldResult]

    relationship: DetectedRelationship | None = None

    warnings: list[str] = Field(default_factory=list)

    # Header identity from the staging workbook (what the document page
    # shows), for when the reviewable values don't carry it.
    staged_contract_number: str | None = None
    staged_contractor: str | None = None


class AnalyzeContractRequest(BaseModel):
    extraction_model_id: int | None = None


class ConfirmRelationshipRequest(BaseModel):
    action: Literal["confirm", "reject"]
    changed_by: str = Field(default="Unknown", min_length=1, max_length=120)


class ConfirmRelationshipResponse(BaseModel):
    document_id: str
    status: Literal["confirmed", "rejected"]
    relationship: DetectedRelationship | None = None


class ManualRelationshipRequest(BaseModel):
    parent_document_id: str
    relationship_type: str = "amendment_of"
    changed_by: str = Field(min_length=1, max_length=120)


class RemoveRelationshipRequest(BaseModel):
    changed_by: str = Field(min_length=1, max_length=120)


class ChildRelationship(BaseModel):
    child_document_id: str
    child_document_title: str
    child_document_number: str | None = None

    relationship_type: str

    confidence: float = Field(ge=0, le=1)

    status: RelationshipStatusLiteral

    reasons: list[str] = Field(default_factory=list)


class ChildRelationshipsResponse(BaseModel):
    parent_document_id: str
    children: list[ChildRelationship] = Field(default_factory=list)


class ApproveDocumentRequest(BaseModel):
    # Ignored: the approver is the authenticated actor. Kept optional so
    # older clients that still send a name keep working.
    changed_by: str | None = Field(default=None, max_length=120)


class ApproveDocumentResponse(BaseModel):
    document_id: str
    approved_by: str
    approved_at: datetime


class PromoteDocumentRequest(BaseModel):
    # Ignored: the approver is the authenticated actor. Kept optional so
    # older clients that still send a name keep working.
    changed_by: str | None = Field(default=None, max_length=120)


class PromoteDocumentResponse(BaseModel):
    document_id: str
    promoted_by: str
    promoted_at: datetime
