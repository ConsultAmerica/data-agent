from datetime import datetime, timezone

from sqlalchemy import DateTime, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base


class PlaybookSavedQuery(Base):
    """A prompt or extraction criterion a team saved to its clause playbook so
    every reviewer runs the same question the same way. Scoped like
    ClausePlaybookRule: owner_workspace is None for callers with real
    credentials (one shared list)."""

    __tablename__ = "playbook_saved_queries"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_workspace: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    # "ask" (a DataoAI prompt) | "clause_search" (FAR/DFARS search) |
    # "extraction" (custom extraction criteria)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    query: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
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
