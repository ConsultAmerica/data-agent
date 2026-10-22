"""Batch validation rules API.

``router`` (mounted at /api/validation-rules): the effective rules, rule
edits, a live preview of an unsaved rule and portfolio failures.
``document_router`` (mounted at /api/documents behind
enforce_document_access): one document's results.

Rules are scoped like the clause playbook: a credential-less workspace
caller edits its own rules; callers with real credentials share one set.
"""

from __future__ import annotations

import re
from uuid import uuid4

from fastapi import APIRouter, Body, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import ActorContext, get_current_actor, require_any_permission
from app.core.document_access import require_document_access, scope_documents, workspace_scoped
from app.database.dependencies import get_database
from app.models.document import Document
from app.models.document_staging_workbook import DocumentStagingWorkbook
from app.models.validation_rule import ValidationRule
from app.services.validation_rules import (
    RuleError,
    effective_rules,
    evaluate_document,
    find_stored_rule,
    portfolio,
    preview_rule,
    template,
    validate_rule_payload,
)

router = APIRouter()
document_router = APIRouter()

_can_edit = require_any_permission("review.edit", "admin.integrations")
_RULE_FIELDS = ("name", "rule_type", "field_label", "pattern", "threshold", "severity", "enabled", "description")


def _workspace(actor: ActorContext) -> str | None:
    return actor.workspace if workspace_scoped(actor) else None


def _writable_workspace(actor: ActorContext) -> str | None:
    if workspace_scoped(actor) and actor.workspace is None:
        # Without a workspace token the edit would land in the shared rule set.
        raise HTTPException(status.HTTP_403_FORBIDDEN, "A workspace is required to edit validation rules.")
    return _workspace(actor)


def _rule_response(database: Session, workspace: str | None, rule_id: str) -> dict:
    rule = next((item for item in effective_rules(database, workspace) if item["rule_id"] == rule_id), None)
    if rule is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Rule not found.")
    return rule


def _validated(payload: dict) -> dict:
    try:
        return validate_rule_payload(payload)
    except RuleError as error:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(error)) from error


@router.get("/rules")
def list_rules(
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(get_current_actor),
) -> list[dict]:
    return effective_rules(database, _workspace(actor))


@router.post("/rules", status_code=status.HTTP_201_CREATED)
def create_rule(
    payload: dict = Body(...),
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(_can_edit),
) -> dict:
    workspace = _writable_workspace(actor)
    fields = _validated(payload)
    slug = re.sub(r"[^0-9a-z]+", "-", fields["name"].lower()).strip("-")[:40] or "rule"
    rule_id = f"custom:{slug}:{uuid4().hex[:8]}"
    database.add(ValidationRule(rule_id=rule_id, owner_workspace=workspace, **fields))
    database.commit()
    return _rule_response(database, workspace, rule_id)


@router.post("/rules/test")
def test_unsaved_rule(
    payload: dict = Body(...),
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(get_current_actor),
) -> dict:
    """Evaluate a rule against one document without saving it. Body: the
    rule's fields plus document_id."""

    document_id = str(payload.get("document_id") or "")
    if not document_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Choose a document to test against.")
    if require_document_access(database, actor, document_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Document not found.")
    try:
        return preview_rule(database, document_id, {**payload, "enabled": True})
    except RuleError as error:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(error)) from error


@router.put("/rules/{rule_id}")
def update_rule(
    rule_id: str,
    payload: dict = Body(...),
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(_can_edit),
) -> dict:
    """Edit a custom rule, or override a template (stored under the
    template's rule_id so DELETE/reset restores it)."""

    workspace = _writable_workspace(actor)
    stored = find_stored_rule(database, workspace, rule_id)
    base = template(rule_id)
    if stored is None and base is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Rule not found.")
    source = stored if stored is not None else base
    current = {key: getattr(source, key) for key in _RULE_FIELDS}
    fields = _validated({**current, **{key: value for key, value in payload.items() if value is not None}})
    if stored is None:
        database.add(ValidationRule(rule_id=rule_id, owner_workspace=workspace, **fields))
    else:
        for key, value in fields.items():
            setattr(stored, key, value)
    database.commit()
    return _rule_response(database, workspace, rule_id)


@router.delete("/rules/{rule_id}")
def delete_rule(
    rule_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(_can_edit),
) -> dict:
    """Removes a custom rule, or drops a template override so the (disabled)
    template applies again."""

    workspace = _writable_workspace(actor)
    stored = find_stored_rule(database, workspace, rule_id)
    if stored is None:
        if template(rule_id) is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Built-in templates cannot be deleted; disable them instead.",
            )
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Rule not found.")
    database.delete(stored)
    database.commit()
    return {"rule_id": rule_id, "restored_template": template(rule_id) is not None}


@router.post("/rules/{rule_id}/reset")
def reset_rule(
    rule_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(_can_edit),
) -> dict:
    workspace = _writable_workspace(actor)
    if template(rule_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Only built-in templates can be reset.")
    stored = find_stored_rule(database, workspace, rule_id)
    if stored is not None:
        database.delete(stored)
        database.commit()
    return _rule_response(database, workspace, rule_id)


# Plain functions from here: evaluation loads staging workbooks, so FastAPI
# runs them in the thread pool instead of blocking the event loop.
@router.get("/portfolio")
def validation_portfolio(
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(get_current_actor),
) -> dict:
    """Failures for every visible staged document."""

    visible = scope_documents(select(Document.id), actor)
    staged = select(DocumentStagingWorkbook.document_id).where(DocumentStagingWorkbook.document_id.in_(visible))
    documents = list(
        database.execute(
            select(Document.id, Document.original_filename, Document.document_type, Document.uploaded_at)
            .where(Document.id.in_(staged))
            .order_by(Document.uploaded_at.desc())
        )
    )
    return portfolio(database, documents, _workspace(actor))


@document_router.get("/{document_id}/validation")
def document_validation(
    document_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(get_current_actor),
) -> dict:
    document = require_document_access(database, actor, document_id)
    if document is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Document not found.")
    return evaluate_document(database, document_id, _workspace(actor))
