from datetime import date, datetime, timezone

from sqlalchemy import Date, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base


class ReviewAssignment(Base):
    """Who should review one queued field, and by when.

    There is no user directory: `assignee` is the display name the assigner
    typed. One active assignment per field — reassigning replaces the row.
    `field_ref` makes that unique even when a field has no persisted id
    ("id:<metadata_field_id>", else "key:<field_key>"), since NULLs never
    collide in a unique constraint.
    """

    __tablename__ = "review_assignments"

    __table_args__ = (
        UniqueConstraint("document_id", "field_ref", name="uq_review_assignments_document_field"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    document_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("documents.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    metadata_field_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    field_key: Mapped[str] = mapped_column(String(200), nullable=False)
    field_ref: Mapped[str] = mapped_column(String(220), nullable=False)
    assignee: Mapped[str] = mapped_column(String(200), nullable=False)
    due_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    assigned_by: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    assigned_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )


def field_ref(metadata_field_id: int | None, field_key: str) -> str:
    return f"id:{metadata_field_id}" if metadata_field_id is not None else f"key:{field_key}"
