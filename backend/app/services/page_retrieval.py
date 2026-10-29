"""Retrieve and rank pages relevant to a discovery target.

Used before deterministic extraction and before any AI fallback so a
1,000-page PDF never sends the whole document to the model.
"""

from __future__ import annotations

import re

from app.models.document_page import DocumentPage
from app.schemas.document_target import DocumentTarget
from app.schemas.extraction_intelligence import (
    CandidatePageScore,
    RetrievalTrace,
)
from app.services.table_shapes import page_tables

_TOKEN_RE = re.compile(r"[a-z0-9]{3,}")


def _tokens(*parts: str) -> set[str]:
    joined = " ".join(part for part in parts if part)
    return set(_TOKEN_RE.findall(joined.lower()))


def _normalize_label(label: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (label or "").lower()).strip()


def rank_pages_for_target(
    *,
    target: DocumentTarget,
    pages: list[DocumentPage],
    max_pages: int = 10,
) -> list[CandidatePageScore]:
    """Score pages using discovery metadata, labels, tables, and structure."""

    if not pages:
        return []

    label_tokens = _tokens(
        target.label,
        target.display_name or "",
        " ".join(target.source_labels or []),
        target.key.replace("_", " ").replace("kv ", ""),
    )
    normalized_labels = {
        _normalize_label(label)
        for label in [
            target.label,
            target.display_name or "",
            *(target.source_labels or []),
        ]
        if label
    }
    likely = set(target.page_numbers or [])
    raw_scores: list[tuple[int, float]] = []

    for page in pages:
        score = 0.0
        text = (page.final_text or "").lower()
        normalized_text = _normalize_label(page.final_text or "")

        if page.page_number in likely:
            score += 5.0

        for label in normalized_labels:
            if label and label in normalized_text:
                score += 3.5
                break

        if label_tokens and text:
            hits = sum(1 for token in label_tokens if token in text)
            if hits:
                score += min(4.0, hits * 0.75)

        # Table header overlap / column metadata
        for table in page_tables(getattr(page, "tables_json", None)):
            headers = [
                _normalize_label(str(header))
                for header in (table.get("headers") or [])
            ]
            if target.columns:
                overlap = len(
                    {_normalize_label(col) for col in target.columns}
                    & set(headers)
                )
                if overlap:
                    score += min(3.0, overlap * 0.8)
            elif any(
                any(token in header for token in label_tokens)
                for header in headers
                if header
            ):
                score += 1.5

        if getattr(page, "form_fields_json", None):
            score += 0.35

        if getattr(page, "requires_ocr", False):
            score -= 0.25
        else:
            score += 0.15

        if score > 0:
            raw_scores.append((page.page_number, score))

    if not raw_scores:
        fallback_numbers = list(target.page_numbers or []) or [
            page.page_number for page in pages[:max_pages]
        ]
        return [
            CandidatePageScore(page=number, score=0.1)
            for number in fallback_numbers[:max_pages]
            if any(page.page_number == number for page in pages)
        ]

    max_raw = max(score for _, score in raw_scores) or 1.0
    ranked = [
        CandidatePageScore(
            page=page_number,
            score=round(min(1.0, score / max_raw), 2),
        )
        for page_number, score in raw_scores
    ]
    ranked.sort(key=lambda item: (-item.score, item.page))
    return ranked[: max(1, max_pages)]


def build_retrieval_trace(
    *,
    target: DocumentTarget,
    pages: list[DocumentPage],
    max_pages: int = 10,
    select_top: int | None = None,
) -> RetrievalTrace:
    candidates = rank_pages_for_target(
        target=target, pages=pages, max_pages=max_pages
    )
    top_n = select_top or min(max_pages, 5)
    # Keep strong candidates; always include at least the top page.
    selected = [
        item.page
        for item in candidates
        if item.score >= 0.45 or item == candidates[0]
    ][:top_n]
    if not selected and candidates:
        selected = [candidates[0].page]

    return RetrievalTrace(
        target_key=target.key,
        candidate_pages=candidates,
        selected_pages=selected,
        deterministic_status="not_attempted",
        ai_fallback_required=False,
    )


def select_pages_for_target(
    *,
    target: DocumentTarget,
    pages: list[DocumentPage],
    page_lookup: dict[int, DocumentPage],
    max_pages: int = 10,
) -> list[DocumentPage]:
    trace = build_retrieval_trace(
        target=target, pages=pages, max_pages=max_pages
    )
    selected = [
        page_lookup[number]
        for number in trace.selected_pages
        if number in page_lookup
    ]
    return selected or pages[:max_pages]


def pages_from_trace(
    *,
    trace: RetrievalTrace,
    page_lookup: dict[int, DocumentPage],
    all_pages: list[DocumentPage],
    max_pages: int = 10,
) -> list[DocumentPage]:
    selected = [
        page_lookup[number]
        for number in trace.selected_pages
        if number in page_lookup
    ]
    return selected or all_pages[:max_pages]
