"""Schema & Label Designer API.

Library: ``/api/schemas`` — reading needs ``documents.view``; creating and
editing drafts ``fields.edit_draft``; publishing, deprecating and
archiving ``admin.integrations``. Schemas are scoped to the owner
workspace for anonymous workspace callers; built-in (system) schemas are
visible to everyone and read-only.

Documents: ``/api/documents/{id}/schema-…`` (mounted with document
isolation) — the review form a schema produces, previews of drafts, schema
assignment / migration, and Field Discovery.
"""

from __future__ import annotations

import json
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.downloads import attachment_header
from app.core.auth import ActorContext, require_permission
from app.core.document_access import workspace_scoped
from app.database.dependencies import get_database
from app.doc_schemas import service
from app.doc_schemas.definition import (
    FIELD_TYPES,
    Definition,
    DefinitionError,
    merge,
    parse_definition,
)
from app.doc_schemas.discovery import Discovery, discover
from app.doc_schemas.resolve import Form, build_form
from app.doc_schemas.system import ensure_system_schemas
from app.models.document import Document
from app.models.document_schema import DocumentSchema, DocumentSchemaAssignment, DocumentSchemaEvent, DocumentSchemaVersion
from app.staging.service import get_staging_workbook, pinned_profile

router = APIRouter()
documents_router = APIRouter()
MAX_IMPORT_BYTES = 2 * 1024 * 1024


class VersionSummary(BaseModel):
    id: int
    version: str
    status: str
    parent_version_id: int | None
    parent: str | None
    author: str
    created_at: datetime
    updated_at: datetime
    published_at: datetime | None
    published_by: str | None
    change_summary: str | None
    documents: int = 0


class SchemaSummary(BaseModel):
    id: int
    schema_key: str
    name: str
    category: str
    description: str | None
    is_system: bool
    profile_id: str | None
    family: str | None
    archived: bool
    latest: VersionSummary | None
    published: VersionSummary | None
    versions: int
    documents: int
    parent: str | None


class SchemaDetail(SchemaSummary):
    all_versions: list[VersionSummary]
    events: list[dict]


class VersionDetail(BaseModel):
    schema_id: int
    version: VersionSummary
    definition: Definition
    effective: Definition
    inherited_field_ids: list[str]
    problems: list[str]
    editable: bool


class CreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    category: str = Field(default="other", max_length=40)
    description: str | None = Field(default=None, max_length=2000)
    parent_version_id: int | None = None
    definition: dict | None = None


