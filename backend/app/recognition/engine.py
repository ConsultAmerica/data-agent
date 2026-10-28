"""The recognition engine: runs a strategy's provider steps for one
document (docs/di-01-target-architecture.md §4).

Per step, in order: is the provider known and configured; does its
condition hold; may this document's data class go to it (policy, for
external providers); is the per-document budget left. Then it runs with
a timeout, retrying only transient failures, up to max_attempts. Every
attempt — and every refusal — is a RecognitionRun row.

Afterwards every field candidate is grounded: it needs evidence (page +
text), and a candidate from an external provider must also be readable
in the platform's own text for that page (native or Tesseract) when that
text exists. Grounded candidates are merged per canonical field: agreeing
providers give one value; disagreeing providers give a conflict for a
person to decide. Nothing ungrounded is ever accepted.
"""

from __future__ import annotations

import asyncio
import re
import time
import uuid
from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from app.recognition.policy import (
    classify_for_policy,
    decide_external_processing,
    member_provider_ids,
)
from app.recognition.providers.base import (
    ProviderError,
    ProviderTransientError,
    ProviderUnavailable,
)
from app.recognition.strategies import StrategyStep
from app.recognition.types import FieldCandidate, RecognitionRequest, RecognitionResult
from app.services.processing_versions import EXTRACTION_PROCESSOR_VERSION
from app.services.source_validator import validate_source_value

LOCAL_TEXT_PROVIDERS = {"native_text", "tesseract"}


@dataclass
class StepOutcome:
    provider: str
    status: str  # ok | skipped | blocked_by_policy | failed
    reason: str | None = None
    attempts: int = 0
    duration_ms: int = 0
    pages: int = 0
    estimated_cost_usd: float | None = None
    model: str | None = None


@dataclass
class Candidate:
    provider: str
    candidate: FieldCandidate
    locally_confirmed: bool


@dataclass
class MergedField:
    canonical_field: str
    value: str
    status: str  # agreed | single | conflict
    candidates: list[Candidate]


@dataclass
class Rejected:
    provider: str
    candidate: FieldCandidate
    reason: str


@dataclass
class EngineOutcome:
    run_id: str
    data_class: str
    steps: list[StepOutcome] = field(default_factory=list)
    results: dict[str, RecognitionResult] = field(default_factory=dict)
    fields: list[MergedField] = field(default_factory=list)
    rejected: list[Rejected] = field(default_factory=list)
    failed_required: bool = False

    @property
    def estimated_cost_usd(self) -> float:
        return round(sum(s.estimated_cost_usd or 0.0 for s in self.steps), 6)

    def local_text(self) -> dict[int, str]:
        pages: dict[int, list[str]] = {}
        for provider, result in self.results.items():
            if provider in LOCAL_TEXT_PROVIDERS:
                for page in result.pages:
                    if page.text.strip():
                        pages.setdefault(page.page, []).append(page.text)
        return {page: "\n".join(texts) for page, texts in pages.items()}


def _comparable(value: str) -> str:
    return re.sub(r"[^0-9a-z.]", "", (value or "").lower()).rstrip(".")


def _numeric(value: str) -> float | None:
    digits = re.sub(r"[^\d.\-]", "", value or "")
    try:
        return float(digits) if re.search(r"\d", digits) else None
    except ValueError:
        return None


def _agree(a: str, b: str) -> bool:
    if _comparable(a) == _comparable(b):
        return True
    na, nb = _numeric(a), _numeric(b)
    return na is not None and nb is not None and abs(na - nb) < 0.005 and not re.search(r"[A-Za-z]", a + b)


