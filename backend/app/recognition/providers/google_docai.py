"""Google Cloud Document AI adapter (REST v1, one processor).

Disabled unless project, location, processor and a service-account
credentials file are configured — and the engine only calls it when
policy allows the document's data class. Entity values are taken as
printed (`mentionText`) for local re-grounding; Google's normalized value
is kept separately.
"""

from __future__ import annotations

import asyncio
import base64
from collections.abc import Awaitable, Callable
from pathlib import Path

import httpx

from app.recognition.layout import PageLayout, Word
from app.recognition.providers.base import (
    ProviderError,
    ProviderTransientError,
    ProviderUnavailable,
    http_error,
)
from app.recognition.types import (
    EvidenceSpan,
    FieldCandidate,
    ModelInfo,
    RecognitionRequest,
    RecognitionResult,
    UsageRecord,
)

# Invoice parser entity type → canonical field (unmapped types ignored).
INVOICE_ENTITIES = {
    "invoice_id": "invoice.invoice_number",
    "invoice_date": "invoice.invoice_date",
    "due_date": "invoice.due_date",
    "supplier_name": "invoice.supplier.name",
    "supplier_address": "invoice.supplier.address",
    "supplier_tax_id": "invoice.supplier.tax_id",
    "remit_to_address": "invoice.supplier.remit_to",
    "receiver_name": "invoice.customer.name",
    "receiver_address": "invoice.customer.bill_to_address",
    "ship_to_address": "invoice.customer.ship_to_address",
    "purchase_order": "invoice.reference.po_number",
    "payment_terms": "invoice.payment_terms",
    "net_amount": "invoice.total.subtotal",
    "total_tax_amount": "invoice.total.tax",
    "total_amount": "invoice.total.invoice_amount",
    "amount_due": "invoice.total.amount_due",
    "freight_amount": "invoice.total.freight",
    "currency": "invoice.currency",
}

TokenProvider = Callable[[], Awaitable[str]]


def service_account_token_provider(credentials_file: str) -> TokenProvider:
    async def token() -> str:
        def fetch() -> str:
            from google.auth.transport.requests import Request
            from google.oauth2 import service_account

            credentials = service_account.Credentials.from_service_account_file(
                credentials_file, scopes=["https://www.googleapis.com/auth/cloud-platform"]
            )
            credentials.refresh(Request())
            return credentials.token

        return await asyncio.to_thread(fetch)

    return token


