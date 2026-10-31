"""Oracle Fusion Template Manager and mapping API.

Templates are configuration (``/api/oracle/...``): uploading or retiring one
needs ``admin.integrations``; reading needs ``documents.view``. Mappings,
previews and exports work on a document (``/api/documents/{id}/oracle/...``,
mounted with document isolation) and need ``oracle.preview``. Nothing here
writes to Oracle: files are generated for a person to load.

The target catalog (``/api/oracle/catalog``) groups registered targets by
Oracle application and integration method, with each one's status
(oracle_templates/catalog.py). A target is registered from an official
template, or — when an Oracle environment is configured — from its REST
metadata (``/api/oracle/discovery``, read-only). Mapping profiles are
versioned, approved (activated) by a reviewer, archived, duplicated and
compared; every change is an audit event.
"""

from __future__ import annotations

import hashlib
import io
import re
import zipfile
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.downloads import attachment_header
from app.core.auth import ActorContext, require_permission
from app.core.document_access import workspace_scoped
from app.core.observability import get_request_id
from app.database.dependencies import get_database
from app.models.document import Document
from app.models.integration_audit_log import IntegrationAuditLog
from app.core.config import get_settings
from app.core.rbac import role_has_permission
from app.models.oracle_template import OracleMappingAuditEvent, OracleMappingProfile, OracleTemplate
from app.oracle_templates import catalog as target_catalog
from app.oracle_templates import discovery
from app.oracle_templates.mapping import (
    TRANSFORM_LABELS,
    BuiltRows,
    ClauseRecord,
    Issue,
    MappingSpec,
    SourceField,
    SourceRef,
    Suggestion,
    build_rows,
    catalogue,
    clause_records,
    column_states,
    contract_numbers,
    explain,
    import_ready,
    suggest,
    suggest_links,
    validate,
    write_csv,
)
from app.oracle_templates.parser import (
    MAX_TEMPLATE_BYTES,
    TemplateError,
    apply_definitions,
    parse_attribute_definitions,
    parse_template,
    template_definitions,
)
from app.staging.models import StagingWorkbook
from app.staging.service import get_staging_workbook, pinned_profile

router = APIRouter()
documents_router = APIRouter()

_MEDIA = {
    "csv": "text/csv",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
}
_PREVIEW_ROWS = 50
_MAX_ISSUES = 300


# ---------------------------------------------------------------- schemas


class TemplateColumnOut(BaseModel):
    position: int
    technical_name: str
    display_label: str | None
    required: bool | None
    # Documented by the template's attribute definitions or Oracle metadata;
    # None when the source doesn't say.
    data_type: str | None = None
    declared_type: str | None = None
    max_length: int | None = None
    precision: int | None = None
    scale: int | None = None
    lookup_values: list[str] | None = None
    lookup_type: str | None = None
    description: str | None = None


class CatalogEntryOut(BaseModel):
    application: str | None
    integration_method: str | None
    integration_method_label: str | None
    oracle_release: str | None
    object_code: str | None
    parent_object: str | None
    user_keys: list[str]
    description: str | None
    source: str
    verified: bool
    verified_by: str | None
    verified_at: str | None
    status: str
    status_label: str
    status_reason: str | None


class TemplateOut(BaseModel):
    id: int
    object_name: str
    version: int
    filename: str
    file_format: str
    sheet_name: str | None
    technical_row: int
    label_row: int | None
    columns: list[TemplateColumnOut]
    warnings: list[str]
    environment: str | None
    status: str
    uploaded_by: str
    uploaded_at: datetime
    checksum_sha256: str
    has_display_labels: bool
    profile_count: int = 0
    # True when an upload matched a template already stored (identical bytes).
    reused: bool = False
    catalog: CatalogEntryOut | None = None
    required_columns: list[str] = Field(default_factory=list)


class ProfileOut(BaseModel):
    id: int
    template_id: int
    name: str
    staging_profile_id: str | None
    spec: MappingSpec
    version: int
    history: list[dict]
    updated_by: str
    updated_at: datetime
    notes: str | None
    # draft | active | archived
    status: str = "draft"
    created_by: str | None = None
    approved_by: str | None = None
    approved_at: datetime | None = None
    source_document_type: str | None = None
    # The profile stays on its template version; a newer one is offered, never applied.
    template_version: int | None = None
    schema_update_available: bool = False


class ProfileIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    staging_profile_id: str | None = Field(default=None, max_length=80)
    spec: MappingSpec
    notes: str | None = Field(default=None, max_length=2000)
    source_document_type: str | None = Field(default=None, max_length=120)


class CatalogObjectOut(BaseModel):
    template: TemplateOut
    versions: list[int]


class CatalogApplicationOut(BaseModel):
    application: str
    objects: list[CatalogObjectOut]


class CatalogOut(BaseModel):
    configured: bool
    message: str | None
    applications: list[CatalogApplicationOut]
    application_names: list[str]
    integration_methods: dict[str, str]
    transformations: dict[str, str]
    discovery: "DiscoveryOut"


class DiscoveryOut(BaseModel):
    configured: bool
    provider: str
    message: str


CatalogOut.model_rebuild()


class DiscoverIn(BaseModel):
    resource: str = Field(min_length=1, max_length=80)
    application: str = Field(min_length=1, max_length=60)
    object_name: str | None = Field(default=None, max_length=120)


class VersionOut(BaseModel):
    version: int
    actor: str | None
    at: str | None
    status: str | None
    name: str | None
    spec: MappingSpec | None


class MappingChange(BaseModel):
    column: str
    change: str  # added | removed | changed
    before: dict | None
    after: dict | None


class CompareOut(BaseModel):
    profile_id: int
    from_version: int
    to_version: int
    changes: list[MappingChange]
    settings: list[str]


class AuditEventOut(BaseModel):
    action: str
    profile_version: int | None
    actor_name: str
    created_at: datetime
    detail: dict | None


class ClausesOut(BaseModel):
    document_id: str
    clauses: list[ClauseRecord]
    families: dict[str, int]


