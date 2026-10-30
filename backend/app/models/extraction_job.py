from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base


class ExtractionJob(Base):
    __tablename__ = "extraction_jobs"

    id: Mapped[int] = mapped_column(
        Integer,
        primary_key=True,
        autoincrement=True,
    )

    document_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("documents.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # "processing" (extract pages + OCR + schema discovery) or
    # "extraction" (extract selected targets).
    job_type: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
    )

    # queued | processing | complete | failed
    status: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default="queued",
    )

    # processing_document | running_ocr | discovering_fields |
    # extracting_data | validating_results | complete
    stage: Mapped[str | None] = mapped_column(
        String(40),
        nullable=True,
    )

    progress: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=0,
    )

    error_message: Mapped[str | None] = mapped_column(
        Text,
        nullable=True,
    )

    retry_count: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=0,
    )

    # Populated once an "extraction" job completes — the aggregated
    # ExtractTargetsResponse payload, since results have nowhere else
    # to land once extraction runs outside the original HTTP request.
    result_json: Mapped[dict | None] = mapped_column(
        JSON,
        nullable=True,
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )

    started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )

    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )

    # Touched every few seconds while the runner is alive; a running job
    # whose heartbeat stops was lost with its process (job_recovery.py).
    heartbeat_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
