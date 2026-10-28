"""Optional AI enrichment around deterministic extraction.

Dataomatix is deterministic-first: native text / OCR → reading order →
source structure → staging workbook works with zero AI quota. AI is an
optional rescue, and this module makes sure it stays optional:

* ``AIEnrichmentSession`` wraps the configured provider for ONE processing
  run. Every call gets a hard timeout and runs off the event loop; failures
  are classified (quota, rate limit, timeout, network, auth, provider 5xx);
  retries are tiny and bounded (one retry, only for a short Retry-After or a
  transient 5xx — never for exhausted quota or a bad key); after the first
  "unavailable" failure a circuit breaker stops every further provider call
  in the run. It only ever raises ``AIProviderError``, so AI can never fail
  a job.
* ``assess_deterministic_sufficiency`` decides whether AI should be tried at
  all — only after deterministic extraction has run, and never merely
  because a document produced few fields.
* ``summary()`` is the run's ``ai_enrichment`` record: status, the short
  user-facing notice, and the technical detail kept for Processing Details.

Values an AI returns are still source-validated by their callers
(ai_value_mapping.validate_source_value) before they can be staged.
"""

from __future__ import annotations

import asyncio
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.orm import Session

from app.core.observability import log_event
from app.models.document import Document
from app.services.ai_provider import AIProvider, AIProviderError, DisabledAIProvider

# Statuses reported for a processing run.
COMPLETED = "completed"  # AI ran and returned usable output
NOT_NEEDED = "not_needed"  # deterministic result sufficient; AI not called
SKIPPED = "skipped"  # AI disabled / not configured / not requested
UNAVAILABLE = "unavailable"  # quota, rate limit, timeout, network, auth, 5xx
FAILED = "failed"  # unexpected provider behaviour (e.g. unparseable output)

_MAX_RETRY_AFTER_SECONDS = 10.0


@dataclass(frozen=True)
class AIFailure:
    kind: str  # quota | rate_limited | timeout | network | auth | provider_error | unknown
    detail: str
    retry_after: float | None = None

    @property
    def terminal(self) -> bool:
        """No retry can help within this run."""
        return self.kind in {"quota", "auth", "timeout", "network"} or (
            self.kind == "rate_limited"
            and (self.retry_after is None or self.retry_after > _MAX_RETRY_AFTER_SECONDS)
        )


_RETRY_DELAY = re.compile(r"retry[_ ]?delay['\"]?\s*[:=]\s*['\"]?(\d+(?:\.\d+)?)s", re.I)
_RETRY_AFTER = re.compile(r"retry[- ]after['\"]?\s*[:=]\s*['\"]?(\d+(?:\.\d+)?)", re.I)
# Quota ids / messages that mean the allowance is gone for the day, the
# project or the model — waiting a few seconds will not bring it back.
_EXHAUSTED_QUOTA = re.compile(r"per[_ ]?day|daily|perproject|per[_ ]?project|per[_ ]?model|free[_ ]tier|billing|limit:\s*0\b", re.I)


def classify_ai_error(exc: BaseException) -> AIFailure:
    """Map any provider exception to a failure kind (provider-agnostic: the
    Gemini SDK, OpenAI and plain HTTP errors all surface these markers)."""

    text = f"{type(exc).__name__}: {exc}"
    cause = exc.__cause__ or exc.__context__
    if cause is not None:
        text += f" | {type(cause).__name__}: {cause}"
    if isinstance(exc, (asyncio.TimeoutError, TimeoutError)) or isinstance(cause, (asyncio.TimeoutError, TimeoutError)) or re.search(r"\btimed? ?out\b|deadline", text, re.I):
        return AIFailure("timeout", text)
    if re.search(r"\b429\b|RESOURCE_EXHAUSTED|rate.?limit|quota", text, re.I):
        delay = _RETRY_DELAY.search(text) or _RETRY_AFTER.search(text)
        retry_after = float(delay.group(1)) if delay else None
        if _EXHAUSTED_QUOTA.search(text):
            return AIFailure("quota", text, retry_after)
        return AIFailure("rate_limited", text, retry_after)
    if re.search(r"\b(401|403)\b|API[_ ]?KEY[_ ]?INVALID|API key (not valid|is missing|missing)|PERMISSION_DENIED|UNAUTHENTICATED", text, re.I):
        return AIFailure("auth", text)
    if re.search(r"\b(500|502|503|504)\b|UNAVAILABLE|INTERNAL|overloaded|high demand", text, re.I):
        return AIFailure("provider_error", text)
    if re.search(r"connect|getaddrinfo|name resolution|network|socket|ECONN|SSL", text, re.I):
        return AIFailure("network", text)
    return AIFailure("unknown", text)


