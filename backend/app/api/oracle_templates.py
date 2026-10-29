"""Oracle Fusion Template Manager and mapping API.

Templates are configuration (``/api/oracle/...``): uploading or retiring one
needs ``admin.integrations``; reading needs ``documents.view``. Mappings,
previews and exports work on a document (``/api/documents/{id}/oracle/...``,
mounted with document isolation) and need ``oracle.preview``. Nothing here
contacts Oracle: files are generated for a person to load.
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
from app.models.oracle_template import OracleMappingProfile, OracleTemplate
from app.oracle_templates.mapping import (
    BuiltRows,
    Issue,
    MappingSpec,
    SourceField,
    SourceRef,
    Suggestion,
    build_rows,
    catalogue,
    import_ready,
    suggest,
    suggest_links,
    validate,
    write_csv,
)
from app.oracle_templates.parser import MAX_TEMPLATE_BYTES, TemplateError, parse_template
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


class ProfileIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    staging_profile_id: str | None = Field(default=None, max_length=80)
    spec: MappingSpec
    notes: str | None = Field(default=None, max_length=2000)


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


def _template_out(template: OracleTemplate, profile_count: int = 0) -> TemplateOut:
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
    )


def _profile_out(profile: OracleMappingProfile) -> ProfileOut:
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
    )


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
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("admin.integrations")),
) -> TemplateOut:
    """Stores the file exactly as uploaded and records its parsed columns.
    Re-uploading identical bytes returns the existing template."""

    data = await file.read(MAX_TEMPLATE_BYTES + 1)
    filename = (file.filename or "template.csv").rsplit("/", 1)[-1].rsplit("\\", 1)[-1][:255]
    try:
        parsed = parse_template(filename, data, sheet=(sheet or None))
    except TemplateError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

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
        columns=[
            {
                "position": column.position,
                "technical_name": column.technical_name,
                "display_label": column.display_label,
                "required": column.required,
            }
            for column in parsed.columns
        ],
        warnings=parsed.warnings,
        environment=(environment or "").strip() or None,
        status="active",
        owner_workspace=workspace,
        uploaded_by=actor.display_name,
    )
    database.add(template)
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
    counts = dict(
        database.execute(
            select(OracleMappingProfile.template_id, func.count())
            .where(OracleMappingProfile.template_id.in_([t.id for t in templates] or [-1]))
            .group_by(OracleMappingProfile.template_id)
        ).all()
    )
    return [_template_out(template, counts.get(template.id, 0)) for template in templates]


@router.get("/templates/{template_id}", response_model=TemplateOut)
def get_template(
    template_id: int,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> TemplateOut:
    return _template_out(_template_or_404(database, template_id, actor))


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
    database.commit()
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
    return [_profile_out(profile) for profile in profiles]


@router.get("/profiles", response_model=list[ProfileOut])
def list_all_profiles(
    staging_profile_id: str | None = None,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> list[ProfileOut]:
    statement = select(OracleMappingProfile).order_by(OracleMappingProfile.updated_at.desc())
    if staging_profile_id:
        statement = statement.where(OracleMappingProfile.staging_profile_id == staging_profile_id)
    return [_profile_out(p) for p in database.scalars(_visible(statement, OracleMappingProfile, actor))]


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
    entry = {"version": profile.version, "actor": actor.display_name, "at": datetime.now(timezone.utc).isoformat()}
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
    )
    profile.history = _history(profile, actor)
    database.add(profile)
    database.commit()
    database.refresh(profile)
    return _profile_out(profile)


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
    profile.version += 1
    profile.updated_by = actor.display_name
    profile.updated_at = datetime.now(timezone.utc)
    profile.history = _history(profile, actor)
    database.commit()
    database.refresh(profile)
    return _profile_out(profile)


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


def _learned(
    database: Session, template: OracleTemplate, staging_profile_id: str | None, actor: ActorContext
) -> dict[str, SourceRef]:
    """Column → source from saved mappings for the same import object and
    document type (newest first wins)."""

    statement = (
        select(OracleMappingProfile)
        .join(OracleTemplate, OracleTemplate.id == OracleMappingProfile.template_id)
        .where(func.lower(OracleTemplate.object_name) == template.object_name.lower())
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
