"""The recognition provider contract (docs/di-01-target-architecture.md §3).

A provider returns pages, tables and field candidates with evidence; the
orchestrator — not the provider — enforces the rules that matter:

* a field candidate without at least one evidence span is rejected,
  never defaulted (`FieldCandidate.grounded`);
* external results are re-grounded against the platform's own text layer;
* every call is recorded with provider, model and version (runs.py).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Protocol

from app.recognition.layout import PageLayout, TableResult

Locality = Literal["local", "external"]
RunStatus = Literal["ok", "partial", "failed", "skipped"]


@dataclass(frozen=True)
class ModelInfo:
    provider_id: str
    model: str | None = None
    version: str | None = None
    region: str | None = None


@dataclass(frozen=True)
class EvidenceSpan:
    page: int  # 1-based; a span without a real page is not evidence
    text: str
    # (x0, y0, x1, y1) in `coord_space`
    bbox: tuple[float, float, float, float] | None = None
    coord_space: Literal["pdf_points", "ocr_pixels"] | None = None


@dataclass
class FieldCandidate:
    raw_label: str | None
    value: str
    canonical_field: str | None = None
    normalized_value: str | None = None
    confidence: float | None = None
    evidence: list[EvidenceSpan] = field(default_factory=list)

    @property
    def grounded(self) -> bool:
        return any(span.page >= 1 and span.text.strip() for span in self.evidence)


@dataclass
class UsageRecord:
    pages: int = 0
    input_tokens: int | None = None
    output_tokens: int | None = None
    estimated_cost_usd: float | None = None
    latency_ms: int | None = None


@dataclass(frozen=True)
class RecognitionRequest:
    document_id: str
    run_id: str
    profile_key: str | None
    data_class: str
    pages: tuple[int, ...] | None = None
    deadline_s: float = 45.0
    file_path: str = ""
    mime_type: str = "application/pdf"
    # Results of earlier steps in the same strategy (text layers for
    # specialist/LLM steps that read rather than see the document).
    prior: tuple["RecognitionResult", ...] = ()
    # Canonical field ids the profile wants (field-capable providers).
    wanted_fields: tuple[str, ...] = ()


@dataclass
class RecognitionResult:
    model: ModelInfo
    status: RunStatus
    fields: list[FieldCandidate] = field(default_factory=list)
    usage: UsageRecord = field(default_factory=UsageRecord)
    warnings: list[str] = field(default_factory=list)
    pages: list[PageLayout] = field(default_factory=list)
    tables: list[TableResult] = field(default_factory=list)

    def accepted_fields(self) -> list[FieldCandidate]:
        """Candidates the orchestrator may use: grounded ones only."""
        return [candidate for candidate in self.fields if candidate.grounded]


class RecognitionProvider(Protocol):
    provider_id: str
    locality: Locality
    capabilities: frozenset[str]

    def configured(self, settings) -> tuple[bool, str]: ...

    def model_info(self) -> ModelInfo: ...

    async def recognize(self, request: RecognitionRequest) -> RecognitionResult: ...
