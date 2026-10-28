"""Azure AI Document Intelligence adapter (REST, API version pinned).

Disabled unless AZURE_DI_ENDPOINT and AZURE_DI_KEY are set — and even then
the engine only calls it when policy allows the document's data class
(app/recognition/policy.py). Field values are taken as printed (`content`)
so the engine can re-ground them against the platform's own text layer;
Azure's normalized value is kept separately.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import httpx

from app.recognition.layout import Line, PageLayout, TableCell, TableResult, Word, polygon_bbox
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

DEFAULT_API_VERSION = "2024-11-30"

# Prebuilt model field → canonical field. Only fields with a canonical id
# are mapped; everything else is ignored rather than guessed.
FIELD_MAPS: dict[str, dict[str, str]] = {
    "prebuilt-invoice": {
        "InvoiceId": "invoice.invoice_number",
        "InvoiceDate": "invoice.invoice_date",
        "DueDate": "invoice.due_date",
        "VendorName": "invoice.supplier.name",
        "VendorAddress": "invoice.supplier.address",
        "VendorTaxId": "invoice.supplier.tax_id",
        "RemittanceAddress": "invoice.supplier.remit_to",
        "CustomerName": "invoice.customer.name",
        "CustomerId": "invoice.customer.number",
        "BillingAddress": "invoice.customer.bill_to_address",
        "ShippingAddress": "invoice.customer.ship_to_address",
        "PurchaseOrder": "invoice.reference.po_number",
        "PaymentTerm": "invoice.payment_terms",
        "SubTotal": "invoice.total.subtotal",
        "TotalTax": "invoice.total.tax",
        "InvoiceTotal": "invoice.total.invoice_amount",
        "AmountDue": "invoice.total.amount_due",
        "TotalDiscount": "invoice.total.discount",
    },
    "prebuilt-idDocument": {
        "DocumentNumber": "identity.document_number",
        "FirstName": "identity.given_names",
        "LastName": "identity.surname",
        "DateOfBirth": "identity.birth_date",
        "DateOfExpiration": "identity.expiry_date",
        "DateOfIssue": "identity.issue_date",
        "CountryRegion": "identity.issuing_state",
        "Nationality": "identity.nationality",
        "Sex": "identity.sex",
    },
}


class AzureDocumentIntelligenceProvider:
    locality = "external"

    def __init__(
        self,
        *,
        endpoint: str | None,
        key: str | None,
        model: str = "prebuilt-layout",
        api_version: str = DEFAULT_API_VERSION,
        price_per_page_usd: float | None = None,
        poll_interval_seconds: float = 1.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self.endpoint = (endpoint or "").rstrip("/")
        self.key = key
        self.model = model
        self.api_version = api_version
        self.price_per_page_usd = price_per_page_usd
        self.poll_interval_seconds = poll_interval_seconds
        self.transport = transport
        self.provider_id = "azure_di"
        caps = {"ocr", "layout", "tables"}
        if model in FIELD_MAPS:
            caps.add("fields:" + ("invoice" if "invoice" in model else "identity"))
        self.capabilities = frozenset(caps)

    def configured(self, settings) -> tuple[bool, str]:
        if not self.endpoint or not self.key:
            return False, "AZURE_DI_ENDPOINT and AZURE_DI_KEY are not set."
        return True, f"{self.model} @ {self.api_version}"

    def model_info(self) -> ModelInfo:
        return ModelInfo(self.provider_id, model=self.model, version=self.api_version)

    async def recognize(self, request: RecognitionRequest) -> RecognitionResult:
        if not self.endpoint or not self.key:
            raise ProviderUnavailable("Azure Document Intelligence is not configured.")
        url = (
            f"{self.endpoint}/documentintelligence/documentModels/{self.model}:analyze"
            f"?api-version={self.api_version}"
        )
        if request.pages:
            url += "&pages=" + ",".join(str(p) for p in request.pages)
        headers = {"Ocp-Apim-Subscription-Key": self.key, "Content-Type": request.mime_type}
        body = Path(request.file_path).read_bytes()
        async with httpx.AsyncClient(transport=self.transport, timeout=request.deadline_s) as client:
            try:
                submitted = await client.post(url, content=body, headers=headers)
            except httpx.TimeoutException as exc:
                raise ProviderTransientError(f"Azure submit timed out: {exc}") from exc
            except httpx.HTTPError as exc:
                raise ProviderTransientError(f"Azure submit failed: {exc}") from exc
            if submitted.status_code != 202:
                raise http_error(submitted.status_code, submitted.text)
            operation = submitted.headers.get("operation-location")
            if not operation:
                raise ProviderError("Azure accepted the request but returned no Operation-Location.")
            payload = await self._poll(client, operation)
        return self._map(payload.get("analyzeResult") or {})

    async def _poll(self, client: httpx.AsyncClient, operation: str) -> dict:
        headers = {"Ocp-Apim-Subscription-Key": self.key}
        while True:
            try:
                response = await client.get(operation, headers=headers)
            except httpx.HTTPError as exc:
                raise ProviderTransientError(f"Azure poll failed: {exc}") from exc
            if response.status_code != 200:
                raise http_error(response.status_code, response.text)
            payload = response.json()
            status = (payload.get("status") or "").lower()
            if status == "succeeded":
                return payload
            if status == "failed":
                raise ProviderError(f"Azure analysis failed: {str(payload.get('error'))[:300]}")
            await asyncio.sleep(self.poll_interval_seconds)

    def _map(self, result: dict) -> RecognitionResult:
        pages: list[PageLayout] = []
        scales: dict[int, float] = {}
        for raw in result.get("pages") or []:
            number = int(raw.get("pageNumber") or len(pages) + 1)
            unit = (raw.get("unit") or "pixel").lower()
            # PDFs come back in inches → PDF points; images in pixels.
            scale = 72.0 if unit == "inch" else 1.0
            scales[number] = scale
            page = PageLayout(
                number,
                float(raw.get("width") or 0) * scale,
                float(raw.get("height") or 0) * scale,
                "pdf_points" if unit == "inch" else "ocr_pixels",
            )
            for word in raw.get("words") or []:
                bbox = polygon_bbox(word.get("polygon"), scale)
                if bbox and word.get("content"):
                    page.words.append(Word(word["content"], bbox, word.get("confidence")))
            for line in raw.get("lines") or []:
                bbox = polygon_bbox(line.get("polygon"), scale)
                if bbox and line.get("content"):
                    page.lines.append(Line(line["content"], bbox))
            pages.append(page)

        tables: list[TableResult] = []
        for raw in result.get("tables") or []:
            regions = raw.get("boundingRegions") or [{}]
            number = int(regions[0].get("pageNumber") or 1)
            scale = scales.get(number, 1.0)
            table = TableResult(
                number,
                int(raw.get("rowCount") or 0),
                int(raw.get("columnCount") or 0),
                coord_space="pdf_points" if scale == 72.0 else "ocr_pixels",
            )
            for cell in raw.get("cells") or []:
                cell_regions = cell.get("boundingRegions") or [{}]
                table.cells.append(
                    TableCell(
                        int(cell.get("rowIndex") or 0),
                        int(cell.get("columnIndex") or 0),
                        cell.get("content") or "",
                        polygon_bbox(cell_regions[0].get("polygon"), scale),
                    )
                )
            tables.append(table)

        fields: list[FieldCandidate] = []
        mapping = FIELD_MAPS.get(self.model, {})
        for document in result.get("documents") or []:
            for name, raw in (document.get("fields") or {}).items():
                canonical = mapping.get(name)
                printed = (raw or {}).get("content")
                if not canonical or not printed:
                    continue
                evidence = []
                for region in raw.get("boundingRegions") or []:
                    number = int(region.get("pageNumber") or 0)
                    evidence.append(
                        EvidenceSpan(
                            page=number,
                            text=printed,
                            bbox=polygon_bbox(region.get("polygon"), scales.get(number, 1.0)),
                            coord_space="pdf_points" if scales.get(number) == 72.0 else "ocr_pixels",
                        )
                    )
                fields.append(
                    FieldCandidate(
                        raw_label=name,
                        value=printed,
                        canonical_field=canonical,
                        normalized_value=_normalized(raw),
                        confidence=raw.get("confidence"),
                        evidence=evidence,
                    )
                )

        usage = UsageRecord(pages=len(pages))
        if self.price_per_page_usd is not None:
            usage.estimated_cost_usd = round(len(pages) * self.price_per_page_usd, 6)
        info = ModelInfo(self.provider_id, model=result.get("modelId") or self.model, version=result.get("apiVersion") or self.api_version)
        return RecognitionResult(info, "ok", fields=fields, pages=pages, tables=tables, usage=usage)


def _normalized(raw: dict) -> str | None:
    for key in ("valueString", "valueDate", "valueNumber", "valueCountryRegion", "valuePhoneNumber"):
        if raw.get(key) is not None:
            return str(raw[key])
    currency = raw.get("valueCurrency")
    if isinstance(currency, dict) and currency.get("amount") is not None:
        return str(currency["amount"])
    return None