class FieldsOut(BaseModel):
    document_id: str
    staging_profile_id: str | None
    fields: list[SourceField]


class SuggestIn(BaseModel):
    row_dataset: str | None = Field(default=None, max_length=120)
    parent_profile_id: int | None = None


class SuggestOut(BaseModel):
    template_id: int
    row_dataset: str | None
    suggestions: list[Suggestion]
    parent_links: list[tuple[str, str]] = Field(default_factory=list)


class PreviewIn(BaseModel):
    spec: MappingSpec


class PreviewCell(BaseModel):
    value: str
    review_status: str | None = None
    problem: str | None = None
    page: int | None = None
    highlight: str | None = None
    source_value: str | None = None


class ParentPreviewOut(BaseModel):
    profile_id: int
    name: str
    headers: list[str]
    rows: list[list[PreviewCell]]
    total_rows: int


class PreviewOut(BaseModel):
    template_id: int
    headers: list[str]
    display_labels: list[str | None]
    rows: list[list[PreviewCell]]
    total_rows: int
    issues: list[Issue]
    issue_counts: dict[str, int]
    import_ready: bool
    unmapped_fields: list[SourceField]
    # Valid | Warning | Error | Needs Review | Not Configured, per attribute.
    column_states: dict[str, str] = Field(default_factory=dict)
    # How each configured attribute's value is made, in words.
    transforms: dict[str, str] = Field(default_factory=dict)
    schema_status: str = "draft"
    parent: ParentPreviewOut | None = None


class ExportIn(BaseModel):
    spec: MappingSpec
    # Download even when validation found errors (the file is then not import-ready).
    force: bool = False


class BundleIn(BaseModel):
    profile_ids: list[int] = Field(min_length=1, max_length=20)
    force: bool = False


# ---------------------------------------------------------------- helpers


def _visible(statement, model, actor: ActorContext):
    if not workspace_scoped(actor):
        return statement
    if actor.workspace is None:
        return statement.where(model.id.is_(None))
    return statement.where(model.owner_workspace == actor.workspace)


def _template_or_404(database: Session, template_id: int, actor: ActorContext) -> OracleTemplate:
    template = database.scalars(
        _visible(select(OracleTemplate).where(OracleTemplate.id == template_id), OracleTemplate, actor)
    ).first()
    if template is None:
        raise HTTPException(status_code=404, detail="Template not found.")
    return template


def _profile_or_404(database: Session, profile_id: int, actor: ActorContext) -> OracleMappingProfile:
    profile = database.scalars(
        _visible(select(OracleMappingProfile).where(OracleMappingProfile.id == profile_id), OracleMappingProfile, actor)
    ).first()
    if profile is None:
        raise HTTPException(status_code=404, detail="Mapping not found.")
    return profile


def _newer_version(database: Session, template: OracleTemplate, actor: ActorContext) -> bool:
    newer = database.scalar(
        _visible(
            select(func.count()).select_from(OracleTemplate).where(
                func.lower(OracleTemplate.object_name) == template.object_name.lower(),
                OracleTemplate.version > template.version,
                OracleTemplate.status == "active",
            ),
            OracleTemplate,
            actor,
        )
    )
    return bool(newer)


def _catalog_out(template: OracleTemplate, newer: bool) -> CatalogEntryOut:
    entry = target_catalog.catalog_of(template)
    status, reason = target_catalog.status_of(template, newer)
    return CatalogEntryOut(
        **entry,
        integration_method_label=target_catalog.INTEGRATION_METHODS.get(entry["integration_method"] or ""),
        status=status,
        status_label=target_catalog.STATUS_LABELS[status],
        status_reason=reason,
    )


def _audit_event(
    database: Session,
    action: str,
    actor: ActorContext,
    *,
    profile: OracleMappingProfile | None = None,
    template: OracleTemplate | None = None,
    detail: dict | None = None,
) -> None:
    database.add(OracleMappingAuditEvent(
        profile_id=profile.id if profile else None,
        template_id=template.id if template else (profile.template_id if profile else None),
        profile_version=profile.version if profile else None,
        action=action,
        actor_id=actor.id,
        actor_name=actor.display_name,
        owner_workspace=actor.workspace if workspace_scoped(actor) else None,
        detail=detail,
    ))


def _template_out(template: OracleTemplate, profile_count: int = 0, newer: bool = False) -> TemplateOut:
    return TemplateOut(
        id=template.id,
        object_name=template.object_name,
        version=template.version,
        filename=template.filename,
        file_format=template.file_format,
        sheet_name=template.sheet_name,
        technical_row=template.technical_row,
        label_row=template.label_row,
        columns=[TemplateColumnOut(**column) for column in template.columns],
        warnings=list(template.warnings or []),
        environment=template.environment,
        status=template.status,
        uploaded_by=template.uploaded_by,
        uploaded_at=template.uploaded_at,
        checksum_sha256=template.checksum_sha256,
        has_display_labels=template.label_row is not None
        or any(column.get("display_label") for column in template.columns),
        profile_count=profile_count,
        catalog=_catalog_out(template, newer),
        required_columns=target_catalog.required_attributes(template.columns),
    )


def _profile_out(profile: OracleMappingProfile, template: OracleTemplate | None = None, newer: bool = False) -> ProfileOut:
    return ProfileOut(
        id=profile.id,
        template_id=profile.template_id,
        name=profile.name,
        staging_profile_id=profile.staging_profile_id,
        spec=MappingSpec(
            row_dataset=profile.row_dataset,
            mappings=profile.mappings or [],
            key_columns=profile.key_columns or [],
            parent=profile.parent,
        ),
        version=profile.version,
        history=list(profile.history or []),
        updated_by=profile.updated_by,
        updated_at=profile.updated_at,
        notes=profile.notes,
        status=profile.status or "draft",
        created_by=profile.created_by,
        approved_by=profile.approved_by,
        approved_at=profile.approved_at,
        source_document_type=profile.source_document_type,
        template_version=template.version if template else None,
        schema_update_available=newer,
    )