_NOTICE_REASON = {
    "quota": "AI usage limit reached.",
    "rate_limited": "AI rate limit reached.",
    "timeout": "The AI service did not respond in time.",
    "network": "The AI service could not be reached.",
    "auth": "The AI service key is missing or invalid.",
    "provider_error": "The AI service is temporarily unavailable.",
    "unknown": "The AI service returned an error.",
}


@dataclass
class AIEnrichmentSession(AIProvider):
    """One processing run's view of the AI provider (see module docstring)."""

    provider: AIProvider
    provider_label: str = "ai"
    model: str | None = None
    timeout_seconds: float = 45.0
    status: str = SKIPPED
    reason: str | None = None
    failure: AIFailure | None = None
    calls: int = 0
    succeeded: int = 0
    # Provenance: every call is recorded as a RecognitionRun row in
    # `database` (added, committed with the caller's work).
    database: Session | None = field(default=None, repr=False)
    document_id: str | None = None
    job_id: int | None = None
    data_class: str | None = None
    policy_reason: str | None = None
    run_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    _breaker_open: bool = field(default=False, repr=False)

    def __post_init__(self) -> None:
        self.provider_id = f"session({getattr(self.provider, 'provider_id', 'ai')})"
        if isinstance(self.provider, DisabledAIProvider) and self.reason is None:
            self.status, self.reason = SKIPPED, "AI enrichment is disabled or not configured."

    # --- state --------------------------------------------------------------

    @property
    def available(self) -> bool:
        return not isinstance(self.provider, DisabledAIProvider) and not self._breaker_open

    def mark_not_needed(self, reason: str) -> None:
        if self.status in (SKIPPED,) and not isinstance(self.provider, DisabledAIProvider):
            self.status, self.reason = NOT_NEEDED, reason

    def mark_not_requested(self) -> None:
        if self.status == SKIPPED and self.reason is None:
            self.reason = "AI enrichment was not requested for this run."

    def summary(self) -> dict:
        notice = None
        if self.status in (UNAVAILABLE, FAILED):
            notice = {
                "title": "AI enhancement skipped. Deterministic extraction completed successfully.",
                "detail": _NOTICE_REASON.get(self.failure.kind if self.failure else "unknown"),
            }
        return {
            "deterministic_status": "completed",
            "ai_enrichment_status": self.status,
            "reason": self.reason,
            "notice": notice,
            "provider": self.provider_label,
            "model": self.model,
            "error_kind": self.failure.kind if self.failure else None,
            "error_detail": self.failure.detail[:2000] if self.failure else None,
            "calls_attempted": self.calls,
            "calls_succeeded": self.succeeded,
            "run_id": self.run_id,
            "data_class": self.data_class,
            "policy": self.policy_reason,
        }

    def _record(
        self,
        *,
        method: str | None,
        status: str,
        started: float | None = None,
        error_kind: str | None = None,
    ) -> None:
        if self.database is None:
            return
        from app.models.recognition_run import RecognitionRun
        from app.recognition.policy import provider_locality
        from app.services.processing_versions import EXTRACTION_PROCESSOR_VERSION

        answered = getattr(self.provider, "last_provider", None) if status == "ok" else None
        source = answered or self.provider
        provider_id = getattr(source, "provider_id", "ai")
        self.database.add(
            RecognitionRun(
                run_id=self.run_id,
                document_id=self.document_id,
                extraction_job_id=self.job_id,
                provider_id=provider_id[:40],
                model=getattr(source, "model", None) if answered else self.model,
                locality=provider_locality(provider_id, _settings()),
                method=method,
                status=status,
                error_kind=error_kind,
                data_class=self.data_class,
                policy_reason=self.policy_reason if status == "blocked_by_policy" else None,
                pipeline_version=EXTRACTION_PROCESSOR_VERSION,
                duration_ms=int((time.perf_counter() - started) * 1000) if started else None,
            )
        )

    # --- the guarded call -------------------------------------------------------

    async def _call(self, method: str, **kwargs: Any) -> dict[str, Any]:
        if isinstance(self.provider, DisabledAIProvider):
            # Not configured: the disabled provider's benign empty answer,
            # exactly as callers received before sessions existed.
            return await getattr(self.provider, method)(**kwargs)
        if self._breaker_open:
            raise AIProviderError("AI enrichment unavailable for this run.")
        attempts = 0
        while True:
            attempts += 1
            self.calls += 1
            started = time.perf_counter()
            try:
                result = await asyncio.wait_for(
                    getattr(self.provider, method)(**kwargs), timeout=self.timeout_seconds
                )
            except Exception as exc:  # noqa: BLE001 — classified, never re-raised raw
                failure = classify_ai_error(exc)
                self._record(method=method, status="error", started=started, error_kind=failure.kind)
                log_event(
                    "ai_enrichment_call",
                    stage="ai",
                    status="error",
                    method=method,
                    error_kind=failure.kind,
                    duration_ms=int((time.perf_counter() - started) * 1000),
                )
                retryable = attempts == 1 and (
                    failure.kind == "provider_error"
                    or (failure.kind == "rate_limited" and not failure.terminal)
                )
                if retryable:
                    await asyncio.sleep(min(failure.retry_after or 1.0, _MAX_RETRY_AFTER_SECONDS))
                    continue
                self.failure = failure
                if failure.kind == "unknown":
                    # e.g. one malformed response — later calls may still work.
                    if self.status != UNAVAILABLE:
                        self.status = FAILED
                else:
                    # One unavailable answer is enough: no provider call for
                    # every remaining field/page/document in this run.
                    self.status = UNAVAILABLE
                    self._breaker_open = True
                self.reason = _NOTICE_REASON.get(failure.kind)
                raise AIProviderError(self.reason or "AI enrichment unavailable.") from None
            self.succeeded += 1
            self._record(method=method, status="ok", started=started)
            if self.status not in (UNAVAILABLE, FAILED):
                self.status, self.reason = COMPLETED, None
            return result

    # --- AIProvider surface -------------------------------------------------------

    async def extract(self, *, instruction: str, page_context: str) -> dict[str, Any]:
        return await self._call("extract", instruction=instruction, page_context=page_context)

    async def classify(self, *, page_context: str) -> dict[str, Any]:
        return await self._call("classify", page_context=page_context)

    async def extract_fields(self, *, page_context: str, field_specs) -> dict[str, Any]:
        return await self._call("extract_fields", page_context=page_context, field_specs=field_specs)

    async def extract_clauses(self, *, page_context: str) -> dict[str, Any]:
        return await self._call("extract_clauses", page_context=page_context)

    async def extract_signatures(self, *, page_context: str) -> dict[str, Any]:
        return await self._call("extract_signatures", page_context=page_context)

    async def extract_structured_tables(self, *, page_context: str, table_specs) -> dict[str, Any]:
        return await self._call("extract_structured_tables", page_context=page_context, table_specs=table_specs)

    async def enrich_schema(self, *, targets_json: str, page_context: str) -> dict[str, Any]:
        return await self._call("enrich_schema", targets_json=targets_json, page_context=page_context)


