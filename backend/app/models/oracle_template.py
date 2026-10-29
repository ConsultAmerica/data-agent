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
