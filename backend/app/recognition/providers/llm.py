"""Structured extraction with an LLM (the configured AIProvider).

The model only sees text an earlier step already read (native or OCR) and
is asked to quote it; the engine then re-grounds every value against that
same text, so a value the document doesn't contain is never accepted.
"""

from __future__ import annotations

from app.recognition.providers.base import ProviderError, ProviderUnavailable
from app.recognition.types import (
    EvidenceSpan,
    FieldCandidate,
    ModelInfo,
    RecognitionRequest,
    RecognitionResult,
    UsageRecord,
)
from app.services.ai_provider import AIProvider, AIProviderError, DisabledAIProvider

_INSTRUCTION = (
    "Extract these fields. For each value found, use the field id below as the "
    "label, give the page number, and quote source_text exactly as printed in "
    "the document. Omit any field the document does not state; never infer, "
    "compute or reformat a value.\nFields: {fields}"
)


class LlmStructuredProvider:
    capabilities = frozenset({"fields:any"})

    def __init__(self, provider: AIProvider, *, max_context_chars: int = 60000):
        self.provider = provider
        self.max_context_chars = max_context_chars
        self.provider_id = f"llm:{getattr(provider, 'provider_id', 'ai')}"
        # Policy needs the concrete members (a fallback chain lists them).
        self.providers = getattr(provider, "providers", None) or [provider]
        self.locality = "external"

    def configured(self, settings) -> tuple[bool, str]:
        if isinstance(self.provider, DisabledAIProvider):
            return False, "No AI provider is configured."
        return True, self.provider_id

    def model_info(self) -> ModelInfo:
        models = [getattr(p, "model", None) for p in self.providers]
        return ModelInfo(self.provider_id, model="+".join(m for m in models if m) or None)

    async def recognize(self, request: RecognitionRequest) -> RecognitionResult:
        if not request.wanted_fields:
            return RecognitionResult(self.model_info(), "skipped", warnings=["No fields requested."])
        pages = [page for prior in request.prior for page in prior.pages if page.text.strip()]
        if not pages:
            raise ProviderUnavailable("No text layer to extract from; run a text or OCR step first.")
        context, used = [], 0
        for page in sorted({p.page: p for p in pages}.values(), key=lambda p: p.page):
            section = f"\n===== PDF PAGE {page.page} =====\n\n{page.text}\n"
            if used + len(section) > self.max_context_chars:
                break
            context.append(section)
            used += len(section)
        try:
            answer = await self.provider.extract(
                instruction=_INSTRUCTION.format(fields=", ".join(request.wanted_fields)),
                page_context="".join(context),
            )
        except AIProviderError as exc:
            raise ProviderError(str(exc)) from exc
        wanted = set(request.wanted_fields)
        fields = []
        for value in (answer or {}).get("values") or []:
            label = str(value.get("label") or "").strip()
            printed = str(value.get("value") or "").strip()
            if label not in wanted or not printed:
                continue
            quote = str(value.get("source_text") or "").strip()
            page = int(value.get("page_number") or 0)
            fields.append(
                FieldCandidate(
                    raw_label=label,
                    value=printed,
                    canonical_field=label,
                    confidence=value.get("confidence"),
                    evidence=[EvidenceSpan(page=page, text=quote)] if quote else [],
                )
            )
        return RecognitionResult(self.model_info(), "ok", fields=fields, usage=UsageRecord(pages=len(context)))