class GoogleDocumentAIProvider:
    locality = "external"

    def __init__(
        self,
        *,
        project: str | None,
        location: str = "us",
        processor_id: str | None,
        processor_version: str | None = None,
        credentials_file: str | None = None,
        processor_kind: str = "ocr",  # ocr | invoice
        price_per_page_usd: float | None = None,
        token_provider: TokenProvider | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self.project = project
        self.location = location
        self.processor_id = processor_id
        self.processor_version = processor_version
        self.credentials_file = credentials_file
        self.processor_kind = processor_kind
        self.price_per_page_usd = price_per_page_usd
        self.token_provider = token_provider
        self.transport = transport
        self.provider_id = "google_docai"
        caps = {"ocr", "layout"}
        if processor_kind == "invoice":
            caps.add("fields:invoice")
        self.capabilities = frozenset(caps)

    def configured(self, settings) -> tuple[bool, str]:
        if not (self.project and self.processor_id):
            return False, "GOOGLE_DOCAI_PROJECT and GOOGLE_DOCAI_PROCESSOR_ID are not set."
        if self.token_provider is None and not (
            self.credentials_file and Path(self.credentials_file).is_file()
        ):
            return False, "GOOGLE_DOCAI_CREDENTIALS_FILE is not set or not readable."
        return True, f"{self.processor_kind} processor {self.processor_id} ({self.location})"

    def model_info(self) -> ModelInfo:
        return ModelInfo(
            self.provider_id,
            model=f"{self.processor_kind}:{self.processor_id}",
            version=self.processor_version,
            region=self.location,
        )

    def _url(self) -> str:
        name = f"projects/{self.project}/locations/{self.location}/processors/{self.processor_id}"
        if self.processor_version:
            name += f"/processorVersions/{self.processor_version}"
        return f"https://{self.location}-documentai.googleapis.com/v1/{name}:process"

    async def recognize(self, request: RecognitionRequest) -> RecognitionResult:
        if not (self.project and self.processor_id):
            raise ProviderUnavailable("Google Document AI is not configured.")
        tokens = self.token_provider or (
            service_account_token_provider(self.credentials_file) if self.credentials_file else None
        )
        if tokens is None:
            raise ProviderUnavailable("Google Document AI has no credentials.")
        token = await tokens()
        body: dict = {
            "rawDocument": {
                "content": base64.b64encode(Path(request.file_path).read_bytes()).decode(),
                "mimeType": request.mime_type,
            }
        }
        if request.pages:
            body["processOptions"] = {"individualPageSelector": {"pages": list(request.pages)}}
        async with httpx.AsyncClient(transport=self.transport, timeout=request.deadline_s) as client:
            try:
                response = await client.post(
                    self._url(), json=body, headers={"Authorization": f"Bearer {token}"}
                )
            except httpx.TimeoutException as exc:
                raise ProviderTransientError(f"Document AI timed out: {exc}") from exc
            except httpx.HTTPError as exc:
                raise ProviderTransientError(f"Document AI request failed: {exc}") from exc
        if response.status_code != 200:
            raise http_error(response.status_code, response.text)
        try:
            document = response.json()["document"]
        except (ValueError, KeyError) as exc:
            raise ProviderError("Document AI returned no document.") from exc
        return self._map(document)

    def _map(self, document: dict) -> RecognitionResult:
        text = document.get("text") or ""

        def anchored(layout: dict) -> str:
            segments = ((layout or {}).get("textAnchor") or {}).get("textSegments") or []
            return "".join(
                text[int(s.get("startIndex") or 0):int(s.get("endIndex") or 0)] for s in segments
            ).strip()

        pages: list[PageLayout] = []
        sizes: dict[int, tuple[float, float]] = {}
        for raw in document.get("pages") or []:
            number = int(raw.get("pageNumber") or len(pages) + 1)
            dimension = raw.get("dimension") or {}
            width, height = float(dimension.get("width") or 0), float(dimension.get("height") or 0)
            sizes[number] = (width, height)
            page = PageLayout(number, width, height, "ocr_pixels")
            for token in raw.get("tokens") or []:
                layout = token.get("layout") or {}
                word = anchored(layout)
                bbox = _normalized_bbox(layout.get("boundingPoly"), width, height)
                if word and bbox:
                    page.words.append(Word(word, bbox, layout.get("confidence")))
            pages.append(page)

        fields: list[FieldCandidate] = []
        mapping = INVOICE_ENTITIES if self.processor_kind == "invoice" else {}
        for entity in document.get("entities") or []:
            canonical = mapping.get(entity.get("type") or "")
            printed = (entity.get("mentionText") or "").strip()
            if not canonical or not printed:
                continue
            evidence = []
            for ref in ((entity.get("pageAnchor") or {}).get("pageRefs")) or []:
                number = int(ref.get("page") or 0) + 1  # Document AI pages are 0-based here
                width, height = sizes.get(number, (0.0, 0.0))
                evidence.append(
                    EvidenceSpan(
                        page=number,
                        text=printed,
                        bbox=_normalized_bbox(ref.get("boundingPoly"), width, height),
                        coord_space="ocr_pixels",
                    )
                )
            normalized = (entity.get("normalizedValue") or {}).get("text")
            fields.append(
                FieldCandidate(
                    raw_label=entity.get("type"),
                    value=printed,
                    canonical_field=canonical,
                    normalized_value=normalized,
                    confidence=entity.get("confidence"),
                    evidence=evidence,
                )
            )

        usage = UsageRecord(pages=len(pages))
        if self.price_per_page_usd is not None:
            usage.estimated_cost_usd = round(len(pages) * self.price_per_page_usd, 6)
        return RecognitionResult(self.model_info(), "ok", fields=fields, pages=pages, usage=usage)


def _normalized_bbox(poly: dict | None, width: float, height: float):
    vertices = (poly or {}).get("normalizedVertices") or []
    if not vertices or not width or not height:
        return None
    xs = [float(v.get("x") or 0) * width for v in vertices]
    ys = [float(v.get("y") or 0) * height for v in vertices]
    return (min(xs), min(ys), max(xs), max(ys))
