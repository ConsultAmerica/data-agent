from datetime import datetime, timezone

from sqlalchemy import DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base


class RelationshipAuditLog(Base):
    __tablename__ = "relationship_audit_log"

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

    action: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
    )

    previous_parent_id: Mapped[str | None] = mapped_column(
        String(36),
        nullable=True,
    )

    new_parent_id: Mapped[str | None] = mapped_column(
        String(36),
        nullable=True,
    )

    previous_relationship_type: Mapped[str | None] = mapped_column(
        String(30),
        nullable=True,
    )

    new_relationship_type: Mapped[str | None] = mapped_column(
        String(30),
        nullable=True,
    )

    # Authenticated actor; changed_by is only the display name.
    actor_id: Mapped[str | None] = mapped_column(
        String(64),
        nullable=True,
        index=True,
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
