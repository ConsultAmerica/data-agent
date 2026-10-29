from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


class DocumentSchema(Base):
    """A named extraction schema (Schema & Label Designer). System schemas
    mirror the built-in staging profiles and can't be edited; user schemas
    are edited as versioned drafts (``DocumentSchemaVersion``)."""

    __tablename__ = "document_schemas"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # Stable identifier, e.g. "government_contract", "acme_service_order".
    schema_key: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    category: Mapped[str] = mapped_column(String(40), nullable=False, default="other")
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # The staging profile whose extraction a system schema describes / a
    # user schema is applied over (e.g. contract_v3); None = any.
    profile_id: Mapped[str | None] = mapped_column(String(80), nullable=True, index=True)
    # Document family this schema is the default for (system schemas).
    family: Mapped[str | None] = mapped_column(String(80), nullable=True)
    is_system: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    owner_workspace: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    created_by: Mapped[str] = mapped_column(String(120), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_now)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class DocumentSchemaVersion(Base):
    """One version of a schema. A published version never changes; editing
    it starts a new draft. ``definition`` holds this version's own groups,
    fields, rules and (for a child schema) its overrides of the parent."""

    __tablename__ = "document_schema_versions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    schema_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("document_schemas.id", ondelete="CASCADE"), nullable=False, index=True
    )
    version: Mapped[str] = mapped_column(String(20), nullable=False)  # "1.0", "1.1", "2.0"
    # draft | in_review | published | deprecated | archived
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft")
    # The exact parent version this one inherits from (pinned), if any.
    parent_version_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("document_schema_versions.id"), nullable=True
    )
    definition: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    change_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    author: Mapped[str] = mapped_column(String(120), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_now)
    submitted_by: Mapped[str | None] = mapped_column(String(120), nullable=True)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    published_by: Mapped[str | None] = mapped_column(String(120), nullable=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    effective_date: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class DocumentSchemaEvent(Base):
    """Audit trail of schema changes (create, edit, submit, publish …)."""

    __tablename__ = "document_schema_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    schema_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    version_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    action: Mapped[str] = mapped_column(String(30), nullable=False)
    actor_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    actor_name: Mapped[str] = mapped_column(String(120), nullable=False)
    detail: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_now)


class DocumentSchemaAssignment(Base):
    """Which schema version a document is reviewed with. A document keeps
    its version until someone explicitly migrates it to another."""

    __tablename__ = "document_schema_assignments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    document_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    schema_version_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("document_schema_versions.id"), nullable=False, index=True
    )
    kind: Mapped[str] = mapped_column(String(20), nullable=False)  # automatic | manual | migration
    is_current: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    assigned_by: Mapped[str] = mapped_column(String(120), nullable=False)
    assigned_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_now)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