class SaveIn(BaseModel):
    definition: dict
    change_summary: str | None = Field(default=None, max_length=2000)
    name: str | None = Field(default=None, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    category: str | None = Field(default=None, max_length=40)


class DraftIn(BaseModel):
    major: bool = False


class NameIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class FormOut(BaseModel):
    document_id: str
    schema_id: int
    schema_name: str
    version_id: int
    version: str
    version_status: str
    assignment_kind: str
    newer_version: dict | None
    form: Form


class PreviewIn(BaseModel):
    definition: dict
    parent_version_id: int | None = None


class AssignIn(BaseModel):
    version_id: int
    note: str | None = Field(default=None, max_length=1000)


def _scoped(actor: ActorContext) -> bool:
    return workspace_scoped(actor)


def _schema_or_404(database: Session, schema_id: int, actor: ActorContext) -> DocumentSchema:
    schema = database.scalars(service.visible(
        select(DocumentSchema).where(DocumentSchema.id == schema_id), actor.workspace, _scoped(actor)
    )).first()
    if schema is None:
        raise HTTPException(status_code=404, detail="Schema not found.")
    return schema


def _version_or_404(database: Session, schema: DocumentSchema, version_id: int) -> DocumentSchemaVersion:
    version = database.get(DocumentSchemaVersion, version_id)
    if version is None or version.schema_id != schema.id:
        raise HTTPException(status_code=404, detail="Version not found.")
    return version


def _label(database: Session, version_id: int | None) -> str | None:
    if version_id is None:
        return None
    version = database.get(DocumentSchemaVersion, version_id)
    schema = database.get(DocumentSchema, version.schema_id) if version else None
    return f"{schema.name} {version.version}" if version and schema else None


def _version_summary(database: Session, version: DocumentSchemaVersion, usage: dict[int, int]) -> VersionSummary:
    return VersionSummary(
        id=version.id, version=version.version, status=version.status, parent_version_id=version.parent_version_id,
        parent=_label(database, version.parent_version_id), author=version.author, created_at=version.created_at,
        updated_at=version.updated_at, published_at=version.published_at, published_by=version.published_by,
        change_summary=version.change_summary, documents=usage.get(version.id, 0),
    )


def _summary(database: Session, schema: DocumentSchema) -> SchemaSummary:
    rows = service.versions(database, schema.id)
    usage = service.usage(database, schema.id)
    latest = rows[-1] if rows else None
    published = next((v for v in reversed(rows) if v.status == "published"), None)
    return SchemaSummary(
        id=schema.id, schema_key=schema.schema_key, name=schema.name, category=schema.category,
        description=schema.description, is_system=schema.is_system, profile_id=schema.profile_id, family=schema.family,
        archived=schema.archived_at is not None,
        latest=_version_summary(database, latest, usage) if latest else None,
        published=_version_summary(database, published, usage) if published else None,
        versions=len(rows), documents=sum(usage.values()),
        parent=_label(database, latest.parent_version_id) if latest else None,
    )


def _error(exc: Exception) -> HTTPException:
    return HTTPException(status_code=422, detail=str(exc))


# ---------------------------------------------------------------- library


@router.get("/field-types")
def field_types(actor: ActorContext = Depends(require_permission("documents.view"))) -> dict:
    return {
        "field_types": list(FIELD_TYPES),
        "group_kinds": ["section", "repeating", "object"],
        "rule_kinds": ["required", "pattern", "range", "allowed_values", "date_order", "sum_matches", "conditional_required"],
        "normalizations": ["none", "trim", "upper", "lower", "date_iso", "number"],
        "versioning": "major.minor; published versions are immutable; editing starts a new draft (minor, or major "
                      "when asked); publishing deprecates the previous published version; documents keep their "
                      "version until migrated.",
    }


@router.get("", response_model=list[SchemaSummary])
def list_schemas(
    q: str = "",
    category: str | None = None,
    status: str | None = None,
    include_archived: bool = False,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> list[SchemaSummary]:
    ensure_system_schemas(database)
    statement = select(DocumentSchema).order_by(DocumentSchema.is_system.desc(), DocumentSchema.name)
    if not include_archived:
        statement = statement.where(DocumentSchema.archived_at.is_(None))
    if category:
        statement = statement.where(DocumentSchema.category == category)
    if q.strip():
        like = f"%{q.strip()}%"
        statement = statement.where(DocumentSchema.name.ilike(like) | DocumentSchema.schema_key.ilike(like))
    items = [_summary(database, s) for s in database.scalars(service.visible(statement, actor.workspace, _scoped(actor)))]
    if status:
        items = [i for i in items if i.latest and i.latest.status == status
                 or (status == "published" and i.published is not None)]
    return items


@router.post("", response_model=SchemaDetail, status_code=201)
def create(
    payload: CreateIn,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("fields.edit_draft")),
) -> SchemaDetail:
    if payload.parent_version_id is not None:
        parent = database.get(DocumentSchemaVersion, payload.parent_version_id)
        if parent is None:
            raise HTTPException(status_code=404, detail="Parent version not found.")
        _schema_or_404(database, parent.schema_id, actor)
    try:
        schema, _version = service.create_schema(
            database, name=payload.name, category=payload.category, description=payload.description,
            actor_id=actor.id, actor=actor.display_name, workspace=actor.workspace if _scoped(actor) else None,
            parent_version_id=payload.parent_version_id, definition=payload.definition,
        )
    except service.SchemaError as exc:
        raise _error(exc) from exc
    return get_schema(schema.id, database, actor)


@router.get("/versions/{version_id}/effective", response_model=Definition)
def effective_by_version(
    version_id: int,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> Definition:
    """A version's effective definition (what a child schema inherits)."""

    version = database.get(DocumentSchemaVersion, version_id)
    if version is None:
        raise HTTPException(status_code=404, detail="Version not found.")
    _schema_or_404(database, version.schema_id, actor)
    try:
        return service.effective(database, version)
    except service.SchemaError as exc:
        raise _error(exc) from exc


@router.get("/{schema_id}", response_model=SchemaDetail)
def get_schema(
    schema_id: int,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> SchemaDetail:
    schema = _schema_or_404(database, schema_id, actor)
    usage = service.usage(database, schema.id)
    events = database.scalars(
        select(DocumentSchemaEvent).where(DocumentSchemaEvent.schema_id == schema.id)
        .order_by(DocumentSchemaEvent.id.desc()).limit(100)
    )
    return SchemaDetail(
        **_summary(database, schema).model_dump(),
        all_versions=[_version_summary(database, v, usage) for v in reversed(service.versions(database, schema.id))],
        events=[{"action": e.action, "actor": e.actor_name, "version_id": e.version_id, "detail": e.detail,
                 "at": e.created_at.isoformat()} for e in events],
    )


@router.get("/{schema_id}/versions/{version_id}", response_model=VersionDetail)
def get_version(
    schema_id: int,
    version_id: int,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> VersionDetail:
    schema = _schema_or_404(database, schema_id, actor)
    version = _version_or_404(database, schema, version_id)
    own = parse_definition(version.definition)
    try:
        effective = service.effective(database, version)
        problems = service.validate_version(database, version, own)
        inherited = []
        if version.parent_version_id is not None:
            parent = database.get(DocumentSchemaVersion, version.parent_version_id)
            from app.doc_schemas.definition import all_fields

            inherited = [f.field_id for _g, f in all_fields(service.effective(database, parent))]
    except service.SchemaError as exc:
        effective, problems, inherited = own, [str(exc)], []
    return VersionDetail(
        schema_id=schema.id, version=_version_summary(database, version, service.usage(database, schema.id)),
        definition=own, effective=effective, inherited_field_ids=inherited, problems=problems,
        editable=not schema.is_system and version.status == "draft" and schema.archived_at is None,
    )


@router.put("/{schema_id}/versions/{version_id}", response_model=VersionDetail)
def save(
    schema_id: int,
    version_id: int,
    payload: SaveIn,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("fields.edit_draft")),
) -> VersionDetail:
    schema = _schema_or_404(database, schema_id, actor)
    version = _version_or_404(database, schema, version_id)
    try:
        service.save_draft(database, schema, version, definition=payload.definition,
                           change_summary=payload.change_summary, actor_id=actor.id, actor=actor.display_name,
                           name=payload.name, description=payload.description, category=payload.category)
    except service.SchemaError as exc:
        raise _error(exc) from exc
    return get_version(schema_id, version_id, database, actor)


@router.post("/{schema_id}/drafts", response_model=VersionDetail)
def new_draft(
    schema_id: int,
    payload: DraftIn,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("fields.edit_draft")),
) -> VersionDetail:
    schema = _schema_or_404(database, schema_id, actor)
    try:
        draft = service.new_draft(database, schema, actor_id=actor.id, actor=actor.display_name, major=payload.major)
    except service.SchemaError as exc:
        raise _error(exc) from exc
    return get_version(schema_id, draft.id, database, actor)


def _transition(action: str):
    def handler(
        schema_id: int,
        version_id: int,
        database: Session = Depends(get_database),
        actor: ActorContext = Depends(require_permission(
            "admin.integrations" if action in ("publish", "deprecate") else "fields.edit_draft"
        )),
    ) -> VersionDetail:
        schema = _schema_or_404(database, schema_id, actor)
        version = _version_or_404(database, schema, version_id)
        try:
            service.transition(database, schema, version, action, actor_id=actor.id, actor=actor.display_name)
        except service.SchemaError as exc:
            raise _error(exc) from exc
        return get_version(schema_id, version_id, database, actor)

    return handler


for _action in ("submit", "withdraw", "publish", "deprecate"):
    router.add_api_route(f"/{{schema_id}}/versions/{{version_id}}/{_action}", _transition(_action),
                         methods=["POST"], response_model=VersionDetail, name=f"schema_{_action}")


@router.post("/{schema_id}/archive", response_model=SchemaDetail)
def archive(
    schema_id: int,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("admin.integrations")),
) -> SchemaDetail:
    schema = _schema_or_404(database, schema_id, actor)
    try:
        service.archive(database, schema, actor_id=actor.id, actor=actor.display_name)
    except service.SchemaError as exc:
        raise _error(exc) from exc
    return get_schema(schema_id, database, actor)


@router.post("/{schema_id}/duplicate", response_model=SchemaDetail, status_code=201)
def duplicate(
    schema_id: int,
    payload: NameIn,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("fields.edit_draft")),
) -> SchemaDetail:
    """A new, independent draft schema with this one's effective fields."""

    schema = _schema_or_404(database, schema_id, actor)
    source = service.latest(database, schema.id, published=True) or service.latest(database, schema.id)
    try:
        definition = service.effective(database, source).model_dump(mode="json")
        copy, _ = service.create_schema(
            database, name=payload.name, category=schema.category, description=schema.description,
            actor_id=actor.id, actor=actor.display_name, workspace=actor.workspace if _scoped(actor) else None,
            definition=definition, profile_id=schema.profile_id, family=schema.family, action="duplicate",
        )
    except service.SchemaError as exc:
        raise _error(exc) from exc
    return get_schema(copy.id, database, actor)


