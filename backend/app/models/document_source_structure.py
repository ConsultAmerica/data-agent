from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base


class DocumentSourceStructure(Base):
    """The schema-neutral structural extraction of one document (regions,
    label/value candidates, table candidates) — an intermediate source
    artifact that staging profiles interpret. Rebuilt when extraction runs
    unless its stored input fingerprint shows the document is unchanged,
    and whenever `extractor_version` changes."""

    __tablename__ = "document_source_structures"

    __table_args__ = (
        UniqueConstraint("document_id", name="uq_document_source_structure_document"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    document_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("documents.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    extractor_version: Mapped[int] = mapped_column(Integer, nullable=False)
    source_type: Mapped[str] = mapped_column(String(20), nullable=False)
    payload_json: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
