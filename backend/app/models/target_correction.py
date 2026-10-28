from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base


class TargetCorrection(Base):
    """A human review action on an extracted target value — either an
    edit (corrected_value differs from original_value) or a verification
    (a reviewer confirmed the existing value is correct, with no value
    change).

    Every action inserts a new row rather than updating in place, so the
    full history survives — "current" state for a target is the most
    recent row for its normalized_key. There is no ORM table for
    individual scalar results (they only ever exist inside an
    ExtractionJob.result_json blob), so original_value/evidence_snapshot
    are supplied by the caller at edit time rather than looked up here.
    """

    __tablename__ = "target_corrections"

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

    normalized_key: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
        index=True,
    )

    # "edit" (value changed) or "verify" (reviewer confirmed the value
    # as-is, corrected_value left null). Defaults to "edit" so rows
    # created before this column existed still read correctly.
    action: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default="edit",
        server_default="edit",
    )

    original_value: Mapped[dict | list | str | int | float | bool | None] = (
        mapped_column(JSON, nullable=True)
    )

    corrected_value: Mapped[dict | list | str | int | float | bool | None] = (
        mapped_column(JSON, nullable=True)
    )

    evidence_snapshot: Mapped[dict | None] = mapped_column(
        JSON,
        nullable=True,
    )

    changed_by: Mapped[str | None] = mapped_column(
        String(120),
        nullable=True,
    )

    # Authenticated actor (changed_by is only the display name) and why
    # the value was corrected — learning needs both (DI-02, B-009).
    actor_id: Mapped[str | None] = mapped_column(
        String(64),
        nullable=True,
        index=True,
    )

    reason_code: Mapped[str | None] = mapped_column(
        String(40),
        nullable=True,
    )

    reason_text: Mapped[str | None] = mapped_column(
        Text,
        nullable=True,
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
