"""Schema library: versions, workflow, inheritance, assignments, import /
export and audit.

Versioning policy (documented for users in the designer):

* ``major.minor``. A schema's first version is 1.0.
* Only a **draft** can be edited. Submitting makes it **in review**;
  publishing (``admin.integrations``) makes it **published** and immutable.
* Editing a published schema starts a new draft: next minor (1.0 → 1.1),
  or next major (→ 2.0) when asked, e.g. for removed fields.
* Publishing a new version deprecates the previous published one.
* A child schema pins the exact parent version it inherits from, so a
  parent's later versions never change a published child.
* A document keeps the version it was assigned until someone migrates it.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.doc_schemas.definition import Definition, DefinitionError, check, diff, merge, parse_definition
from app.models.document_schema import (
    DocumentSchema,
    DocumentSchemaAssignment,
    DocumentSchemaEvent,
    DocumentSchemaVersion,
)
from app.models.oracle_template import OracleMappingProfile

EXPORT_FORMAT = "dataomatix.schema/1"
_KEY = re.compile(r"^[a-z][a-z0-9_.]{1,119}$")
MAX_INHERITANCE = 8


class SchemaError(ValueError):
    """Not possible; the message says why."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def event(database: Session, schema: DocumentSchema, action: str, actor_id: str | None, actor: str,
          version: DocumentSchemaVersion | None = None, detail: dict | None = None) -> None:
    database.add(DocumentSchemaEvent(schema_id=schema.id, version_id=version.id if version else None, action=action,
                                     actor_id=actor_id, actor_name=actor, detail=detail))


def visible(statement, workspace: str | None, scoped: bool):
    if not scoped:
        return statement
    return statement.where(
        (DocumentSchema.is_system.is_(True)) | (DocumentSchema.owner_workspace == workspace if workspace else False)
    )


def versions(database: Session, schema_id: int) -> list[DocumentSchemaVersion]:
    return list(database.scalars(
        select(DocumentSchemaVersion).where(DocumentSchemaVersion.schema_id == schema_id)
        .order_by(DocumentSchemaVersion.id)
    ))


def latest(database: Session, schema_id: int, *, published: bool = False) -> DocumentSchemaVersion | None:
    rows = [v for v in versions(database, schema_id) if not published or v.status == "published"]
    return rows[-1] if rows else None


def _bump(version: str, major: bool) -> str:
    try:
        a, b = (int(x) for x in version.split(".", 1))
    except ValueError:
        a, b = 1, 0
    return f"{a + 1}.0" if major else f"{a}.{b + 1}"


def ancestry(database: Session, version: DocumentSchemaVersion) -> list[DocumentSchemaVersion]:
    """[root … parent] of a version; raises on a cycle."""

    chain: list[DocumentSchemaVersion] = []
    seen = {version.id}
    current = version
    while current.parent_version_id is not None:
        if current.parent_version_id in seen or len(chain) >= MAX_INHERITANCE:
            raise SchemaError("Circular or too deep inheritance.")
        seen.add(current.parent_version_id)
        parent = database.get(DocumentSchemaVersion, current.parent_version_id)
        if parent is None:
            raise SchemaError("The parent schema version no longer exists.")
        chain.insert(0, parent)
        current = parent
    return chain


def effective(database: Session, version: DocumentSchemaVersion) -> Definition:
    definition: Definition | None = None
    for item in [*ancestry(database, version), version]:
        definition = merge(definition, parse_definition(item.definition))
    return definition or Definition()


def validate_version(database: Session, version: DocumentSchemaVersion, own: Definition) -> list[str]:
    parent = None
    if version.parent_version_id is not None:
        parent_version = database.get(DocumentSchemaVersion, version.parent_version_id)
        if parent_version is None:
            return ["The parent schema version no longer exists."]
        parent = effective(database, parent_version)
    problems = check(own, inherited=parent) if parent is not None else []
    return problems + check(merge(parent, own))


