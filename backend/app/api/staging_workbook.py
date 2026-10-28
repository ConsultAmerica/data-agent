"""Professional Staging Workbook API — the primary Results surface.

Permissions mirror v3_export.py: reading the workbook needs documents.view;
downloading exports needs export.read.
"""

from __future__ import annotations

import gzip
import re

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.downloads import attachment_header, excel_csv
from app.core.auth import ActorContext, require_permission
from app.database.dependencies import get_database
from app.models.document import Document
from app.source_structure.models import (
    FieldCandidate,
    StructuredRegion,
    StructuredSourceDocument,
    TableCandidate,
)
from app.source_structure.service import get_or_build_source_structure, page_transcript
from app.staging import registry
from app.staging.engine import profile_descriptor
from app.staging.document_labels import document_labels
from app.staging.custom_export import CustomExportManifest, build_custom_export
from app.staging.export import build_dataset_csv, build_profile_xlsx, build_workbook_xlsx, find_dataset
from app.staging.models import ProfileDescriptor, StagingRecord, StagingWorkbook
from app.staging.selection_export import (
    FieldSelectionManifest,
    SelectionError,
    SelectionManifest,
    build_selected_export,
    build_selected_fields_export,
)
from app.staging.service import (
    compact_for_grid,
    get_staging_record,
    get_staging_workbook,
    pinned_profile,
)

router = APIRouter()
profiles_router = APIRouter()


def _workbook_or_404(database: Session, document_id: str) -> StagingWorkbook:
    try:
        return get_staging_workbook(database, document_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


# Large workbooks (e.g. FAR Part 52: ~1,000 records) are gzip-encoded when
# the client accepts it; the decoded body is identical.
_GZIP_MIN_BYTES = 256 * 1024


# Workbook handlers are plain functions: FastAPI runs them in its thread
# pool, so building a workbook (or a contract's first-open structure
# rebuild) never blocks other requests on the event loop.
@router.get("/{document_id}/staging-workbook", response_model=StagingWorkbook)
def read_staging_workbook(
    document_id: str,
    request: Request,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> Response:
    workbook = compact_for_grid(_workbook_or_404(database, document_id))
    body = workbook.model_dump_json().encode()
    headers = {"Vary": "Accept-Encoding"}
    if len(body) >= _GZIP_MIN_BYTES and "gzip" in request.headers.get("accept-encoding", "").lower():
        body = gzip.compress(body, compresslevel=5)
        headers["Content-Encoding"] = "gzip"
    return Response(content=body, media_type="application/json", headers=headers)


@router.get(
    "/{document_id}/staging-workbook/datasets/{dataset_id}/records/{record_id:path}",
    response_model=StagingRecord,
)
def read_staging_record(
    document_id: str,
    dataset_id: str,
    record_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> StagingRecord:
    """Every cell of one record — the detail view of a compact grid row."""

    try:
        record = get_staging_record(database, document_id, dataset_id, record_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if record is None:
        raise HTTPException(status_code=404, detail=f"Record {record_id!r} not found in {dataset_id!r}.")
    return record


@router.get("/{document_id}/staging-profile", response_model=ProfileDescriptor)
def read_staging_profile(
    document_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> ProfileDescriptor:
    """The document's pinned profile — its presentation and exports —
    without building the workbook (a FAR source has ~1,000 records)."""

    document = database.get(Document, document_id)
    if document is None:
        raise HTTPException(status_code=404, detail=f"Document {document_id} not found.")
    return profile_descriptor(pinned_profile(database, document), document_id)


@router.get("/{document_id}/staging-workbook/export.xlsx")
def export_staging_workbook_xlsx(
    document_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("export.read")),
) -> Response:
    workbook = _workbook_or_404(database, document_id)
    filename = f"{workbook.document_filename.rsplit('.', 1)[0]}_staging.xlsx"
    profile = registry.get_profile(workbook.profile.profile_id, workbook.profile.profile_version)
    if profile is not None and profile.export_sheets:
        # The profile's own workbook, from the same staged values.
        document = database.get(Document, document_id)
        content = build_profile_xlsx(workbook, profile.export_sheets, document_labels(database, document))
    else:
        content = build_workbook_xlsx(workbook)
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": attachment_header(filename)},
    )


@router.get("/{document_id}/staging-workbook/export.json")
def export_staging_workbook_json(
    document_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("export.read")),
) -> Response:
    """The full workbook as JSON — every record with every cell, its
    provenance and checks (the browser view is compacted for its grids)."""
    workbook = _workbook_or_404(database, document_id)
    filename = f"{workbook.document_filename.rsplit('.', 1)[0]}_staging.json"
    return Response(
        content=workbook.model_dump_json(indent=1),
        media_type="application/json",
        headers={"Content-Disposition": attachment_header(filename)},
    )


@router.get("/{document_id}/staging-workbook/datasets/{dataset_id}.csv")
def export_staging_dataset_csv(
    document_id: str,
    dataset_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("export.read")),
) -> Response:
    workbook = _workbook_or_404(database, document_id)
    dataset = find_dataset(workbook, dataset_id)
    if dataset is None:
        valid = ", ".join(d.dataset_id for d in workbook.datasets)
        raise HTTPException(
            status_code=404, detail=f"Unknown dataset {dataset_id!r}. Valid: {valid}"
        )
    return Response(
        content=excel_csv(build_dataset_csv(dataset)),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": attachment_header(f"{dataset_id}.csv")},
    )


@router.post("/{document_id}/staging-workbook/datasets/{dataset_id}/export-selected")
def export_staging_selection(
    document_id: str,
    dataset_id: str,
    manifest: SelectionManifest,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("export.read")),
) -> Response:
    """The cells a reviewer selected in a grid. The manifest names records
    and fields only; values are read from the persisted staging workbook
    (as Export All reads them — nothing is re-extracted). Records outside
    this document's dataset and non-business fields are rejected."""

    workbook = _workbook_or_404(database, document_id)
    if find_dataset(workbook, dataset_id) is None:
        raise HTTPException(status_code=404, detail=f"Unknown dataset {dataset_id!r}.")
    try:
        content, media_type, filename = build_selected_export(workbook, dataset_id, manifest)
    except SelectionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if manifest.format == "csv":
        content, media_type = excel_csv(content), "text/csv; charset=utf-8"
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": attachment_header(filename)},
    )


