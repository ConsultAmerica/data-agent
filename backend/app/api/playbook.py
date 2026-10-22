"""Clause playbook API.

``router`` (mounted at /api/playbook): the effective rules, rule edits,
portfolio deviations, the team's saved queries, and verbatim clause text
from ingested FAR / DFARS regulation records (never generated). ``document_router`` (mounted at /api/documents behind
enforce_document_access): one document's evaluation.

Rules are scoped like documents: a credential-less workspace caller edits
its own playbook; callers with real credentials share one playbook.
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
from app.models.clause_playbook_rule import ClausePlaybookRule
from app.models.document import Document
from app.models.document_clause_reference import DocumentClauseReference
from app.models.document_contract_structure import DocumentContractStructure
from app.models.playbook_saved_query import PlaybookSavedQuery
from app.services.clause_playbook import (
    default_rule,
    effective_rules,
    evaluate_document,
    find_stored_rule,
    ingested_clause_index,
    ingested_clause_texts,
    normalize_clause_number,
    rule_fields,
    validate_rule_payload,
)

router = APIRouter()
document_router = APIRouter()

_can_edit = require_any_permission("review.edit", "admin.integrations")


def _workspace(actor: ActorContext) -> str | None:
    return actor.workspace if workspace_scoped(actor) else None


def _writable_workspace(actor: ActorContext) -> str | None:
    if workspace_scoped(actor) and actor.workspace is None:
        # Without a workspace token the edit would land in the shared playbook.
        raise HTTPException(status.HTTP_403_FORBIDDEN, "A workspace is required to edit the playbook.")
    return _workspace(actor)


def _rule_response(database: Session, workspace: str | None, rule_id: str) -> dict:
    rule = next((item for item in effective_rules(database, workspace) if item["rule_id"] == rule_id), None)
    if rule is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Rule not found.")
    return rule


def _validated(payload: dict) -> dict:
    try:
        return validate_rule_payload(payload)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error


@router.get("/rules")
async def list_rules(
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(get_current_actor),
) -> list[dict]:
    return effective_rules(database, _workspace(actor))


@router.post("/rules", status_code=status.HTTP_201_CREATED)
async def create_rule(
    payload: dict = Body(...),
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(_can_edit),
) -> dict:
    workspace = _writable_workspace(actor)
    fields = _validated(payload)
    slug = re.sub(r"[^0-9a-z.-]+", "-", fields["clause_number"].lower())
    rule_id = f"custom:{slug}:{uuid4().hex[:8]}"
    database.add(ClausePlaybookRule(rule_id=rule_id, owner_workspace=workspace, **fields))
    database.commit()
    return _rule_response(database, workspace, rule_id)


@router.put("/rules/{rule_id}")
async def update_rule(
    rule_id: str,
    payload: dict = Body(...),
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(_can_edit),
) -> dict:
    """Edit a custom rule, or override a default (stored under the default's
    rule_id so DELETE/reset restores it)."""

    workspace = _writable_workspace(actor)
    stored = find_stored_rule(database, workspace, rule_id)
    base = default_rule(rule_id)
    if stored is None and base is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Rule not found.")
    current = rule_fields(stored if stored is not None else base)
    fields = _validated({**current, **{key: value for key, value in payload.items() if value is not None}})
    if stored is None:
        database.add(ClausePlaybookRule(rule_id=rule_id, owner_workspace=workspace, **fields))
    else:
        for key, value in fields.items():
            setattr(stored, key, value)
    database.commit()
    return _rule_response(database, workspace, rule_id)


@router.delete("/rules/{rule_id}")
async def delete_rule(
    rule_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(_can_edit),
) -> dict:
    """Removes a custom rule, or drops an override so the default applies
    again. A default with no override can only be disabled (PUT enabled=false)."""

    workspace = _writable_workspace(actor)
    stored = find_stored_rule(database, workspace, rule_id)
    if stored is None:
        if default_rule(rule_id) is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Built-in rules cannot be deleted; disable them instead.",
            )
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Rule not found.")
    database.delete(stored)
    database.commit()
    return {"rule_id": rule_id, "restored_default": default_rule(rule_id) is not None}


@router.post("/rules/{rule_id}/reset")
async def reset_rule(
    rule_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(_can_edit),
) -> dict:
    workspace = _writable_workspace(actor)
    if default_rule(rule_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Only built-in rules can be reset.")
    stored = find_stored_rule(database, workspace, rule_id)
    if stored is not None:
        database.delete(stored)
        database.commit()
    return _rule_response(database, workspace, rule_id)


@router.get("/rules/{rule_id}/standard-text")
async def rule_standard_text(
    rule_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(get_current_actor),
) -> dict:
    """The rule's clause verbatim from ingested FAR / DFARS records the
    caller can see (newest version first), plus any text the team entered
    on the rule. ``ingested`` is null when nothing is ingested."""

    rule = _rule_response(database, _workspace(actor), rule_id)
    records = ingested_clause_texts(database, rule["clause_number"], scope_documents(select(Document.id), actor))
    return {
        "rule_id": rule_id,
        "clause_number": rule["clause_number"],
        "ingested": records[0] if records else None,
        "versions": [{key: value for key, value in record.items() if key != "source_text"} for record in records],
        "custom_text": rule["standard_text"] or None,
    }


@router.get("/far-clauses")
async def list_ingested_clauses(
    q: str | None = None,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(get_current_actor),
) -> list[dict]:
    """Clause numbers with verbatim text on file (from ingested FAR / DFARS
    regulation sources), with their version dates."""

    index = ingested_clause_index(database, scope_documents(select(Document.id), actor))
    needle = (q or "").strip().lower()
    if needle:
        index = [entry for entry in index if needle in f"{entry['clause_number']} {entry['title']}".lower()]
    return index


@router.get("/far-clauses/{clause_number}/texts")
async def ingested_clause_versions(
    clause_number: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(get_current_actor),
) -> dict:
    number = normalize_clause_number(clause_number)
    if not number:
        raise HTTPException(422, "clause_number must be a clause number such as 52.212-4 or 252.204-7012.")
    records = ingested_clause_texts(database, number, scope_documents(select(Document.id), actor))
    return {"clause_number": number, "records": records}


@router.get("/portfolio")
async def playbook_portfolio(
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(get_current_actor),
) -> dict:
    """Deviations for every visible document that cites clauses."""

    visible = scope_documents(select(Document.id), actor)
    with_clauses = set(
        database.scalars(
            select(DocumentClauseReference.document_id).where(DocumentClauseReference.document_id.in_(visible)).distinct()
        )
    ) | set(
        database.scalars(
            select(DocumentContractStructure.document_id).where(DocumentContractStructure.document_id.in_(visible))
        )
    )
    documents = list(
        database.execute(
            select(Document.id, Document.original_filename, Document.document_type, Document.uploaded_at)
            .where(Document.id.in_(with_clauses))
            .order_by(Document.uploaded_at.desc())
        )
    )
    workspace = _workspace(actor)
    rows: list[dict] = []
    totals = {"documents": 0, "with_deviations": 0, "high": 0, "medium": 0, "low": 0}
    for document in documents:
        result = evaluate_document(database, document.id, workspace)
        if not result["applicable"]:
            continue
        summary = result["summary"]
        totals["documents"] += 1
        totals["with_deviations"] += 1 if summary["deviations"] else 0
        for level in ("high", "medium", "low"):
            totals[level] += summary[level]
        rows.append(
            {
                "document_id": document.id,
                "filename": document.original_filename,
                "document_type": document.document_type,
                "is_dod": result["is_dod"],
                "summary": summary,
                "findings": [item for item in result["findings"] if item["status"] != "satisfied"],
            }
        )
    rows.sort(key=lambda row: (-row["summary"]["high"], -row["summary"]["deviations"], row["filename"] or ""))
    return {"totals": totals, "documents": rows}


# Saved queries: prompts and extraction criteria a team keeps in its
# playbook so every reviewer asks the same question the same way.

SAVED_QUERY_KINDS = ("ask", "clause_search", "extraction")


def _saved_query_dict(row: PlaybookSavedQuery) -> dict:
    return {
        "id": row.id,
        "name": row.name,
        "kind": row.kind,
        "query": row.query,
        "description": row.description,
        "created_by": row.created_by,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


def _owned_by(workspace: str | None):
    column = PlaybookSavedQuery.owner_workspace
    return column.is_(None) if workspace is None else column == workspace


def _validated_saved_query(payload: dict) -> dict:
    name = " ".join(str(payload.get("name") or "").split())
    query = str(payload.get("query") or "").strip()
    kind = payload.get("kind")
    description = str(payload.get("description") or "").strip()
    if not name or len(name) > 120:
        raise HTTPException(422, "A name of 1–120 characters is required.")
    if not query or len(query) > 2000:
        raise HTTPException(422, "A query of 1–2000 characters is required.")
    if kind not in SAVED_QUERY_KINDS:
        raise HTTPException(422, f"kind must be one of: {', '.join(SAVED_QUERY_KINDS)}.")
    if len(description) > 1000:
        raise HTTPException(422, "The description is limited to 1000 characters.")
    return {"name": name, "query": query, "kind": kind, "description": description}


def _find_saved_query(database: Session, workspace: str | None, query_id: str) -> PlaybookSavedQuery:
    row = database.scalar(
        select(PlaybookSavedQuery).where(PlaybookSavedQuery.id == query_id, _owned_by(workspace))
    )
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Saved query not found.")
    return row


@router.get("/saved-queries")
async def list_saved_queries(
    kind: str | None = None,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(get_current_actor),
) -> list[dict]:
    statement = select(PlaybookSavedQuery).where(_owned_by(_workspace(actor)))
    if kind:
        statement = statement.where(PlaybookSavedQuery.kind == kind)
    rows = database.scalars(statement.order_by(PlaybookSavedQuery.name))
    return [_saved_query_dict(row) for row in rows]


@router.post("/saved-queries", status_code=status.HTTP_201_CREATED)
async def create_saved_query(
    payload: dict = Body(...),
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(_can_edit),
) -> dict:
    workspace = _writable_workspace(actor)
    row = PlaybookSavedQuery(
        id=str(uuid4()),
        owner_workspace=workspace,
        created_by=actor.display_name or "",
        **_validated_saved_query(payload),
    )
    database.add(row)
    database.commit()
    return _saved_query_dict(row)


@router.put("/saved-queries/{query_id}")
async def update_saved_query(
    query_id: str,
    payload: dict = Body(...),
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(_can_edit),
) -> dict:
    row = _find_saved_query(database, _writable_workspace(actor), query_id)
    current = {"name": row.name, "query": row.query, "kind": row.kind, "description": row.description}
    fields = _validated_saved_query({**current, **{key: value for key, value in payload.items() if value is not None}})
    for key, value in fields.items():
        setattr(row, key, value)
    database.commit()
    return _saved_query_dict(row)


@router.delete("/saved-queries/{query_id}")
async def delete_saved_query(
    query_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(_can_edit),
) -> dict:
    row = _find_saved_query(database, _writable_workspace(actor), query_id)
    database.delete(row)
    database.commit()
    return {"id": query_id, "deleted": True}


@document_router.get("/{document_id}/playbook")
async def document_playbook(
    document_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(get_current_actor),
) -> dict:
    document = require_document_access(database, actor, document_id)
    if document is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Document not found.")
    return evaluate_document(database, document_id, _workspace(actor))
