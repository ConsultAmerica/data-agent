from datetime import date, datetime, timezone

from sqlalchemy import JSON, Date, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base


class DocumentKeyDate(Base):
    """A dated event a document states about itself — expiry, validity
    end, renewal, termination, period end, due, issue, effective — with the
    page and text it was read from (app/key_dates/). Rebuilt whenever the
    document is (re)staged; status (expired / expiring) is computed on read
    against today, never stored."""

    __tablename__ = "document_key_dates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    document_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("documents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # expiry | valid_until | renewal | termination | period_end | due | issue | effective
    kind: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    label: Mapped[str] = mapped_column(String(200), nullable=False)
    # mrz | text | contract_schedule
    source: Mapped[str] = mapped_column(String(30), nullable=False)
    page: Mapped[int | None] = mapped_column(Integer, nullable=True)
    evidence_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    details: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    confidence: Mapped[float] = mapped_column(Float, nullable=False, default=0.8)
    extractor_version: Mapped[str] = mapped_column(String(20), nullable=False)
    detected_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc)
    )