def _profile_full(database: Session, profile: OracleMappingProfile, actor: ActorContext) -> ProfileOut:
    template = database.get(OracleTemplate, profile.template_id)
    return _profile_out(profile, template, bool(template) and _newer_version(database, template, actor))


def _workbook_or_404(database: Session, document_id: str) -> StagingWorkbook:
    try:
        return get_staging_workbook(database, document_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


def _staging_profile_id(database: Session, document_id: str) -> str | None:
    document = database.get(Document, document_id)
    if document is None:
        return None
    try:
        return pinned_profile(database, document).profile_id
    except Exception:  # noqa: BLE001 - an unstaged document simply has none
        return None


def _build(workbook: StagingWorkbook, template: OracleTemplate, spec: MappingSpec) -> BuiltRows:
    try:
        return build_rows(workbook, template.columns, spec)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _parent_rows(
    database: Session, workbook: StagingWorkbook, spec: MappingSpec, actor: ActorContext
) -> BuiltRows | None:
    if spec.parent is None:
        return None
    parent = _profile_or_404(database, spec.parent.profile_id, actor)
    parent_template = _template_or_404(database, parent.template_id, actor)
    parent_spec = _profile_out(parent).spec
    return build_rows(workbook, parent_template.columns, parent_spec)


def _checked(
    database: Session, workbook: StagingWorkbook, template: OracleTemplate, spec: MappingSpec, actor: ActorContext
) -> tuple[BuiltRows, list[Issue]]:
    from app.classification.service import current as current_classification

    built = _build(workbook, template, spec)
    try:
        parent_rows = _parent_rows(database, workbook, spec, actor)
    except ValueError:
        parent_rows = None
    available = {(f.ref.dataset_id, f.ref.field, f.ref.pair_key) for f in catalogue(workbook)}
    classification = current_classification(database, workbook.document_id)
    return built, validate(
        template.columns, spec, built, parent_rows, available,
        classification.status if classification else None,
        contracts=contract_numbers(workbook),
        schema=target_catalog.status_of(template, _newer_version(database, template, actor)),
    )


def _counts(issues: list[Issue]) -> dict[str, int]:
    counts = {"error": 0, "warning": 0, "info": 0}
    for issue in issues:
        counts[issue.severity] += 1
    return counts


def _export_name(template: OracleTemplate) -> str:
    stem = re.sub(r"\.[^.]+$", "", template.filename)
    stem = re.sub(r"[^\w\- .]+", "_", stem).strip(" .") or "import"
    return f"{stem}.csv"


def _audit(database: Session, document_id: str, actor: ActorContext, status: str, snapshot: dict, detail: str) -> None:
    database.add(
        IntegrationAuditLog(
            document_id=document_id,
            integration="oracle",
            action="export",
            status=status,
            request_snapshot=snapshot,
            response_snapshot=None,
            actor_id=actor.id,
            actor_type=actor.actor_type,
            actor_role=actor.role,
            changed_by=actor.display_name,
            request_id=get_request_id(),
            detail=detail,
        )
    )


# ---------------------------------------------------------------- templates


@router.post("/templates", response_model=TemplateOut, status_code=201)
async def upload_template(
    file: UploadFile = File(...),
    object_name: str | None = Form(default=None, max_length=120),
    environment: str | None = Form(default=None, max_length=120),
    sheet: str | None = Form(default=None, max_length=120),
    application: str | None = Form(default=None, max_length=60),
    integration_method: str | None = Form(default=None, max_length=30),
    oracle_release: str | None = Form(default=None, max_length=40),
    object_code: str | None = Form(default=None, max_length=120),
    parent_object: str | None = Form(default=None, max_length=120),
    user_keys: str | None = Form(default=None, max_length=1000),
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("admin.integrations")),
) -> TemplateOut:
    """Stores the file exactly as uploaded and records its parsed columns,
    with the attribute definitions the workbook documents. Re-uploading
    identical bytes returns the existing template. The catalog fields say
    where the target sits in Oracle; it is registered as a Draft until an
    administrator verifies it."""

    data = await file.read(MAX_TEMPLATE_BYTES + 1)
    filename = (file.filename or "template.csv").rsplit("/", 1)[-1].rsplit("\\", 1)[-1][:255]
    try:
        parsed = parse_template(filename, data, sheet=(sheet or None))
    except TemplateError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    catalog_in: target_catalog.CatalogIn | None = None
    if application or integration_method:
        try:
            catalog_in = target_catalog.CatalogIn(
                application=application or "", integration_method=integration_method or "other",
                oracle_release=oracle_release or None, object_code=object_code or None,
                parent_object=parent_object or None,
                user_keys=[k.strip() for k in (user_keys or "").split(",") if k.strip()],
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=f"Catalog: {exc}") from exc

    checksum = hashlib.sha256(data).hexdigest()
    workspace = actor.workspace if workspace_scoped(actor) else None
    existing = database.scalars(
        _visible(
            select(OracleTemplate).where(OracleTemplate.checksum_sha256 == checksum, OracleTemplate.status == "active"),
            OracleTemplate,
            actor,
        )
    ).first()
    if existing is not None:
        return _template_out(existing).model_copy(update={"reused": True})

    columns = [
        {
            "position": column.position,
            "technical_name": column.technical_name,
            "display_label": column.display_label,
            "required": column.required,
        }
        for column in parsed.columns
    ]
    warnings = list(parsed.warnings)
    try:
        definitions = template_definitions(filename, data, parsed.sheet_name)
    except Exception:  # noqa: BLE001 - definitions only enrich the columns
        definitions = {}
    if definitions:
        columns, unmatched = apply_definitions(columns, definitions)
        warnings += unmatched
        warnings = [w for w in warnings if not w.startswith("The template does not mark required")] if any(
            c.get("required") for c in columns) else warnings

    name = (object_name or "").strip() or parsed.object_name
    latest = database.scalar(
        _visible(
            select(func.max(OracleTemplate.version)).where(func.lower(OracleTemplate.object_name) == name.lower()),
            OracleTemplate,
            actor,
        )
    )
    template = OracleTemplate(
        object_name=name,
        version=(latest or 0) + 1,
        filename=filename,
        file_format=parsed.file_format,
        original_bytes=data,
        checksum_sha256=checksum,
        sheet_name=parsed.sheet_name,
        technical_row=parsed.technical_row,
        label_row=parsed.label_row,
        columns=columns,
        warnings=warnings,
        environment=(environment or "").strip() or None,
        status="active",
        owner_workspace=workspace,
        uploaded_by=actor.display_name,
        catalog={"source": "uploaded_template"},
    )
    if catalog_in is not None:
        try:
            template.catalog = target_catalog.updated_catalog(template, catalog_in)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    database.add(template)
    database.flush()
    _audit_event(database, "registered", actor, template=template,
                 detail={"object_name": template.object_name, "version": template.version, "source": "uploaded_template",
                         "attributes_documented": sum(1 for c in columns if c.get("data_type"))})
    database.commit()
    database.refresh(template)
    return _template_out(template)


