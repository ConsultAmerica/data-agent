"""Extraction strategies: the ordered provider steps a document goes
through (docs/di-01-target-architecture.md §4).

Local steps come first; external steps run only when their condition
holds, they are configured, policy allows the document's data class and
the per-document budget isn't spent. A profile can declare its own
strategy (StagingProfile.extraction_strategy); otherwise its data class /
profile id picks one below.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

# always         run the step
# no_text        only if no earlier step produced any text
# fields_missing only if some wanted field has no grounded candidate yet
Condition = Literal["always", "no_text", "fields_missing"]


@dataclass(frozen=True)
class StrategyStep:
    provider: str
    when: Condition = "always"
    timeout_s: float = 60.0
    max_attempts: int = 1
    # A required step that fails marks the whole run failed.
    required: bool = False


TEXT_LAYER = (
    StrategyStep("native_text", required=True, timeout_s=120.0),
    StrategyStep("tesseract", when="no_text", timeout_s=300.0),
)

DEFAULT_STRATEGY: tuple[StrategyStep, ...] = TEXT_LAYER

INVOICE_STRATEGY: tuple[StrategyStep, ...] = TEXT_LAYER + (
    StrategyStep("azure_di", when="fields_missing", timeout_s=120.0, max_attempts=2),
    StrategyStep("google_docai", when="fields_missing", timeout_s=120.0, max_attempts=2),
    StrategyStep("oci_document", when="fields_missing", timeout_s=120.0, max_attempts=2),
    StrategyStep("llm", when="fields_missing", timeout_s=60.0),
)

IDENTITY_STRATEGY: tuple[StrategyStep, ...] = TEXT_LAYER + (StrategyStep("mrz", required=False),)

_BY_PROFILE = {"invoice": INVOICE_STRATEGY}


def strategy_for(profile) -> tuple[StrategyStep, ...]:
    declared = getattr(profile, "extraction_strategy", ()) if profile is not None else ()
    if declared:
        return tuple(declared)
    if profile is not None and profile.profile_id in _BY_PROFILE:
        return _BY_PROFILE[profile.profile_id]
    return DEFAULT_STRATEGY


def wanted_fields(profile) -> tuple[str, ...]:
    """Single-value business fields read from the document itself."""

    if profile is None:
        return ()
    return tuple(
        field.canonical_field
        for dataset in profile.datasets
        if dataset.role == "business" and dataset.cardinality == "single"
        for field in dataset.fields
        if field.grounding == "evidence"
    )