def _settings():
    from app.core.config import get_settings

    return get_settings()


def _model_label(provider: AIProvider) -> str | None:
    """The configured model(s): a fallback chain lists its members'."""

    members = getattr(provider, "providers", None)
    if members:
        models = [getattr(member, "model", None) for member in members]
        return "+".join(m for m in models if m) or None
    return getattr(provider, "model", None)


def start_session(
    provider: AIProvider,
    settings,
    *,
    database: Session | None = None,
    document: Document | None = None,
    job_id: int | None = None,
) -> AIEnrichmentSession:
    """One run's AI session. With `document`, the provider policy decides
    whether this document may be sent to the configured provider(s) at all
    (app/recognition/policy.py); a refusal makes the session a disabled
    one with the policy's reason, recorded as a blocked run."""

    from app.recognition.policy import (
        classify_for_policy,
        decide_external_processing,
        member_provider_ids,
    )
    from app.services.ai_provider_factory import describe_ai_provider

    session_kwargs = dict(
        provider_label=describe_ai_provider(provider),
        model=_model_label(provider),
        timeout_seconds=float(getattr(settings, "ai_provider_attempt_timeout_seconds", 45.0) or 45.0),
        database=database,
        document_id=getattr(document, "id", None),
        job_id=job_id,
    )
    if isinstance(provider, DisabledAIProvider):
        return AIEnrichmentSession(provider=provider, **session_kwargs)

    decision = decide_external_processing(
        database,
        data_class=classify_for_policy(database, document) if document is not None else None,
        provider_ids=member_provider_ids(provider),
        settings=settings,
    )
    if not decision.allowed:
        session = AIEnrichmentSession(
            provider=DisabledAIProvider(),
            status=SKIPPED,
            reason=decision.reason,
            data_class=decision.data_class,
            policy_reason=decision.reason,
            **session_kwargs,
        )
        session._record(method=None, status="blocked_by_policy")
        log_event("ai_policy_blocked", stage="ai", status="skipped", data_class=decision.data_class)
        return session
    return AIEnrichmentSession(
        provider=provider,
        data_class=decision.data_class,
        policy_reason=decision.reason,
        **session_kwargs,
    )


