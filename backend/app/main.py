import logging

from fastapi import FastAPI, Response, status
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app.api import (
    actors,
    ask,
    assignments,
    classification,
    contract_analysis,
    doc_schemas,
    dashboard,
    document_actions,
    document_compare,
    documents,
    extraction_models,
    financial_analysis,
    insights_search,
    intake,
    jobs,
    key_dates,
    obligations,
    oracle_templates,
    page_extraction,
    playbook,
    provider_approvals,
    recognition,
    reference_data,
    reviewed_export,
    system,
    target_corrections,
    universal_extraction,
    validation_rules,
    document_intelligence,
    source_view,
    staging_workbook,
    v3_export,
)
from fastapi import Depends

from app.core.document_access import enforce_document_access
from app.core.config import get_settings
from app.core.observability import RequestIdMiddleware
from app.core.security_headers import SecurityHeadersMiddleware
from app.core.masking import install_log_redaction
from app.core.version import get_version_metadata, resolve_git_sha
from app.database.base import Base
from app.database.migrate import (
    ensure_actor_audit_log_columns,
    ensure_detected_target_columns,
    ensure_document_metadata_field_columns,
    ensure_document_page_columns,
    ensure_documents_columns,
    ensure_extraction_model_columns,
    ensure_metadata_field_audit_log_columns,
    ensure_recognition_run_columns,
    ensure_target_correction_columns,
    run_alembic_upgrade,
)
from app.database.playbook_columns import ensure_clause_playbook_rule_columns
from app.database.rls import RlsLockdownError, lock_down_public_schema
from app.database.session import SessionLocal, engine
from app.services.document_storage import is_remote_storage_configured
from app.models import (  # noqa: F401
    classification_audit_log as classification_audit_log_model,
)
from app.models import document as document_model  # noqa: F401
from app.models import extraction_job as extraction_job_model  # noqa: F401
from app.models import document_address as document_address_model  # noqa: F401
from app.models import (  # noqa: F401
    document_amendment_history as document_amendment_history_model,
)
from app.models import document_attachment as document_attachment_model  # noqa: F401
from app.models import document_clause as document_clause_model  # noqa: F401
from app.models import (  # noqa: F401
    document_clause_reference as document_clause_reference_model,
)
from app.models import document_contact as document_contact_model  # noqa: F401
from app.models import (  # noqa: F401
    document_contract_summary as document_contract_summary_model,
)
from app.models import document_qa_review as document_qa_review_model  # noqa: F401
from app.models import document_staging_workbook as document_staging_workbook_model  # noqa: F401
from app.models import document_source_structure as document_source_structure_model  # noqa: F401
from app.models import document_far_record as document_far_record_model  # noqa: F401
from app.models import document_contract_structure as document_contract_structure_model  # noqa: F401
from app.models import staged_upload as staged_upload_model  # noqa: F401
from app.models import provider_approval as provider_approval_model  # noqa: F401
from app.models import oracle_template as oracle_template_model  # noqa: F401
from app.models import document_classification as document_classification_model  # noqa: F401
from app.models import document_schema as document_schema_model  # noqa: F401
from app.models import recognition_run as recognition_run_model  # noqa: F401
from app.models import reference_data as reference_data_model  # noqa: F401
from app.models import document_key_date as document_key_date_model  # noqa: F401
from app.models import far_master_clause as far_master_clause_model  # noqa: F401
from app.models import (  # noqa: F401
    document_delivery_schedule as document_delivery_schedule_model,
)
from app.models import (  # noqa: F401
    document_detected_target as document_detected_target_model,
)
from app.models import (  # noqa: F401
    document_funding_line as document_funding_line_model,
)
from app.models import (  # noqa: F401
    document_insurance_requirement as document_insurance_requirement_model,
)
from app.models import (  # noqa: F401
    document_key_position as document_key_position_model,
)
from app.models import document_line_item as document_line_item_model  # noqa: F401
from app.models import (  # noqa: F401
    document_metadata_field as document_metadata_field_model,
)
from app.models import (  # noqa: F401
    document_extracted_table as document_extracted_table_model,
)
from app.models import document_order_range as document_order_range_model  # noqa: F401
from app.models import document_page as document_page_model  # noqa: F401
from app.models import (  # noqa: F401
    document_performance_period as document_performance_period_model,
)
from app.models import (  # noqa: F401
    document_signature as document_signature_model,
)
from app.models import (  # noqa: F401
    document_wawf_instruction as document_wawf_instruction_model,
)
from app.models import (  # noqa: F401
    extraction_model as extraction_model_model,
)
from app.models import (  # noqa: F401
    metadata_field_audit_log as metadata_field_audit_log_model,
)
from app.models import actor as actor_model  # noqa: F401
from app.models import (  # noqa: F401
    integration_audit_log as integration_audit_log_model,
)
from app.models import page_text_block as page_text_block_model  # noqa: F401
from app.models import (  # noqa: F401
    relationship_audit_log as relationship_audit_log_model,
)
from app.models import (  # noqa: F401
    target_correction as target_correction_model,
)

