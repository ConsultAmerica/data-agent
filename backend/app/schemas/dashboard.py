from datetime import datetime
from typing import Literal

from pydantic import BaseModel


class DashboardStatsResponse(BaseModel):
    total_documents: int
    completed: int
    review_required: int
    processing: int

    extraction_accuracy: float | None
    average_processing_seconds: float | None
    human_review_rate: float | None
    fields_extracted: int

    review_completion_rate: float | None
    ocr_accuracy: float | None
    clause_extraction_accuracy: float | None
    fields_extracted_today: int
    documents_requiring_manual_review: int


ReviewQueueBucket = Literal[
    "high", "medium", "low", "rejected", "unknown"
]


class ReviewQueueEntry(BaseModel):
    document_id: str
    original_filename: str
    document_type: str | None
    confidence: float | None
    queue_bucket: ReviewQueueBucket
    uploaded_at: datetime
    pending_field_count: int = 0
    attention_field_count: int = 0
    top_reasons: list[str] = []
    review_href: str | None = None


class ReviewQueueFieldItem(BaseModel):
    document_id: str
    original_filename: str
    # The persisted row id: review actions address the field by it, since a
    # field_key can repeat within one document (two telephone numbers).
    metadata_field_id: int | None = None
    field_key: str
    label: str
    value: str
    confidence: float
    confidence_band: str | None = None
    review_status: str
    extraction_source: str
    extraction_method: str | None = None
    reasons: list[str] = []
    reason_labels: list[str] = []
    priority: str = "medium"
    decision_status: str = "needs_review"
    page_number: int | None = None
    review_href: str | None = None