@router.get("/templates", response_model=list[TemplateOut])
def list_templates(
    include_retired: bool = False,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> list[TemplateOut]:
    statement = select(OracleTemplate).order_by(OracleTemplate.object_name, OracleTemplate.version.desc())
    if not include_retired:
        statement = statement.where(OracleTemplate.status == "active")
    templates = list(database.scalars(_visible(statement, OracleTemplate, actor)))
    latest: dict[str, int] = {}
    for template in templates:
        if template.status == "active":
            key = template.object_name.lower()
            latest[key] = max(latest.get(key, 0), template.version)
    counts = dict(
        database.execute(
            select(OracleMappingProfile.template_id, func.count())
            .where(OracleMappingProfile.template_id.in_([t.id for t in templates] or [-1]))
            .group_by(OracleMappingProfile.template_id)
        ).all()
    )
    return [
        _template_out(template, counts.get(template.id, 0), template.version < latest.get(template.object_name.lower(), 0))
        for template in templates
    ]


@router.get("/templates/{template_id}", response_model=TemplateOut)
def get_template(
    template_id: int,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> TemplateOut:
    template = _template_or_404(database, template_id, actor)
    return _template_out(template, newer=_newer_version(database, template, actor))


@router.get("/templates/{template_id}/original")
def download_original(
    template_id: int,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> Response:
    """The uploaded file, byte for byte."""

    template = _template_or_404(database, template_id, actor)
    return Response(
        content=template.original_bytes,
        media_type=_MEDIA.get(template.file_format, "application/octet-stream"),
        headers={"Content-Disposition": attachment_header(template.filename)},
    )


@router.post("/templates/{template_id}/retire", response_model=TemplateOut)
def retire_template(
    template_id: int,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("admin.integrations")),
) -> TemplateOut:
    """Hidden from new mappings; kept (with its mappings) for history."""

    template = _template_or_404(database, template_id, actor)
    template.status = "retired"
    _audit_event(database, "retired", actor, template=template)
    database.commit()
    return _template_out(template)


# ---------------------------------------------------------------- target catalog


@router.get("/catalog", response_model=CatalogOut)
def get_catalog(
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> CatalogOut:
    """Registered targets by Oracle application: the latest active version
    of each object, with its status and the versions on record. Targets
    whose application isn't set are listed under "Not classified"."""

    templates = list(database.scalars(_visible(
        select(OracleTemplate).where(OracleTemplate.status == "active")
        .order_by(OracleTemplate.object_name, OracleTemplate.version.desc()),
        OracleTemplate, actor,
    )))
    objects: dict[str, list[OracleTemplate]] = {}
    for template in templates:
        objects.setdefault(template.object_name.lower(), []).append(template)
    grouped: dict[str, list[CatalogObjectOut]] = {}
    for versions in objects.values():
        latest = versions[0]
        application = target_catalog.catalog_of(latest)["application"] or "Not classified"
        grouped.setdefault(application, []).append(
            CatalogObjectOut(template=_template_out(latest), versions=[t.version for t in versions])
        )
    order = list(target_catalog.APPLICATIONS) + ["Not classified"]
    applications = [CatalogApplicationOut(application=name, objects=grouped[name]) for name in order if name in grouped]
    found = discovery.provider(get_settings())
    return CatalogOut(
        configured=bool(templates),
        message=None if templates else target_catalog.NOT_CONFIGURED,
        applications=applications,
        application_names=list(target_catalog.APPLICATIONS),
        integration_methods=target_catalog.INTEGRATION_METHODS,
        transformations=TRANSFORM_LABELS,
        discovery=DiscoveryOut(configured=found.configured, provider=found.name, message=found.message),
    )


@router.put("/templates/{template_id}/catalog", response_model=TemplateOut)
def update_catalog(
    template_id: int,
    payload: target_catalog.CatalogIn,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("admin.integrations")),
) -> TemplateOut:
    """Where the target sits in Oracle. Changing what it is (application,
    method, release, object code) withdraws its verification."""

    template = _template_or_404(database, template_id, actor)
    try:
        template.catalog = target_catalog.updated_catalog(template, payload)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    _audit_event(database, "catalog_updated", actor, template=template, detail=payload.model_dump())
    database.commit()
    return _template_out(template, newer=_newer_version(database, template, actor))


@router.post("/templates/{template_id}/verify", response_model=TemplateOut)
def verify_template(
    template_id: int,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("admin.integrations")),
) -> TemplateOut:
    """An administrator confirms the schema is Oracle's own for the stated
    application, method and release: only then can it be import-ready."""

    template = _template_or_404(database, template_id, actor)
    if template.status == "retired" or _newer_version(database, template, actor):
        raise HTTPException(status_code=409, detail="A stale target can't be verified; verify its latest version.")
    try:
        template.catalog = target_catalog.verified_catalog(template, actor.display_name)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    _audit_event(database, "verified", actor, template=template)
    database.commit()
    return _template_out(template)


@router.post("/templates/{template_id}/attributes", response_model=TemplateOut)
async def register_attributes(
    template_id: int,
    file: UploadFile = File(...),
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("admin.integrations")),
) -> TemplateOut:
    """Attribute definitions (data type, length, precision, scale, required,
    lookup values) from Oracle's documentation for this template's
    attributes. Registering them withdraws an earlier verification."""

    template = _template_or_404(database, template_id, actor)
    data = await file.read(MAX_TEMPLATE_BYTES + 1)
    try:
        definitions = parse_attribute_definitions(file.filename or "definitions.csv", data)
    except TemplateError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    columns, unmatched = apply_definitions(template.columns, definitions)
    if len(unmatched) == len(definitions):
        raise HTTPException(status_code=422, detail="None of the definitions names an attribute of this template.")
    template.columns = columns
    template.warnings = [*(template.warnings or []), *unmatched][-50:]
    entry = target_catalog.catalog_of(template)
    entry.update(verified=False, verified_by=None, verified_at=None)
    template.catalog = entry
    _audit_event(database, "attributes_registered", actor, template=template,
                 detail={"defined": len(definitions) - len(unmatched), "unmatched": len(unmatched)})
    database.commit()
    return _template_out(template, newer=_newer_version(database, template, actor))


