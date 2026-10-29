"""System schemas: the built-in staging profiles, described in the schema
language so the library lists them, the designer can extend or duplicate
them, and review forms render from them. They are generated, published as
1.0 and never edited; the profiles keep doing the extraction."""

from __future__ import annotations

import re
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.doc_schemas.definition import Definition, SchemaField, SchemaGroup, humanize
from app.models.document_schema import DocumentSchema, DocumentSchemaVersion
from app.oracle_templates.mapping import SourceRef
from app.staging import registry
from app.staging.document_categories import category_for_family

SYSTEM_PREFIX = "system."
SYSTEM_AUTHOR = "Dataomatix (built-in)"
_FIELD_ID = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,5}$")
_TYPES = {
    "text": "text", "string": "text", "number": "number", "integer": "number", "decimal": "number",
    "money": "currency", "currency": "currency", "amount": "currency", "date": "date", "boolean": "boolean",
    "email": "email", "identifier": "identifier",
}
# Contract subtypes published as child schemas of Government Contract.
CONTRACT_CHILDREN = (
    ("sf1442", "SF 1442 Contract Award", "Construction award on Standard Form 1442; inherits Government Contract."),
    ("sf33", "SF 33 Solicitation / Award", "Solicitation, offer and award on Standard Form 33; inherits Government Contract."),
)


def _field_id(canonical: str) -> str:
    candidate = canonical.lower().replace("-", "_")
    candidate = re.sub(r"[^a-z0-9_.]", "_", candidate)
    candidate = re.sub(r"\.{2,}", ".", candidate).strip(".")
    if not _FIELD_ID.fullmatch(candidate):
        parts = [re.sub(r"^[^a-z]+", "", p) or "f" for p in candidate.split(".")][:6]
        candidate = ".".join(parts)
    return candidate


def _group_id(dataset_id: str) -> str:
    gid = re.sub(r"[^a-z0-9_]", "_", dataset_id.lower())[:60]
    return gid if gid and gid[0].isalpha() else f"g_{gid}"[:60]


def profile_definition(profile) -> Definition:
    groups: list[SchemaGroup] = []
    seen: set[str] = set()
    for dataset in profile.datasets:
        if dataset.role not in ("business", "transform"):
            continue
        repeating = dataset.cardinality == "repeating"
        fields: list[SchemaField] = []
        for order, definition in enumerate(dataset.fields):
            field_id = _field_id(definition.canonical_field)
            if field_id in seen:
                continue
            seen.add(field_id)
            fields.append(
                SchemaField(
                    field_id=field_id,
                    label=definition.display_label or humanize(definition.key),
                    type=_TYPES.get(str(definition.value_type), "text"),
                    required=False,
                    source=SourceRef(
                        kind="field", dataset_id=dataset.dataset_id, field=definition.canonical_field,
                        shape="column" if repeating else "single",
                    ),
                    order=order,
                )
            )
        if not fields:
            continue
        key = next(
            (f.field_id for f in fields for k in dataset.identity_fields if _field_id(k) == f.field_id), None
        )
        groups.append(
            SchemaGroup(
                group_id=_group_id(dataset.dataset_id),
                label=dataset.display_name,
                kind="repeating" if repeating else "section",
                description=dataset.description,
                source_dataset=dataset.dataset_id if repeating else None,
                key_field=key if repeating else None,
                fields=fields,
            )
        )
    return Definition(groups=groups)


def _version(database: Session, schema: DocumentSchema, definition: Definition, parent_id: int | None) -> DocumentSchemaVersion:
    now = datetime.now(timezone.utc)
    version = DocumentSchemaVersion(
        schema_id=schema.id, version="1.0", status="published", parent_version_id=parent_id,
        definition=definition.model_dump(mode="json"), change_summary="Built-in schema",
        author=SYSTEM_AUTHOR, created_at=now, updated_at=now, published_by=SYSTEM_AUTHOR, published_at=now,
        effective_date=now,
    )
    database.add(version)
    database.flush()
    return version


def ensure_system_schemas(database: Session) -> None:
    """Creates the built-in schemas once (idempotent)."""

    existing = set(
        database.scalars(select(DocumentSchema.schema_key).where(DocumentSchema.is_system.is_(True)))
    )
    created = False
    contract_version: DocumentSchemaVersion | None = None
    for profile in registry.latest_profiles():
        key = f"{SYSTEM_PREFIX}{profile.profile_id}"
        family = next((f for f in profile.document_families if f not in ("unknown", "generic_business")), None)
        if key in existing:
            continue
        schema = DocumentSchema(
            schema_key=key, name=profile.display_name if profile.profile_id != "contract_v3" else "Government Contract",
            category=category_for_family(family) if family else "other", description=profile.description,
            profile_id=profile.profile_id, family=family, is_system=True, created_by=SYSTEM_AUTHOR,
        )
        database.add(schema)
        database.flush()
        version = _version(database, schema, profile_definition(profile), None)
        if profile.profile_id == "contract_v3":
            contract_version = version
        created = True
    if contract_version is None and any(f"{SYSTEM_PREFIX}contract_v3.{c[0]}" not in existing for c in CONTRACT_CHILDREN):
        contract_version = database.scalars(
            select(DocumentSchemaVersion)
            .join(DocumentSchema, DocumentSchema.id == DocumentSchemaVersion.schema_id)
            .where(DocumentSchema.schema_key == f"{SYSTEM_PREFIX}contract_v3")
        ).first()
    if contract_version is not None:
        for suffix, name, description in CONTRACT_CHILDREN:
            key = f"{SYSTEM_PREFIX}contract_v3.{suffix}"
            if key in existing:
                continue
            schema = DocumentSchema(
                schema_key=key, name=name, category="contracts", description=description, profile_id="contract_v3",
                family="government_contract", is_system=True, created_by=SYSTEM_AUTHOR,
            )
            database.add(schema)
            database.flush()
            _version(database, schema, Definition(), contract_version.id)
            created = True
    if created:
        database.commit()
