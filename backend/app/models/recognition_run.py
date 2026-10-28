from datetime import datetime, timezone

from sqlalchemy import DateTime, Float, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base


class RecognitionRun(Base):
    """One call to a recognition provider (or one refusal by policy):
    which provider and model saw which document, when, and how it went.

    No FK to documents: like the audit logs, the record of what was sent
    where outlives the document. Holds no document content."""

    __tablename__ = "recognition_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    document_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    extraction_job_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    provider_id: Mapped[str] = mapped_column(String(40), nullable=False)
    model: Mapped[str | None] = mapped_column(String(80), nullable=True)
    model_version: Mapped[str | None] = mapped_column(String(40), nullable=True)
    locality: Mapped[str] = mapped_column(String(10), nullable=False)  # local | external
    method: Mapped[str | None] = mapped_column(String(40), nullable=True)
    # ok | error | blocked_by_policy
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    error_kind: Mapped[str | None] = mapped_column(String(20), nullable=True)
    data_class: Mapped[str | None] = mapped_column(String(20), nullable=True)
    policy_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    pipeline_version: Mapped[str | None] = mapped_column(String(40), nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Usage as the provider reported it; cost only from the operator's
    # configured per-page price (never assumed).
    pages: Mapped[int | None] = mapped_column(Integer, nullable=True)
    input_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    output_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    estimated_cost_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc)
    )
