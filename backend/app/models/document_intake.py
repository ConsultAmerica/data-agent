from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base

INTAKE_STATUSES = ("draft", "submitted", "rejected")


class DocumentIntake(Base):
    """What the uploader said about a document when it entered the system:
    the batch it arrived in, the agency and contracting officer it belongs
    to, the extraction profile they asked for, and whether the batch was
    sent on to review. One row per document; documents uploaded without
    any intake fields have no row.

    ``extraction_profile`` is a hint only: the staging resolver
    (app/staging/resolver.py) still picks the profile from the document's
    own evidence and never forces one it wasn't detected as."""

    __tablename__ = "document_intake"

    document_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("documents.id", ondelete="CASCADE"),
        primary_key=True,
    )
    batch_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    agency: Mapped[str | None] = mapped_column(String(200), nullable=True)
    contracting_officer: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # A registered staging profile id, or "auto".
    extraction_profile: Mapped[str] = mapped_column(String(80), nullable=False, default="auto")
    # "draft" | "submitted" | "rejected"
    intake_status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft")
    created_by: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
