from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, LargeBinary, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


class OracleTemplate(Base):
    """An Oracle Fusion import template as the user uploaded it. The file is
    kept byte for byte; the parsed columns (technical name, display label,
    order) are what exports are built from — never names Dataomatix made up.
    """

    __tablename__ = "oracle_templates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # The import object, e.g. "Contract", "Contract Line" (from the file or the uploader).
    object_name: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    # 1, 2, … per object and workspace; a re-upload of identical bytes reuses its row.
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    file_format: Mapped[str] = mapped_column(String(10), nullable=False)  # csv | xlsx | xlsm
    original_bytes: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    checksum_sha256: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    sheet_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    # 0-based rows in the file (or sheet) holding the technical names / display labels.
    technical_row: Mapped[int] = mapped_column(Integer, nullable=False)
    label_row: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # [{"position", "technical_name", "display_label", "required"}] in file order.
    columns: Mapped[list] = mapped_column(JSON, nullable=False)
    warnings: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    environment: Mapped[str | None] = mapped_column(String(120), nullable=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active")  # active | retired
    owner_workspace: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    uploaded_by: Mapped[str] = mapped_column(String(120), nullable=False)
    uploaded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_now)
    # Where the target sits in Oracle Fusion (oracle_templates/catalog.py):
    # application, integration method, release, object code, parent object,
    # user keys, the metadata's source, and whether an administrator
    # verified it. None for templates uploaded before the catalog existed
    # (read as an unverified uploaded template).
    catalog: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class OracleMappingProfile(Base):
    """How one template's columns are filled from a document type's
    extracted fields. Mappings name fields by reference (dataset + field,
    or a label/value row by its stable id), never by value, so one profile
    serves every document of that type."""

    __tablename__ = "oracle_mapping_profiles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    template_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("oracle_templates.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    # The staging profile the field references belong to (e.g. contract_v3).
    staging_profile_id: Mapped[str | None] = mapped_column(String(80), nullable=True, index=True)
    # The repeating dataset giving one output row per record; None = one row.
    row_dataset: Mapped[str | None] = mapped_column(String(120), nullable=True)
    # [{"column", "source": {...}, "transform", "method", "confidence"}]
    mappings: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    # Template columns that identify a row (checked for blanks and duplicates).
    key_columns: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    # {"profile_id": int, "links": [[child_column, parent_column], …]}
    parent: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    # [{"version", "actor", "at"}] — one entry per save.
    history: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    owner_workspace: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    updated_by: Mapped[str] = mapped_column(String(120), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_now)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    # draft | active | archived. Saving an active profile makes a new draft
    # version: an approval never carries over to changed mappings.
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft", index=True)
    created_by: Mapped[str | None] = mapped_column(String(120), nullable=True)
    approved_by: Mapped[str | None] = mapped_column(String(120), nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # The document type it was made for, as shown ("Contract").
    source_document_type: Mapped[str | None] = mapped_column(String(120), nullable=True)


class OracleMappingAuditEvent(Base):
    """Append-only history of mapping profiles and of the target catalog:
    who created, changed, approved, archived or registered what, and when.
    A profile event names the profile version it produced."""

    __tablename__ = "oracle_mapping_audit_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # No foreign keys: the history outlives what it describes.
    profile_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    template_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    profile_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # created | saved | duplicated | activated | archived | reverted_to_draft |
    # catalog_updated | verified | attributes_registered | discovered
    action: Mapped[str] = mapped_column(String(40), nullable=False)
    actor_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    actor_name: Mapped[str] = mapped_column(String(120), nullable=False)
    owner_workspace: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    detail: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_now, index=True)