@router.get("/discovery", response_model=DiscoveryOut)
def discovery_status(actor: ActorContext = Depends(require_permission("documents.view"))) -> DiscoveryOut:
    """Whether Oracle metadata discovery is available (never the credentials)."""

    found = discovery.provider(get_settings())
    return DiscoveryOut(configured=found.configured, provider=found.name, message=found.message)


@router.post("/discovery/register", response_model=TemplateOut, status_code=201)
def register_discovered(
    payload: DiscoverIn,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("admin.integrations")),
) -> TemplateOut:
    """Registers a REST resource's attributes, read from Oracle's describe
    metadata, as a Draft target. Read-only on the Oracle side."""

    found_provider = discovery.provider(get_settings())
    if not found_provider.configured:
        raise HTTPException(status_code=409, detail=found_provider.message)
    try:
        found = found_provider.describe(payload.resource.strip())
    except discovery.DiscoveryError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    try:
        entry = target_catalog.CatalogIn(application=payload.application, integration_method="rest",
                                         oracle_release=get_settings().oracle_api_version, object_code=found.resource)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    name = (payload.object_name or "").strip() or found.title or found.resource
    latest = database.scalar(_visible(
        select(func.max(OracleTemplate.version)).where(func.lower(OracleTemplate.object_name) == name.lower()),
        OracleTemplate, actor,
    ))
    template = OracleTemplate(
        object_name=name[:120], version=(latest or 0) + 1, filename=f"{found.resource}-describe.json", file_format="json",
        original_bytes=found.raw or b"{}", checksum_sha256=hashlib.sha256(found.raw or b"{}").hexdigest(),
        sheet_name=None, technical_row=0, label_row=None, columns=discovery.template_columns(found),
        warnings=[f"Child resources: {', '.join(found.children)}."] if found.children else [],
        environment=None, status="active", owner_workspace=actor.workspace if workspace_scoped(actor) else None,
        uploaded_by=actor.display_name,
    )
    template.catalog = {**target_catalog.updated_catalog(template, entry), "source": "metadata_api"}
    database.add(template)
    database.flush()
    _audit_event(database, "discovered", actor, template=template,
                 detail={"resource": found.resource, "attributes": len(found.attributes), "children": found.children})
    database.commit()
    database.refresh(template)
    return _template_out(template)


# ---------------------------------------------------------------- mapping profiles


