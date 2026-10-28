import asyncio
import logging
import time
from typing import Any

from app.core.observability import log_event
from app.services.ai_provider import (
    AIProvider,
    AIProviderError,
)
from app.services.contract_field_schema import FieldSpec
from app.services.contract_structured_table_schema import StructuredTableSpec

logger = logging.getLogger(__name__)


class FallbackAIProvider(AIProvider):
    """
    Chains providers once each (e.g. Gemini → OpenAI → Ollama).

    No sleeps, no retries of the same provider, and a hard per-attempt
    timeout so auto mode cannot cascade into multi-minute hangs.
    """

    provider_id = "fallback"

    def __init__(
        self,
        providers: list[AIProvider],
        *,
        attempt_timeout_seconds: float = 45.0,
        max_providers: int | None = None,
    ) -> None:
        usable = [provider for provider in providers if provider is not None]
        if not usable:
            raise ValueError("FallbackAIProvider requires at least one provider.")
        if max_providers is not None and max_providers > 0:
            usable = usable[:max_providers]
        self.providers = usable
        self.attempt_timeout_seconds = max(1.0, float(attempt_timeout_seconds))
        parts = [
            getattr(item, "provider_id", item.__class__.__name__)
            for item in self.providers
        ]
        self.provider_id = "fallback(" + "+".join(parts) + ")"
        # The member that answered the most recent call (recorded per call
        # by AIEnrichmentSession so a run names the model actually used).
        self.last_provider: AIProvider | None = None

    async def _execute_with_fallback(
        self,
        method_name: str,
        *args: Any,
        **kwargs: Any,
    ) -> dict[str, Any]:
        errors: list[str] = []

        for idx, provider in enumerate(self.providers):
            provider_name = getattr(provider, "provider_id", provider.__class__.__name__)
            started = time.perf_counter()
            try:
                method = getattr(provider, method_name)
                result = await asyncio.wait_for(
                    method(*args, **kwargs),
                    timeout=self.attempt_timeout_seconds,
                )
                duration_ms = int((time.perf_counter() - started) * 1000)
                log_event(
                    "ai_provider_attempt",
                    stage="ai",
                    status="ok",
                    duration_ms=duration_ms,
                    provider=provider_name,
                    provider_attempt=idx + 1,
                    method=method_name,
                )
                self.last_provider = provider
                if idx > 0:
                    logger.info(
                        "Fallback provider %s succeeded for %s after prior failures.",
                        provider_name,
                        method_name,
                    )
                return result
            except asyncio.TimeoutError:
                duration_ms = int((time.perf_counter() - started) * 1000)
                err_msg = (
                    f"{provider_name}.{method_name} timed out after "
                    f"{self.attempt_timeout_seconds:.0f}s"
                )
                log_event(
                    "ai_provider_attempt",
                    stage="ai",
                    status="error",
                    duration_ms=duration_ms,
                    error_category="timeout",
                    provider=provider_name,
                    provider_attempt=idx + 1,
                    method=method_name,
                )
                logger.warning(err_msg)
                errors.append(err_msg)
            except (AIProviderError, Exception) as exc:
                duration_ms = int((time.perf_counter() - started) * 1000)
                err_msg = f"{provider_name}.{method_name} failed: {exc}"
                log_event(
                    "ai_provider_attempt",
                    stage="ai",
                    status="error",
                    duration_ms=duration_ms,
                    error_category="provider_error",
                    provider=provider_name,
                    provider_attempt=idx + 1,
                    method=method_name,
                )
                logger.warning(err_msg)
                errors.append(err_msg)

        raise AIProviderError(
            f"All AI fallback providers failed for {method_name}: "
            f"{'; '.join(errors)}"
        )

    async def extract(
        self,
        *,
        instruction: str,
        page_context: str,
    ) -> dict[str, Any]:
        return await self._execute_with_fallback(
            "extract",
            instruction=instruction,
            page_context=page_context,
        )

    async def classify(
        self,
        *,
        page_context: str,
    ) -> dict[str, Any]:
        return await self._execute_with_fallback(
            "classify",
            page_context=page_context,
        )

    async def extract_fields(
        self,
        *,
        page_context: str,
        field_specs: list[FieldSpec],
    ) -> dict[str, Any]:
        return await self._execute_with_fallback(
            "extract_fields",
            page_context=page_context,
            field_specs=field_specs,
        )

    async def extract_clauses(
        self,
        *,
        page_context: str,
    ) -> dict[str, Any]:
        return await self._execute_with_fallback(
            "extract_clauses",
            page_context=page_context,
        )

    async def extract_signatures(
        self,
        *,
        page_context: str,
    ) -> dict[str, Any]:
        return await self._execute_with_fallback(
            "extract_signatures",
            page_context=page_context,
        )

    async def extract_structured_tables(
        self,
        *,
        page_context: str,
        table_specs: list[StructuredTableSpec],
    ) -> dict[str, Any]:
        return await self._execute_with_fallback(
            "extract_structured_tables",
            page_context=page_context,
            table_specs=table_specs,
        )

    async def enrich_schema(
        self,
        *,
        targets_json: str,
        page_context: str,
    ) -> dict[str, Any]:
        return await self._execute_with_fallback(
            "enrich_schema",
            targets_json=targets_json,
            page_context=page_context,
        )
