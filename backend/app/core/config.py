from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

_ROOT_ENV = Path(__file__).resolve().parents[3] / ".env"
_BACKEND_ENV = Path(__file__).resolve().parents[2] / ".env"


class Settings(BaseSettings):
    """Application configuration loaded from environment variables."""

    app_name: str = "Enterprise Financial Data Agent"
    app_env: str = "development"
    debug: bool = True

    upload_directory: str = "uploads"
    max_upload_mb: int = 100
    max_pdf_pages: int = 1000
    allow_encrypted_pdf: bool = False

    # Backs up uploaded files to Supabase Storage so they survive Render's
    # free-tier ephemeral disk being wiped on every redeploy/idle restart.
    # Local disk is still used as a working cache; when unset, storage
    # stays local-only (e.g. local development).
    supabase_url: str | None = None
    supabase_service_role_key: str | None = None
    supabase_storage_bucket: str = "documents"

    database_url: str = "sqlite:///./data_agent.db"

    oracle_base_url: str = "https://example.fa.oraclecloud.com"
    oracle_api_version: str = "11.13.18.05"
    oracle_dry_run: bool = True

    frontend_url: str = "http://localhost:3000"

    ai_provider: str = "gemini"

    convera_enabled: bool = False
    convera_api_url: str = "http://localhost:8000"
    convera_api_key: str | None = None
    convera_timeout_seconds: int = 120
    convera_documents_enabled: bool = False
    convera_ai_enabled: bool = False

    gemini_api_key: str | None = None
    gemini_model: str = "gemini-3.6-flash"

    openai_api_key: str | None = None
    openai_model: str | None = None

    # No default: an always-truthy base_url would make
    # ai_provider_factory always add Ollama as a fallback provider,
    # even on deployments (e.g. Render) that never intended to use it
    # and have no Ollama server reachable.
    ollama_base_url: str | None = None
    ollama_model: str | None = None

    ai_fallback_enabled: bool = True

    # When true, discover-schema may ask the AI provider to refine
    # display names / groups for generic heuristic targets only.
    ai_schema_enrichment_enabled: bool = True

    # development | local | production
    # "development" shows the Gemini free-tier privacy notice in the UI.
    ai_provider_mode: str = "development"

    ai_max_pages: int = 10
    ai_max_context_chars: int = 60000

    # Cap auto-chain length and per-attempt wait so cascading providers
    # cannot hang a job for minutes when every vendor is down.
    ai_fallback_max_providers: int = 3
    ai_provider_attempt_timeout_seconds: float = 45.0

    # When true, clean high-confidence grounded fields may auto-accept.
    # Default false — enterprise governance prefers explicit human accept.
    auto_accept_high_confidence: bool = False

    # Metadata Accept/Edit/Reject (+ accept-all + target corrections that
    # mutate review_status). None = unset: enabled outside production,
    # fail-closed when APP_ENV=production (RC2 restricted core-platform).
    # Set METADATA_REVIEW_MUTATIONS_ENABLED=true only with an explicit waiver.
    metadata_review_mutations_enabled: bool | None = None

    # When true, requests must present X-Actor-Id or Bearer API key.
    # Default false keeps local/dev/tests working with seeded Dev Admin.
    # Production (app_env=production) always enforces RBAC regardless.
    rbac_enforced: bool = False

    # When true (default), a request that presents no credential at all is
    # served as the built-in "workspace" role even under enforced RBAC, so
    # the core flow (upload → process → staging workbook → review → export)
    # needs no key. Delete, authoritative export, Oracle and admin
    # permissions still require a real credential; an invalid credential is
    # still rejected. Set false to require a credential for every request.
    public_workspace_access: bool = True

    # SQLAlchemy pool for Postgres (ignored for SQLite).
    db_pool_size: int = 5
    db_max_overflow: int = 5
    db_pool_recycle_seconds: int = 1800
    db_pool_timeout_seconds: int = 30

    # Cap document search scan when status/confidence filters need Python
    # post-processing — avoids loading unbounded repositories into memory.
    search_scan_cap: int = 500

    # Microsoft Entra ID (Azure AD) — API access-token validation.
    # When tenant + audience are set, Bearer JWTs are validated via JWKS.
    entra_tenant_id: str | None = None
    entra_api_audience: str | None = None
    entra_client_id: str | None = None
    entra_role_claim: str = "roles"
    # Used when the token has no mapped app roles.
    entra_default_role: str = "viewer"

    ocr_enabled: bool = True
    ocr_language: str = "eng"
    ocr_dpi: int = 300
    # Bounds a single Tesseract invocation so one malformed/huge image
    # cannot occupy a worker (or the request thread) indefinitely.
    ocr_page_timeout_seconds: int = 45

    ocr_min_character_count: int = 40
    ocr_min_word_count: int = 8
    ocr_min_text_coverage: float = 0.002
    ocr_max_image_ratio: float = 0.70
    # Fraction of replacement/control glyphs that marks a useless text layer.
    ocr_max_bad_glyph_ratio: float = 0.15

    tessdata_prefix: str | None = None

    model_config = SettingsConfigDict(
        env_file=(_ROOT_ENV, _BACKEND_ENV),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    @property
    def cors_origins(self) -> list[str]:
        """Support comma-separated FRONTEND_URL values."""
        origins = [
            origin.strip()
            for origin in self.frontend_url.split(",")
            if origin.strip()
        ]

        # Known frontend origins for this project. Kept here (not
        # just in the Render dashboard's FRONTEND_URL) so CORS still
        # works out of the box if the service is ever recreated.
        for origin in (
            "http://localhost:3000",
            "https://data-agent-ca.vercel.app",
            "https://frontend-ivory-nine-22.vercel.app",
        ):
            if origin not in origins:
                origins.append(origin)

        if self.debug:
            for origin in (
                "http://localhost:3000",
                "http://127.0.0.1:3000",
                "http://localhost:3001",
                "http://127.0.0.1:3001",
                "http://192.168.0.193:3000",
            ):
                if origin not in origins:
                    origins.append(origin)

        return origins

    @property
    def entra_configured(self) -> bool:
        return bool(self.entra_tenant_id and self.entra_api_audience)

    @property
    def effective_rbac_enforced(self) -> bool:
        """Production always enforces RBAC; otherwise honor rbac_enforced."""

        if (self.app_env or "").strip().lower() == "production":
            return True
        return bool(self.rbac_enforced)

    @property
    def effective_metadata_review_mutations_enabled(self) -> bool:
        """Whether metadata review mutation APIs may run.

        Explicit METADATA_REVIEW_MUTATIONS_ENABLED wins. When unset,
        production is fail-closed; other environments remain open for
        local development and the automated test suite.
        """

        if self.metadata_review_mutations_enabled is not None:
            return bool(self.metadata_review_mutations_enabled)
        return (self.app_env or "").strip().lower() != "production"

    @property
    def resolved_database_url(self) -> str:
        """Normalize database_url for the driver actually installed.

        Two independent fixups:

        - A relative sqlite:/// path (e.g. "sqlite:///./data_agent.db")
          resolves against the process's current working directory,
          which is not stable across restarts (different launch
          method, IDE run config, shell cwd, ...). SQLite silently
          creates a fresh empty database at the new location instead
          of erroring, so every previously stored row appears to
          vanish even though the original file is untouched. Anchor it
          to the backend directory instead, mirroring upload_path.

        - Render (and Heroku-style) Postgres connection strings are
          handed out as postgres:// or postgresql://, which
          SQLAlchemy's default dialect maps to psycopg2 — but this
          project only installs psycopg (v3). Rewrite to
          postgresql+psycopg:// so the installed driver is used.
        """
        url = self.database_url

        if url.startswith("sqlite:///"):
            raw_path = url.removeprefix("sqlite:///")

            if raw_path in ("", ":memory:"):
                return url

            path = Path(raw_path)
            if not path.is_absolute():
                path = Path(__file__).resolve().parents[2] / path

            return f"sqlite:///{path.resolve().as_posix()}"

        if url.startswith("postgres://"):
            url = "postgresql://" + url.removeprefix("postgres://")

        if url.startswith("postgresql://"):
            url = "postgresql+psycopg://" + url.removeprefix(
                "postgresql://"
            )

        return url

    @property
    def upload_path(self) -> Path:
        """Create and return the private upload directory."""
        path = Path(self.upload_directory)
        if not path.is_absolute():
            path = Path(__file__).resolve().parents[2] / path
        path = path.resolve()
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def tessdata_path(self) -> Path | None:
        if not self.tessdata_prefix:
            return None

        path = Path(self.tessdata_prefix)

        if not path.exists():
            return None

        return path


@lru_cache
def get_settings() -> Settings:
    return Settings()