settings = get_settings()
logger = logging.getLogger(__name__)
# Mask account/SSN/IBAN/MRZ shapes in every log message (core/masking.py).
install_log_redaction()

app = FastAPI(
    title=settings.app_name,
    description=(
        "Extract specific financial information and tables from PDFs "
        "and prepare Oracle Fusion dry-run payloads."
    ),
    version="0.1.0",
    debug=settings.debug,
)

# Last added = outermost. Request ID wraps CORS so responses always get it.
# Security headers sit outside so every response (incl. errors) is hardened.
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(RequestIdMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_origin_regex=(
        r"https?://("
        r"localhost|"
        r"127\.0\.0\.1|"
        r"192\.168\.\d{1,3}\.\d{1,3}|"
        r"10\.\d{1,3}\.\d{1,3}\.\d{1,3}"
        r")(:\d+)?"
        if settings.debug
        else r"https://([a-z0-9-]+\.)*vercel\.app"
    ),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    # Content-Disposition carries the export's file name to the browser app.
    expose_headers=["X-Request-ID", "Content-Disposition", "X-Import-Ready"],
)

app.include_router(
    documents.router,
    prefix="/api/documents",
    # Document isolation for every /{document_id} route (core/document_access.py).
    dependencies=[Depends(enforce_document_access)],
    tags=["Documents"],
)

app.include_router(
    page_extraction.router,
    prefix="/api/documents",
    # Document isolation for every /{document_id} route (core/document_access.py).
    dependencies=[Depends(enforce_document_access)],
    tags=["Page Extraction"],
)

app.include_router(
    document_intelligence.router,
    prefix="/api/documents",
    # Document isolation for every /{document_id} route (core/document_access.py).
    dependencies=[Depends(enforce_document_access)],
    tags=["Document Intelligence"],
)

app.include_router(
    source_view.router,
    prefix="/api/documents",
    # Document isolation for every /{document_id} route (core/document_access.py).
    dependencies=[Depends(enforce_document_access)],
    tags=["Source View"],
)

app.include_router(
    financial_analysis.router,
    prefix="/api/documents",
    # Document isolation for every /{document_id} route (core/document_access.py).
    dependencies=[Depends(enforce_document_access)],
    tags=["Financial Analysis"],
)

app.include_router(
    universal_extraction.router,
    prefix="/api/documents",
    # Document isolation for every /{document_id} route (core/document_access.py).
    dependencies=[Depends(enforce_document_access)],
    tags=["Universal Extraction"],
)

app.include_router(
    contract_analysis.router,
    prefix="/api/documents",
    # Document isolation for every /{document_id} route (core/document_access.py).
    dependencies=[Depends(enforce_document_access)],
    tags=["Contract Analysis"],
)

app.include_router(
    extraction_models.router,
    prefix="/api/extraction-models",
    tags=["Extraction Models"],
)

app.include_router(
    dashboard.router,
    prefix="/api/dashboard",
    tags=["Dashboard"],
)

app.include_router(
    system.router,
    prefix="/api/system",
    tags=["System"],
)

app.include_router(
    jobs.router,
    prefix="/api/documents",
    # Document isolation for every /{document_id} route (core/document_access.py).
    dependencies=[Depends(enforce_document_access)],
    tags=["Jobs"],
)