def create_schema(database: Session, *, name: str, category: str, description: str | None, actor_id: str | None,
                  actor: str, workspace: str | None, parent_version_id: int | None = None,
                  definition: dict | None = None, schema_key: str | None = None, profile_id: str | None = None,
                  family: str | None = None, action: str = "create") -> tuple[DocumentSchema, DocumentSchemaVersion]:
    key = schema_key or re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")[:100] or "schema"
    if not _KEY.fullmatch(key) or key.startswith("system."):
        raise SchemaError("Schema keys are lower-case letters, digits, '_' or '.', and can't start with 'system.'.")
    taken = database.scalar(select(func.count()).select_from(DocumentSchema).where(
        DocumentSchema.schema_key == key, DocumentSchema.owner_workspace.is_(workspace) if workspace is None
        else DocumentSchema.owner_workspace == workspace))
    if taken:
        key = f"{key}_{_now().strftime('%H%M%S')}"
    if parent_version_id is not None:
        parent = database.get(DocumentSchemaVersion, parent_version_id)
        if parent is None or parent.status not in ("published", "deprecated"):
            raise SchemaError("A schema can only inherit from a published version.")
        parent_schema = database.get(DocumentSchema, parent.schema_id)
        profile_id = profile_id or (parent_schema.profile_id if parent_schema else None)
        family = family or (parent_schema.family if parent_schema else None)
    try:
        own = parse_definition(definition or {})
    except DefinitionError as exc:
        raise SchemaError(str(exc)) from exc
    schema = DocumentSchema(schema_key=key, name=name.strip()[:200], category=category, description=description,
                            profile_id=profile_id, family=family, is_system=False, owner_workspace=workspace,
                            created_by=actor)
    database.add(schema)
    database.flush()
    version = DocumentSchemaVersion(schema_id=schema.id, version="1.0", status="draft",
                                    parent_version_id=parent_version_id, definition=own.model_dump(mode="json"),
                                    author=actor, change_summary="Created")
    database.add(version)
    database.flush()
    problems = validate_version(database, version, own)
    if problems:
        database.rollback()
        raise SchemaError("; ".join(problems[:10]))
    event(database, schema, action, actor_id, actor, version)
    database.commit()
    return schema, version


def save_draft(database: Session, schema: DocumentSchema, version: DocumentSchemaVersion, *, definition: dict,
               change_summary: str | None, actor_id: str | None, actor: str, name: str | None = None,
               description: str | None = None, category: str | None = None) -> DocumentSchemaVersion:
    if schema.is_system:
        raise SchemaError("Built-in schemas can't be edited; duplicate or extend one instead.")
    if version.status != "draft":
        raise SchemaError(f"Version {version.version} is {version.status.replace('_', ' ')} and can't be edited; "
                          "start a new draft.")
    try:
        own = parse_definition(definition)
    except DefinitionError as exc:
        raise SchemaError(str(exc)) from exc
    problems = validate_version(database, version, own)
    if problems:
        raise SchemaError("; ".join(problems[:10]))
    version.definition = own.model_dump(mode="json")
    version.change_summary = change_summary if change_summary is not None else version.change_summary
    version.updated_at = _now()
    if name:
        schema.name = name.strip()[:200]
    if description is not None:
        schema.description = description
    if category:
        schema.category = category
    event(database, schema, "edit", actor_id, actor, version)
    database.commit()
    return version


def new_draft(database: Session, schema: DocumentSchema, *, actor_id: str | None, actor: str, major: bool = False,
              parent_version_id: int | None = None) -> DocumentSchemaVersion:
    if schema.is_system:
        raise SchemaError("Built-in schemas can't be edited; duplicate or extend one instead.")
    existing = [v for v in versions(database, schema.id) if v.status in ("draft", "in_review")]
    if existing:
        return existing[-1]
    base = latest(database, schema.id)
    if base is None:
        raise SchemaError("The schema has no versions.")
    draft = DocumentSchemaVersion(
        schema_id=schema.id, version=_bump(base.version, major), status="draft",
        parent_version_id=parent_version_id if parent_version_id is not None else base.parent_version_id,
        definition=dict(base.definition), author=actor, change_summary=None,
    )
    database.add(draft)
    database.flush()
    event(database, schema, "new_draft", actor_id, actor, draft, {"from": base.version})
    database.commit()
    return draft


