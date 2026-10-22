from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base


class ClausePlaybookRule(Base):
    """A workspace's own clause playbook rule, or its override of a built-in
    default (same rule_id). The built-in defaults live in code
    (app.services.clause_playbook.DEFAULT_RULES); only what a workspace
    added or changed is stored here. owner_workspace is None for callers
    with real credentials (one shared playbook)."""

    __tablename__ = "clause_playbook_rules"

    __table_args__ = (
        UniqueConstraint("owner_workspace", "rule_id", name="uq_clause_playbook_rule_workspace_rule"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    rule_id: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    owner_workspace: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    clause_number: Mapped[str] = mapped_column(String(30), nullable=False)
    title: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    # "required" | "prohibited" | "review"
    expectation: Mapped[str] = mapped_column(String(20), nullable=False)
    # "high" | "medium" | "low"
    severity: Mapped[str] = mapped_column(String(10), nullable=False)
    rationale: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # "all" | "dod" (dod = the document lists any DFARS 252.* clause in a clause listing)
    applies_to: Mapped[str] = mapped_column(String(10), nullable=False, default="all")
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # Clause library fields. standard_text is only ever user-entered (or
    # copied from an ingested FAR record) — never generated regulation text.
    standard_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Corporate fallback / acceptable deviation language.
    fallback_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    # [{"kind": "regex" | "phrase", "pattern": str, "note": str}] matched
    # against page text when the clause is not among the cited clauses.
    extraction_patterns: Mapped[list | None] = mapped_column(JSON, nullable=True, default=list)
    category: Mapped[str | None] = mapped_column(String(120), nullable=True)
    # Issuing agency the rule is specific to ("Navy", "DLA"); empty = all.
    agency: Mapped[str | None] = mapped_column(String(80), nullable=True)
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