app.include_router(
    jobs.v1_router,
    prefix="/v1/jobs",
    tags=["Jobs"],
)

app.include_router(
    target_corrections.router,
    prefix="/api/documents",
    # Document isolation for every /{document_id} route (core/document_access.py).
    dependencies=[Depends(enforce_document_access)],
    tags=["Target Corrections"],
)

app.include_router(
    reviewed_export.router,
    prefix="/api/documents",
    # Document isolation for every /{document_id} route (core/document_access.py).
    dependencies=[Depends(enforce_document_access)],
    tags=["Export"],
)

app.include_router(
    v3_export.router,
    prefix="/api/documents",
    # Document isolation for every /{document_id} route (core/document_access.py).
    dependencies=[Depends(enforce_document_access)],
    tags=["V3 Export"],
)

app.include_router(
    staging_workbook.router,
    prefix="/api/documents",
    # Document isolation for every /{document_id} route (core/document_access.py).
    dependencies=[Depends(enforce_document_access)],
    tags=["Staging Workbook"],
)

app.include_router(
    staging_workbook.profiles_router,
    prefix="/api/staging-profiles",
    tags=["Staging Workbook"],
)

app.include_router(
    actors.router,
    prefix="/api/actors",
    tags=["Actors"],
)

app.include_router(
    doc_schemas.router,
    prefix="/api/schemas",
    tags=["Schema & Label Designer"],
)

app.include_router(
    doc_schemas.documents_router,
    prefix="/api/documents",
    # Document isolation for every /{document_id} route (core/document_access.py).
    dependencies=[Depends(enforce_document_access)],
    tags=["Schema & Label Designer"],
)

app.include_router(
    classification.router,
    prefix="/api/classification",
    tags=["Classification"],
)

app.include_router(
    classification.documents_router,
    prefix="/api/documents",
    # Document isolation for every /{document_id} route (core/document_access.py).
    dependencies=[Depends(enforce_document_access)],
    tags=["Classification"],
)

app.include_router(
    oracle_templates.router,
    prefix="/api/oracle",
    tags=["Oracle templates"],
)

app.include_router(
    oracle_templates.documents_router,
    prefix="/api/documents",
    # Document isolation for every /{document_id} route (core/document_access.py).
    dependencies=[Depends(enforce_document_access)],
    tags=["Oracle mapping"],
)

app.include_router(
    provider_approvals.router,
    prefix="/api/admin/provider-approvals",
    tags=["Provider approvals"],
)

app.include_router(
    recognition.router,
    prefix="/api/recognition",
    tags=["Recognition"],
)

app.include_router(
    reference_data.router,
    prefix="/api/reference",
    tags=["Reference data"],
)

app.include_router(
    key_dates.router,
    prefix="/api/key-dates",
    tags=["Key dates"],
)

app.include_router(
    key_dates.documents_router,
    prefix="/api/documents",
    # Document isolation for every /{document_id} route (core/document_access.py).
    dependencies=[Depends(enforce_document_access)],
    tags=["Key dates"],
)

app.include_router(
    reference_data.documents_router,
    prefix="/api/documents",
    # Document isolation for every /{document_id} route (core/document_access.py).
    dependencies=[Depends(enforce_document_access)],
    tags=["Reference data"],
)

app.include_router(
    recognition.documents_router,
    prefix="/api/documents",
    # Document isolation for every /{document_id} route (core/document_access.py).
    dependencies=[Depends(enforce_document_access)],
    tags=["Recognition"],
)