def transition(database: Session, schema: DocumentSchema, version: DocumentSchemaVersion, action: str, *,
               actor_id: str | None, actor: str) -> DocumentSchemaVersion:
    allowed = {
        "submit": ({"draft"}, "in_review"),
        "withdraw": ({"in_review"}, "draft"),
        "publish": ({"draft", "in_review"}, "published"),
        "deprecate": ({"published"}, "deprecated"),
    }
    if schema.is_system:
        raise SchemaError("Built-in schemas are managed by Dataomatix.")
    if action not in allowed:
        raise SchemaError(f"Unknown action {action!r}.")
    sources, target = allowed[action]
    if version.status not in sources:
        raise SchemaError(f"Can't {action} a version that is {version.status.replace('_', ' ')}.")
    if action == "publish":
        problems = validate_version(database, version, parse_definition(version.definition))
        if problems:
            raise SchemaError("; ".join(problems[:10]))
        for other in versions(database, schema.id):
            if other.id != version.id and other.status == "published":
                other.status = "deprecated"
        version.published_by, version.published_at = actor, _now()
        version.effective_date = version.effective_date or version.published_at
    if action == "submit":
        version.submitted_by, version.submitted_at = actor, _now()
    version.status = target
    event(database, schema, action, actor_id, actor, version)
    database.commit()
    return version


def archive(database: Session, schema: DocumentSchema, *, actor_id: str | None, actor: str) -> DocumentSchema:
    if schema.is_system:
        raise SchemaError("Built-in schemas can't be archived.")
    schema.archived_at = _now()
    for version in versions(database, schema.id):
        if version.status in ("draft", "in_review"):
            version.status = "archived"
    event(database, schema, "archive", actor_id, actor)
    database.commit()
    return schema


def mapping_impact(database: Session, changes: dict, old: Definition) -> list[dict]:
    """Saved Oracle mappings that read a field this change removes or
    rebinds. A label change alone affects nothing."""

    from app.doc_schemas.definition import all_fields

    breaking = {c["field_id"] for c in changes["breaking"]}
    sources = {}
    for _group, field in all_fields(old):
        if field.field_id in breaking and field.source is not None and field.source.kind == "field":
            sources[(field.source.dataset_id, field.source.field, field.source.pair_key)] = field.field_id
    affected = []
    for profile in database.scalars(select(OracleMappingProfile)):
        hits = []
        for mapping in profile.mappings or []:
            source = mapping.get("source") or {}
            key = (source.get("dataset_id"), source.get("field"), source.get("pair_key"))
            if key in sources:
                hits.append({"column": mapping.get("column"), "field_id": sources[key]})
        if hits:
            affected.append({"profile_id": profile.id, "name": profile.name, "columns": hits})
    return affected


def version_diff(database: Session, old: DocumentSchemaVersion, new: DocumentSchemaVersion) -> dict:
    before, after = effective(database, old), effective(database, new)
    changes = diff(before, after)
    return {**changes, "from": old.version, "to": new.version, "mappings_to_review": mapping_impact(database, changes, before)}


# ---------------------------------------------------------------- assignments


def assignment(database: Session, document_id: str) -> DocumentSchemaAssignment | None:
    return database.scalars(
        select(DocumentSchemaAssignment)
        .where(DocumentSchemaAssignment.document_id == document_id, DocumentSchemaAssignment.is_current.is_(True))
        .order_by(DocumentSchemaAssignment.id.desc())
    ).first()


def default_version(database: Session, profile_id: str | None, family: str | None) -> DocumentSchemaVersion | None:
    from app.doc_schemas.system import SYSTEM_PREFIX, ensure_system_schemas

    ensure_system_schemas(database)
    schema = database.scalars(
        select(DocumentSchema).where(DocumentSchema.schema_key == f"{SYSTEM_PREFIX}{profile_id}")
    ).first() if profile_id else None
    if schema is None:
        schema = database.scalars(
            select(DocumentSchema).where(DocumentSchema.schema_key == f"{SYSTEM_PREFIX}generic_business_document")
        ).first()
    return latest(database, schema.id, published=True) if schema else None


