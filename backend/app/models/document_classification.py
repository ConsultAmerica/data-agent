from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, Float, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base


class DocumentClassification(Base):
    """One classification event for a document: a prediction by the engine
    or a person's decision (confirm / override). Rows are only added, never
    rewritten, so the original prediction and every decision stay on
    record. A document's current classification is its latest decision,
    else its latest prediction (app/classification/service.py)."""

    __tablename__ = "document_classifications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # No FK: like the other audit trails, the history outlives the document.
    document_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)  # prediction | confirmation | override
    is_decision: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    family: Mapped[str] = mapped_column(String(80), nullable=False)
    family_label: Mapped[str] = mapped_column(String(160), nullable=False)
    category: Mapped[str] = mapped_column(String(40), nullable=False)
    subtype: Mapped[str | None] = mapped_column(String(160), nullable=True)
    profile_id: Mapped[str] = mapped_column(String(80), nullable=False)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    # classified | review_recommended | review_required | confirmed
    status: Mapped[str] = mapped_column(String(30), nullable=False)
    # [{"family", "label", "category", "profile_id", "subtype", "score", "evidence": [...], "sources": [...]}]
    candidates: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    evidence: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    method: Mapped[str] = mapped_column(String(80), nullable=False)
    engine_version: Mapped[str] = mapped_column(String(20), nullable=False)
    thresholds: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    actor_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    actor_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc), index=True
    )