@router.get("/templates/{template_id}/profiles", response_model=list[ProfileOut])
def list_profiles(
    template_id: int,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> list[ProfileOut]:
    _template_or_404(database, template_id, actor)
    profiles = database.scalars(
        _visible(
            select(OracleMappingProfile)
            .where(OracleMappingProfile.template_id == template_id)
            .order_by(OracleMappingProfile.updated_at.desc()),
            OracleMappingProfile,
            actor,
        )
    )
    return [_profile_full(database, profile, actor) for profile in profiles]


@router.get("/profiles", response_model=list[ProfileOut])
def list_all_profiles(
    staging_profile_id: str | None = None,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> list[ProfileOut]:
    statement = select(OracleMappingProfile).order_by(OracleMappingProfile.updated_at.desc())
    if staging_profile_id:
        statement = statement.where(OracleMappingProfile.staging_profile_id == staging_profile_id)
    return [_profile_full(database, p, actor) for p in database.scalars(_visible(statement, OracleMappingProfile, actor))]


def _check_spec(database: Session, template: OracleTemplate, spec: MappingSpec, actor: ActorContext) -> None:
    names = {column["technical_name"] for column in template.columns}
    unknown = sorted({m.column for m in spec.mappings} - names)
    if unknown:
        raise HTTPException(status_code=422, detail=f"Not columns of this template: {', '.join(unknown)}.")
    if len({m.column for m in spec.mappings}) != len(spec.mappings):
        raise HTTPException(status_code=422, detail="Each template column can be mapped once.")
    if spec.parent is not None:
        _profile_or_404(database, spec.parent.profile_id, actor)


def _history(profile: OracleMappingProfile, actor: ActorContext) -> list[dict]:
    """One entry per version, with what that version said (for Compare)."""

    entry = {
        "version": profile.version, "actor": actor.display_name, "at": datetime.now(timezone.utc).isoformat(),
        "status": profile.status or "draft", "name": profile.name,
        "spec": {"row_dataset": profile.row_dataset, "mappings": profile.mappings or [],
                 "key_columns": profile.key_columns or [], "parent": profile.parent},
    }
    return [*(profile.history or []), entry][-50:]


@router.post("/templates/{template_id}/profiles", response_model=ProfileOut, status_code=201)
def create_profile(
    template_id: int,
    payload: ProfileIn,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("oracle.preview")),
) -> ProfileOut:
    template = _template_or_404(database, template_id, actor)
    _check_spec(database, template, payload.spec, actor)
    profile = OracleMappingProfile(
        template_id=template.id,
        name=payload.name.strip(),
        staging_profile_id=payload.staging_profile_id,
        row_dataset=payload.spec.row_dataset,
        mappings=[m.model_dump() for m in payload.spec.mappings],
        key_columns=payload.spec.key_columns,
        parent=payload.spec.parent.model_dump() if payload.spec.parent else None,
        version=1,
        history=[],
        owner_workspace=actor.workspace if workspace_scoped(actor) else None,
        updated_by=actor.display_name,
        notes=payload.notes,
        status="draft",
        created_by=actor.display_name,
        source_document_type=payload.source_document_type,
    )
    profile.history = _history(profile, actor)
    database.add(profile)
    database.flush()
    _audit_event(database, "created", actor, profile=profile, detail={"name": profile.name})
    database.commit()
    database.refresh(profile)
    return _profile_full(database, profile, actor)


@router.put("/profiles/{profile_id}", response_model=ProfileOut)
def save_profile(
    profile_id: int,
    payload: ProfileIn,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("oracle.preview")),
) -> ProfileOut:
    """Saves a new version of the mapping; earlier exports keep their own."""

    profile = _profile_or_404(database, profile_id, actor)
    template = _template_or_404(database, profile.template_id, actor)
    _check_spec(database, template, payload.spec, actor)
    if payload.spec.parent is not None and payload.spec.parent.profile_id == profile.id:
        raise HTTPException(status_code=422, detail="A mapping can't be its own parent.")
    profile.name = payload.name.strip()
    profile.staging_profile_id = payload.staging_profile_id or profile.staging_profile_id
    profile.row_dataset = payload.spec.row_dataset
    profile.mappings = [m.model_dump() for m in payload.spec.mappings]
    profile.key_columns = payload.spec.key_columns
    profile.parent = payload.spec.parent.model_dump() if payload.spec.parent else None
    profile.notes = payload.notes
    profile.source_document_type = payload.source_document_type or profile.source_document_type
    was_active = profile.status == "active"
    if profile.status != "archived":
        # A change is a new draft: an approval never covers mappings it didn't see.
        profile.status, profile.approved_by, profile.approved_at = "draft", None, None
    profile.version += 1
    profile.updated_by = actor.display_name
    profile.updated_at = datetime.now(timezone.utc)
    profile.history = _history(profile, actor)
    _audit_event(database, "reverted_to_draft" if was_active else "saved", actor, profile=profile,
                 detail={"mappings": len(payload.spec.mappings)})
    database.commit()
    database.refresh(profile)
    return _profile_full(database, profile, actor)


@router.post("/profiles/{profile_id}/duplicate", response_model=ProfileOut, status_code=201)
def duplicate_profile(
    profile_id: int,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("oracle.preview")),
) -> ProfileOut:
    """A copy as a new Draft profile (version 1)."""

    source = _profile_or_404(database, profile_id, actor)
    copy = OracleMappingProfile(
        template_id=source.template_id, name=f"{source.name} (copy)"[:200], staging_profile_id=source.staging_profile_id,
        row_dataset=source.row_dataset, mappings=list(source.mappings or []), key_columns=list(source.key_columns or []),
        parent=source.parent, version=1, history=[], owner_workspace=actor.workspace if workspace_scoped(actor) else None,
        updated_by=actor.display_name, notes=source.notes, status="draft", created_by=actor.display_name,
        source_document_type=source.source_document_type,
    )
    copy.history = _history(copy, actor)
    database.add(copy)
    database.flush()
    _audit_event(database, "duplicated", actor, profile=copy, detail={"from_profile": source.id, "from_version": source.version})
    database.commit()
    database.refresh(copy)
    return _profile_full(database, copy, actor)


@router.post("/profiles/{profile_id}/activate", response_model=ProfileOut)
def activate_profile(
    profile_id: int,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("oracle.preview")),
) -> ProfileOut:
    """Approves this version of the profile for use. Needs the review
    permission too; the target must be a verified, current schema, every
    mapped column must exist and every required one be mapped."""

    if not role_has_permission(actor.role, "review.accept"):
        raise HTTPException(status_code=403, detail="Approving a mapping profile needs the review permission.")
    profile = _profile_or_404(database, profile_id, actor)
    template = _template_or_404(database, profile.template_id, actor)
    status, reason = target_catalog.status_of(template, _newer_version(database, template, actor))
    if status != target_catalog.VERIFIED:
        raise HTTPException(status_code=409, detail=f"The target is {status}: {reason}")
    spec = _profile_out(profile).spec
    names = {c["technical_name"] for c in template.columns}
    mapped = {m.column for m in spec.mappings if m.source.kind != "none"}
    problems = [f"{c} is not an attribute of the target" for c in sorted(mapped - names)]
    problems += [f"{c} is required but not mapped" for c in target_catalog.required_attributes(template.columns) if c not in mapped]
    if problems:
        raise HTTPException(status_code=409, detail="Not approvable: " + "; ".join(problems) + ".")
    profile.status, profile.approved_by, profile.approved_at = "active", actor.display_name, datetime.now(timezone.utc)
    history = list(profile.history or [])
    if history and history[-1].get("version") == profile.version:
        history[-1] = {**history[-1], "status": "active", "approved_by": actor.display_name}
    profile.history = history
    _audit_event(database, "activated", actor, profile=profile)
    database.commit()
    database.refresh(profile)
    return _profile_full(database, profile, actor)


@router.post("/profiles/{profile_id}/archive", response_model=ProfileOut)
def archive_profile(
    profile_id: int,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("oracle.preview")),
) -> ProfileOut:
    """Out of use; kept, with its versions, for history."""

    profile = _profile_or_404(database, profile_id, actor)
    profile.status = "archived"
    _audit_event(database, "archived", actor, profile=profile)
    database.commit()
    database.refresh(profile)
    return _profile_full(database, profile, actor)


