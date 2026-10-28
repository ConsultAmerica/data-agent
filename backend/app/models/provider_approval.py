from datetime import datetime, timezone

from sqlalchemy import DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base


class ProviderApproval(Base):
    """Explicit approval for an external provider to process documents of
    one data class (app/recognition/policy.py). Without an active row,
    restricted documents never leave the platform, and confidential ones
    only under the legacy policy."""

    __tablename__ = "provider_approvals"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # "gemini", "openai", "convera", "ollama"; "*" = any configured provider.
    provider_id: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    data_class: Mapped[str] = mapped_column(String(20), nullable=False)
    purpose: Mapped[str] = mapped_column(Text, nullable=False)
    region: Mapped[str | None] = mapped_column(String(40), nullable=True)
    approved_by: Mapped[str] = mapped_column(String(64), nullable=False)
    approved_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc)
    )
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