app.include_router(
    obligations.router,
    prefix="/api/documents",
    # Document isolation for every /{document_id} route (core/document_access.py).
    dependencies=[Depends(enforce_document_access)],
    tags=["Obligations"],
)
app.include_router(
    obligations.portfolio_router,
    prefix="/api/obligations",
    tags=["Obligations"],
)
app.include_router(
    playbook.document_router,
    prefix="/api/documents",
    # Document isolation for every /{document_id} route (core/document_access.py).
    dependencies=[Depends(enforce_document_access)],
    tags=["Clause Playbook"],
)
app.include_router(
    playbook.router,
    prefix="/api/playbook",
    tags=["Clause Playbook"],
)
app.include_router(
    intake.router,
    prefix="/api/intake",
    # Batches are scoped in the handlers; /documents/{document_id} is isolated here.
    dependencies=[Depends(enforce_document_access)],
    tags=["Intake"],
)
# Handlers check access per document (items can span documents).
app.include_router(
    assignments.router,
    prefix="/api/review-assignments",
    tags=["Review Assignments"],
)
app.include_router(
    document_actions.router,
    prefix="/api/documents",
    # Document isolation for every /{document_id} route (core/document_access.py).
    dependencies=[Depends(enforce_document_access)],
    tags=["Document Actions"],
)
app.include_router(
    validation_rules.document_router,
    prefix="/api/documents",
    # Document isolation for every /{document_id} route (core/document_access.py).
    dependencies=[Depends(enforce_document_access)],
    tags=["Validation Rules"],
)
app.include_router(
    validation_rules.router,
    prefix="/api/validation-rules",
    tags=["Validation Rules"],
)
# Scoped to the caller's documents inside the handler.
app.include_router(
    insights_search.router,
    prefix="/api/search",
    tags=["Insights Search"],
)
app.include_router(
    ask.router,
    prefix="/api/ask",
    tags=["Ask"],
)
# Both document ids are access-checked inside the handler.
app.include_router(
    document_compare.router,
    prefix="/api/compare",
    tags=["Compare"],
)


@app.on_event("startup")
async def create_database_tables() -> None:
    if settings.app_env == "production":
        if settings.resolved_database_url.startswith("sqlite"):
            raise RuntimeError(
                "APP_ENV=production requires a persistent PostgreSQL "
                "DATABASE_URL — refusing to start on ephemeral SQLite, "
                "which does not survive a restart or redeploy."
            )

        if not is_remote_storage_configured(settings):
            raise RuntimeError(
                "APP_ENV=production requires SUPABASE_URL and "
                "SUPABASE_SERVICE_ROLE_KEY to be set — refusing to start "
                "without persistent object storage for uploaded "
                "documents."
            )

        run_alembic_upgrade()
    else:
        # Local development: create_all for brand-new tables.
        Base.metadata.create_all(bind=engine)

    # Safety net on every startup, in both modes: patches any column
    # added to a model after its table already existed — e.g. a
    # database that predates a migration, or one whose tables were
    # created by an earlier create_all before a column existed. Runs on
    # any dialect (see database/migrate.py) so this now also covers
    # Postgres, not just the SQLite databases it originally targeted.
    ensure_document_page_columns(engine)
    ensure_documents_columns(engine)
    ensure_document_metadata_field_columns(engine)
    ensure_extraction_model_columns(engine)
    ensure_target_correction_columns(engine)
    ensure_metadata_field_audit_log_columns(engine)
    ensure_actor_audit_log_columns(engine)
    ensure_recognition_run_columns(engine)
    ensure_detected_target_columns(engine)
    ensure_clause_playbook_rule_columns(engine)

    # Supabase serves public tables over PostgREST; the app never uses it.
    try:
        lock_down_public_schema(engine)
    except RlsLockdownError:
        logger.exception("Public schema left exposed to the Supabase REST API")

    from app.database.session import SessionLocal
    from app.services.actor_seed import ensure_actors_seeded

    seed_db = SessionLocal()
    try:
        ensure_actors_seeded(seed_db)
    finally:
        seed_db.close()

    _recover_interrupted_jobs()


def _recover_interrupted_jobs() -> None:
    """In-process background tasks don't survive a process restart —
    anything still queued/processing when the process died is stuck
    forever otherwise. Surface it as a clean failure instead.

    Only stale jobs are failed here: during a rolling deploy the previous
    instance is still running its jobs while this one boots. Younger
    orphans are failed lazily by the job status endpoint once stale."""

    from app.database.session import SessionLocal
    from app.models.extraction_job import ExtractionJob
    from app.services.job_recovery import (
        ACTIVE_STATUSES,
        is_orphaned,
        mark_interrupted,
    )

    database = SessionLocal()

    try:
        active_jobs = database.query(ExtractionJob).filter(
            ExtractionJob.status.in_(ACTIVE_STATUSES)
        )

        for job in active_jobs:
            if is_orphaned(job):
                mark_interrupted(job)

        database.commit()
    finally:
        database.close()


