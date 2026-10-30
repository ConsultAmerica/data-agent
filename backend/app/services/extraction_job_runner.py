import asyncio
from datetime import datetime, timezone
import time

from fastapi.concurrency import run_in_threadpool
from sqlalchemy import select

from app.core.config import get_settings
from app.core.observability import bind_job_context, log_event
from app.database.session import SessionLocal
from app.models.document import Document
from app.models.document_page import DocumentPage
from app.models.extraction_job import ExtractionJob
from app.services.job_recovery import start_heartbeat, stop_heartbeat
from app.services.job_metrics import job_metrics, queue_wait_ms
from app.services.ai_provider_factory import create_ai_provider
from app.services.detected_target_store import (
    load_document_targets,
    persist_document_targets,
)
from app.services.document_extraction import (
    DocumentExtractionError,
    process_document_pages,
    summarize_stored_pages,
)
from app.services.document_storage import (
    DocumentStorageError,
    ensure_local_copy,
)
from app.services.ingestion_provenance import merge_provenance
from app.services.processing_versions import (
    can_reuse_pages_without_source,
    discovery_artifacts_reusable,
    pages_artifacts_reusable,
    processing_versions_payload,
)
from app.services.schema_discovery import discover_document_schema
from app.services.ai_enrichment import start_session
from app.services.target_extraction_service import extract_by_targets
from app.services.target_result_store import (
    clear_stale_target_values,
    persist_target_extraction_results,
)
from app.services.v3_orchestrator import run_and_persist_v3_extraction
from app.staging.preparation import prepare_staging
from app.staging.resolver import recognize_document_profile
from app.schemas.document_target import ScalarTargetResult, TableTargetResult

settings = get_settings()

# extract_by_targets resolves each batch's fields against one shared
# document context; kept well under the request-schema's former cap so a
# single job can accept an unbounded target_id list from the frontend.
EXTRACTION_BATCH_SIZE = 50

EMPTY_STRUCTURES_WARNING = (
    "Processing completed, but no extractable structures were detected."
)


def run_in_worker_thread(job_runner, *args) -> None:
    """BackgroundTasks entry point for the async job runners below.

    The runners do long stretches of synchronous work (DB writes, regex
    extraction over multi-MB documents). Scheduled directly as async
    background tasks they run on the server's event loop, which — behind
    the BaseHTTPMiddleware stack — stalls delivery of the job-start
    response body until the job finishes: headers arrive instantly but the
    body can lag 30s+, long enough for Render's proxy to cut it and the
    browser to see an empty 202. As a sync callable, Starlette runs this
    in its threadpool, so the job gets its own event loop and the request
    loop stays free.
    """
    asyncio.run(job_runner(*args))


def _chunk(items: list[str], size: int) -> list[list[str]]:
    return [items[i : i + size] for i in range(0, len(items), size)]


def _append_stage(job: ExtractionJob, stage: str) -> None:
    payload = dict(job.result_json or {})
    history = list(payload.get("stage_history") or [])
    now = datetime.now(timezone.utc)
    duration_ms = None
    if history:
        previous_at = history[-1].get("at")
        if previous_at:
            try:
                previous = datetime.fromisoformat(str(previous_at))
                if previous.tzinfo is None:
                    previous = previous.replace(tzinfo=timezone.utc)
                duration_ms = int((now - previous).total_seconds() * 1000)
            except (TypeError, ValueError):
                duration_ms = None
    entry: dict = {
        "stage": stage,
        "at": now.isoformat(),
    }
    if duration_ms is not None:
        entry["duration_ms"] = max(0, duration_ms)
    history.append(entry)
    payload["stage_history"] = history
    if payload.get("warnings") is None:
        payload["warnings"] = []
    job.result_json = payload
    job.stage = stage