def assign(database: Session, document_id: str, version: DocumentSchemaVersion, *, kind: str, actor: str,
           note: str | None = None) -> DocumentSchemaAssignment:
    if version.status not in ("published", "deprecated"):
        raise SchemaError("Documents can only use a published schema version.")
    for row in database.scalars(select(DocumentSchemaAssignment).where(
        DocumentSchemaAssignment.document_id == document_id, DocumentSchemaAssignment.is_current.is_(True)
    )):
        row.is_current = False
    row = DocumentSchemaAssignment(document_id=document_id, schema_version_id=version.id, kind=kind,
                                   is_current=True, assigned_by=actor, note=note)
    database.add(row)
    schema = database.get(DocumentSchema, version.schema_id)
    if schema is not None:
        event(database, schema, "assign", None, actor, version, {"document_id": document_id, "kind": kind})
    database.commit()
    return row


def usage(database: Session, schema_id: int) -> dict[int, int]:
    rows = database.execute(
        select(DocumentSchemaAssignment.schema_version_id, func.count())
        .join(DocumentSchemaVersion, DocumentSchemaVersion.id == DocumentSchemaAssignment.schema_version_id)
        .where(DocumentSchemaVersion.schema_id == schema_id, DocumentSchemaAssignment.is_current.is_(True))
        .group_by(DocumentSchemaAssignment.schema_version_id)
    ).all()
    return dict(rows)


# ---------------------------------------------------------------- import / export


def export_payload(database: Session, schema: DocumentSchema, version: DocumentSchemaVersion, *, flatten: bool) -> dict:
    definition = effective(database, version) if flatten else parse_definition(version.definition)
    parent = None
    if not flatten and version.parent_version_id is not None:
        parent_version = database.get(DocumentSchemaVersion, version.parent_version_id)
        parent_schema = database.get(DocumentSchema, parent_version.schema_id) if parent_version else None
        if parent_version and parent_schema:
            parent = {"schema_key": parent_schema.schema_key, "version": parent_version.version}
    return {
        "format": EXPORT_FORMAT,
        "schema_key": schema.schema_key,
        "schema_name": schema.name,
        "category": schema.category,
        "description": schema.description,
        "version": version.version,
        "status": version.status,
        "parent": parent,
        "definition": definition.model_dump(mode="json", exclude_defaults=False),
    }


def import_payload(database: Session, payload: dict, *, actor_id: str | None, actor: str, workspace: str | None,
                   scoped: bool) -> tuple[DocumentSchema, DocumentSchemaVersion]:
    """A new draft schema from exported JSON. Validated in full; nothing in
    the file is executed. The parent, if named, must be a published version
    visible to the importer."""

    if not isinstance(payload, dict) or payload.get("format") != EXPORT_FORMAT:
        raise SchemaError(f"Not a Dataomatix schema file (expected format {EXPORT_FORMAT!r}).")
    name = payload.get("schema_name")
    if not isinstance(name, str) or not name.strip():
        raise SchemaError("The schema needs a name.")
    parent_version_id = None
    parent = payload.get("parent")
    if parent:
        if not isinstance(parent, dict):
            raise SchemaError("Invalid parent reference.")
        parent_schema = database.scalars(visible(
            select(DocumentSchema).where(DocumentSchema.schema_key == str(parent.get("schema_key"))), workspace, scoped
        )).first()
        if parent_schema is None:
            raise SchemaError(f"Parent schema {parent.get('schema_key')!r} doesn't exist here.")
        match = next((v for v in versions(database, parent_schema.id) if v.version == str(parent.get("version"))), None)
        if match is None or match.status not in ("published", "deprecated"):
            raise SchemaError(f"Parent version {parent.get('version')!r} isn't published here.")
        parent_version_id = match.id
    category = payload.get("category") if isinstance(payload.get("category"), str) else "other"
    key = payload.get("schema_key") if isinstance(payload.get("schema_key"), str) else None
    if key and key.startswith("system."):
        key = key.replace("system.", "imported.", 1)
    return create_schema(
        database, name=name, category=category[:40], description=payload.get("description") if isinstance(
            payload.get("description"), str) else None, actor_id=actor_id, actor=actor, workspace=workspace,
        parent_version_id=parent_version_id, definition=payload.get("definition") or {}, schema_key=key,
        action="import",
    )
