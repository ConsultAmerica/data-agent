from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
)
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.errors import STRUCTURE_DETECTION_FAILED, TARGET_NOT_FOUND, http_error
from app.database.dependencies import (
    get_database,
)
from app.models.document import Document
from app.models.document_page import DocumentPage
from app.schemas.document_target import (
    CreateCustomTargetRequest,
    DiscoverSchemaResponse,
    DocumentTarget,
    ExtractTargetsRequest,
    ExtractTargetsResponse,
    RenameCustomTargetRequest,
)
from app.schemas.structure_detection import (
    StructureDetectionResponse,
)
from app.schemas.universal_extraction import (
    UniversalExtractionRequest,
    UniversalExtractionResponse,
)
from app.staging.document_categories import document_category
from app.services.ai_enrichment import start_session
from app.services.ai_provider_factory import (
    create_ai_provider,
)
from app.services.detected_target_store import (
    CustomTargetError,
    add_custom_target,
    delete_custom_target,
    load_document_targets,
    persist_document_targets,
    rename_custom_target,
)
from app.services.ingestion_provenance import merge_provenance
from app.services.processing_versions import (
    persisted_discovery_is_fresh,
    processing_versions_payload,
)
from app.services.target_result_store import (
    load_persisted_extract_results,
    persist_target_extraction_results,
)
from app.services.schema_discovery import discover_document_schema
from app.services.structure_detection import (
    detect_document_structures,
)
from app.services.target_extraction_service import extract_by_targets
from app.services.universal_extraction_service import (
    universal_extract,
)


router = APIRouter()
settings = get_settings()


@router.post(
    "/{document_id}/extract",
    response_model=(
        UniversalExtractionResponse
    ),
)
async def extract_anything(
    document_id: str,
    request: UniversalExtractionRequest,
    database: Session = Depends(
        get_database
    ),
) -> UniversalExtractionResponse:

    document = database.get(
        Document,
        document_id,
    )

    if document is None:

        raise HTTPException(
            status_code=404,
            detail="Document not found.",
        )

    if (
        document.processing_status
        not in {
            "completed",
            "completed_with_warnings",
        }
    ):

        raise HTTPException(
            status_code=409,
            detail=(
                "Run page extraction "
                "before universal extraction."
            ),
        )

    ai_provider = start_session(
        create_ai_provider(settings), settings, database=database, document=document
    )

    return await universal_extract(
        database=database,
        document=document,
        instruction=request.instruction,
        max_pages=min(
            request.max_pages,
            settings.ai_max_pages,
        ),
        use_ai_fallback=(
            request.use_ai_fallback
            and settings.ai_fallback_enabled
        ),
        ai_provider=ai_provider,
    )


@router.post(
    "/{document_id}/detect-structures",
    response_model=StructureDetectionResponse,
)
async def detect_structures(
    document_id: str,
    database: Session = Depends(get_database),
) -> StructureDetectionResponse:

    document = database.get(Document, document_id)

    if document is None:
        raise HTTPException(
            status_code=404,
            detail="Document not found.",
        )

    if document.processing_status not in {
        "completed",
        "completed_with_warnings",
    }:
        raise HTTPException(
            status_code=409,
            detail=(
                "Run page extraction "
                "before detecting document structures."
            ),
        )

    pages = list(
        database.scalars(
            select(DocumentPage)
            .where(DocumentPage.document_id == document_id)
            .order_by(DocumentPage.page_number)
        )
    )

    ai_provider = start_session(
        create_ai_provider(settings), settings, database=database, document=document
    )

    return await detect_document_structures(
        document=document,
        pages=pages,
        ai_provider=ai_provider,
    )


def _load_document_or_404(database: Session, document_id: str) -> Document:
    document = database.get(Document, document_id)
    if document is None:
        raise http_error(404, TARGET_NOT_FOUND, "Document not found.")
    return document


