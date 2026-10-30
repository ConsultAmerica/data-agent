import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# Give the test suite its own SQLite file. app.core.config.get_settings()
# is @lru_cache'd and reads DATABASE_URL on first call, so this must be
# set before anything below imports app.main (which triggers that first
# call) — otherwise every test run writes real rows into the dev DB the
# uvicorn server is also reading from.
if "DATABASE_URL" not in os.environ:
    # Fresh file per session: rows left by an earlier run (e.g. an upload
    # with the same checksum) must not change this run's results. Only
    # the suite's own default file is ever removed.
    _test_db = ROOT / "test_data_agent.db"
    for _suffix in ("", "-wal", "-shm", "-journal"):
        Path(f"{_test_db}{_suffix}").unlink(missing_ok=True)
    os.environ["DATABASE_URL"] = f"sqlite:///{_test_db}"
# The seeded service actor has no key unless one is configured; the
# suite authenticates as it with this test-only key.
os.environ.setdefault("SEED_SERVICE_API_KEY", "test-only-service-api-key")
# Never reach a real AI vendor from the suite: the developer's .env may
# hold live keys. Overridden (not setdefault) so a shell can't leak one
# in; tests that need a provider inject a fake.
for _name in (
    "GEMINI_API_KEY", "OPENAI_API_KEY", "CONVERA_API_KEY", "OLLAMA_BASE_URL",
    "AZURE_DI_ENDPOINT", "AZURE_DI_KEY", "GOOGLE_DOCAI_PROCESSOR_ID", "GOOGLE_DOCAI_CREDENTIALS_FILE",
):
    os.environ[_name] = ""
os.environ["CONVERA_ENABLED"] = "false"
# No background layout builds racing a test database.
os.environ["PREBUILD_LAYOUT"] = "false"
os.environ["OCR_ENGINE"] = "tesseract"

from app.main import app  # noqa: E402
from app.database.base import Base  # noqa: E402
from app.database.migrate import (  # noqa: E402
    ensure_actor_audit_log_columns,
    ensure_detected_target_columns,
    ensure_document_metadata_field_columns,
    ensure_document_page_columns,
    ensure_documents_columns,
    ensure_extraction_model_columns,
    ensure_metadata_field_audit_log_columns,
    ensure_recognition_run_columns,
    ensure_target_correction_columns,
)
from app.database.session import engine  # noqa: E402
from app.models import actor as _actor_model  # noqa: E402,F401
from app.models import (  # noqa: E402,F401
    integration_audit_log as _integration_audit_log_model,
)
from app.services.actor_seed import ensure_actors_seeded  # noqa: E402
from app.models import (  # noqa: E402,F401
    classification_audit_log as _classification_audit_log_model,
)
from app.models import document as _document_model  # noqa: E402,F401
from app.models import (  # noqa: E402,F401
    document_address as _document_address_model,
)
from app.models import (  # noqa: E402,F401
    document_amendment_history as _document_amendment_history_model,
)
from app.models import (  # noqa: E402,F401
    document_clause as _document_clause_model,
)
from app.models import (  # noqa: E402,F401
    document_clause_reference as _document_clause_reference_model,
)
from app.models import (  # noqa: E402,F401
    document_contact as _document_contact_model,
)
from app.models import (  # noqa: E402,F401
    document_delivery_schedule as _document_delivery_schedule_model,
)
from app.models import (  # noqa: E402,F401
    document_funding_line as _document_funding_line_model,
)
from app.models import (  # noqa: E402,F401
    document_insurance_requirement as _document_insurance_requirement_model,
)
from app.models import (  # noqa: E402,F401
    document_key_position as _document_key_position_model,
)
from app.models import (  # noqa: E402,F401
    document_line_item as _document_line_item_model,
)
from app.models import (  # noqa: E402,F401
    document_metadata_field as _document_metadata_field_model,
)
from app.models import (  # noqa: E402,F401
    document_order_range as _document_order_range_model,
)
from app.models import document_page as _document_page_model  # noqa: E402,F401
from app.models import (  # noqa: E402,F401
    document_performance_period as _document_performance_period_model,
)
from app.models import (  # noqa: E402,F401
    document_signature as _document_signature_model,
)
from app.models import (  # noqa: E402,F401
    document_wawf_instruction as _document_wawf_instruction_model,
)
from app.models import (  # noqa: E402,F401
    extraction_model as _extraction_model_model,
)
from app.models import (  # noqa: E402,F401
    metadata_field_audit_log as _metadata_field_audit_log_model,
)
from app.models import (  # noqa: E402,F401
    page_text_block as _page_text_block_model,
)
from app.models import (  # noqa: E402,F401
    relationship_audit_log as _relationship_audit_log_model,
)
from app.models import (  # noqa: E402,F401
    validation_rule as _validation_rule_model,
)


@pytest.fixture(scope="session", autouse=True)
def _initialize_database() -> None:
    """
    FastAPI's `@app.on_event("startup")` handler (which normally runs
    this same migration) does not fire for a plain, non-context-managed
    `TestClient(app)` — every test file in this suite instantiates the
    client that way. Without this, the test DB silently keeps whatever
    stale schema it already had, which only "worked" before because a
    manually-run `uvicorn` dev server happened to migrate the shared
    SQLite file first. Running the same migration helpers eagerly here
    guarantees the schema is correct before any test runs, regardless
    of how the app is invoked.
    """

    Base.metadata.create_all(bind=engine)
    ensure_document_page_columns(engine)
    ensure_documents_columns(engine)
    ensure_document_metadata_field_columns(engine)
    ensure_extraction_model_columns(engine)
    ensure_target_correction_columns(engine)
    ensure_metadata_field_audit_log_columns(engine)
    ensure_actor_audit_log_columns(engine)
    ensure_recognition_run_columns(engine)
    ensure_detected_target_columns(engine)
    from app.database.playbook_columns import ensure_clause_playbook_rule_columns

    ensure_clause_playbook_rule_columns(engine)

    from app.database.session import SessionLocal

    database = SessionLocal()
    try:
        ensure_actors_seeded(database)
    finally:
        database.close()


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)