@router.post("/{schema_id}/extend", response_model=SchemaDetail, status_code=201)
def extend(
    schema_id: int,
    payload: NameIn,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("fields.edit_draft")),
) -> SchemaDetail:
    """A child schema inheriting this one's latest published version."""

    schema = _schema_or_404(database, schema_id, actor)
    parent = service.latest(database, schema.id, published=True)
    if parent is None:
        raise HTTPException(status_code=422, detail="Only a published schema can be extended.")
    return create(CreateIn(name=payload.name, category=schema.category, parent_version_id=parent.id), database, actor)


@router.get("/{schema_id}/versions/{version_id}/diff")
def version_diff(
    schema_id: int,
    version_id: int,
    against: int,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> dict:
    schema = _schema_or_404(database, schema_id, actor)
    new = _version_or_404(database, schema, version_id)
    old = database.get(DocumentSchemaVersion, against)
    if old is None:
        raise HTTPException(status_code=404, detail="Version not found.")
    _schema_or_404(database, old.schema_id, actor)
    return service.version_diff(database, old, new)


@router.get("/{schema_id}/versions/{version_id}/export")
def export(
    schema_id: int,
    version_id: int,
    flatten: bool = False,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> Response:
    schema = _schema_or_404(database, schema_id, actor)
    version = _version_or_404(database, schema, version_id)
    payload = service.export_payload(database, schema, version, flatten=flatten)
    name = f"{schema.schema_key.replace('.', '_')}_v{version.version}.json"
    return Response(content=json.dumps(payload, indent=2, ensure_ascii=False), media_type="application/json",
                    headers={"Content-Disposition": attachment_header(name)})


@router.post("/import", response_model=SchemaDetail, status_code=201)
def import_schema(
    payload: dict,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("fields.edit_draft")),
) -> SchemaDetail:
    if len(json.dumps(payload)) > MAX_IMPORT_BYTES:
        raise HTTPException(status_code=413, detail="Schema files are limited to 2 MB.")
    try:
        schema, _ = service.import_payload(database, payload, actor_id=actor.id, actor=actor.display_name,
                                           workspace=actor.workspace if _scoped(actor) else None,
                                           scoped=_scoped(actor))
    except (service.SchemaError, DefinitionError) as exc:
        raise _error(exc) from exc
    return get_schema(schema.id, database, actor)


# ---------------------------------------------------------------- documents


def _document(database: Session, document_id: str) -> Document:
    document = database.get(Document, document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found.")
    return document


def _workbook(database: Session, document_id: str):
    try:
        return get_staging_workbook(database, document_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@documents_router.get("/{document_id}/schema-form", response_model=FormOut)
def schema_form(
    document_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> FormOut:
    """The document's review form from its assigned schema version (the
    default schema for its type is assigned on first use and kept)."""

    document = _document(database, document_id)
    workbook = _workbook(database, document_id)
    current = service.assignment(database, document_id)
    if current is None:
        profile = pinned_profile(database, document)
        default = service.default_version(database, profile.profile_id, None)
        if default is None:
            raise HTTPException(status_code=404, detail="No schema available for this document.")
        current = service.assign(database, document_id, default, kind="automatic", actor="Dataomatix")
    version = database.get(DocumentSchemaVersion, current.schema_version_id)
    schema = database.get(DocumentSchema, version.schema_id)
    newest = service.latest(database, schema.id, published=True)
    newer = {"version_id": newest.id, "version": newest.version} if newest and newest.id != version.id else None
    return FormOut(
        document_id=document_id, schema_id=schema.id, schema_name=schema.name, version_id=version.id,
        version=version.version, version_status=version.status, assignment_kind=current.kind, newer_version=newer,
        form=build_form(workbook, service.effective(database, version)),
    )


@documents_router.post("/{document_id}/schema-form/preview", response_model=Form)
def preview_form(
    document_id: str,
    payload: PreviewIn,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> Form:
    """The form a (draft) definition would produce for this document."""

    workbook = _workbook(database, document_id)
    try:
        own = parse_definition(payload.definition)
    except DefinitionError as exc:
        raise _error(exc) from exc
    parent = None
    if payload.parent_version_id is not None:
        parent_version = database.get(DocumentSchemaVersion, payload.parent_version_id)
        if parent_version is None:
            raise HTTPException(status_code=404, detail="Parent version not found.")
        _schema_or_404(database, parent_version.schema_id, actor)
        parent = service.effective(database, parent_version)
    return build_form(workbook, merge(parent, own))


@documents_router.post("/{document_id}/schema-assignment", response_model=FormOut)
def assign_schema(
    document_id: str,
    payload: AssignIn,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("fields.edit_draft")),
) -> FormOut:
    """Moves the document to another published schema version (explicit
    migration). Extracted and approved values are untouched."""

    _document(database, document_id)
    version = database.get(DocumentSchemaVersion, payload.version_id)
    if version is None:
        raise HTTPException(status_code=404, detail="Version not found.")
    _schema_or_404(database, version.schema_id, actor)
    previous = service.assignment(database, document_id)
    try:
        service.assign(database, document_id, version, kind="migration" if previous else "manual",
                       actor=actor.display_name, note=payload.note)
    except service.SchemaError as exc:
        raise _error(exc) from exc
    return schema_form(document_id, database, actor)


@documents_router.get("/{document_id}/schema-assignment/diff")
def assignment_diff(
    document_id: str,
    version_id: int,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> dict:
    """What would change for this document moving to ``version_id``."""

    current = service.assignment(database, document_id)
    target = database.get(DocumentSchemaVersion, version_id)
    if target is None:
        raise HTTPException(status_code=404, detail="Version not found.")
    _schema_or_404(database, target.schema_id, actor)
    if current is None:
        return {"changes": [], "breaking": [], "mappings_to_review": [], "from": None, "to": target.version}
    old = database.get(DocumentSchemaVersion, current.schema_version_id)
    return service.version_diff(database, old, target)


@documents_router.post("/{document_id}/schema-discovery", response_model=Discovery)
def schema_discovery(
    document_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> Discovery:
    """A proposed schema from what this document contains, plus the fields
    its classified type normally has (marked as not found here)."""

    document = _document(database, document_id)
    workbook = _workbook(database, document_id)
    category = None
    profile = pinned_profile(database, document)
    if profile.profile_id != "generic_business_document":
        default = service.default_version(database, profile.profile_id, None)
        if default is not None:
            category = service.effective(database, default)
    return discover(workbook, category_definition=category)


@router.get("/{schema_id}/usage")
def schema_usage(
    schema_id: int,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> dict:
    schema = _schema_or_404(database, schema_id, actor)
    rows = database.execute(
        select(DocumentSchemaAssignment.document_id, DocumentSchemaVersion.version, DocumentSchemaAssignment.kind,
               DocumentSchemaAssignment.assigned_at)
        .join(DocumentSchemaVersion, DocumentSchemaVersion.id == DocumentSchemaAssignment.schema_version_id)
        .where(DocumentSchemaVersion.schema_id == schema.id, DocumentSchemaAssignment.is_current.is_(True))
        .order_by(DocumentSchemaAssignment.assigned_at.desc()).limit(200)
    ).all()
    total = database.scalar(
        select(func.count()).select_from(DocumentSchemaAssignment)
        .join(DocumentSchemaVersion, DocumentSchemaVersion.id == DocumentSchemaAssignment.schema_version_id)
        .where(DocumentSchemaVersion.schema_id == schema.id, DocumentSchemaAssignment.is_current.is_(True))
    )
    return {"documents": total or 0, "recent": [
        {"document_id": r[0], "version": r[1], "kind": r[2], "assigned_at": r[3].isoformat()} for r in rows
    ]}