@app.get("/")
async def root() -> dict[str, str]:
    return {
        "application": settings.app_name,
        "status": "running",
        "mode": "oracle-dry-run",
        "git_sha": resolve_git_sha(),
        "environment": settings.app_env,
    }


@app.get("/version")
async def version() -> dict[str, str]:
    """Deployment fingerprint for release certification.

    Every field below is captured once at process startup
    (app/core/version.py) — it describes the artifact THIS running
    process actually loaded, not whatever the repository's current HEAD
    happens to be. `started_at` is the tell for a stale process: if it's
    much older than the last deploy/commit, this process is serving old
    code and should be restarted, not trusted.
    """

    metadata = get_version_metadata()
    return {
        # Back-compat aliases for existing callers/scripts.
        "git_sha": metadata["git_commit_sha"],
        "environment": settings.app_env,
        "service": "dataomatix",
        **metadata,
    }


@app.get("/health")
async def health_check() -> dict[str, str]:
    """Liveness only — cheap enough for Render / keep-alive probes."""

    return {
        "status": "ok",
        "service": "dataomatix",
    }


def _ai_status_payload() -> dict[str, object]:
    provider = (settings.ai_provider or "").strip().lower() or "disabled"
    fallback_enabled = bool(settings.ai_fallback_enabled)
    provider_mode = (settings.ai_provider_mode or "development").strip().lower()
    show_dev_ai_warning = (
        fallback_enabled
        and provider == "gemini"
        and provider_mode == "development"
    )
    model = None
    if provider == "gemini":
        model = settings.gemini_model
    elif provider == "openai":
        model = settings.openai_model or "gpt-4o-mini"
    elif provider == "ollama":
        model = settings.ollama_model
    elif provider in {"auto", "gemini_fallback", ""}:
        model = settings.gemini_model
    # Config-only resolution string — no live vendor client construction.
    resolved_parts: list[str] = []
    if not fallback_enabled:
        resolved = "disabled"
    elif settings.convera_enabled and settings.convera_ai_enabled:
        resolved = "convera"
    elif provider == "ollama":
        resolved = "ollama" if settings.ollama_base_url else "disabled"
    elif provider == "openai":
        resolved = "openai" if settings.openai_api_key else "disabled"
    elif provider == "gemini":
        resolved = "gemini" if settings.gemini_api_key else "disabled"
    else:
        if settings.gemini_api_key:
            resolved_parts.append("gemini")
        if settings.openai_api_key:
            resolved_parts.append("openai")
        if settings.ollama_base_url:
            resolved_parts.append("ollama")
        if not resolved_parts:
            resolved = "disabled"
        elif len(resolved_parts) == 1:
            resolved = resolved_parts[0]
        else:
            resolved = "fallback(" + "+".join(resolved_parts) + ")"
    return {
        "provider": provider if fallback_enabled else "disabled",
        "fallback_enabled": fallback_enabled,
        "mode": provider_mode,
        "show_dev_warning": show_dev_ai_warning,
        "model": model,
        "schema_enrichment_enabled": bool(settings.ai_schema_enrichment_enabled),
        "resolved": resolved,
    }


