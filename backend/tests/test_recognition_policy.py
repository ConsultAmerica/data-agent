"""External-provider policy, run records and data classes (DI-02 B-010..B-013)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import uuid4

import fitz
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.config import Settings
from app.database.session import SessionLocal
from app.main import app
from app.models.document import Document
from app.models.provider_approval import ProviderApproval
from app.models.recognition_run import RecognitionRun
from app.recognition.policy import (
    UNCLASSIFIED,
    decide_external_processing,
    member_provider_ids,
    provider_locality,
)
from app.recognition.types import EvidenceSpan, FieldCandidate, ModelInfo, RecognitionResult
from app.services.ai_enrichment import SKIPPED, start_session
from app.services.ai_provider import AIProvider, DisabledAIProvider
from app.services.fallback_ai_provider import FallbackAIProvider
from app.staging import registry

client = TestClient(app)
LEGACY = Settings(external_ai_policy="legacy")
ENTERPRISE = Settings(external_ai_policy="enterprise")


class FakeProvider(AIProvider):
    def __init__(self, provider_id: str = "gemini", model: str = "fake-model", fail: bool = False):
        self.provider_id = provider_id
        self.model = model
        self.fail = fail
        self.calls = 0

    async def extract(self, *, instruction, page_context):
        self.calls += 1
        if self.fail:
            raise RuntimeError("503 UNAVAILABLE")
        return {"value": "x"}

    async def classify(self, *, page_context):
        return {}

    async def extract_fields(self, *, page_context, field_specs):
        return {}

    async def extract_clauses(self, *, page_context):
        return {}

    async def extract_signatures(self, *, page_context):
        return {}

    async def extract_structured_tables(self, *, page_context, table_specs):
        return {}

    async def enrich_schema(self, *, targets_json, page_context):
        return {}


def _document(data_class: str | None) -> str:
    pdf = fitz.open()
    pdf.new_page().insert_text((72, 72), f"Memo {uuid4()}", fontsize=10)
    response = client.post(
        "/api/documents/upload",
        files={"file": (f"policy-{uuid4()}.pdf", pdf.tobytes(), "application/pdf")},
    )
    assert response.status_code == 201, response.text
    document_id = response.json()["document_id"]
    database = SessionLocal()
    try:
        document = database.get(Document, document_id)
        document.data_class = data_class
        document.data_class_source = "user" if data_class else None
        database.commit()
    finally:
        database.close()
    return document_id


# --- policy -------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("data_class", "settings", "allowed"),
    [
        ("public", ENTERPRISE, True),
        ("internal", ENTERPRISE, True),
        ("confidential", LEGACY, True),
        ("confidential", ENTERPRISE, False),
        ("restricted", LEGACY, False),
        ("restricted", ENTERPRISE, False),
        (UNCLASSIFIED, LEGACY, True),
        (UNCLASSIFIED, ENTERPRISE, False),
    ],
)
def test_policy_matrix_without_approvals(data_class, settings, allowed) -> None:
    database = SessionLocal()
    try:
        decision = decide_external_processing(
            database, data_class=data_class, provider_ids=["gemini"], settings=settings
        )
    finally:
        database.close()
    assert decision.allowed is allowed, decision.reason


def test_local_providers_are_always_allowed() -> None:
    local_ollama = Settings(ollama_base_url="http://127.0.0.1:11434")
    remote_ollama = Settings(ollama_base_url="https://ollama.example.com")
    assert provider_locality("ollama", local_ollama) == "local"
    assert provider_locality("ollama", remote_ollama) == "external"
    decision = decide_external_processing(
        None, data_class="restricted", provider_ids=["ollama"], settings=local_ollama
    )
    assert decision.allowed


def test_approval_allows_restricted_until_revoked_or_expired() -> None:
    provider = f"vendor-{uuid4().hex[:6]}"
    database = SessionLocal()
    try:
        def allowed(now=None) -> bool:
            return decide_external_processing(
                database, data_class="restricted", provider_ids=[provider], settings=LEGACY, now=now
            ).allowed

        assert not allowed()
        approval = ProviderApproval(
            provider_id=provider, data_class="restricted", purpose="pilot", approved_by="a",
            expires_at=datetime.now(timezone.utc) + timedelta(days=1),
        )
        database.add(approval)
        database.commit()
        assert allowed()
        assert not allowed(now=datetime.now(timezone.utc) + timedelta(days=2))  # expired
        approval.revoked_at = datetime.now(timezone.utc)
        database.commit()
        assert not allowed()
    finally:
        database.close()


def test_a_chain_needs_every_external_member_approved() -> None:
    chain = FallbackAIProvider([FakeProvider("gemini"), FakeProvider("openai")])
    assert member_provider_ids(chain) == ["gemini", "openai"]
    database = SessionLocal()
    try:
        database.add(ProviderApproval(provider_id="gemini", data_class="confidential", purpose="t", approved_by="a"))
        database.commit()
        decision = decide_external_processing(
            database, data_class="confidential", provider_ids=member_provider_ids(chain), settings=ENTERPRISE
        )
        assert not decision.allowed and "openai" in decision.reason
    finally:
        database.query(ProviderApproval).filter(ProviderApproval.provider_id == "gemini").delete()
        database.commit()
        database.close()


# --- sessions ------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_restricted_document_never_reaches_the_provider() -> None:
    document_id = _document("restricted")
    provider = FakeProvider()
    database = SessionLocal()
    try:
        document = database.get(Document, document_id)
        session = start_session(provider, LEGACY, database=database, document=document)
        assert session.status == SKIPPED and "restricted" in (session.reason or "")
        assert not session.available
        await session.extract(instruction="i", page_context="p")  # disabled answer, no call
        database.commit()
        runs = database.scalars(select(RecognitionRun).where(RecognitionRun.document_id == document_id)).all()
    finally:
        database.close()
    assert provider.calls == 0
    assert [(r.status, r.provider_id, r.data_class) for r in runs] == [("blocked_by_policy", "disabled", "restricted")]
    assert runs[0].policy_reason


@pytest.mark.asyncio
async def test_allowed_calls_are_recorded_with_the_answering_model() -> None:
    document_id = _document("confidential")
    chain = FallbackAIProvider([FakeProvider("gemini", "g-1", fail=True), FakeProvider("openai", "o-1")])
    database = SessionLocal()
    try:
        document = database.get(Document, document_id)
        session = start_session(chain, LEGACY, database=database, document=document, job_id=42)
        assert session.model == "g-1+o-1"  # was mislabelled with GEMINI_MODEL before
        await session.extract(instruction="i", page_context="p")
        database.commit()
        runs = database.scalars(select(RecognitionRun).where(RecognitionRun.document_id == document_id)).all()
        summary = session.summary()
    finally:
        database.close()
    assert [(r.status, r.provider_id, r.model, r.locality, r.extraction_job_id) for r in runs] == [
        ("ok", "openai", "o-1", "external", 42)
    ]
    assert summary["run_id"] == runs[0].run_id and summary["data_class"] == "confidential"


def test_unclassified_document_follows_the_policy() -> None:
    document_id = _document(None)
    database = SessionLocal()
    try:
        document = database.get(Document, document_id)
        legacy = start_session(FakeProvider(), LEGACY, database=database, document=document)
        enterprise = start_session(FakeProvider(), ENTERPRISE, database=database, document=document)
    finally:
        database.close()
    assert legacy.available and legacy.data_class == UNCLASSIFIED
    assert not enterprise.available


def test_disabled_provider_needs_no_policy() -> None:
    session = start_session(DisabledAIProvider(), ENTERPRISE)
    assert session.status == SKIPPED and session.policy_reason is None


# --- data classes ---------------------------------------------------------------------


def test_profiles_declare_data_classes() -> None:
    classes = {p.profile_id: p.data_class for p in registry.latest_profiles()}
    assert classes["academic_transcript"] == "restricted"
    assert classes["far_part_52"] == "public"
    assert classes["invoice"] == "confidential"
    assert set(classes.values()) <= {"public", "internal", "confidential", "restricted"}


def test_document_detail_exposes_data_class() -> None:
    document_id = _document("restricted")
    body = client.get(f"/api/documents/{document_id}").json()
    assert (body["data_class"], body["data_class_source"]) == ("restricted", "user")


def test_ungrounded_candidates_are_not_accepted() -> None:
    result = RecognitionResult(
        model=ModelInfo("vendor"),
        status="ok",
        fields=[
            FieldCandidate(raw_label="Total", value="10", evidence=[EvidenceSpan(page=2, text="Total 10")]),
            FieldCandidate(raw_label="Total", value="99"),
            FieldCandidate(raw_label="Total", value="7", evidence=[EvidenceSpan(page=0, text="Total 7")]),
        ],
    )
    assert [c.value for c in result.accepted_fields()] == ["10"]


# --- admin API --------------------------------------------------------------------------


def test_provider_approvals_api_is_admin_only_and_revocable() -> None:
    created = client.post(
        "/api/admin/provider-approvals",
        json={"provider_id": "Gemini", "data_class": "restricted", "purpose": "transcript pilot"},
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["provider_id"] == "gemini" and body["approved_by"] == "actor-admin-default"

    forbidden = client.post(
        "/api/admin/provider-approvals",
        json={"provider_id": "gemini", "data_class": "restricted", "purpose": "x" * 5},
        headers={"X-Actor-Id": "actor-reviewer-default"},
    )
    assert forbidden.status_code == 403

    revoked = client.post(f"/api/admin/provider-approvals/{body['id']}/revoke")
    assert revoked.status_code == 200 and revoked.json()["revoked_at"]
    listed = client.get("/api/admin/provider-approvals").json()
    assert any(a["id"] == body["id"] and a["revoked_by"] == "actor-admin-default" for a in listed)
