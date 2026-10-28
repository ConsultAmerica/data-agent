"""The one way a document is deleted.

Deleting a document removes everything that belongs to it alone: its rows
in every table that references it — directly (document_id) or through one
of its own rows (a page's text blocks) — found from the schema's foreign
keys (audit logs deliberately have none, so its history is kept and a
deletion event is added), so new tables are covered without changes here; then, once the
database transaction has committed, its stored file, any files derived
from it (normalized images, converted Office files) and the remote storage
object. Child documents (portfolio members) are detached, not deleted.
Shared reference data is never touched.

Authorization: `documents.delete` deletes any document; `documents.delete_own`
(the anonymous workspace role) only documents its own workspace uploaded.
A document the caller may not reach is reported as not found.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from app.core.auth import ActorContext
from app.core.config import get_settings
from app.core.document_access import can_access_document
from app.database.base import Base
from app.core.observability import get_request_id
from app.models.document import Document
from app.models.metadata_field_audit_log import DOCUMENT_EVENT_FIELD_KEY, MetadataFieldAuditLog
from app.services.document_storage import delete_object

logger = logging.getLogger(__name__)


@dataclass
class DeletionResult:
    deleted: list[str] = field(default_factory=list)
    not_found: list[str] = field(default_factory=list)
    forbidden: list[str] = field(default_factory=list)
    rows_deleted: int = 0
    # Files/objects that could not be removed after the commit; the
    # document itself is gone either way.
    storage_errors: list[str] = field(default_factory=list)


def can_delete(actor: ActorContext, document: Document) -> bool:
    if actor.has("documents.delete"):
        return True
    return (
        actor.has("documents.delete_own")
        and document.owner_workspace is not None
        and can_access_document(actor, document)
        and document.owner_workspace == actor.workspace
    )


def _dependent_tables():
    """(table, fk column, parent table) for every table referencing
    documents directly or through a documents-owned table, children first."""

    documents = Base.metadata.tables["documents"]
    direct = []
    for table in Base.metadata.sorted_tables:
        if table is documents:
            continue
        for fk in table.foreign_keys:
            if fk.column.table is documents and fk.parent.name != "parent_document_id":
                direct.append((table, fk.parent))
    owned = {table for table, _ in direct}
    nested = []
    for table in Base.metadata.sorted_tables:
        for fk in table.foreign_keys:
            if fk.column.table in owned and table not in owned and table is not documents:
                nested.append((table, fk.parent, fk.column))
    return direct, nested


def delete_documents(database: Session, actor: ActorContext, document_ids: list[str]) -> DeletionResult:
    result = DeletionResult()
    targets: list[Document] = []
    for document_id in dict.fromkeys(str(i) for i in document_ids):
        document = database.get(Document, document_id)
        if document is None or (not actor.has("documents.delete") and not can_access_document(actor, document)):
            result.not_found.append(document_id)
        elif not can_delete(actor, document):
            result.forbidden.append(document_id)
        else:
            targets.append(document)
    if not targets:
        return result

    ids = [document.id for document in targets]
    files = [document.stored_filename for document in targets]
    direct, nested = _dependent_tables()
    try:
        # Portfolio members survive as standalone documents.
        database.execute(update(Document).where(Document.parent_document_id.in_(ids)).values(parent_document_id=None))
        for table, column, parent_column in nested:
            owner = next(c for t, c in direct if t is parent_column.table)
            parents = select(parent_column).where(owner.in_(ids))
            result.rows_deleted += database.execute(delete(table).where(column.in_(parents))).rowcount or 0
        for table, column in direct:
            result.rows_deleted += database.execute(delete(table).where(column.in_(ids))).rowcount or 0
        result.rows_deleted += database.execute(delete(Document).where(Document.id.in_(ids))).rowcount or 0
        # Audit logs have no FK to documents and are kept; record who
        # deleted each one (no filename — names can carry personal data).
        for document_id in ids:
            database.add(
                MetadataFieldAuditLog(
                    document_id=document_id,
                    field_key=DOCUMENT_EVENT_FIELD_KEY,
                    action="delete",
                    reason="Document deleted",
                    request_id=get_request_id(),
                    actor_id=actor.id,
                    actor_type=actor.actor_type,
                    actor_role=actor.role,
                    changed_by=actor.display_name,
                )
            )
        database.commit()
    except Exception:
        database.rollback()
        raise
    result.deleted = ids

    settings = get_settings()
    for stored_filename in files:
        stem = stored_filename.rsplit(".", 1)[0]
        for path in settings.upload_path.glob(f"{stem}.*"):
            try:
                path.unlink()
            except OSError as exc:
                result.storage_errors.append(f"{path.name}: {exc}")
        try:
            delete_object(settings, stored_filename)
        except Exception as exc:  # noqa: BLE001 - reported, the record is already gone
            result.storage_errors.append(f"{stored_filename}: {exc}")
    for document in targets:
        logger.info("document_deleted id=%s actor=%s", document.id, actor.id)
    return result