@router.get("/profiles/{profile_id}/versions", response_model=list[VersionOut])
def profile_versions(
    profile_id: int,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> list[VersionOut]:
    profile = _profile_or_404(database, profile_id, actor)
    return [
        VersionOut(version=entry.get("version", 0), actor=entry.get("actor"), at=entry.get("at"), status=entry.get("status"),
                   name=entry.get("name"), spec=MappingSpec(**entry["spec"]) if entry.get("spec") else None)
        for entry in profile.history or []
    ]


def _mapping_view(mapping) -> dict:
    return {"source": mapping.source.model_dump(exclude_none=True), "transform": mapping.transform,
            "options": mapping.options, "sources": [s.model_dump(exclude_none=True) for s in mapping.sources]}


@router.get("/profiles/{profile_id}/compare", response_model=CompareOut)
def compare_versions(
    profile_id: int,
    from_version: int,
    to_version: int,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> CompareOut:
    """What changed between two versions: each attribute's mapping added,
    removed or changed, and the profile-level settings."""

    profile = _profile_or_404(database, profile_id, actor)
    versions = {entry.get("version"): entry for entry in profile.history or [] if entry.get("spec")}
    missing = [v for v in (from_version, to_version) if v not in versions]
    if missing:
        raise HTTPException(status_code=404, detail=f"Version {missing[0]} has no recorded mappings.")
    before, after = MappingSpec(**versions[from_version]["spec"]), MappingSpec(**versions[to_version]["spec"])
    old = {m.column: _mapping_view(m) for m in before.mappings}
    new = {m.column: _mapping_view(m) for m in after.mappings}
    changes = []
    for column in sorted(set(old) | set(new)):
        if column not in old:
            changes.append(MappingChange(column=column, change="added", before=None, after=new[column]))
        elif column not in new:
            changes.append(MappingChange(column=column, change="removed", before=old[column], after=None))
        elif old[column] != new[column]:
            changes.append(MappingChange(column=column, change="changed", before=old[column], after=new[column]))
    settings = [
        label for label, a, b in (
            ("Row table", before.row_dataset, after.row_dataset),
            ("Key columns", before.key_columns, after.key_columns),
            ("Parent mapping", before.parent, after.parent),
            ("Name", versions[from_version].get("name"), versions[to_version].get("name")),
        ) if a != b
    ]
    return CompareOut(profile_id=profile.id, from_version=from_version, to_version=to_version, changes=changes, settings=settings)


@router.get("/profiles/{profile_id}/history", response_model=list[AuditEventOut])
def profile_history(
    profile_id: int,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> list[AuditEventOut]:
    profile = _profile_or_404(database, profile_id, actor)
    events = database.scalars(
        select(OracleMappingAuditEvent).where(OracleMappingAuditEvent.profile_id == profile.id)
        .order_by(OracleMappingAuditEvent.created_at.desc(), OracleMappingAuditEvent.id.desc())
    )
    return [AuditEventOut(action=e.action, profile_version=e.profile_version, actor_name=e.actor_name,
                          created_at=e.created_at, detail=e.detail) for e in events]


# ---------------------------------------------------------------- document-scoped


@documents_router.get("/{document_id}/oracle/fields", response_model=FieldsOut)
def document_fields(
    document_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("oracle.preview")),
) -> FieldsOut:
    """Every extracted field a template column can be filled from."""

    workbook = _workbook_or_404(database, document_id)
    return FieldsOut(
        document_id=document_id,
        staging_profile_id=_staging_profile_id(database, document_id),
        fields=catalogue(workbook),
    )


@documents_router.get("/{document_id}/oracle/clauses", response_model=ClausesOut)
def document_clauses(
    document_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("oracle.preview")),
) -> ClausesOut:
    """The clauses the document cites (number, title, FAR / DFARS family,
    contract, evidence), as a mapping source. They map only to a target
    whose verified schema has clause attributes."""

    records = clause_records(_workbook_or_404(database, document_id))
    families: dict[str, int] = {}
    for record in records:
        families[record.regulation_family] = families.get(record.regulation_family, 0) + 1
    return ClausesOut(document_id=document_id, clauses=records, families=families)


def _learned(
    database: Session, template: OracleTemplate, staging_profile_id: str | None, actor: ActorContext
) -> dict[str, SourceRef]:
    """Column → source from approved (active) mappings for the same import
    object and document type (newest wins). Drafts and archived profiles
    are not learned from."""

    statement = (
        select(OracleMappingProfile)
        .join(OracleTemplate, OracleTemplate.id == OracleMappingProfile.template_id)
        .where(func.lower(OracleTemplate.object_name) == template.object_name.lower())
        .where(OracleMappingProfile.status == "active")
        .order_by(OracleMappingProfile.updated_at.asc())
    )
    if staging_profile_id:
        statement = statement.where(OracleMappingProfile.staging_profile_id == staging_profile_id)
    learned: dict[str, SourceRef] = {}
    for profile in database.scalars(_visible(statement, OracleMappingProfile, actor)):
        for mapping in profile.mappings or []:
            source = SourceRef(**mapping.get("source", {}))
            if source.kind != "none":
                learned[str(mapping.get("column", "")).strip().lower()] = source
    return learned


@documents_router.post("/{document_id}/oracle/templates/{template_id}/suggest", response_model=SuggestOut)
def suggest_mapping(
    document_id: str,
    template_id: int,
    payload: SuggestIn,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("oracle.preview")),
) -> SuggestOut:
    """Proposed sources per column, each with its method and score. A
    proposal is not a mapping until someone saves it."""

    template = _template_or_404(database, template_id, actor)
    workbook = _workbook_or_404(database, document_id)
    learned = _learned(database, template, _staging_profile_id(database, document_id), actor)
    suggestions, row_dataset = suggest(
        template.columns, catalogue(workbook), learned, payload.row_dataset, template.object_name
    )
    links: list[tuple[str, str]] = []
    if payload.parent_profile_id is not None:
        parent = _profile_or_404(database, payload.parent_profile_id, actor)
        parent_template = _template_or_404(database, parent.template_id, actor)
        links = suggest_links(
            [c["technical_name"] for c in template.columns], [c["technical_name"] for c in parent_template.columns]
        )
    return SuggestOut(template_id=template.id, row_dataset=row_dataset, suggestions=suggestions, parent_links=links)


