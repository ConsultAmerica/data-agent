from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base


class ObligationTracking(Base):
    """A team's progress on one derived obligation.

    Obligations themselves are computed on read (services/obligations.py)
    and never stored; this row only carries what people add on top —
    workflow status, owner and sub-tasks — keyed by the obligation's stable
    `obligation_id` (a hash of document, source type, source reference and
    title, so it survives re-reads).
    """

    __tablename__ = "obligation_tracking"

    __table_args__ = (
        UniqueConstraint("document_id", "obligation_key", name="uq_obligation_tracking_document_key"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    document_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("documents.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    obligation_key: Mapped[str] = mapped_column(String(64), nullable=False)
    # "upcoming" | "in_review" | "pending_co" | "completed"
    workflow_status: Mapped[str] = mapped_column(String(20), nullable=False, default="upcoming")
    assignee: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # [{"title": str, "done": bool}]
    subtasks: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    updated_by: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
