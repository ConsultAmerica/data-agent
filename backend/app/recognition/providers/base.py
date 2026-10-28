"""Shared provider plumbing: errors that tell the engine whether a retry
can help, and the request/document helpers adapters need."""

from __future__ import annotations

from pathlib import Path


class ProviderUnavailable(Exception):
    """Not configured / dependency missing. Never retried; the step is
    skipped and the next one runs."""


class ProviderTransientError(Exception):
    """Timeout, rate limit, 5xx — a retry may succeed (bounded)."""


class ProviderError(Exception):
    """The provider answered but the call failed (bad request, auth,
    unparseable output). Not retried."""


PDF_TYPES = {"application/pdf"}
IMAGE_TYPES = {"image/png", "image/jpeg", "image/tiff", "image/bmp", "image/webp"}


def guess_mime(path: str | Path) -> str:
    suffix = Path(path).suffix.lower()
    return {
        ".pdf": "application/pdf",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".tif": "image/tiff",
        ".tiff": "image/tiff",
        ".bmp": "image/bmp",
        ".webp": "image/webp",
    }.get(suffix, "application/octet-stream")


def http_error(status: int, detail: str) -> Exception:
    """Map an HTTP status to the engine's retry semantics."""

    if status == 429 or status >= 500:
        return ProviderTransientError(f"HTTP {status}: {detail[:300]}")
    return ProviderError(f"HTTP {status}: {detail[:300]}")