@router.post("/{document_id}/staging-workbook/export-selected-fields")
def export_staging_field_selection(
    document_id: str,
    manifest: FieldSelectionManifest,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("export.read")),
) -> Response:
    """Values a reviewer selected in a label / value list (Supplier, Bill-To,
    Charges & Totals), as one Section | Field | Value table. Like a grid
    selection, the manifest names (dataset, record, field) only; labels and
    values are read from the persisted staging workbook."""

    workbook = _workbook_or_404(database, document_id)
    try:
        content, media_type, filename = build_selected_fields_export(workbook, manifest)
    except SelectionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if manifest.format == "csv":
        content, media_type = excel_csv(content), "text/csv; charset=utf-8"
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": attachment_header(filename)},
    )


@router.post("/{document_id}/staging-workbook/export-custom")
def export_staging_custom(
    document_id: str,
    manifest: CustomExportManifest,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("export.read")),
) -> Response:
    """A reviewer-defined import file: chosen fields under their own labels,
    combined where asked, one row per table record (or one row). The
    manifest names fields by id; values come from the staging workbook."""

    workbook = _workbook_or_404(database, document_id)
    try:
        content, media_type, filename = build_custom_export(workbook, manifest)
    except SelectionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if manifest.format == "csv":
        content, media_type = excel_csv(content), "text/csv; charset=utf-8"
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": attachment_header(filename)},
    )


@router.get("/{document_id}/staging-workbook/exports/{export_id}")
def export_staging_profile_artifact(
    document_id: str,
    export_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("export.read")),
) -> Response:
    """Profile-specific exports (StagingProfile.exporter), addressed by the
    ids the profile declares in its export capabilities."""

    document = database.get(Document, document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found.")
    profile = pinned_profile(database, document)
    artifact = profile.exporter(database, document, export_id) if profile.exporter is not None else None
    if artifact is None:
        raise HTTPException(status_code=404, detail=f"Unknown export {export_id!r} for this document.")
    csv_artifact = artifact.media_type == "text/csv"
    return Response(
        content=excel_csv(artifact.content) if csv_artifact else artifact.content,
        media_type="text/csv; charset=utf-8" if csv_artifact else artifact.media_type,
        headers={"Content-Disposition": attachment_header(artifact.filename)},
    )


@profiles_router.get("", response_model=list[ProfileDescriptor])
async def list_staging_profiles(
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> list[ProfileDescriptor]:
    return [profile_descriptor(p, "{document_id}") for p in registry.all_profiles()]


class RegionContext(BaseModel):
    """Everything needed to show where a staging value came from without
    rendering the source: the region, its label/value candidate, or its
    table with the originating cell marked."""

    region: StructuredRegion | None = None
    field: FieldCandidate | None = None
    table: TableCandidate | None = None
    row_index: int | None = None
    column_index: int | None = None


_CELL_ID = re.compile(r"^(?P<table>.+):r(?P<row>\d+)(?::c(?P<col>\d+))?$")


@router.get("/{document_id}/source-structure", response_model=StructuredSourceDocument)
def read_source_structure(
    document_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> StructuredSourceDocument:
    document = database.get(Document, document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found.")
    return get_or_build_source_structure(database, document)


@router.get("/{document_id}/pages/{page_number}/transcript")
def read_page_transcript(
    document_id: str,
    page_number: int,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> dict:
    """The user-facing transcript of one page, in reconstructed reading
    order (source_structure/reading_order.py). Raw OCR text stays on the
    pages endpoint for diagnostics."""

    document = database.get(Document, document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found.")
    try:
        return page_transcript(database, document, page_number)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get(
    "/{document_id}/source-structure/regions/{region_id:path}",
    response_model=RegionContext,
)
def read_region_context(
    document_id: str,
    region_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> RegionContext:
    document = database.get(Document, document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found.")
    structure = get_or_build_source_structure(database, document)

    cell = _CELL_ID.match(region_id)
    if cell:
        table = next((t for t in structure.table_candidates if t.candidate_id == cell.group("table")), None)
        if table is not None:
            return RegionContext(
                table=table,
                row_index=int(cell.group("row")),
                column_index=int(cell.group("col")) if cell.group("col") else None,
            )
    field = next(
        (
            f
            for f in structure.field_candidates
            if f.candidate_id == region_id or region_id in f.source_region_ids
        ),
        None,
    )
    region = next((r for r in structure.regions if r.region_id == region_id), None)
    table = next((t for t in structure.table_candidates if t.region_id == region_id), None)
    if field is None and region is None and table is None:
        raise HTTPException(status_code=404, detail=f"Region {region_id!r} not found.")
    return RegionContext(region=region, field=field, table=table)
