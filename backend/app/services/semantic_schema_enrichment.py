"""Optional AI semantic enrichment layered on heuristic discovery.

Heuristics always run first. AI only renames/groups ambiguous targets —
it never invents keys or replaces selectable evidence-backed schema.
"""

from __future__ import annotations

import asyncio
import json
import logging

from app.core.config import get_settings
from app.models.document_page import DocumentPage
from app.schemas.document_target import DocumentTarget
from app.schemas.schema_enrichment import SchemaEnrichmentResult, SchemaTargetEnrichment
from app.services.ai_context import build_page_context
from app.services.ai_enrichment import AIEnrichmentSession
from app.services.ai_provider import AIProvider, AIProviderError, DisabledAIProvider
from app.services.discovery_enrichment import assign_discovery_group
from app.services.generic_kv_scanner import is_internal_form_name

logger = logging.getLogger(__name__)

_GENERIC_GROUPS = {"Document Fields", "Custom Fields"}
_ALLOWED_VALUE_TYPES = {
    "string",
    "identifier",
    "date",
    "currency",
    "amount",
    "email",
    "phone",
    "table",
}
_MAX_TARGETS = 40
_MAX_CONTEXT_CHARS = 12000


def needs_semantic_enrichment(target: DocumentTarget) -> bool:
    if target.is_custom or target.target_type == "table":
        return False
    if target.is_internal or not target.selectable:
        return False
    if target.group in _GENERIC_GROUPS:
        return True
    if target.discovery_method in {"ai", "unknown", None} and not target.description:
        return True
    return False


def _targets_payload(targets: list[DocumentTarget]) -> str:
    rows = [
        {
            "key": target.key,
            "label": target.label,
            "display_name": target.display_name,
            "group": target.group,
            "value_type": target.value_type,
            "target_type": target.target_type,
            "source_labels": target.source_labels[:3],
        }
        for target in targets[:_MAX_TARGETS]
    ]
    return json.dumps(rows, ensure_ascii=False)


def _is_safe_enrichment_key(key: str, known_keys: set[str]) -> bool:
    if not key or key not in known_keys:
        return False
    if is_internal_form_name(key):
        return False
    return True


def _dedupe_enrichments(
    enrichments: list[SchemaTargetEnrichment],
    *,
    known_keys: set[str],
) -> dict[str, SchemaTargetEnrichment]:
    """Keep first safe suggestion per known key; drop invented/internal keys."""

    by_key: dict[str, SchemaTargetEnrichment] = {}
    for item in enrichments:
        key = (item.key or "").strip()
        if not _is_safe_enrichment_key(key, known_keys):
            continue
        if key in by_key:
            continue
        by_key[key] = item
    return by_key


def _apply_enrichment(
    target: DocumentTarget,
    *,
    display_name: str | None,
    group: str | None,
    value_type: str | None,
    description: str | None,
) -> DocumentTarget:
    updates: dict = {}
    if display_name:
        cleaned = " ".join(display_name.split()).strip()
        if cleaned and len(cleaned) <= 120 and not is_internal_form_name(cleaned):
            updates["display_name"] = cleaned
            updates["label"] = cleaned
    if group:
        cleaned_group = " ".join(group.split()).strip()
        if cleaned_group and len(cleaned_group) <= 60:
            # Only replace generic groups, or accept AI group when current is generic.
            if target.group in _GENERIC_GROUPS or not target.group:
                updates["group"] = cleaned_group
    if value_type and value_type in _ALLOWED_VALUE_TYPES:
        if not target.value_type or target.value_type == "string":
            updates["value_type"] = value_type
    if description:
        cleaned_desc = " ".join(description.split()).strip()
        if cleaned_desc and not target.description:
            updates["description"] = cleaned_desc[:240]
    if not updates:
        return target
    method = target.discovery_method or "detected"
    if "semantic" not in method:
        updates["discovery_method"] = f"{method}+semantic"
    # Key is never part of updates — stable by construction.
    return target.model_copy(update=updates)


async def enrich_targets_semantically(
    *,
    targets: list[DocumentTarget],
    pages: list[DocumentPage],
    ai_provider: AIProvider,
) -> tuple[list[DocumentTarget], list[str]]:
    """Return enriched targets + soft warnings (never fails discovery)."""

    warnings: list[str] = []
    if isinstance(ai_provider, DisabledAIProvider) or (
        isinstance(ai_provider, AIEnrichmentSession) and not ai_provider.available
    ):
        return targets, warnings

    candidates = [target for target in targets if needs_semantic_enrichment(target)]
    if not candidates:
        return targets, warnings

    page_context = build_page_context(
        pages[:5],
        maximum_characters=_MAX_CONTEXT_CHARS,
    )
    budget = get_settings().ai_schema_enrichment_budget_seconds
    try:
        raw = await asyncio.wait_for(
            ai_provider.enrich_schema(
                targets_json=_targets_payload(candidates),
                page_context=page_context,
            ),
            timeout=budget,
        )
        result = SchemaEnrichmentResult.model_validate(raw)
    except TimeoutError:
        logger.info("Semantic schema enrichment skipped: no answer within %ss", budget)
        warnings.append(
            f"Semantic schema enrichment took longer than {budget:g}s; using heuristic labels."
        )
        return targets, warnings
    except (AIProviderError, Exception) as exc:
        logger.info("Semantic schema enrichment skipped: %s", exc)
        warnings.append("Semantic schema enrichment unavailable; using heuristic labels.")
        return targets, warnings

    warnings.extend(result.warnings or [])
    known_keys = {target.key for target in targets}
    by_key = _dedupe_enrichments(result.enrichments, known_keys=known_keys)

    enriched: list[DocumentTarget] = []
    for target in targets:
        suggestion = by_key.get(target.key)
        if suggestion is None:
            if not target.group:
                target = target.model_copy(
                    update={
                        "group": assign_discovery_group(
                            label=target.display_name or target.label,
                            target_type=target.target_type,
                        )
                    }
                )
            enriched.append(target)
            continue
        enriched.append(
            _apply_enrichment(
                target,
                display_name=suggestion.display_name,
                group=suggestion.group,
                value_type=suggestion.value_type,
                description=suggestion.description,
            )
        )
    return enriched, warnings
