"""Append-only integration (Oracle) send audit trail."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base


class IntegrationAuditLog(Base):
    """Who sent what, when, from which reviewed values, and what came back."""

    __tablename__ = "integration_audit_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    # No FK to documents: the audit trail outlives the document it
    # describes (document deletion keeps it and logs a deletion event).
    document_id: Mapped[str] = mapped_column(
        String(36),
        nullable=False,
        index=True,
    )

    integration: Mapped[str] = mapped_column(String(40), nullable=False, default="oracle")

    action: Mapped[str] = mapped_column(String(20), nullable=False)

    status: Mapped[str] = mapped_column(String(20), nullable=False)

    request_snapshot: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    response_snapshot: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    actor_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)

    actor_type: Mapped[str | None] = mapped_column(String(20), nullable=True)

    actor_role: Mapped[str | None] = mapped_column(String(32), nullable=True)

    changed_by: Mapped[str] = mapped_column(String(120), nullable=False)

    request_id: Mapped[str | None] = mapped_column(String(64), nullable=True)

    detail: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
