from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.schemas.extraction_intelligence import (
    ConfidenceDetail,
    RetrievalTrace,
    ValidationResult,
)
from app.schemas.universal_extraction import SourceEvidence

TargetType = Literal[
    "field",
    "table",
    "section",
    "contact",
    "date",
    "amount",
    "identifier",
    "clause",
    "obligation",
    "signature",
    "custom",
]

TargetSource = Literal["detected", "template", "custom"]


class DocumentTarget(BaseModel):
    id: str
    key: str
    label: str
    target_type: TargetType
    page_numbers: list[int] = Field(default_factory=list)
    confidence: float
    source_examples: list[str] = Field(default_factory=list)
    parent_section: str | None = None
    columns: list[str] = Field(default_factory=list)
    occurrence_count: int = 1
    suggested_instruction: str | None = None
    source: TargetSource = "detected"
    # Richer discovery metadata (additive — Select All still uses id/key).
    display_name: str | None = None
    group: str | None = None
    value_type: str | None = None
    discovery_method: str | None = None
    source_labels: list[str] = Field(default_factory=list)
    is_custom: bool = False
    is_internal: bool = False
    selectable: bool = True
    description: str | None = None


class DiscoverSchemaResponse(BaseModel):
    document_id: str
    document_family: str
    document_family_label: str
    document_family_confidence: float
    # The broad category the document is grouped under: from its persisted
    # staging resolution, else the resolver's current reading of it.
    category: str | None = None
    category_label: str | None = None
    # The type the document is listed as (e.g. "SF 1442 Contract Award").
    type_label: str | None = None
    targets: list[DocumentTarget] = Field(default_factory=list)
    counts_by_type: dict[str, int] = Field(default_factory=dict)
    generated_at: datetime


class ExtractTargetsRequest(BaseModel):
    target_ids: list[str] = Field(min_length=1, max_length=50)
    use_ai_fallback: bool = True


class CreateCustomTargetRequest(BaseModel):
    label: str = Field(min_length=1, max_length=120)
    target_type: TargetType = "custom"


class RenameCustomTargetRequest(BaseModel):
    label: str = Field(min_length=1, max_length=120)


class ScalarTargetResult(BaseModel):
    target: str
    normalized_key: str
    value: Any
    page: int
    confidence: float
    confidence_band: Literal["high", "medium", "low"] = "medium"
    verified: bool
    extraction_method: str
    display_method: str = ""
    evidence: SourceEvidence
    # Inspectable intelligence layer (retrieval → confidence → validation).
    retrieval: RetrievalTrace | None = None
    confidence_detail: ConfidenceDetail | None = None
    validation: ValidationResult | None = None
    review_decision: dict[str, Any] | None = None
    # Durable governance — effective ``value`` may differ from machine extract.
    extracted_value: Any | None = None
    review_status: str | None = None
    # Legacy list-shaped signals kept for older UI consumers.
    confidence_signals: list[dict[str, Any]] = Field(default_factory=list)
    validation_status: Literal["passed", "failed", "skipped"] = "passed"


class TableTargetResult(BaseModel):
    target: str
    columns: list[str] = Field(default_factory=list)
    rows: list[dict[str, Any]] = Field(default_factory=list)
    pages: list[int] = Field(default_factory=list)


class ExtractTargetsResponse(BaseModel):
    document_id: str
    scalars: list[ScalarTargetResult] = Field(default_factory=list)
    tables: list[TableTargetResult] = Field(default_factory=list)
    unresolved_targets: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    # This run's optional AI enrichment outcome (app/services/ai_enrichment.py):
    # deterministic_status, ai_enrichment_status, a short notice, and the
    # technical detail shown only under Processing Details.
    ai_enrichment: dict | None = None
