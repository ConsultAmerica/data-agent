"""Oracle Cloud Infrastructure Document Understanding adapter (REST,
API version 20221109, synchronous analyzeDocument).

Disabled unless region, compartment and an API signing key (tenancy,
user, fingerprint, private key file) are configured — and the engine
only calls it when policy allows the document's data class. Requests are
signed with OCI's API-key HTTP signature; no OCI SDK is needed.

This is OCI's general document service, not Oracle Fusion Payables IDR:
its output comes back to Dataomatix for grounding and review, and says
nothing about invoice validation or approval in Oracle Payables
(docs/di-01-oracle-idr-parity-matrix.md §1). Key values are taken as
printed (`fieldValue.text`) for local re-grounding; OCI's typed value is
kept separately.
"""

from __future__ import annotations

import base64
import hashlib
import json
from collections.abc import Callable
from email.utils import formatdate
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from app.recognition.layout import Line, PageLayout, TableCell, TableResult, Word
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

API_VERSION = "20221109"

# Prebuilt key-value document type → (label → canonical field). Labels
# without a canonical id are ignored rather than guessed.
FIELD_MAPS: dict[str, dict[str, str]] = {
    "INVOICE": {
        "InvoiceId": "invoice.invoice_number",
        "InvoiceDate": "invoice.invoice_date",
        "DueDate": "invoice.due_date",
        "VendorName": "invoice.supplier.name",
        "VendorAddress": "invoice.supplier.address",
        "CustomerName": "invoice.customer.name",
        "CustomerId": "invoice.customer.number",
        "BillingAddress": "invoice.customer.bill_to_address",
        "ShippingAddress": "invoice.customer.ship_to_address",
        "PurchaseOrder": "invoice.reference.po_number",
        "PaymentTerm": "invoice.payment_terms",
        "SubTotal": "invoice.total.subtotal",
        "Tax": "invoice.total.tax",
        "InvoiceTotal": "invoice.total.invoice_amount",
        "AmountDue": "invoice.total.amount_due",
    },
    "PASSPORT": {
        "DocumentNumber": "identity.document_number",
        "FirstName": "identity.given_names",
        "LastName": "identity.surname",
        "DateOfBirth": "identity.birth_date",
        "DateOfExpiration": "identity.expiry_date",
        "DateOfIssue": "identity.issue_date",
        "Country": "identity.issuing_state",
        "Nationality": "identity.nationality",
        "Gender": "identity.sex",
    },
}
_FIELD_CAPS = {"INVOICE": "fields:invoice", "PASSPORT": "fields:identity"}

# (method, url, headers, body) → headers to add (Authorization etc.)
Signer = Callable[[str, str, dict[str, str], bytes], dict[str, str]]


def api_key_signer(
    *, tenancy: str, user: str, fingerprint: str, private_key_file: str, passphrase: str | None = None
) -> Signer:
    """OCI API-key request signing (draft-cavage HTTP signatures, RSA-SHA256)."""

    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding

    key = serialization.load_pem_private_key(
        Path(private_key_file).read_bytes(), password=passphrase.encode() if passphrase else None
    )
    key_id = f"{tenancy}/{user}/{fingerprint}"

    def sign(method: str, url: str, headers: dict[str, str], body: bytes) -> dict[str, str]:
        parts = urlsplit(url)
        target = parts.path + (f"?{parts.query}" if parts.query else "")
        signed = {
            "date": formatdate(usegmt=True),
            "host": parts.netloc,
            "x-content-sha256": base64.b64encode(hashlib.sha256(body).digest()).decode(),
            "content-type": headers.get("content-type", "application/json"),
            "content-length": str(len(body)),
        }
        names = ["(request-target)", *signed]
        signing_string = "\n".join(
            [f"(request-target): {method.lower()} {target}"] + [f"{k}: {v}" for k, v in signed.items()]
        )
        signature = base64.b64encode(
            key.sign(signing_string.encode(), padding.PKCS1v15(), hashes.SHA256())
        ).decode()
        signed["authorization"] = (
            f'Signature version="1",keyId="{key_id}",algorithm="rsa-sha256",'
            f'headers="{" ".join(names)}",signature="{signature}"'
        )
        return signed

    return sign


