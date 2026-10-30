from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base


class StructureRecordReview(Base):
    """A reviewer's decision on a record of the document's original layout
    that has no extraction row of its own — a printed form field nothing
    extracted, or a table row. Fields that do have one are reviewed on that
    row (DocumentMetadataField) instead, so the decision reaches staging and
    Oracle mapping.

    `record_key` is the layout's stable key ("field:1:2-contract-information:
    contract-number:0", "table:4:0:row:12"). The printed value is kept as
    `original_value`; a correction goes to `reviewed_value`, never over it.
    """

    __tablename__ = "structure_record_reviews"
    __table_args__ = (UniqueConstraint("document_id", "record_key", name="uq_structure_record_review"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    document_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("documents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    record_key: Mapped[str] = mapped_column(String(300), nullable=False)
    # field | row
    record_kind: Mapped[str] = mapped_column(String(10), nullable=False)
    # accepted | rejected | edited
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    # Field: the printed text. Row: the printed cells.
    original_value: Mapped[object | None] = mapped_column(JSON, nullable=True)
    reviewed_value: Mapped[object | None] = mapped_column(JSON, nullable=True)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    actor_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    actor_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # Every earlier decision, oldest first: {status, value, reason, actor, at}.
    history: Mapped[list | None] = mapped_column(JSON, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc)
    )
