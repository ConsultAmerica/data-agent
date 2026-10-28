from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base


class Document(Base):
    __tablename__ = "documents"

    id: Mapped[str] = mapped_column(
        String(36),
        primary_key=True,
    )

    original_filename: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
    )

    stored_filename: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
        unique=True,
    )

    content_type: Mapped[str] = mapped_column(
        String(100),
        nullable=False,
        default="application/pdf",
    )

    size_bytes: Mapped[int] = mapped_column(
        BigInteger,
        nullable=False,
    )

    checksum_sha256: Mapped[str] = mapped_column(
        String(64),
        nullable=False,
        index=True,
    )

    page_count: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
    )

    encrypted: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False,
    )

    status: Mapped[str] = mapped_column(
        String(30),
        nullable=False,
        default="uploaded",
    )

    processing_status: Mapped[str] = mapped_column(
        String(30),
        nullable=False,
        default="not_processed",
    )

    processed_page_count: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=0,
    )

    ocr_required_page_count: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=0,
    )

    ocr_completed_page_count: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=0,
    )

    uploaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )

    # Classification (Step 4).
    document_type: Mapped[str | None] = mapped_column(
        String(60),
        nullable=True,
    )

    industry: Mapped[str | None] = mapped_column(
        String(60),
        nullable=True,
    )

    contract_side: Mapped[str | None] = mapped_column(
        String(20),
        nullable=True,
    )

    document_language: Mapped[str | None] = mapped_column(
        String(40),
        nullable=True,
    )

    classification_confidence: Mapped[float | None] = mapped_column(
        Float,
        nullable=True,
    )

    # Computed (not AI-classified) — derived from document_type and the
    # confirmed parent relationship. See services/document_status.py.
    document_status: Mapped[str | None] = mapped_column(
        String(30),
        nullable=True,
    )

    # Parent/child relationship (Step 3).
    parent_document_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("documents.id"),
        nullable=True,
    )

    parent_relationship_type: Mapped[str | None] = mapped_column(
        String(30),
        nullable=True,
    )

    parent_relationship_confidence: Mapped[float | None] = mapped_column(
        Float,
        nullable=True,
    )

    parent_relationship_matched_on: Mapped[str | None] = mapped_column(
        String(20),
        nullable=True,
    )

    parent_relationship_status: Mapped[str | None] = mapped_column(
        String(20),
        nullable=True,
    )

    parent_relationship_reasons: Mapped[list | None] = mapped_column(
        JSON,
        nullable=True,
    )

    parent_relationship_detection_method: Mapped[
        str | None
    ] = mapped_column(
        String(20),
        nullable=True,
    )

    # Dashboard stats (Step 16).
    processing_duration_seconds: Mapped[float | None] = mapped_column(
        Float,
        nullable=True,
    )

    # Approval gate (review workspace pipeline).
    approved_by: Mapped[str | None] = mapped_column(
        String(120),
        nullable=True,
    )

    approved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )

    # Hash of the uploading browser workspace's secret token
    # (core/document_access.py). Anonymous workspace callers may only reach
    # documents they own; NULL (documents from before isolation) is
    # reachable by real credentials (admins) only.
    owner_workspace: Mapped[str | None] = mapped_column(
        String(64),
        nullable=True,
        index=True,
    )

    # Sensitivity class (public | internal | confidential | restricted —
    # docs/di-01-document-taxonomy.md §4). Set from the resolved staging
    # profile unless a person set it ("user"); NULL = not yet classified,
    # treated as confidential. Decides whether any external provider may
    # see the document (app/recognition/policy.py).
    data_class: Mapped[str | None] = mapped_column(
        String(20),
        nullable=True,
    )
    data_class_source: Mapped[str | None] = mapped_column(
        String(20),
        nullable=True,
    )

    # Repository promotion — deliberately separate from Approve; see
    # services/document_status.py's compute_repository_status.
    promoted_by: Mapped[str | None] = mapped_column(
        String(120),
        nullable=True,
    )

    promoted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )

    # Schema prep only — not read or written anywhere yet. Exists so a
    # future auth/tenant model doesn't require a second migration on
    # top of this one. Do not add logic against these until a real
    # organization/user model exists.
    organization_id: Mapped[str | None] = mapped_column(
        String(36),
        nullable=True,
    )

    owner_id: Mapped[str | None] = mapped_column(
        String(36),
        nullable=True,
    )

    # Universal Document Ingestion RC — adapter / OCR / conversion trail.
    ingestion_provenance: Mapped[dict | None] = mapped_column(
        JSON,
        nullable=True,
    )
