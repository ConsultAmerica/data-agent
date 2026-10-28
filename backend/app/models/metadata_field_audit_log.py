from datetime import datetime, timezone

from sqlalchemy import DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base


# field_key of document-level events (approve, promote, delete), which
# have no metadata_field_id.
DOCUMENT_EVENT_FIELD_KEY = "__document__"


class MetadataFieldAuditLog(Base):
    """Append-only application history for field review decisions.

    Rows are never updated in place. Actor identity attaches via
    actor_id / actor_type / actor_role; ``changed_by`` remains the
    human-readable display name for existing UI consumers.
    """

    __tablename__ = "metadata_field_audit_log"

    id: Mapped[int] = mapped_column(
        Integer,
        primary_key=True,
        autoincrement=True,
    )

    # No FK to documents: the audit trail outlives the document it
    # describes (document deletion keeps it and logs a deletion event).
    document_id: Mapped[str] = mapped_column(
        String(36),
        nullable=False,
        index=True,
    )

    field_key: Mapped[str] = mapped_column(
        String(50),
        nullable=False,
        index=True,
    )

    # Exact DocumentMetadataField.id when known (RC2-05B). Nullable for
    # historical rows written before ID-addressed review.
    metadata_field_id: Mapped[int | None] = mapped_column(
        Integer,
        nullable=True,
        index=True,
    )

    action: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
    )

    previous_value: Mapped[str | None] = mapped_column(
        Text,
        nullable=True,
    )

    new_value: Mapped[str | None] = mapped_column(
        Text,
        nullable=True,
    )

    previous_status: Mapped[str | None] = mapped_column(
        String(20),
        nullable=True,
    )

    new_status: Mapped[str | None] = mapped_column(
        String(20),
        nullable=True,
    )

    reason: Mapped[str | None] = mapped_column(
        Text,
        nullable=True,
    )

    request_id: Mapped[str | None] = mapped_column(
        String(64),
        nullable=True,
    )

    actor_id: Mapped[str | None] = mapped_column(
        String(64),
        nullable=True,
        index=True,
    )

    actor_type: Mapped[str | None] = mapped_column(
        String(20),
        nullable=True,
    )

    actor_role: Mapped[str | None] = mapped_column(
        String(32),
        nullable=True,
    )

    changed_by: Mapped[str] = mapped_column(
        String(120),
        nullable=False,
    )

    changed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