def _fail_job(job: ExtractionJob, database, exc: Exception) -> None:
    # Discard any partial writes from the failed stage (e.g. a
    # delete-then-insert of discovered targets that threw mid-loop) before
    # committing the failure itself — otherwise the partial rows survive
    # and a later "Use Existing" reload sees a non-empty but incomplete
    # target set and wrongly treats it as a finished, reusable result.
    database.rollback()
    job.status = "failed"
    job.error_message = str(exc)
    job.completed_at = datetime.now(timezone.utc)
    database.commit()
    log_event(
        "job_failed",
        stage=job.stage or "unknown",
        status="error",
        error_category=type(exc).__name__,
        job_id=job.id,
        document_id=job.document_id,
    )


async def run_processing_job(job_id: int) -> None:
    """Background runner for a "processing" job: restore the file,
    extract native text/OCR/tables/pages, then discover the schema."""

    database = SessionLocal()
    started = time.perf_counter()
    heartbeat = start_heartbeat(job_id)

    try:
        job = database.get(ExtractionJob, job_id)
        if job is None:
            return

        document = database.get(Document, job.document_id)
        if document is None:
            _fail_job(job, database, ValueError("Document not found."))
            return

        bind_job_context(document_id=document.id, job_id=job.id)
        log_event(
            "job_started",
            stage="reading_document",
            job_type="processing",
        )

        queue_ms = queue_wait_ms(job)
        job.status = "processing"
        _append_stage(job, "reading_document")
        job.started_at = datetime.now(timezone.utc)
        job.progress = 5
        merge_provenance(
            document,
            {
                "processing_mode": "background",
                "processing_job_id": job.id,
                "size_tier": (document.ingestion_provenance or {}).get(
                    "size_tier"
                ),
            },
        )
        database.commit()

        stage_timings: dict[str, int] = {}
        startup_ms = int((time.perf_counter() - started) * 1000)
        retrieval_started = time.perf_counter()
        force_pages = not pages_artifacts_reusable(document)
        reused_pages_without_source = False

        async def _load_from_stored_pages() -> None:
            nonlocal force_pages, reused_pages_without_source
            stage_timings["source_retrieval_ms"] = int(
                (time.perf_counter() - retrieval_started) * 1000
            )
            _append_stage(job, "rendering_ocr")
            job.progress = 20
            database.commit()
            pages_started = time.perf_counter()
            summarize_stored_pages(
                database=database,
                document_record=document,
                started_at=time.perf_counter(),
            )
            pages_ms = int((time.perf_counter() - pages_started) * 1000)
            stage_timings["document_page_loading_ms"] = pages_ms
            stage_timings["ocr_ms"] = 0
            stage_timings["pages_ocr_ms"] = pages_ms
            force_pages = False
            reused_pages_without_source = True

        if (
            not force_pages
            and can_reuse_pages_without_source(
                database, document, force_reprocess=False
            )
        ):
            await _load_from_stored_pages()
        else:
            try:
                file_path = await run_in_threadpool(
                    ensure_local_copy,
                    settings,
                    stored_filename=document.stored_filename,
                )
            except DocumentStorageError as exc:
                if can_reuse_pages_without_source(
                    database, document, force_reprocess=False
                ):
                    await _load_from_stored_pages()
                else:
                    _fail_job(job, database, exc)
                    return
            else:
                stage_timings["source_retrieval_ms"] = int(
                    (time.perf_counter() - retrieval_started) * 1000
                )

                _append_stage(job, "rendering_ocr")
                job.progress = 20
                database.commit()

                pages_started = time.perf_counter()
                try:
                    await run_in_threadpool(
                        process_document_pages,
                        database=database,
                        document_record=document,
                        file_path=file_path,
                        settings=settings,
                        run_ocr=True,
                        page_start=None,
                        page_end=None,
                        force_reprocess=force_pages,
                    )
                except DocumentExtractionError as exc:
                    _fail_job(job, database, exc)
                    return
                pages_ms = int((time.perf_counter() - pages_started) * 1000)
                stage_timings["document_page_loading_ms"] = pages_ms
                stage_timings["ocr_ms"] = 0 if not force_pages else pages_ms
                stage_timings["pages_ocr_ms"] = pages_ms

        # Refresh after threadpool mutation.
        database.refresh(document)
        merge_provenance(
            document,
            {
                **processing_versions_payload(document=document),
                "pages_reused": not force_pages or reused_pages_without_source,
            },
        )

        index_started = time.perf_counter()
        _append_stage(job, "indexing")
        job.progress = 60
        database.commit()
        stage_timings["indexing_ms"] = int(
            (time.perf_counter() - index_started) * 1000
        )

        _append_stage(job, "discovering_fields")
        job.progress = 75
        database.commit()

        pages = list(
            database.scalars(
                select(DocumentPage)
                .where(DocumentPage.document_id == document.id)
                .order_by(DocumentPage.page_number)
            )
        )

        page_text_chars = sum(len(page.final_text or "") for page in pages)

        discovery_started = time.perf_counter()
        reused_discovery = False
        existing = None
        if discovery_artifacts_reusable(document):
            existing = load_document_targets(
                database=database, document_id=document.id
            )
        if existing is not None and existing.targets:
            schema_result = existing
            reused_discovery = True
            target_count = len(schema_result.targets)
            stage_timings["table_detection_ms"] = 0
            stage_timings["schema_discovery_ms"] = int(
                (time.perf_counter() - discovery_started) * 1000
            )
        else:
            ai_provider = start_session(
                create_ai_provider(settings), settings, database=database, document=document, job_id=job.id
            )
            log_event(
                "schema_discovery_start",
                stage="discovering_fields",
                provider=ai_provider.provider_label,
                page_count=len(pages),
                page_text_chars=page_text_chars,
            )

            try:
                schema_result = await discover_document_schema(
                    document=document,
                    pages=pages,
                    ai_provider=ai_provider,
                )
                db_write_started = time.perf_counter()
                persist_document_targets(database=database, result=schema_result)
                stage_timings["db_writes_ms"] = int(
                    (time.perf_counter() - db_write_started) * 1000
                )
            except Exception as exc:  # noqa: BLE001 - surfaced via job status
                _fail_job(job, database, exc)
                return
            target_count = len(schema_result.targets)
            discovery_ms = int((time.perf_counter() - discovery_started) * 1000)
            stage_timings["schema_discovery_ms"] = discovery_ms
            # Table detection is part of schema discovery for this pipeline.
            stage_timings["table_detection_ms"] = discovery_ms

        stage_timings["discovery_ms"] = stage_timings.get(
            "schema_discovery_ms", 0
        )

        empty_warning = None
        if page_text_chars == 0 or target_count == 0:
            empty_warning = EMPTY_STRUCTURES_WARNING

        merge_provenance(
            document,
            {
                **processing_versions_payload(document=document),
                "page_text_chars": page_text_chars,
                "targets_discovered": target_count,
                "empty_extraction_warning": empty_warning,
                "processing_mode": "background",
                "processing_job_id": job.id,
                "discovery_reused": reused_discovery,
                "pages_reused": not force_pages,
                "stage_timings_ms": stage_timings,
            },
        )

        payload = dict(job.result_json or {})
        warnings = list(payload.get("warnings") or [])
        if empty_warning:
            warnings.append(empty_warning)
            log_event(
                "empty_extraction_warning",
                stage="complete",
                status="warning",
                page_text_chars=page_text_chars,
                target_count=target_count,
            )
        payload["warnings"] = warnings
        payload["page_text_chars"] = page_text_chars
        payload["targets_discovered"] = target_count
        payload["stage_timings_ms"] = stage_timings
        payload["pages_reused"] = not force_pages
        payload["discovery_reused"] = reused_discovery
        job.result_json = payload

        # Classify now, from the pages just read, so the type (and anything
        # needing review) is known before extraction. Never fails the job.
        classification_started = time.perf_counter()
        try:
            from app.classification.service import record_prediction

            await run_in_threadpool(record_prediction, database, document)
        except Exception as exc:  # noqa: BLE001 - classification is redone at staging
            database.rollback()
            log_event("classification_failed", stage="discovering_fields", status="error",
                      error_category=type(exc).__name__)
        stage_timings["classification_ms"] = int((time.perf_counter() - classification_started) * 1000)
        # Discovery's own split: structure detection and the AI calls.
        for key, value in ((document.ingestion_provenance or {}).get("discovery_timings_ms") or {}).items():
            if not reused_discovery and key != "ai_wall_ms":
                stage_timings[f"discovery_{key}"] = value
        if not reused_discovery:
            stage_timings.pop("schema_discovery_ms", None)
        payload["metrics"] = job_metrics(
            database, job,
            total_ms=int((time.perf_counter() - started) * 1000),
            queue_ms=queue_ms, startup_ms=startup_ms, stage_timings=stage_timings,
            records={"pages": len(pages), "targets": target_count},
        )
        job.result_json = {**payload}

        job.status = "complete"
        _append_stage(job, "complete")
        job.progress = 100
        job.completed_at = datetime.now(timezone.utc)
        database.commit()
        log_event(
            "job_complete",
            stage="complete",
            job_type="processing",
            duration_ms=int((time.perf_counter() - started) * 1000),
            target_count=target_count,
            page_text_chars=page_text_chars,
            pages_processed=len(pages),
            pages_reused=not force_pages,
            discovery_reused=reused_discovery,
            **{f"timing_{key}": value for key, value in stage_timings.items()},
        )

    finally:
        await stop_heartbeat(heartbeat)
        database.close()