class OciDocumentUnderstandingProvider:
    locality = "external"

    def __init__(
        self,
        *,
        region: str | None,
        compartment_id: str | None,
        tenancy: str | None = None,
        user: str | None = None,
        fingerprint: str | None = None,
        private_key_file: str | None = None,
        private_key_passphrase: str | None = None,
        document_type: str | None = None,  # None = OCR/layout only; INVOICE | PASSPORT | ...
        language: str | None = None,
        price_per_page_usd: float | None = None,
        signer: Signer | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self.region = region
        self.compartment_id = compartment_id
        self.tenancy = tenancy
        self.user = user
        self.fingerprint = fingerprint
        self.private_key_file = private_key_file
        self.private_key_passphrase = private_key_passphrase
        self.document_type = (document_type or "").strip().upper() or None
        self.language = language
        self.price_per_page_usd = price_per_page_usd
        self.signer = signer
        self.transport = transport
        self.provider_id = "oci_document"
        caps = {"ocr", "layout", "tables"}
        if self.document_type in _FIELD_CAPS:
            caps.add(_FIELD_CAPS[self.document_type])
        self.capabilities = frozenset(caps)

    def _has_key(self) -> bool:
        return bool(
            self.tenancy and self.user and self.fingerprint
            and self.private_key_file and Path(self.private_key_file).is_file()
        )

    def configured(self, settings) -> tuple[bool, str]:
        if not (self.region and self.compartment_id):
            return False, "OCI_DOCUMENT_REGION and OCI_DOCUMENT_COMPARTMENT_ID are not set."
        if self.signer is None and not self._has_key():
            return False, "OCI API signing key (tenancy, user, fingerprint, key file) is not set or not readable."
        return True, f"{self.document_type or 'layout'} @ {self.region}"

    def model_info(self) -> ModelInfo:
        return ModelInfo(
            self.provider_id,
            model=(self.document_type or "layout").lower(),
            version=API_VERSION,
            region=self.region,
        )

    def _url(self) -> str:
        return f"https://document.aiservice.{self.region}.oci.oraclecloud.com/{API_VERSION}/actions/analyzeDocument"

    async def recognize(self, request: RecognitionRequest) -> RecognitionResult:
        if not (self.region and self.compartment_id):
            raise ProviderUnavailable("OCI Document Understanding is not configured.")
        signer = self.signer
        if signer is None:
            if not self._has_key():
                raise ProviderUnavailable("OCI Document Understanding has no signing key.")
            signer = api_key_signer(
                tenancy=self.tenancy, user=self.user, fingerprint=self.fingerprint,
                private_key_file=self.private_key_file, passphrase=self.private_key_passphrase,
            )
        features = [{"featureType": "TEXT_EXTRACTION"}, {"featureType": "TABLE_EXTRACTION"}]
        if self.document_type:
            features.append({"featureType": "KEY_VALUE_EXTRACTION"})
        payload: dict = {
            "compartmentId": self.compartment_id,
            "features": features,
            "document": {
                "source": "INLINE",
                "data": base64.b64encode(Path(request.file_path).read_bytes()).decode(),
            },
        }
        if self.document_type:
            payload["documentType"] = self.document_type
        if self.language:
            payload["language"] = self.language
        body = json.dumps(payload).encode()
        url = self._url()
        headers = {"content-type": "application/json"}
        headers.update(signer("POST", url, headers, body))
        async with httpx.AsyncClient(transport=self.transport, timeout=request.deadline_s) as client:
            try:
                response = await client.post(url, content=body, headers=headers)
            except httpx.TimeoutException as exc:
                raise ProviderTransientError(f"OCI Document Understanding timed out: {exc}") from exc
            except httpx.HTTPError as exc:
                raise ProviderTransientError(f"OCI Document Understanding request failed: {exc}") from exc
        if response.status_code != 200:
            raise http_error(response.status_code, response.text)
        try:
            result = response.json()
        except ValueError as exc:
            raise ProviderError("OCI Document Understanding returned no JSON.") from exc
        return self._map(result, request.pages)

    def _map(self, result: dict, wanted_pages: tuple[int, ...] | None = None) -> RecognitionResult:
        pages: list[PageLayout] = []
        tables: list[TableResult] = []
        fields: list[FieldCandidate] = []
        mapping = FIELD_MAPS.get(self.document_type or "", {})
        for raw in result.get("pages") or []:
            number = int(raw.get("pageNumber") or len(pages) + 1)
            if wanted_pages and number not in wanted_pages:
                continue
            dimensions = raw.get("dimensions") or {}
            unit = (dimensions.get("unit") or "PIXEL").upper()
            # Inches → PDF points; anything else stays in image pixels.
            scale = 72.0 if unit == "INCH" else 1.0
            space = "pdf_points" if unit == "INCH" else "ocr_pixels"
            width = float(dimensions.get("width") or 0) * scale
            height = float(dimensions.get("height") or 0) * scale
            page = PageLayout(number, width, height, space)
            for word in raw.get("words") or []:
                bbox = _normalized_bbox(word.get("boundingPolygon"), width, height)
                if bbox and word.get("text"):
                    page.words.append(Word(word["text"], bbox, word.get("confidence")))
            for line in raw.get("lines") or []:
                bbox = _normalized_bbox(line.get("boundingPolygon"), width, height)
                if bbox and line.get("text"):
                    page.lines.append(Line(line["text"], bbox, confidence=line.get("confidence")))
            pages.append(page)

            for raw_table in raw.get("tables") or []:
                table = TableResult(
                    number,
                    int(raw_table.get("rowCount") or 0),
                    int(raw_table.get("columnCount") or 0),
                    coord_space=space,
                )
                for group in ("headerRows", "bodyRows", "footerRows"):
                    for row in raw_table.get(group) or []:
                        for cell in row.get("cells") or []:
                            table.cells.append(
                                TableCell(
                                    int(cell.get("rowIndex") or 0),
                                    int(cell.get("columnIndex") or 0),
                                    cell.get("text") or "",
                                    _normalized_bbox(cell.get("boundingPolygon"), width, height),
                                )
                            )
                tables.append(table)

            for raw_field in raw.get("documentFields") or []:
                if (raw_field.get("fieldType") or "KEY_VALUE") != "KEY_VALUE":
                    continue
                label = (raw_field.get("fieldLabel") or {}).get("name")
                value = raw_field.get("fieldValue") or {}
                printed = (value.get("text") or "").strip()
                canonical = mapping.get(label or "")
                if not canonical or not printed:
                    continue
                typed = value.get("value")
                fields.append(
                    FieldCandidate(
                        raw_label=label,
                        value=printed,
                        canonical_field=canonical,
                        normalized_value=str(typed) if typed is not None else None,
                        confidence=value.get("confidence"),
                        evidence=[
                            EvidenceSpan(
                                page=number,
                                text=printed,
                                bbox=_normalized_bbox(value.get("boundingPolygon"), width, height),
                                coord_space=space,
                            )
                        ],
                    )
                )

        warnings = [
            str(error.get("message") or error)[:300] for error in result.get("errors") or []
        ]
        usage = UsageRecord(pages=len(pages))
        if self.price_per_page_usd is not None:
            usage.estimated_cost_usd = round(len(pages) * self.price_per_page_usd, 6)
        version = result.get("keyValueExtractionModelVersion") or result.get("textExtractionModelVersion")
        info = ModelInfo(
            self.provider_id,
            model=(self.document_type or "layout").lower(),
            version=version or API_VERSION,
            region=self.region,
        )
        status = "partial" if warnings else "ok"
        return RecognitionResult(info, status, fields=fields, pages=pages, tables=tables, usage=usage, warnings=warnings)


def _normalized_bbox(poly: dict | None, width: float, height: float):
    vertices = (poly or {}).get("normalizedVertices") or []
    if not vertices or not width or not height:
        return None
    xs = [float(v.get("x") or 0) * width for v in vertices]
    ys = [float(v.get("y") or 0) * height for v in vertices]
    return (min(xs), min(ys), max(xs), max(ys))
