from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.schemas.universal_extraction import SourceEvidence

CorrectionAction = Literal["edit", "verify", "reject"]
# Why a value was corrected (docs/di-01-correction-learning-design.md §2).
CorrectionReason = Literal[
    "wrong_value", "wrong_field", "missing", "ocr_error", "split_merge", "other"
]


class TargetCorrectionCreate(BaseModel):
    action: CorrectionAction = "edit"
    original_value: Any = None
    corrected_value: Any = None
    evidence: SourceEvidence | None = None
    changed_by: str | None = None
    reason_code: CorrectionReason | None = None
    reason_text: str | None = Field(default=None, max_length=2000)


class TargetCorrectionResponse(BaseModel):
    id: int
    document_id: str
    normalized_key: str
    action: CorrectionAction = "edit"
    original_value: Any = None
    corrected_value: Any = None
    evidence_snapshot: SourceEvidence | None = None
    changed_by: str | None = None
    actor_id: str | None = None
    reason_code: CorrectionReason | None = None
    reason_text: str | None = None
    created_at: datetime

    model_config = {"from_attributes": True}
