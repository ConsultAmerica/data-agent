"""The configured recognition providers, by id.

Every adapter is always registered so the engine and the providers API can
say *why* one isn't used ("not configured", "blocked by policy"); whether
it runs is decided per step (configured + policy + condition)."""

from __future__ import annotations

from app.recognition.providers.azure_di import AzureDocumentIntelligenceProvider
from app.recognition.providers.google_docai import GoogleDocumentAIProvider
from app.recognition.providers.llm import LlmStructuredProvider
from app.recognition.providers.local import MrzProvider, NativeTextProvider, TesseractProvider
from app.recognition.providers.oci_document import OciDocumentUnderstandingProvider
from app.recognition.providers.rapid_ocr import RapidOcrProvider


def build_providers(settings, *, ai_provider=None) -> dict[str, object]:
    from app.services.ai_provider_factory import create_ai_provider

    return {
        "native_text": NativeTextProvider(),
        "tesseract": TesseractProvider(
            language=settings.ocr_language,
            dpi=min(int(settings.ocr_dpi or 220), 220),
            timeout_seconds=int(settings.ocr_page_timeout_seconds or 45),
        ),
        "mrz": MrzProvider(),
        "rapidocr": RapidOcrProvider(),
        "azure_di": AzureDocumentIntelligenceProvider(
            endpoint=settings.azure_di_endpoint,
            key=settings.azure_di_key,
            model=settings.azure_di_model,
            api_version=settings.azure_di_api_version,
            price_per_page_usd=settings.azure_di_price_per_page_usd,
        ),
        "google_docai": GoogleDocumentAIProvider(
            project=settings.google_docai_project,
            location=settings.google_docai_location,
            processor_id=settings.google_docai_processor_id,
            processor_version=settings.google_docai_processor_version,
            credentials_file=settings.google_docai_credentials_file,
            processor_kind=settings.google_docai_processor_kind,
            price_per_page_usd=settings.google_docai_price_per_page_usd,
        ),
        "oci_document": OciDocumentUnderstandingProvider(
            region=settings.oci_document_region,
            compartment_id=settings.oci_document_compartment_id,
            tenancy=settings.oci_tenancy_ocid,
            user=settings.oci_user_ocid,
            fingerprint=settings.oci_key_fingerprint,
            private_key_file=settings.oci_private_key_file,
            private_key_passphrase=settings.oci_private_key_passphrase,
            document_type=settings.oci_document_type,
            language=settings.oci_document_language,
            price_per_page_usd=settings.oci_document_price_per_page_usd,
        ),
        "llm": LlmStructuredProvider(ai_provider or create_ai_provider(settings)),
    }
