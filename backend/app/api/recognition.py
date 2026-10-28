"""Recognition engine API: the configured providers, and running a
strategy over one document (app/recognition/engine.py).

Running returns grounded, merged field candidates with their evidence and
every step's outcome; it records RecognitionRun rows but writes nothing
into the staging workbook — reviewed staging stays the single source of
exported values."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import ActorContext, require_permission
from app.core.config import get_settings
from app.database.dependencies import get_database
from app.models.document import Document
from app.models.document_staging_workbook import DocumentStagingWorkbook
from app.recognition.engine import EngineOutcome, RecognitionEngine
from app.recognition.providers.base import guess_mime
from app.recognition.registry import build_providers
from app.recognition.strategies import Condition, StrategyStep, strategy_for, wanted_fields
from app.services.document_storage import DocumentStorageError, ensure_local_copy
from app.staging import registry as profiles

router = APIRouter()
documents_router = APIRouter()


class ProviderStatus(BaseModel):
    id: str
    locality: str
    capabilities: list[str]
    configured: bool
    detail: str
    model: str | None
    version: str | None


@router.get("/providers", response_model=list[ProviderStatus])
async def list_providers(
    actor: ActorContext = Depends(require_permission("extraction.run")),
) -> list[ProviderStatus]:
    settings = get_settings()
    statuses = []
    for provider_id, provider in build_providers(settings).items():
        configured, detail = provider.configured(settings)
        info = provider.model_info()
        statuses.append(
            ProviderStatus(
                id=provider_id,
                locality=provider.locality,
                capabilities=sorted(provider.capabilities),
                configured=configured,
                detail=detail,
                model=info.model,
                version=info.version,
            )
        )
    return statuses


class StepRequest(BaseModel):
    provider: str = Field(min_length=1, max_length=40)
    when: Condition = "always"
    timeout_s: float = Field(default=60.0, gt=0, le=600)
    max_attempts: int = Field(default=1, ge=1, le=3)
    required: bool = False


class RecognizeRequest(BaseModel):
    # Omit to use the document's profile strategy.
    strategy: list[StepRequest] | None = Field(default=None, max_length=10)
    wanted_fields: list[str] | None = Field(default=None, max_length=100)
    pages: list[int] | None = Field(default=None, max_length=50)


class EvidenceOut(BaseModel):
    page: int
    text: str
    bbox: list[float] | None = None
    coord_space: str | None = None


class CandidateOut(BaseModel):
    provider: str
    value: str
    normalized_value: str | None
    confidence: float | None
    locally_confirmed: bool
    evidence: list[EvidenceOut]


class FieldOut(BaseModel):
    canonical_field: str
    value: str
    status: str
    candidates: list[CandidateOut]


class RejectedOut(BaseModel):
    provider: str
    canonical_field: str | None
    value: str
    reason: str


class StepOut(BaseModel):
    provider: str
    status: str
    reason: str | None
    attempts: int
    duration_ms: int
    pages: int
    estimated_cost_usd: float | None
    model: str | None


class RecognizeResponse(BaseModel):
    run_id: str
    data_class: str
    profile: str | None
    text_pages: int
    steps: list[StepOut]
    fields: list[FieldOut]
    rejected: list[RejectedOut]
    estimated_cost_usd: float
    failed_required: bool


def _evidence(candidate) -> list[EvidenceOut]:
    return [
        EvidenceOut(page=s.page, text=s.text, bbox=list(s.bbox) if s.bbox else None, coord_space=s.coord_space)
        for s in candidate.evidence
    ]


def _response(outcome: EngineOutcome, profile_key: str | None) -> RecognizeResponse:
    return RecognizeResponse(
        run_id=outcome.run_id,
        data_class=outcome.data_class,
        profile=profile_key,
        text_pages=len(outcome.local_text()),
        steps=[StepOut(**vars(step)) for step in outcome.steps],
        fields=[
            FieldOut(
                canonical_field=merged.canonical_field,
                value=merged.value,
                status=merged.status,
                candidates=[
                    CandidateOut(
                        provider=c.provider,
                        value=c.candidate.value,
                        normalized_value=c.candidate.normalized_value,
                        confidence=c.candidate.confidence,
                        locally_confirmed=c.locally_confirmed,
                        evidence=_evidence(c.candidate),
                    )
                    for c in merged.candidates
                ],
            )
            for merged in outcome.fields
        ],
        rejected=[
            RejectedOut(
                provider=r.provider,
                canonical_field=r.candidate.canonical_field,
                value=r.candidate.value,
                reason=r.reason,
            )
            for r in outcome.rejected
        ],
        estimated_cost_usd=outcome.estimated_cost_usd,
        failed_required=outcome.failed_required,
    )


@documents_router.post("/{document_id}/recognize", response_model=RecognizeResponse)
async def recognize_document(
    document_id: str,
    payload: RecognizeRequest,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("extraction.run")),
) -> RecognizeResponse:
    document = database.get(Document, document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found.")
    settings = get_settings()
    try:
        file_path = await run_in_threadpool(ensure_local_copy, settings, stored_filename=document.stored_filename)
    except DocumentStorageError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    record = database.scalars(
        select(DocumentStagingWorkbook).where(DocumentStagingWorkbook.document_id == document.id)
    ).first()
    profile = profiles.get_profile(record.profile_id, record.profile_version) if record else None
    strategy = (
        tuple(StrategyStep(**step.model_dump()) for step in payload.strategy)
        if payload.strategy
        else strategy_for(profile)
    )
    fields = tuple(payload.wanted_fields) if payload.wanted_fields is not None else wanted_fields(profile)

    engine = RecognitionEngine(build_providers(settings), settings)
    outcome = await engine.run(
        database=database,
        document=document,
        file_path=str(file_path),
        mime_type=document.content_type or guess_mime(file_path),
        strategy=strategy,
        wanted_fields=fields,
        profile_key=profile.key if profile else None,
        pages=tuple(payload.pages) if payload.pages else None,
    )
    database.commit()
    return _response(outcome, profile.key if profile else None)
