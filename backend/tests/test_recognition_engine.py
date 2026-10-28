"""DI-03 pluggable recognition: provider adapters (mocked transports — no
network), the engine's routing/policy/retry/budget/grounding rules, the
page-OCR seam and the API. All documents are synthetic."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from uuid import uuid4

import fitz
import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.config import Settings
from app.database.session import SessionLocal
from app.main import app
from app.models.document import Document
from app.models.recognition_run import RecognitionRun
from app.recognition.engine import RecognitionEngine
from app.recognition.layout import Line, PageLayout, Word
from app.recognition.page_ocr import layout_to_ocr, resolve_page_ocr_engine
from app.recognition.providers.azure_di import AzureDocumentIntelligenceProvider
from app.recognition.providers.base import ProviderError, ProviderTransientError, ProviderUnavailable
from app.recognition.providers.google_docai import GoogleDocumentAIProvider
from app.recognition.providers.llm import LlmStructuredProvider
from app.recognition.providers.local import MrzProvider, NativeTextProvider
from app.recognition.providers.oci_document import OciDocumentUnderstandingProvider, api_key_signer
from app.recognition.strategies import StrategyStep
from app.recognition.types import (
    EvidenceSpan,
    FieldCandidate,
    ModelInfo,
    RecognitionRequest,
    RecognitionResult,
    UsageRecord,
)
from app.services.ai_provider import AIProvider

client = TestClient(app)
LEGACY = Settings(external_ai_policy="legacy")

TD3 = ("P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<", "L898902C36UTO7408122F1204159ZE184226B<<<<<10")


def _pdf(lines: list[str], tmp_path: Path) -> Path:
    pdf = fitz.open()
    page = pdf.new_page()
    for i, line in enumerate(lines):
        page.insert_text((40, 60 + 16 * i), line, fontsize=9, fontname="cour")
    path = tmp_path / f"doc-{uuid4().hex[:6]}.pdf"
    pdf.save(path)
    return path


def _request(path: Path, **kwargs) -> RecognitionRequest:
    return RecognitionRequest(
        document_id="d", run_id="r", profile_key=None, data_class="confidential",
        file_path=str(path), mime_type="application/pdf", **kwargs,
    )


def _document(data_class: str | None = "confidential", lines: list[str] | None = None) -> str:
    pdf = fitz.open()
    page = pdf.new_page()
    for i, line in enumerate(lines or [f"Invoice Number: INV-{uuid4().hex[:6]}"]):
        page.insert_text((40, 60 + 16 * i), line, fontsize=9, fontname="cour")
    response = client.post(
        "/api/documents/upload",
        files={"file": (f"rec-{uuid4()}.pdf", pdf.tobytes(), "application/pdf")},
    )
    assert response.status_code == 201, response.text
    document_id = response.json()["document_id"]
    database = SessionLocal()
    try:
        document = database.get(Document, document_id)
        document.data_class, document.data_class_source = data_class, "user" if data_class else None
        database.commit()
    finally:
        database.close()
    return document_id


# --- Azure Document Intelligence (mocked) ------------------------------------------


AZURE_RESULT = {
    "status": "succeeded",
    "analyzeResult": {
        "apiVersion": "2024-11-30",
        "modelId": "prebuilt-invoice",
        "pages": [
            {
                "pageNumber": 1, "unit": "inch", "width": 8.5, "height": 11,
                "words": [
                    {"content": "INV-1001", "polygon": [1, 1, 2, 1, 2, 1.2, 1, 1.2], "confidence": 0.98},
                    {"content": "$1,175.71", "polygon": [5, 9, 6, 9, 6, 9.2, 5, 9.2], "confidence": 0.97},
                ],
                "lines": [{"content": "Invoice INV-1001", "polygon": [0.5, 1, 2, 1, 2, 1.2, 0.5, 1.2]}],
            }
        ],
        "tables": [
            {"rowCount": 1, "columnCount": 2, "boundingRegions": [{"pageNumber": 1}],
             "cells": [{"rowIndex": 0, "columnIndex": 0, "content": "Widget"},
                       {"rowIndex": 0, "columnIndex": 1, "content": "10.00"}]}
        ],
        "documents": [
            {"fields": {
                "InvoiceId": {"type": "string", "valueString": "INV-1001", "content": "INV-1001",
                              "confidence": 0.95,
                              "boundingRegions": [{"pageNumber": 1, "polygon": [1, 1, 2, 1, 2, 1.2, 1, 1.2]}]},
                "InvoiceTotal": {"type": "currency", "valueCurrency": {"amount": 1175.71},
                                 "content": "$1,175.71", "confidence": 0.9,
                                 "boundingRegions": [{"pageNumber": 1, "polygon": [5, 9, 6, 9, 6, 9.2, 5, 9.2]}]},
                "SomethingUnmapped": {"content": "x", "confidence": 0.9},
            }}
        ],
    },
}


def _azure(handler, **kwargs) -> AzureDocumentIntelligenceProvider:
    return AzureDocumentIntelligenceProvider(
        endpoint="https://example.cognitiveservices.azure.com", key="k", model="prebuilt-invoice",
        poll_interval_seconds=0, transport=httpx.MockTransport(handler), **kwargs,
    )


def test_azure_maps_layout_tables_and_fields(tmp_path) -> None:
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.method == "POST":
            return httpx.Response(202, headers={"operation-location": "https://example/op/1"})
        if len(calls) == 2:
            return httpx.Response(200, json={"status": "running"})
        return httpx.Response(200, json=AZURE_RESULT)

    provider = _azure(handler, price_per_page_usd=0.01)
    result = asyncio.run(provider.recognize(_request(_pdf(["x"], tmp_path))))

    post = calls[0]
    assert "documentModels/prebuilt-invoice:analyze" in str(post.url)
    assert "api-version=2024-11-30" in str(post.url)
    assert post.headers["Ocp-Apim-Subscription-Key"] == "k"
    page = result.pages[0]
    assert page.coord_space == "pdf_points" and page.width == pytest.approx(612)
    assert page.words[0].bbox == pytest.approx((72, 72, 144, 86.4))
    assert result.tables[0].grid() == [["Widget", "10.00"]]
    fields = {f.canonical_field: f for f in result.fields}
    assert set(fields) == {"invoice.invoice_number", "invoice.total.invoice_amount"}
    total = fields["invoice.total.invoice_amount"]
    assert (total.value, total.normalized_value) == ("$1,175.71", "1175.71")
    assert total.evidence[0].page == 1
    assert result.usage.pages == 1 and result.usage.estimated_cost_usd == pytest.approx(0.01)
    assert (result.model.model, result.model.version) == ("prebuilt-invoice", "2024-11-30")


@pytest.mark.parametrize(("status", "error"), [(429, ProviderTransientError), (503, ProviderTransientError), (401, ProviderError), (400, ProviderError)])
def test_azure_http_errors_map_to_retry_semantics(tmp_path, status, error) -> None:
    provider = _azure(lambda request: httpx.Response(status, text="nope"))
    with pytest.raises(error):
        asyncio.run(provider.recognize(_request(_pdf(["x"], tmp_path))))


def test_unconfigured_azure_is_unavailable(tmp_path) -> None:
    provider = AzureDocumentIntelligenceProvider(endpoint=None, key=None)
    assert provider.configured(LEGACY)[0] is False
    with pytest.raises(ProviderUnavailable):
        asyncio.run(provider.recognize(_request(_pdf(["x"], tmp_path))))


# --- Google Document AI (mocked) ----------------------------------------------------


def test_google_docai_maps_tokens_and_entities(tmp_path) -> None:
    text = "Invoice INV-77 Total 99.50"
    document = {
        "text": text,
        "pages": [{
            "pageNumber": 1, "dimension": {"width": 1000, "height": 2000, "unit": "pixels"},
            "tokens": [{"layout": {"textAnchor": {"textSegments": [{"endIndex": "7"}]}, "confidence": 0.9,
                                   "boundingPoly": {"normalizedVertices": [{"x": 0.1, "y": 0.1}, {"x": 0.2, "y": 0.1}, {"x": 0.2, "y": 0.12}, {"x": 0.1, "y": 0.12}]}}}],
        }],
        "entities": [
            {"type": "invoice_id", "mentionText": "INV-77", "confidence": 0.93,
             "pageAnchor": {"pageRefs": [{"boundingPoly": {"normalizedVertices": [{"x": 0.3, "y": 0.1}, {"x": 0.4, "y": 0.12}]}}]}},
            {"type": "total_amount", "mentionText": "99.50", "normalizedValue": {"text": "99.5"},
             "pageAnchor": {"pageRefs": [{"page": "0"}]}},
        ],
    }
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers["Authorization"]
        seen["body"] = json.loads(request.content)
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"document": document})

    async def token() -> str:
        return "tkn"

    provider = GoogleDocumentAIProvider(
        project="p", location="eu", processor_id="abc", processor_kind="invoice",
        token_provider=token, transport=httpx.MockTransport(handler),
    )
    result = asyncio.run(provider.recognize(_request(_pdf(["x"], tmp_path))))
    assert seen["auth"] == "Bearer tkn"
    assert seen["url"] == "https://eu-documentai.googleapis.com/v1/projects/p/locations/eu/processors/abc:process"
    assert seen["body"]["rawDocument"]["mimeType"] == "application/pdf"
    assert result.pages[0].words[0].text == "Invoice"
    assert result.pages[0].words[0].bbox == pytest.approx((100, 200, 200, 240))
    fields = {f.canonical_field: f for f in result.fields}
    assert fields["invoice.invoice_number"].evidence[0].page == 1
    assert fields["invoice.total.invoice_amount"].normalized_value == "99.5"


def test_google_docai_unconfigured_and_server_errors(tmp_path) -> None:
    assert GoogleDocumentAIProvider(project=None, processor_id=None).configured(LEGACY)[0] is False

    async def token() -> str:
        return "t"

    provider = GoogleDocumentAIProvider(
        project="p", processor_id="x", token_provider=token,
        transport=httpx.MockTransport(lambda r: httpx.Response(503, text="busy")),
    )
    with pytest.raises(ProviderTransientError):
        asyncio.run(provider.recognize(_request(_pdf(["x"], tmp_path))))


# --- OCI Document Understanding (mocked) ---------------------------------------------

OCI_RESULT = {
    "pages": [{
        "pageNumber": 1,
        "dimensions": {"width": 8.5, "height": 11, "unit": "INCH"},
        "words": [{"text": "Invoice", "confidence": 0.98,
                   "boundingPolygon": {"normalizedVertices": [{"x": 0.1, "y": 0.1}, {"x": 0.2, "y": 0.1}, {"x": 0.2, "y": 0.12}, {"x": 0.1, "y": 0.12}]}}],
        "lines": [{"text": "Invoice INV-9", "confidence": 0.97,
                   "boundingPolygon": {"normalizedVertices": [{"x": 0.1, "y": 0.1}, {"x": 0.4, "y": 0.12}]}}],
        "tables": [{"rowCount": 2, "columnCount": 2,
                    "headerRows": [{"cells": [{"text": "Item", "rowIndex": 0, "columnIndex": 0}, {"text": "Amount", "rowIndex": 0, "columnIndex": 1}]}],
                    "bodyRows": [{"cells": [{"text": "Widget", "rowIndex": 1, "columnIndex": 0}, {"text": "10.00", "rowIndex": 1, "columnIndex": 1}]}]}],
        "documentFields": [
            {"fieldType": "KEY_VALUE", "fieldLabel": {"name": "InvoiceId"},
             "fieldValue": {"valueType": "STRING", "text": "INV-9", "value": "INV-9", "confidence": 0.94,
                            "boundingPolygon": {"normalizedVertices": [{"x": 0.3, "y": 0.1}, {"x": 0.4, "y": 0.12}]}}},
            {"fieldType": "KEY_VALUE", "fieldLabel": {"name": "InvoiceTotal"},
             "fieldValue": {"valueType": "NUMBER", "text": "$99.50", "value": 99.5, "confidence": 0.9}},
            {"fieldType": "KEY_VALUE", "fieldLabel": {"name": "Unmapped"}, "fieldValue": {"text": "x"}},
            {"fieldType": "LINE_ITEM_GROUP", "fieldLabel": {"name": "Items"}, "fieldValue": {"text": "Widget"}},
        ],
    }],
    "keyValueExtractionModelVersion": "1.4.0",
}


def _oci(handler, **kwargs) -> OciDocumentUnderstandingProvider:
    kwargs.setdefault("document_type", "invoice")
    return OciDocumentUnderstandingProvider(
        region="eu-frankfurt-1", compartment_id="ocid1.compartment.oc1..c",
        signer=lambda method, url, headers, body: {"authorization": "Signature test"},
        transport=httpx.MockTransport(handler), **kwargs,
    )


def test_oci_document_maps_layout_tables_and_fields(tmp_path) -> None:
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers["authorization"]
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json=OCI_RESULT)

    provider = _oci(handler, price_per_page_usd=0.01)
    assert "fields:invoice" in provider.capabilities
    result = asyncio.run(provider.recognize(_request(_pdf(["x"], tmp_path))))

    assert seen["url"] == "https://document.aiservice.eu-frankfurt-1.oci.oraclecloud.com/20221109/actions/analyzeDocument"
    assert seen["auth"] == "Signature test"
    body = seen["body"]
    assert body["documentType"] == "INVOICE" and body["document"]["source"] == "INLINE"
    assert {f["featureType"] for f in body["features"]} == {"TEXT_EXTRACTION", "TABLE_EXTRACTION", "KEY_VALUE_EXTRACTION"}
    page = result.pages[0]
    assert page.coord_space == "pdf_points" and page.width == pytest.approx(612)
    assert page.words[0].bbox == pytest.approx((61.2, 79.2, 122.4, 95.04))
    assert result.tables[0].grid() == [["Item", "Amount"], ["Widget", "10.00"]]
    fields = {f.canonical_field: f for f in result.fields}
    assert set(fields) == {"invoice.invoice_number", "invoice.total.invoice_amount"}
    total = fields["invoice.total.invoice_amount"]
    assert (total.value, total.normalized_value) == ("$99.50", "99.5")
    assert total.grounded and total.evidence[0].bbox is None
    assert result.usage.estimated_cost_usd == pytest.approx(0.01)
    assert (result.model.version, result.model.region) == ("1.4.0", "eu-frankfurt-1")


def test_oci_document_layout_only_and_errors(tmp_path) -> None:
    unconfigured = OciDocumentUnderstandingProvider(region=None, compartment_id=None)
    assert unconfigured.configured(LEGACY)[0] is False
    no_key = OciDocumentUnderstandingProvider(region="r", compartment_id="c", private_key_file=str(tmp_path / "missing.pem"))
    assert no_key.configured(LEGACY)[0] is False
    with pytest.raises(ProviderUnavailable):
        asyncio.run(no_key.recognize(_request(_pdf(["x"], tmp_path))))

    layout = _oci(lambda r: httpx.Response(200, json={"pages": []}), document_type=None)
    assert "fields:invoice" not in layout.capabilities and layout.configured(LEGACY)[0] is True
    for status, error in ((429, ProviderTransientError), (503, ProviderTransientError), (401, ProviderError)):
        provider = _oci(lambda r, s=status: httpx.Response(s, text="nope"))
        with pytest.raises(error):
            asyncio.run(provider.recognize(_request(_pdf(["x"], tmp_path))))


def test_oci_api_key_signature_verifies(tmp_path) -> None:
    import base64
    import hashlib
    import re

    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding, rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = tmp_path / "oci.pem"
    pem.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    sign = api_key_signer(tenancy="ten", user="usr", fingerprint="aa:bb", private_key_file=str(pem))
    url = "https://document.aiservice.eu-frankfurt-1.oci.oraclecloud.com/20221109/actions/analyzeDocument"
    body = b'{"a": 1}'
    headers = sign("POST", url, {"content-type": "application/json"}, body)

    assert headers["x-content-sha256"] == base64.b64encode(hashlib.sha256(body).digest()).decode()
    assert headers["content-length"] == str(len(body))
    auth = headers["authorization"]
    assert 'keyId="ten/usr/aa:bb"' in auth and 'algorithm="rsa-sha256"' in auth
    names = re.search(r'headers="([^"]+)"', auth).group(1).split()
    assert names == ["(request-target)", "date", "host", "x-content-sha256", "content-type", "content-length"]
    lines = ["(request-target): post /20221109/actions/analyzeDocument"] + [f"{n}: {headers[n]}" for n in names[1:]]
    signature = base64.b64decode(re.search(r'signature="([^"]+)"', auth).group(1))
    key.public_key().verify(signature, "\n".join(lines).encode(), padding.PKCS1v15(), hashes.SHA256())


# --- local providers -----------------------------------------------------------------


def test_native_text_and_mrz_providers(tmp_path) -> None:
    path = _pdf(["PASSPORT", *TD3], tmp_path)
    native = asyncio.run(NativeTextProvider().recognize(_request(path)))
    assert native.status == "ok" and native.pages[0].coord_space == "pdf_points"
    mrz = asyncio.run(MrzProvider().recognize(_request(path, prior=(native,))))
    fields = {f.canonical_field: f.value for f in mrz.fields}
    assert fields["identity.document_number"] == "L898902C3"
    assert fields["identity.surname"] == "ERIKSSON"
    assert mrz.warnings == ["MRZ TD3: check digits valid"]
    assert all(f.grounded for f in mrz.fields)


# --- engine ------------------------------------------------------------------------


class Fake:
    def __init__(self, provider_id, *, locality="external", results=(), configured=True, delay=0.0):
        self.provider_id = provider_id
        self.locality = locality
        self.capabilities = frozenset({"fields:any"})
        self._results = list(results)
        self._configured = configured
        self.delay = delay
        self.calls = 0

    def configured(self, settings):
        return self._configured, "fake"

    def model_info(self):
        return ModelInfo(self.provider_id, model="fake-1", version="1")

    async def recognize(self, request):
        self.calls += 1
        if self.delay:
            await asyncio.sleep(self.delay)
        item = self._results.pop(0) if len(self._results) > 1 else self._results[0]
        if isinstance(item, Exception):
            raise item
        return item


def _fields(*pairs, cost=None) -> RecognitionResult:
    return RecognitionResult(
        ModelInfo("fake", "fake-1"), "ok",
        fields=[FieldCandidate(raw_label=k, value=v, canonical_field=k, confidence=0.9,
                               evidence=[EvidenceSpan(page=p, text=q)] if p else [])
                for k, v, p, q in pairs],
        usage=UsageRecord(pages=1, estimated_cost_usd=cost),
    )


def _run(document_id, strategy, providers, wanted=("invoice.invoice_number",), settings=LEGACY, tmp=None):
    database = SessionLocal()
    try:
        document = database.get(Document, document_id)
        engine = RecognitionEngine(providers, settings, retry_backoff_seconds=0)
        outcome = asyncio.run(engine.run(
            database=database, document=document, file_path=str(tmp or ""), mime_type="application/pdf",
            strategy=strategy, wanted_fields=wanted,
        ))
        database.commit()
        runs = database.scalars(select(RecognitionRun).where(RecognitionRun.run_id == outcome.run_id)).all()
        return outcome, runs
    finally:
        database.close()


def _local_text(text: str) -> RecognitionResult:
    page = PageLayout(1, 612, 792, "pdf_points", lines=[Line(text, (0, 0, 10, 10))])
    return RecognitionResult(ModelInfo("native_text"), "ok", pages=[page])


def test_engine_grounds_external_values_against_local_text() -> None:
    document_id = _document()
    native = Fake("native_text", locality="local", results=[_local_text("Invoice Number: INV-1001 Total $1,175.71")])
    vendor = Fake("vendor", results=[_fields(
        ("invoice.invoice_number", "INV-1001", 1, "INV-1001"),
        ("invoice.total.invoice_amount", "$9,999.00", 1, "$9,999.00"),  # not in the document
        ("invoice.due_date", "2026-01-01", 0, ""),  # no evidence
    )])
    outcome, runs = _run(document_id, (StrategyStep("native_text"), StrategyStep("vendor")),
                         {"native_text": native, "vendor": vendor},
                         wanted=("invoice.invoice_number", "invoice.total.invoice_amount", "invoice.due_date"))
    accepted = {f.canonical_field: f for f in outcome.fields}
    assert set(accepted) == {"invoice.invoice_number"}
    assert accepted["invoice.invoice_number"].candidates[0].locally_confirmed
    reasons = {r.candidate.canonical_field: r.reason for r in outcome.rejected}
    assert "Not found in the document's own text" in reasons["invoice.total.invoice_amount"]
    assert "No evidence" in reasons["invoice.due_date"]
    assert [(r.provider_id, r.status) for r in runs] == [("native_text", "ok"), ("vendor", "ok")]


def test_engine_conditions_skip_steps() -> None:
    document_id = _document()
    native = Fake("native_text", locality="local", results=[_local_text("Invoice Number: INV-1001")])
    ocr = Fake("ocr", locality="local", results=[_local_text("x")])
    first = Fake("first", results=[_fields(("invoice.invoice_number", "INV-1001", 1, "INV-1001"))])
    second = Fake("second", results=[_fields(("invoice.invoice_number", "INV-1001", 1, "INV-1001"))])
    outcome, _ = _run(
        document_id,
        (StrategyStep("native_text"), StrategyStep("ocr", when="no_text"),
         StrategyStep("first", when="fields_missing"), StrategyStep("second", when="fields_missing")),
        {"native_text": native, "ocr": ocr, "first": first, "second": second},
    )
    statuses = [(s.provider, s.status) for s in outcome.steps]
    assert statuses == [("native_text", "ok"), ("ocr", "skipped"), ("first", "ok"), ("second", "skipped")]
    assert ocr.calls == 0 and second.calls == 0


def test_engine_blocks_external_steps_by_policy_and_records_it() -> None:
    document_id = _document("restricted")
    vendor = Fake("vendor", results=[_fields(("invoice.invoice_number", "X", 1, "X"))])
    outcome, runs = _run(document_id, (StrategyStep("vendor"),), {"vendor": vendor})
    assert outcome.steps[0].status == "blocked_by_policy" and vendor.calls == 0
    assert [(r.status, r.data_class) for r in runs] == [("blocked_by_policy", "restricted")]


def test_engine_retries_transient_failures_only() -> None:
    document_id = _document()
    flaky = Fake("flaky", results=[ProviderTransientError("503"), _fields()])
    broken = Fake("broken", results=[ProviderError("400 bad request")])
    outcome, runs = _run(document_id, (StrategyStep("flaky", max_attempts=2), StrategyStep("broken", max_attempts=3)),
                         {"flaky": flaky, "broken": broken})
    assert [(s.provider, s.status, s.attempts) for s in outcome.steps] == [("flaky", "ok", 2), ("broken", "failed", 1)]
    assert flaky.calls == 2 and broken.calls == 1
    assert [(r.provider_id, r.status, r.error_kind) for r in runs] == [
        ("flaky", "error", "transient"), ("flaky", "ok", None), ("broken", "error", "provider_error"),
    ]


def test_engine_timeout_and_required_failure() -> None:
    document_id = _document()
    slow = Fake("slow", locality="local", results=[_fields()], delay=0.5)
    outcome, _ = _run(document_id, (StrategyStep("slow", timeout_s=0.05, required=True),), {"slow": slow})
    assert outcome.steps[0].status == "failed" and outcome.failed_required


def test_engine_stops_paid_steps_at_the_budget() -> None:
    document_id = _document()
    a = Fake("a", results=[_fields(cost=0.30)])
    b = Fake("b", results=[_fields(cost=0.30)])
    budget = Settings(external_ai_policy="legacy", recognition_budget_usd_per_document=0.25)
    outcome, _ = _run(document_id, (StrategyStep("a"), StrategyStep("b")), {"a": a, "b": b}, settings=budget)
    assert [s.status for s in outcome.steps] == ["ok", "skipped"]
    assert "budget" in outcome.steps[1].reason and b.calls == 0


def test_engine_reports_agreement_and_conflict() -> None:
    document_id = _document()
    native = Fake("native_text", locality="local", results=[_local_text("Total $1,175.71 Invoice INV-1 INV-2")])
    a = Fake("a", results=[_fields(("invoice.total.invoice_amount", "$1,175.71", 1, "$1,175.71"),
                                   ("invoice.invoice_number", "INV-1", 1, "INV-1"))])
    b = Fake("b", results=[_fields(("invoice.total.invoice_amount", "1175.71", 1, "$1,175.71"),
                                   ("invoice.invoice_number", "INV-2", 1, "INV-2"))])
    outcome, _ = _run(document_id, (StrategyStep("native_text"), StrategyStep("a"), StrategyStep("b")),
                      {"native_text": native, "a": a, "b": b})
    status = {f.canonical_field: f.status for f in outcome.fields}
    assert status == {"invoice.total.invoice_amount": "agreed", "invoice.invoice_number": "conflict"}


def test_unconfigured_and_unknown_steps_are_skipped_with_reasons() -> None:
    document_id = _document()
    off = Fake("off", configured=False, results=[_fields()])
    outcome, runs = _run(document_id, (StrategyStep("off"), StrategyStep("nope")), {"off": off})
    assert [(s.status, s.reason) for s in outcome.steps] == [("skipped", "fake"), ("skipped", "Unknown provider.")]
    assert off.calls == 0 and runs == []


# --- LLM structured extraction -----------------------------------------------------


class FakeLLM(AIProvider):
    provider_id = "gemini"
    model = "fake-llm"

    async def extract(self, *, instruction, page_context):
        assert "invoice.invoice_number" in instruction and "PDF PAGE 1" in page_context
        return {"values": [
            {"label": "invoice.invoice_number", "value": "INV-1001", "page_number": 1, "source_text": "Invoice Number: INV-1001"},
            # A real quote with an invented value: must not be accepted.
            {"label": "invoice.total.invoice_amount", "value": "5,000.00", "page_number": 1, "source_text": "Total $1,175.71"},
            {"label": "not.requested", "value": "x", "page_number": 1, "source_text": "x"},
        ]}

    async def classify(self, **kw): return {}
    async def extract_fields(self, **kw): return {}
    async def extract_clauses(self, **kw): return {}
    async def extract_signatures(self, **kw): return {}
    async def extract_structured_tables(self, **kw): return {}
    async def enrich_schema(self, **kw): return {}


def test_llm_values_are_grounded_by_the_engine() -> None:
    document_id = _document()
    native = Fake("native_text", locality="local", results=[_local_text("Invoice Number: INV-1001 Total $1,175.71")])
    llm = LlmStructuredProvider(FakeLLM())
    outcome, runs = _run(
        document_id, (StrategyStep("native_text"), StrategyStep("llm")), {"native_text": native, "llm": llm},
        wanted=("invoice.invoice_number", "invoice.total.invoice_amount"),
    )
    assert {f.canonical_field: f.value for f in outcome.fields} == {"invoice.invoice_number": "INV-1001"}
    assert [r.candidate.canonical_field for r in outcome.rejected] == ["invoice.total.invoice_amount"]
    assert runs[-1].provider_id == "llm:gemini" and runs[-1].locality == "external"


# --- page OCR seam -----------------------------------------------------------------


def test_default_ocr_engine_is_the_builtin_path(monkeypatch) -> None:
    import app.recognition.page_ocr as page_ocr

    monkeypatch.setattr(page_ocr.shutil, "which", lambda name: "/usr/bin/tesseract")
    document_id = _document()
    database = SessionLocal()
    try:
        assert resolve_page_ocr_engine(database, database.get(Document, document_id), Settings()) is None
        # Configured name but nothing configured → still the built-in path.
        assert resolve_page_ocr_engine(database, database.get(Document, document_id), Settings(ocr_engine="azure_di")) is None
    finally:
        database.close()


def test_restricted_document_never_goes_to_external_page_ocr() -> None:
    document_id = _document("restricted")
    settings = Settings(ocr_engine="azure_di", azure_di_endpoint="https://x", azure_di_key="k")
    database = SessionLocal()
    try:
        engine = resolve_page_ocr_engine(database, database.get(Document, document_id), settings)
        database.commit()
        runs = database.scalars(select(RecognitionRun).where(RecognitionRun.document_id == document_id)).all()
    finally:
        database.close()
    assert engine is None
    assert [(r.method, r.status) for r in runs] == [("page_ocr", "blocked_by_policy")]


def test_external_page_layout_becomes_the_page_text() -> None:
    from app.services.page_text_extractor import extract_page

    class FakePageOcr:
        engine_id = "fake_ocr"

        def ocr(self, png_bytes, *, page_number):
            page = PageLayout(page_number, 1000, 1000, "ocr_pixels", dpi=220, words=[
                Word("Invoice", (100, 100, 200, 120), 0.99), Word("INV-9", (210, 100, 260, 120), 0.95),
                Word("Total", (100, 300, 160, 320), 0.9),
            ])
            return layout_to_ocr(page, self.engine_id)

    pdf = fitz.open()
    pdf.new_page()  # blank page: needs OCR
    extracted = extract_page(document=pdf, page_index=0, settings=Settings(), run_ocr=True,
                             force_ocr=True, page_ocr=FakePageOcr())
    assert extracted.final_text == "Invoice INV-9\nTotal"
    assert extracted.extraction_method == "ocr" and extracted.ocr_succeeded
    assert extracted.ocr_layout["engine"] == "fake_ocr"
    assert extracted.ocr_layout["coordinate_space"]["unit"] == "px"
    assert extracted.blocks[0].x0 == pytest.approx(100 * 72 / extracted.ocr_layout["coordinate_space"]["dpi"])


def test_failed_external_page_ocr_falls_back_to_the_builtin_path() -> None:
    from app.services.page_text_extractor import extract_page

    class Failing:
        engine_id = "failing"

        def ocr(self, png_bytes, *, page_number):
            return None

    pdf = fitz.open()
    pdf.new_page().insert_text((72, 72), "Native text on the page", fontsize=12)
    extracted = extract_page(document=pdf, page_index=0, settings=Settings(), run_ocr=True,
                             force_ocr=False, page_ocr=Failing())
    assert "Native text" in extracted.final_text
    assert (extracted.ocr_layout or {}).get("engine") != "failing"


# --- API ---------------------------------------------------------------------------


def test_providers_api_reports_configuration() -> None:
    body = client.get("/api/recognition/providers").json()
    by_id = {p["id"]: p for p in body}
    assert set(by_id) >= {"native_text", "tesseract", "mrz", "azure_di", "google_docai", "oci_document", "llm"}
    assert by_id["native_text"]["configured"] is True and by_id["native_text"]["locality"] == "local"
    assert by_id["azure_di"]["configured"] is False and by_id["azure_di"]["locality"] == "external"


def test_recognize_api_runs_local_steps_and_mrz() -> None:
    document_id = _document("restricted", ["PASSPORT", *TD3])
    response = client.post(
        f"/api/documents/{document_id}/recognize",
        json={"strategy": [{"provider": "native_text"}, {"provider": "mrz"}, {"provider": "azure_di"}],
              "wanted_fields": ["identity.document_number"]},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert [(s["provider"], s["status"]) for s in body["steps"]] == [
        ("native_text", "ok"), ("mrz", "ok"), ("azure_di", "skipped"),
    ]
    fields = {f["canonical_field"]: f for f in body["fields"]}
    assert fields["identity.document_number"]["value"] == "L898902C3"
    assert fields["identity.document_number"]["candidates"][0]["evidence"][0]["page"] == 1
    assert body["data_class"] == "restricted" and body["estimated_cost_usd"] == 0


def test_recognize_api_needs_extraction_permission() -> None:
    document_id = _document()
    response = client.post(
        f"/api/documents/{document_id}/recognize", json={}, headers={"X-Actor-Id": "actor-viewer-default"}
    )
    assert response.status_code == 403


def test_missing_tesseract_falls_back_to_local_rapidocr(monkeypatch) -> None:
    import app.recognition.page_ocr as page_ocr
    from app.recognition.providers import rapid_ocr

    monkeypatch.setattr(page_ocr.shutil, "which", lambda name: None)
    monkeypatch.setattr(rapid_ocr, "available", lambda: True)
    document_id = _document(data_class="restricted")
    database = SessionLocal()
    try:
        engine = resolve_page_ocr_engine(database, database.get(Document, document_id), Settings())
        # Local, so even a restricted document (a passport) may use it.
        assert engine is not None and engine.engine_id == "rapidocr"
        monkeypatch.setattr(rapid_ocr, "available", lambda: False)
        assert resolve_page_ocr_engine(database, database.get(Document, document_id), Settings()) is None
    finally:
        database.close()


def test_rapidocr_lines_become_words_with_boxes() -> None:
    from app.recognition.providers.rapid_ocr import to_page

    page = to_page([[[[10, 20], [110, 20], [110, 40], [10, 40]], "Passport No AB123", 0.97]], 600, 800)
    assert page.coord_space == "ocr_pixels" and (page.width, page.height) == (600, 800)
    assert [w.text for w in page.words] == ["Passport", "No", "AB123"]
    assert page.lines[0].bbox == (10, 20, 110, 40)
    first, last = page.words[0].bbox, page.words[-1].bbox
    assert first[0] == 10 and last[2] == pytest.approx(110)
    assert all(w.confidence == pytest.approx(0.97) for w in page.words)