@documents_router.post("/{document_id}/oracle/templates/{template_id}/preview", response_model=PreviewOut)
def preview_mapping(
    document_id: str,
    template_id: int,
    payload: PreviewIn,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("oracle.preview")),
) -> PreviewOut:
    template = _template_or_404(database, template_id, actor)
    workbook = _workbook_or_404(database, document_id)
    built, issues = _checked(database, workbook, template, payload.spec, actor)
    used = {
        (m.source.dataset_id, m.source.field, m.source.pair_key)
        for m in payload.spec.mappings
        if m.source.kind == "field"
    }
    unmapped = [f for f in catalogue(workbook) if (f.ref.dataset_id, f.ref.field, f.ref.pair_key) not in used]
    parent: ParentPreviewOut | None = None
    if payload.spec.parent is not None:
        try:
            parent_profile = _profile_or_404(database, payload.spec.parent.profile_id, actor)
            parent_template = _template_or_404(database, parent_profile.template_id, actor)
            parent_built = build_rows(workbook, parent_template.columns, _profile_out(parent_profile).spec)
            parent = ParentPreviewOut(
                profile_id=parent_profile.id, name=parent_profile.name, headers=parent_built.headers,
                rows=[[PreviewCell(**cell.model_dump()) for cell in row] for row in parent_built.rows[:_PREVIEW_ROWS]],
                total_rows=len(parent_built.rows),
            )
        except (HTTPException, ValueError):
            parent = None
    return PreviewOut(
        template_id=template.id,
        headers=built.headers,
        display_labels=[column.get("display_label") for column in template.columns],
        rows=[[PreviewCell(**cell.model_dump()) for cell in row] for row in built.rows[:_PREVIEW_ROWS]],
        total_rows=len(built.rows),
        issues=issues[:_MAX_ISSUES],
        issue_counts=_counts(issues),
        import_ready=import_ready(issues),
        unmapped_fields=unmapped,
        column_states=column_states(template.columns, payload.spec, issues),
        transforms={m.column: explain(m) for m in payload.spec.mappings if m.source.kind != "none"},
        schema_status=target_catalog.status_of(template, _newer_version(database, template, actor))[0],
        parent=parent,
    )


@documents_router.post("/{document_id}/oracle/templates/{template_id}/export")
def export_csv(
    document_id: str,
    template_id: int,
    payload: ExportIn,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("oracle.preview")),
) -> Response:
    """The import CSV: the template's exact header strings in its order,
    then one line per row. Refused (409) while validation finds errors,
    unless ``force`` is set."""

    template = _template_or_404(database, template_id, actor)
    if target_catalog.catalog_of(template)["integration_method"] == "rest":
        raise HTTPException(status_code=409, detail="A REST target has no import file; it is mapped and previewed only.")
    workbook = _workbook_or_404(database, document_id)
    built, issues = _checked(database, workbook, template, payload.spec, actor)
    ready = import_ready(issues)
    if not ready and not payload.force:
        raise HTTPException(
            status_code=409,
            detail={"message": "Validation found errors; the file is not import-ready.", "issue_counts": _counts(issues)},
        )
    content = write_csv(built.headers, [[cell.value for cell in row] for row in built.rows])
    _audit(
        database,
        document_id,
        actor,
        "generated" if ready else "generated_with_errors",
        {"template_id": template.id, "template_version": template.version, "rows": len(built.rows),
         "sha256": hashlib.sha256(content).hexdigest()},
        f"Oracle import CSV for {template.object_name} v{template.version}",
    )
    database.commit()
    return Response(
        content=content,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": attachment_header(_export_name(template)),
            "X-Import-Ready": "true" if ready else "false",
        },
    )


@documents_router.post("/{document_id}/oracle/export-bundle")
def export_bundle(
    document_id: str,
    payload: BundleIn,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("oracle.preview")),
) -> Response:
    """Several saved mappings' files for one document in one ZIP, each named
    after its template file (e.g. Contract.csv, Contract_Line.csv)."""

    workbook = _workbook_or_404(database, document_id)
    archive = io.BytesIO()
    summary: list[dict] = []
    all_ready = True
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
        names: set[str] = set()
        for profile_id in payload.profile_ids:
            profile = _profile_or_404(database, profile_id, actor)
            template = _template_or_404(database, profile.template_id, actor)
            built, issues = _checked(database, workbook, template, _profile_out(profile).spec, actor)
            ready = import_ready(issues)
            all_ready = all_ready and ready
            name = _export_name(template)
            if name in names:
                name = f"{name[:-4]}_{template.version}.csv"
            names.add(name)
            bundle.writestr(name, write_csv(built.headers, [[cell.value for cell in row] for row in built.rows]))
            summary.append({"file": name, "profile_id": profile.id, "profile_version": profile.version,
                            "template_id": template.id, "rows": len(built.rows), "import_ready": ready,
                            "issue_counts": _counts(issues)})
    if not all_ready and not payload.force:
        raise HTTPException(
            status_code=409,
            detail={"message": "Validation found errors in at least one file.", "files": summary},
        )
    _audit(database, document_id, actor, "generated" if all_ready else "generated_with_errors",
           {"bundle": summary}, "Oracle import bundle")
    database.commit()
    stem = re.sub(r"[^\w\- .]+", "_", (workbook.document_filename or "document").rsplit(".", 1)[0]).strip(" .")
    return Response(
        content=archive.getvalue(),
        media_type="application/zip",
        headers={
            "Content-Disposition": attachment_header(f"{stem or 'document'}_oracle_import.zip"),
            "X-Import-Ready": "true" if all_ready else "false",
        },
    )