# --- when is AI worth trying? ----------------------------------------------------------------

_MIN_RESOLVED_FRACTION = 0.5
_MIN_READABLE_WORDS = 30


def assess_deterministic_sufficiency(
    database: Session,
    document: Document,
    *,
    requested: int,
    resolved: int,
) -> tuple[bool, str]:
    """(sufficient, reason). Deterministic extraction is sufficient when it
    resolved most requested targets, or when the source structure (reading
    order, spatial label/value pairs, tables) produced usable structure from
    readable text. AI is a rescue for documents where neither holds — never
    a reflex for "few fields"."""

    if requested and resolved / requested >= _MIN_RESOLVED_FRACTION:
        return True, f"Deterministic extraction resolved {resolved} of {requested} requested field(s)."
    try:
        from app.source_structure.service import get_or_build_source_structure

        structure = get_or_build_source_structure(database, document)
    except Exception:  # noqa: BLE001 — assessment must never fail a run
        return False, "Source structure unavailable for assessment."
    fields = sum(1 for f in structure.field_candidates if f.acceptance == "accepted")
    tables = sum(1 for t in structure.table_candidates if t.acceptance == "accepted")
    words = sum(len(r.text.split()) for r in structure.regions if r.region_type not in ("TABLE_ROW", "TABLE_CELL"))
    if words >= _MIN_READABLE_WORDS and (fields or tables):
        return True, f"Source structure produced {fields} label/value field(s) and {tables} table(s) from readable text."
    return False, (
        f"Deterministic extraction resolved {resolved} of {requested} field(s) and the source structure "
        f"produced {fields} field(s) and {tables} table(s)."
    )
