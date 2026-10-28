"""Request-scoped observability helpers (no document text / prompts)."""

from __future__ import annotations

import logging
import time
import uuid
from contextvars import ContextVar
from typing import Any

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)
document_id_var: ContextVar[str | None] = ContextVar("document_id", default=None)
job_id_var: ContextVar[int | None] = ContextVar("job_id", default=None)

logger = logging.getLogger("dataomatix.obs")

# Fields that must never appear in structured logs.
_SENSITIVE_KEYS = {
    "page_context",
    "page_text",
    "prompt",
    "instruction",
    "targets_json",
    "source_text",
    "final_text",
    "content",
    "document_bytes",
}


def new_request_id() -> str:
    return uuid.uuid4().hex[:16]


def get_request_id() -> str | None:
    return request_id_var.get()


def bind_job_context(*, document_id: str | None = None, job_id: int | None = None) -> None:
    if document_id is not None:
        document_id_var.set(document_id)
    if job_id is not None:
        job_id_var.set(job_id)


def _sanitize(payload: dict[str, Any]) -> dict[str, Any]:
    clean: dict[str, Any] = {}
    for key, value in payload.items():
        if key.lower() in _SENSITIVE_KEYS:
            continue
        if isinstance(value, (str, int, float, bool)) or value is None:
            clean[key] = value
        elif isinstance(value, (list, tuple)):
            # Allow short numeric/string lists (e.g. page numbers).
            if len(value) <= 20 and all(
                isinstance(item, (str, int, float, bool)) or item is None
                for item in value
            ):
                clean[key] = list(value)
        elif isinstance(value, dict):
            nested = _sanitize(value)
            if nested:
                clean[key] = nested
    return clean


def log_event(
    event: str,
    *,
    stage: str | None = None,
    status: str = "ok",
    duration_ms: int | None = None,
    error_category: str | None = None,
    **fields: Any,
) -> None:
    """Emit one structured log line for a pipeline stage."""

    payload = {
        "event": event,
        "request_id": request_id_var.get(),
        "document_id": document_id_var.get(),
        "job_id": job_id_var.get(),
        "stage": stage,
        "status": status,
        "duration_ms": duration_ms,
        "error_category": error_category,
        **fields,
    }
    clean = _sanitize({key: value for key, value in payload.items() if value is not None})
    logger.info("%s", clean)


class RequestIdMiddleware(BaseHTTPMiddleware):
    """Attach X-Request-ID and bind it for structured logs."""

    async def dispatch(self, request: Request, call_next) -> Response:
        incoming = request.headers.get("x-request-id") or request.headers.get(
            "x-correlation-id"
        )
        request_id = (incoming or new_request_id()).strip()[:64] or new_request_id()
        token = request_id_var.set(request_id)
        started = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception:
            duration_ms = int((time.perf_counter() - started) * 1000)
            log_event(
                "http_request",
                stage="http",
                status="error",
                duration_ms=duration_ms,
                error_category="unhandled",
                method=request.method,
                path=request.url.path,
            )
            raise
        finally:
            request_id_var.reset(token)

        duration_ms = int((time.perf_counter() - started) * 1000)
        response.headers["X-Request-ID"] = request_id
        # Skip noisy health probes in info logs.
        if request.url.path not in {"/health", "/ready", "/"}:
            log_event(
                "http_request",
                stage="http",
                status="ok" if response.status_code < 500 else "error",
                duration_ms=duration_ms,
                method=request.method,
                path=request.url.path,
                http_status=response.status_code,
            )
        return response