@router.post(
    "/{document_id}/discover-schema",
    response_model=DiscoverSchemaResponse,
)
async def discover_schema(
    document_id: str,
    force: bool = Query(
        False,
        description="Force rediscovery even when persisted targets exist.",
    ),
    database: Session = Depends(get_database),
) -> DiscoverSchemaResponse:

    document = _load_document_or_404(database, document_id)

    if document.processing_status not in {
        "completed",
        "completed_with_warnings",
    }:
        raise http_error(
            409,
            STRUCTURE_DETECTION_FAILED,
            "Run page extraction before schema discovery.",
        )

    if not force:
        cached = load_document_targets(
            database=database, document_id=document_id
        )
        if (
            cached is not None
            and cached.targets
            and persisted_discovery_is_fresh(document)
        ):
            return cached

    pages = list(
        database.scalars(
            select(DocumentPage)
            .where(DocumentPage.document_id == document_id)
            .order_by(DocumentPage.page_number)
        )
    )

    ai_provider = start_session(
        create_ai_provider(settings), settings, database=database, document=document
    )

    try:
        result = await discover_document_schema(
            document=document,
            pages=pages,
            ai_provider=ai_provider,
        )
    except Exception as exc:
        import logging

        logging.getLogger(__name__).exception(
            "discover-schema failed for document %s", document_id
        )
        raise http_error(
            500,
            STRUCTURE_DETECTION_FAILED,
            "Schema discovery failed.",
        ) from exc

    persist_document_targets(database=database, result=result)
    merge_provenance(
        document,
        {
            **processing_versions_payload(document=document),
            "targets_discovered": len(result.targets),
            "discovery_reused": False,
        },
    )
    database.commit()

    return result


@router.get(
    "/{document_id}/targets",
    response_model=DiscoverSchemaResponse,
)
async def get_targets(
    document_id: str,
    database: Session = Depends(get_database),
) -> DiscoverSchemaResponse:

    document = _load_document_or_404(database, document_id)

    result = load_document_targets(database=database, document_id=document_id)

    if result is None:
        raise http_error(
            404,
            TARGET_NOT_FOUND,
            "No discovered targets yet. Call discover-schema first.",
        )

    # Lets an intake queue group the file by category before it is staged.
    return result.model_copy(update=document_category(database, document))


@router.post(
    "/{document_id}/targets/custom",
    response_model=DocumentTarget,
    status_code=201,
)
async def create_custom_target(
    document_id: str,
    request: CreateCustomTargetRequest,
    database: Session = Depends(get_database),
) -> DocumentTarget:
    _load_document_or_404(database, document_id)

    try:
        return add_custom_target(
            database=database,
            document_id=document_id,
            label=request.label,
            target_type=request.target_type,
        )
    except CustomTargetError as exc:
        raise http_error(409, TARGET_NOT_FOUND, str(exc)) from exc


@router.patch(
    "/{document_id}/targets/custom/{target_key}",
    response_model=DocumentTarget,
)
async def rename_custom_target_endpoint(
    document_id: str,
    target_key: str,
    request: RenameCustomTargetRequest,
    database: Session = Depends(get_database),
) -> DocumentTarget:
    _load_document_or_404(database, document_id)

    try:
        return rename_custom_target(
            database=database,
            document_id=document_id,
            target_key=target_key,
            label=request.label,
        )
    except CustomTargetError as exc:
        raise http_error(404, TARGET_NOT_FOUND, str(exc)) from exc


@router.delete(
    "/{document_id}/targets/custom/{target_key}",
    status_code=204,
)
async def delete_custom_target_endpoint(
    document_id: str,
    target_key: str,
    database: Session = Depends(get_database),
) -> None:
    _load_document_or_404(database, document_id)

    try:
        delete_custom_target(
            database=database,
            document_id=document_id,
            target_key=target_key,
        )
    except CustomTargetError as exc:
        raise http_error(404, TARGET_NOT_FOUND, str(exc)) from exc


@router.get(
    "/{document_id}/extract-results",
    response_model=ExtractTargetsResponse,
)
async def get_extract_results(
    document_id: str,
    database: Session = Depends(get_database),
) -> ExtractTargetsResponse:
    """Return durable targeted-extraction results without re-running extract.

    Reopen after restart must use this path — not jobs/extract — unless the
    user explicitly requests reprocess.
    """

    _load_document_or_404(database, document_id)
    result = load_persisted_extract_results(
        database=database,
        document_id=document_id,
    )
    if result is None:
        raise HTTPException(
            status_code=404,
            detail=(
                "No persisted extraction results for this document yet. "
                "Run targeted extraction first."
            ),
        )
    return result


@router.post(
    "/{document_id}/extract-targets",
    response_model=ExtractTargetsResponse,
)
async def extract_targets(
    document_id: str,
    request: ExtractTargetsRequest,
    database: Session = Depends(get_database),
) -> ExtractTargetsResponse:

    document = _load_document_or_404(database, document_id)

    ai_provider = start_session(
        create_ai_provider(settings), settings, database=database, document=document
    )

    result = await extract_by_targets(
        database=database,
        document=document,
        target_ids=request.target_ids,
        use_ai_fallback=(
            request.use_ai_fallback and settings.ai_fallback_enabled
        ),
        ai_provider=ai_provider,
    )
    persist_target_extraction_results(
        database=database,
        document_id=document_id,
        scalars=result.scalars,
        tables=result.tables,
        extraction_job_id=None,
    )
    result.ai_enrichment = ai_provider.summary()
    return result
