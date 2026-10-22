from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Float, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base


class ValidationRule(Base):
    """A workspace's own validation rule, or its override of a built-in
    template (same rule_id). The templates live in code
    (app.services.validation_rules.TEMPLATES, all disabled until enabled);
    only what a workspace added or changed is stored here. owner_workspace
    is None for callers with real credentials (one shared rule set)."""

    __tablename__ = "validation_rules"

    __table_args__ = (
        UniqueConstraint("owner_workspace", "rule_id", name="uq_validation_rule_workspace_rule"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    rule_id: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    owner_workspace: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    # "regex" | "required_field" | "funding_gap" | "max_amount" | "field_match"
    rule_type: Mapped[str] = mapped_column(String(30), nullable=False)
    # Field label(s) looked up in the staging workbook; "|" separates alternatives.
    field_label: Mapped[str | None] = mapped_column(String(300), nullable=True)
    # regex: the pattern; field_match: the second field label(s).
    pattern: Mapped[str | None] = mapped_column(String(300), nullable=True)
    # funding_gap / max_amount: dollars.
    threshold: Mapped[float | None] = mapped_column(Float, nullable=True)
    # "high" | "medium" | "low"
    severity: Mapped[str] = mapped_column(String(10), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
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