class RecognitionEngine:
    def __init__(self, providers: dict[str, object], settings, *, retry_backoff_seconds: float = 0.5):
        self.providers = providers
        self.settings = settings
        self.retry_backoff_seconds = retry_backoff_seconds

    async def run(
        self,
        *,
        database: Session,
        document,
        file_path: str,
        mime_type: str,
        strategy: tuple[StrategyStep, ...],
        wanted_fields: tuple[str, ...] = (),
        profile_key: str | None = None,
        job_id: int | None = None,
        pages: tuple[int, ...] | None = None,
    ) -> EngineOutcome:
        outcome = EngineOutcome(run_id=str(uuid.uuid4()), data_class=classify_for_policy(database, document))
        budget = getattr(self.settings, "recognition_budget_usd_per_document", None)

        for step in strategy:
            provider = self.providers.get(step.provider)
            if provider is None:
                outcome.steps.append(StepOutcome(step.provider, "skipped", "Unknown provider."))
                continue
            ok, why = provider.configured(self.settings)
            if not ok:
                outcome.steps.append(StepOutcome(step.provider, "skipped", why))
                continue
            reason = self._condition_unmet(step, outcome, wanted_fields)
            if reason:
                outcome.steps.append(StepOutcome(step.provider, "skipped", reason))
                continue
            if provider.locality == "external":
                decision = decide_external_processing(
                    database,
                    data_class=outcome.data_class,
                    provider_ids=self._policy_ids(provider),
                    settings=self.settings,
                )
                if not decision.allowed:
                    outcome.steps.append(StepOutcome(step.provider, "blocked_by_policy", decision.reason))
                    self._record(database, outcome, document, job_id, provider, step, "blocked_by_policy",
                                 policy_reason=decision.reason)
                    continue
                if budget is not None and outcome.estimated_cost_usd >= budget:
                    outcome.steps.append(
                        StepOutcome(step.provider, "skipped", f"Per-document budget of ${budget} reached.")
                    )
                    continue

            request = RecognitionRequest(
                document_id=document.id,
                run_id=outcome.run_id,
                profile_key=profile_key,
                data_class=outcome.data_class,
                pages=pages,
                deadline_s=step.timeout_s,
                file_path=file_path,
                mime_type=mime_type,
                prior=tuple(outcome.results.values()),
                wanted_fields=wanted_fields,
            )
            step_outcome = await self._run_step(database, outcome, document, job_id, provider, step, request)
            outcome.steps.append(step_outcome)
            if step_outcome.status == "failed" and step.required:
                outcome.failed_required = True

        self._ground_and_merge(outcome)
        return outcome

    @staticmethod
    def _policy_ids(provider) -> list[str]:
        members = getattr(provider, "providers", None)
        if members:
            return [pid for member in members for pid in member_provider_ids(member)]
        return [provider.provider_id]

    @staticmethod
    def _condition_unmet(step: StrategyStep, outcome: EngineOutcome, wanted: tuple[str, ...]) -> str | None:
        if step.when == "no_text" and outcome.local_text():
            return "An earlier step already produced text."
        if step.when == "fields_missing":
            if not wanted:
                return "The profile requests no fields."
            found = {merged.canonical_field for merged in RecognitionEngine._merge(outcome)[0]}
            if set(wanted) <= found:
                return "Every requested field already has a grounded value."
        return None

    async def _run_step(self, database, outcome, document, job_id, provider, step, request) -> StepOutcome:
        started = time.perf_counter()
        result_outcome = StepOutcome(step.provider, "failed")
        for attempt in range(1, max(1, step.max_attempts) + 1):
            result_outcome.attempts = attempt
            attempt_started = time.perf_counter()
            try:
                result = await asyncio.wait_for(provider.recognize(request), timeout=step.timeout_s)
            except ProviderUnavailable as exc:
                result_outcome.status, result_outcome.reason = "skipped", str(exc)
                self._record(database, outcome, document, job_id, provider, step, "skipped",
                             error_kind="unavailable", started=attempt_started)
                break
            except (asyncio.TimeoutError, TimeoutError, ProviderTransientError) as exc:
                kind = "timeout" if not isinstance(exc, ProviderTransientError) else "transient"
                result_outcome.reason = str(exc) or f"Timed out after {step.timeout_s:.0f}s."
                self._record(database, outcome, document, job_id, provider, step, "error",
                             error_kind=kind, started=attempt_started)
                if attempt < step.max_attempts:
                    await asyncio.sleep(self.retry_backoff_seconds * attempt)
                    continue
                break
            except ProviderError as exc:
                result_outcome.reason = str(exc)
                self._record(database, outcome, document, job_id, provider, step, "error",
                             error_kind="provider_error", started=attempt_started)
                break
            except Exception as exc:  # noqa: BLE001 - one engine must never fail the run
                result_outcome.reason = f"{type(exc).__name__}: {exc}"[:500]
                self._record(database, outcome, document, job_id, provider, step, "error",
                             error_kind="unexpected", started=attempt_started)
                break
            else:
                outcome.results[step.provider] = result
                result_outcome.status = "ok" if result.status != "skipped" else "skipped"
                result_outcome.reason = "; ".join(result.warnings) or None
                result_outcome.pages = result.usage.pages
                result_outcome.estimated_cost_usd = result.usage.estimated_cost_usd
                result_outcome.model = result.model.model
                self._record(database, outcome, document, job_id, provider, step, "ok",
                             started=attempt_started, result=result)
                break
        result_outcome.duration_ms = int((time.perf_counter() - started) * 1000)
        return result_outcome

    def _record(self, database, outcome, document, job_id, provider, step, status, *, policy_reason=None,
                error_kind=None, started=None, result: RecognitionResult | None = None) -> None:
        from app.models.recognition_run import RecognitionRun

        info = result.model if result is not None else provider.model_info()
        usage = result.usage if result is not None else None
        database.add(
            RecognitionRun(
                run_id=outcome.run_id,
                document_id=document.id,
                extraction_job_id=job_id,
                provider_id=provider.provider_id[:40],
                model=(info.model or None) and str(info.model)[:80],
                model_version=(info.version or None) and str(info.version)[:40],
                locality=provider.locality,
                method=f"strategy:{step.provider}",
                status=status,
                error_kind=error_kind,
                data_class=outcome.data_class,
                policy_reason=policy_reason,
                pipeline_version=EXTRACTION_PROCESSOR_VERSION,
                duration_ms=int((time.perf_counter() - started) * 1000) if started else None,
                pages=usage.pages if usage else None,
                input_tokens=usage.input_tokens if usage else None,
                output_tokens=usage.output_tokens if usage else None,
                estimated_cost_usd=usage.estimated_cost_usd if usage else None,
            )
        )

    @staticmethod
    def _merge(outcome: EngineOutcome) -> tuple[list[MergedField], list[Rejected]]:
        local = outcome.local_text()
        grouped: dict[str, list[Candidate]] = {}
        rejected: list[Rejected] = []
        for provider_id, result in outcome.results.items():
            for candidate in result.fields:
                if not candidate.canonical_field:
                    continue
                if not candidate.grounded:
                    rejected.append(Rejected(provider_id, candidate, "No evidence (page and source text)."))
                    continue
                span = next(s for s in candidate.evidence if s.page >= 1 and s.text.strip())
                page_text = local.get(span.page)
                confirmed = False
                if page_text is not None:
                    if not validate_source_value(
                        strict=True, value=candidate.value, source_text=span.text, page_text=page_text
                    ):
                        rejected.append(
                            Rejected(provider_id, candidate, f"Not found in the document's own text on page {span.page}.")
                        )
                        continue
                    confirmed = True
                grouped.setdefault(candidate.canonical_field, []).append(Candidate(provider_id, candidate, confirmed))

        merged: list[MergedField] = []
        for canonical, candidates in grouped.items():
            first = candidates[0].candidate.value
            if all(_agree(first, c.candidate.value) for c in candidates[1:]):
                best = max(candidates, key=lambda c: (c.locally_confirmed, c.candidate.confidence or 0))
                status = "agreed" if len({c.provider for c in candidates}) > 1 else "single"
                merged.append(MergedField(canonical, best.candidate.value, status, candidates))
            else:
                merged.append(MergedField(canonical, first, "conflict", candidates))
        return merged, rejected

    def _ground_and_merge(self, outcome: EngineOutcome) -> None:
        outcome.fields, outcome.rejected = self._merge(outcome)
