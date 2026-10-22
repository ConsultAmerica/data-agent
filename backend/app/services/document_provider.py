from typing import Any

from app.core.config import Settings, get_settings
from app.services.convera_client import ConveraClient, ConveraError

__all__ = [
    "ConveraError",
    "should_use_convera_documents",
    "normalize_convera_extraction",
    "extract_document",
]


def should_use_convera_documents(settings: Settings) -> bool:
    return (
        settings.convera_enabled and settings.convera_documents_enabled
    )


def normalize_convera_extraction(
    payload: dict[str, Any],
) -> dict[str, Any]:
    """
    Adapter so the rest of Dataomatix never has to know Convera's
    response shape. Convera's live response nests the extracted text
    under "extraction" (confirmed against the running service:
    {"extraction": {"text": ..., "pages": [{"page", "text"}, ...]}}),
    but older/alternate deployments have been seen returning a flat
    {"text": ..., "page_data": [...]} shape instead — fall back to
    that (or "data", which Convera also echoes) if "extraction" isn't
    present.
    """

    extraction = payload.get("extraction")

    if isinstance(extraction, dict):
        full_text = extraction.get("text", "")
        pages = extraction.get("pages", [])
        ocr_required = extraction.get("ocr_required")
    else:
        data = payload.get("data") if isinstance(
            payload.get("data"), dict
        ) else {}

        full_text = payload.get("text", data.get("text", ""))
        pages = payload.get(
            "page_data", data.get("pages", [])
        )
        ocr_required = data.get("ocr_required")

    ocr = payload.get("ocr") or {}

    return {
        "text": full_text,
        "pages": pages,
        "ocr_required": bool(
            ocr.get("required", ocr_required or False)
        ),
        "ocr_used": bool(ocr.get("used", False)),
        "raw": payload,
    }


def extract_document(
    file_path: str,
    *,
    settings: Settings | None = None,
) -> dict[str, Any]:
    """
    Replaces the direct local-extractor call for documents routed
    through Convera. Returns the normalized {text, pages, ocr_required,
    ocr_used, raw} shape regardless of Convera's actual response
    format — callers should never need to reach into "raw" directly.
    """

    active_settings = settings or get_settings()

    if not should_use_convera_documents(active_settings):
        raise NotImplementedError(
            "extract_document() only handles the Convera path. "
            "Local extraction is still handled by "
            "document_extraction.py's native PyMuPDF pipeline."
        )

    client = ConveraClient()
    payload = client.extract_document(file_path)
    return normalize_convera_extraction(payload)