@app.get("/ready")
async def readiness_check(response: Response) -> dict[str, object]:
    """Readiness — database, storage config, and AI provider configuration."""

    checks: dict[str, object] = {}
    ready = True

    # Database
    try:
        database = SessionLocal()
        try:
            database.execute(text("SELECT 1"))
            checks["database"] = {"status": "ok"}
        finally:
            database.close()
    except Exception as exc:  # noqa: BLE001
        ready = False
        checks["database"] = {"status": "error", "detail": str(exc)[:200]}

    # Object storage (required in production; optional locally)
    storage_configured = is_remote_storage_configured(settings)
    if settings.app_env == "production" and not storage_configured:
        ready = False
        checks["storage"] = {
            "status": "error",
            "detail": "Remote storage required in production.",
        }
    else:
        checks["storage"] = {
            "status": "ok",
            "mode": "remote" if storage_configured else "local",
        }

    # Provider configuration (settings only — no live vendor ping)
    ai_payload = _ai_status_payload()
    checks["ai"] = ai_payload

    documents_via_convera = (
        settings.convera_enabled and settings.convera_documents_enabled
    )
    ai_via_convera = settings.convera_enabled and settings.convera_ai_enabled
    checks["convera"] = {
        "enabled": settings.convera_enabled,
        "documents": "convera" if documents_via_convera else "local",
        "ai": "convera" if ai_via_convera else ai_payload["provider"],
        "migration_mode": documents_via_convera and not ai_via_convera,
    }

    checks["auth"] = {
        "status": "ok",
        "rbac_enforced": settings.effective_rbac_enforced,
        "entra_configured": settings.entra_configured,
        "entra_tenant_set": bool(settings.entra_tenant_id),
        "mode": (
            "entra+service"
            if settings.entra_configured
            else "service_or_dev"
        ),
    }
    if (
        (settings.app_env or "").strip().lower() == "production"
        and not settings.entra_configured
    ):
        # Soft warn — do not fail readiness so existing deploys keep serving;
        # production still forces RBAC via service keys until Entra is wired.
        checks["auth"] = {
            **checks["auth"],  # type: ignore[dict-item]
            "status": "warn",
            "detail": (
                "Production without Entra: set ENTRA_TENANT_ID and "
                "ENTRA_API_AUDIENCE for IdP JWT validation. "
                "Service API keys remain valid under RBAC."
            ),
        }

    from app.services.libreoffice_convert import libreoffice_available

    lo_ok = libreoffice_available()
    checks["legacy_office_conversion"] = {
        "status": "ok" if lo_ok else "warn",
        "available": lo_ok,
        "detail": (
            None
            if lo_ok
            else "soffice not found; .doc/.xls/.ppt conversion unavailable"
        ),
    }

    # Temporary diagnostics for the TESSDATA_PREFIX/OCR investigation —
    # no document content, just binary/env presence.
    import os
    import shutil

    tessdata_env = os.environ.get("TESSDATA_PREFIX")
    tessdata_dir_listing: list[str] | str | None = None
    if tessdata_env:
        try:
            tessdata_dir_listing = sorted(os.listdir(tessdata_env))[:20]
        except OSError as exc:
            tessdata_dir_listing = f"error: {exc}"

    marker_path = "/etc/tessdata_prefix"
    marker_contents = None
    if os.path.exists(marker_path):
        try:
            with open(marker_path, "r", encoding="utf-8") as handle:
                marker_contents = handle.read().strip()
        except OSError as exc:
            marker_contents = f"error: {exc}"

    checks["ocr_diagnostics"] = {
        "tesseract_binary": shutil.which("tesseract"),
        "soffice_binary": shutil.which("soffice"),
        "tessdata_prefix_env": tessdata_env,
        "tessdata_prefix_settings": (
            str(settings.tessdata_prefix)
            if settings.tessdata_prefix
            else None
        ),
        "tessdata_dir_listing": tessdata_dir_listing,
        "build_marker_file": marker_path,
        "build_marker_contents": marker_contents,
    }

    if not ready:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE

    return {
        "status": "ready" if ready else "not_ready",
        "service": "dataomatix",
        "environment": settings.app_env,
        "git_sha": resolve_git_sha(),
        "oracle_dry_run": settings.oracle_dry_run,
        "rbac_enforced": settings.effective_rbac_enforced,
        "metadata_review_mutations_enabled": (
            settings.effective_metadata_review_mutations_enabled
        ),
        "entra_configured": settings.entra_configured,
        "legacy_office_conversion": {
            "available": lo_ok,
        },
        "checks": checks,
        # Flat ai/convera mirrors keep existing frontend clients working
        # when pointed at /ready instead of the old fat /health payload.
        "ai": ai_payload,
        "convera": checks["convera"],
    }