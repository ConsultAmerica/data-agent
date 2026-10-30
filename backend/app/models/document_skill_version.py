from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base


class DocumentSkillVersion(Base):
    """Every version of a document skill (app/skills/definitions.py) as it
    was first used, so a result can always be traced to the exact skill
    definition that organized and validated it. Rows are never updated: a
    changed definition is a new version."""

    __tablename__ = "document_skill_versions"
    __table_args__ = (UniqueConstraint("skill_id", "version", name="uq_document_skill_version"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    skill_id: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    version: Mapped[str] = mapped_column(String(20), nullable=False)
    content_hash: Mapped[str] = mapped_column(String(32), nullable=False)
    definition: Mapped[dict] = mapped_column(JSON, nullable=False)
    recorded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc)
    )