async def run_extraction_job(
    job_id: int,
    target_ids: list[str],
    use_ai_fallback: bool,
) -> None:
    """Background runner for an "extraction" job: extract the selected
    targets, batching internally so the caller never sees a batch limit."""

    database = SessionLocal()
    started = time.perf_counter()
    heartbeat = start_heartbeat(job_id)

    try:
        job = database.get(ExtractionJob, job_id)
        if job is None:
            return

        document = database.get(Document, job.document_id)
        if document is None:
            _fail_job(job, database, ValueError("Document not found."))
            return

        queue_ms = queue_wait_ms(job)
        startup_ms = int((time.perf_counter() - started) * 1000)

        bind_job_context(document_id=document.id, job_id=job.id)

        job.status = "processing"
        _append_stage(job, "extracting_data")
        job.started_at = datetime.now(timezone.utc)
        database.commit()

        # One AI enrichment session per run: timeouts, classified failures,
        # a circuit breaker, and a single ai_enrichment summary (AI never
        # fails the job — see app/services/ai_enrichment.py).
        ai_provider = start_session(
            create_ai_provider(settings), settings, database=database, document=document, job_id=job.id
        )
        if not use_ai_fallback:
            ai_provider.mark_not_requested()
        log_event(
            "job_started",
            stage="extracting_data",
            job_type="extraction",
            provider=ai_provider.provider_label,
            target_count=len(target_ids),
            use_ai_fallback=use_ai_fallback,
        )

        batches = _chunk(target_ids, EXTRACTION_BATCH_SIZE)
        scalars: list[dict] = []
        tables: list[dict] = []
        unresolved: list[str] = []
        warnings: list[str] = []
        stage_timings: dict[str, int] = {
            "extraction_ms": 0,
            "validation_ms": 0,
            "db_writes_ms": 0,
        }

        for index, batch in enumerate(batches):
            extract_started = time.perf_counter()
            try:
                batch_result = await extract_by_targets(
                    database=database,
                    document=document,
                    target_ids=batch,
                    use_ai_fallback=use_ai_fallback,
                    ai_provider=ai_provider,
                )
            except Exception as exc:  # noqa: BLE001 - surfaced via job status
                _fail_job(job, database, exc)
                return
            stage_timings["extraction_ms"] += int(
                (time.perf_counter() - extract_started) * 1000
            )

            scalars.extend(
                scalar.model_dump(mode="json")
                for scalar in batch_result.scalars
            )
            tables.extend(
                table.model_dump(mode="json") for table in batch_result.tables
            )
            unresolved.extend(batch_result.unresolved_targets)
            warnings.extend(batch_result.warnings)

            # Partial persist so reopen/UI can show completed batches while
            # long documents continue extracting.
            db_started = time.perf_counter()
            persist_target_extraction_results(
                database=database,
                document_id=document.id,
                scalars=batch_result.scalars,
                tables=batch_result.tables,
                extraction_job_id=job.id,
            )
            stage_timings["db_writes_ms"] += int(
                (time.perf_counter() - db_started) * 1000
            )

            history = list((job.result_json or {}).get("stage_history") or [])
            job.result_json = {
                "document_id": document.id,
                "scalars": scalars,
                "tables": tables,
                "unresolved_targets": unresolved,
                "warnings": warnings,
                "stage_history": history,
                "stage_timings_ms": stage_timings,
                "partial": index + 1 < len(batches),
                "batches_completed": index + 1,
                "batches_total": len(batches),
            }
            job.progress = round((index + 1) / len(batches) * 80)
            database.commit()

        # Targets that found nothing this run drop their old, unreviewed value.
        cleared_stale = clear_stale_target_values(
            database=database,
            document_id=document.id,
            unresolved_keys=unresolved,
        )
        if cleared_stale:
            warnings.append(
                f"Cleared {cleared_stale} unreviewed value(s) the latest extraction no longer found."
            )
        database.commit()

        validate_started = time.perf_counter()
        _append_stage(job, "validating_results")
        database.commit()
        stage_timings["validation_ms"] = int(
            (time.perf_counter() - validate_started) * 1000
        )

        # V3 canonical pipeline (docs/v3-implementation-plan.md): runs as
        # part of the SAME job the frontend already calls, so Results/CSV/
        # Excel get V3 data without a separate opt-in step. Additive and
        # isolated — a failure here is logged and surfaced in the job's
        # warnings, but never fails the job or drops the kv_* results above.
        v3_started = time.perf_counter()
        # Read back by extraction_outcome.py so Results can tell "V3 ran and
        # found nothing" apart from "V3 failed" or "V3 never ran".
        v3_record: dict = {"status": "failed", "error": None, "source_inspection": None}
        _append_stage(job, "v3_classification")
        database.commit()
        # A profile recognized from the document's own structure may declare
        # that the contract pipeline doesn't apply (StagingProfile.
        # contract_pipeline) — e.g. a regulation source, where V3 would only
        # spend minutes finding "clauses" that are the regulation itself.
        recognized = None
        try:
            recognized = await run_in_threadpool(recognize_document_profile, database, document)
        except Exception:  # noqa: BLE001 - recognition is advisory here
            database.rollback()
        if recognized is not None and not recognized.profile.contract_pipeline:
            v3_record = {
                "status": "skipped",
                "error": None,
                "source_inspection": None,
                "reason": f"{recognized.profile.key} does not use the contract pipeline.",
            }
            stage_timings["v3_ms"] = int((time.perf_counter() - v3_started) * 1000)
            log_event(
                "v3_extraction_skipped",
                stage="v3_classification",
                profile_id=recognized.profile.profile_id,
                profile_version=recognized.profile.profile_version,
            )
        else:
            try:
                v3_pages = list(
                    database.scalars(
                        select(DocumentPage)
                        .where(DocumentPage.document_id == document.id)
                        .order_by(DocumentPage.page_number)
                    )
                )
                v3_summary = await run_in_threadpool(
                    run_and_persist_v3_extraction,
                    database=database,
                    document=document,
                    pages=v3_pages,
                )
                stage_timings["v3_ms"] = int((time.perf_counter() - v3_started) * 1000)
                warnings.extend(v3_summary.warnings)
                v3_record = {
                    "status": "completed",
                    "error": None,
                    "source_inspection": (
                        v3_summary.source_inspection.to_dict()
                        if v3_summary.source_inspection is not None
                        else None
                    ),
                }
                log_event(
                    "v3_extraction_complete",
                    stage="v3_classification",
                    candidate_count=v3_summary.candidate_count,
                    all_fields_count=v3_summary.all_fields_count,
                    clin_count=v3_summary.clin_count,
                    funding_count=v3_summary.funding_count,
                    performance_delivery_count=v3_summary.performance_delivery_count,
                    attachment_count=v3_summary.attachment_count,
                    clause_reference_count=v3_summary.clause_reference_count,
                    pages_with_geometry=v3_summary.pages_with_geometry,
                )
            except Exception as exc:  # noqa: BLE001 - V3 is additive, never fails the job
                database.rollback()
                warning = f"V3 canonical extraction failed: {exc}"
                warnings.append(warning)
                v3_record["error"] = type(exc).__name__
                log_event(
                    "v3_extraction_failed",
                    stage="v3_classification",
                    status="error",
                    error_category=type(exc).__name__,
                    error=str(exc),
                )

        # Pin the staging profile, then build the schema-neutral source
        # structure only if that profile (or an uncertain resolution) needs
        # it — see app/staging/preparation.py. Runs even when V3 failed so
        # the workbook still renders with an explicit outcome. A failure is
        # a warning: both steps are redone lazily on first read.
        try:
            preparation = await run_in_threadpool(prepare_staging, database, document)
            stage_timings.update(preparation.timings_ms)
            log_event(
                "staging_prepared",
                stage="v3_classification",
                profile_id=preparation.record.profile_id,
                profile_version=preparation.record.profile_version,
                document_family=preparation.record.document_family,
                source_structure_built=preparation.structure_built,
                source_structure_reason=preparation.structure_reason,
            )
        except Exception as exc:  # noqa: BLE001 - redone lazily on first read
            database.rollback()
            warnings.append(f"Staging preparation failed: {exc}")

        history = list((job.result_json or {}).get("stage_history") or [])
        job.result_json = {
            "document_id": document.id,
            "scalars": scalars,
            "tables": tables,
            "unresolved_targets": unresolved,
            "warnings": warnings,
            "stage_history": history,
            "stage_timings_ms": stage_timings,
            "partial": False,
            "batches_completed": len(batches),
            "batches_total": len(batches),
            "ai_enrichment": ai_provider.summary(),
        }
        job.result_json = {
            **job.result_json,
            "metrics": job_metrics(
                database, job,
                total_ms=int((time.perf_counter() - started) * 1000),
                queue_ms=queue_ms, startup_ms=startup_ms, stage_timings=stage_timings,
                records={"scalars": len(scalars), "tables": len(tables), "unresolved": len(unresolved)},
            ),
        }

        from app.services.processing_versions import processing_versions_payload

        merge_provenance(
            document,
            {
                **processing_versions_payload(document=document),
                "extraction_job_id": job.id,
                "scalars_extracted": len(scalars),
                "tables_extracted": len(tables),
                "stage_timings_ms": stage_timings,
                "v3_extraction": v3_record,
                "ai_enrichment": ai_provider.summary(),
            },
        )

        job.status = "complete"
        _append_stage(job, "complete")
        job.progress = 100
        job.completed_at = datetime.now(timezone.utc)
        database.commit()
        log_event(
            "job_complete",
            stage="complete",
            job_type="extraction",
            duration_ms=int((time.perf_counter() - started) * 1000),
            scalar_count=len(scalars),
            table_count=len(tables),
            unresolved_count=len(unresolved),
            **{f"timing_{key}": value for key, value in stage_timings.items()},
        )

    finally:
        await stop_heartbeat(heartbeat)
        database.close()
