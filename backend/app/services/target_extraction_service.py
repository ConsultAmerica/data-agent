"""Targeted extraction: retrieve → deterministic → AI escalate → validate."""

from __future__ import annotations

import asyncio
import re
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.errors import TARGET_NOT_FOUND, http_error
from app.models.document import Document
from app.models.document_page import DocumentPage
from app.models.page_text_block import PageTextBlock
from app.schemas.document_target import (
    DocumentTarget,
    ExtractTargetsResponse,
    ScalarTargetResult,
    TableTargetResult,
)
from app.schemas.extraction_intelligence import (
    ConfidenceDetail,
    RetrievalTrace,
    ValidationResult,
    confidence_detail_to_legacy_signals,
)
from app.services.ai_context import build_page_context
from app.services.ai_enrichment import AIEnrichmentSession, assess_deterministic_sufficiency
from app.services.ai_provider import AIProvider, AIProviderError
from app.services.ai_value_mapping import map_ai_value
from app.services.clause_citation_scanner import scan_pages_for_clause_citations
from app.services.confidence_engine import (
    display_method,
    explain_confidence,
)
from app.services.detected_target_store import load_document_targets
from app.services.document_outline import SectionBoundary, build_document_outline
from app.services.form_field_search import search_form_fields
from app.services.generic_kv_scanner import is_internal_form_name
from app.services.generic_label_extractor import (
    LayoutBlock,
    extract_labeled_value,
    extract_labeled_value_from_layout,
    normalize_label,
)
from app.services.page_retrieval import (
    build_retrieval_trace,
    pages_from_trace,
)
from app.services.result_validation import build_validation_result
from app.services.section_detection import section_for_value
from app.services.review_routing import decide_review_for_scalar
from app.services.label_rejection import reject_as_field_value
from app.services.candidate_consensus import ExtractionCandidate, resolve_candidates
from app.services.scanned_accuracy import (
    layout_candidates_for_target,
    maybe_targeted_second_pass,
)
from app.services.source_validator import validate_source_value
from app.services.table_shapes import page_tables

settings = get_settings()

_TABLE_LIKE_TYPES = {"table", "section", "clause"}
_MAX_CONCURRENT_AI_CALLS = 3

_KV_SOURCE_EVIDENCE = re.compile(
    r"^'(?P<label>[^:]+):\s*(?P<value>.+)'\s+on page\s+(?P<page>\d+)\s+\(",
)


def _scalar_result(
    *,
    target: DocumentTarget,
    value: Any,
    page_number: int,
    page: DocumentPage | None,
    method: str,
    confidence: ConfidenceDetail,
    validation: ValidationResult,
    evidence: dict[str, Any],
    retrieval: RetrievalTrace | None,
    verified: bool,
) -> ScalarTargetResult:
    scalar = ScalarTargetResult(
        target=target.key,
        normalized_key=target.key,
        value=value,
        extracted_value=value,
        review_status=None,  # filled after decide_review_for_scalar
        page=page_number,
        confidence=confidence.score,
        confidence_band=confidence.band,
        verified=verified,
        extraction_method=method,
        display_method=display_method(method, page),
        evidence=evidence,
        retrieval=retrieval,
        confidence_detail=confidence,
        validation=validation,
        confidence_signals=confidence_detail_to_legacy_signals(confidence),
        validation_status=validation.status,
    )
    decision = decide_review_for_scalar(scalar)
    return scalar.model_copy(
        update={
            "review_status": decision["review_status"],
            "review_decision": {
                "status": decision["status"],
                "priority": decision["priority"],
                "reasons": decision["reasons"],
            },
        }
    )


def _load_blocks_by_page_id(
    *,
    database: Session,
    pages: list[DocumentPage],
) -> dict[int, list[LayoutBlock]]:
    page_ids = [page.id for page in pages]
    if not page_ids:
        return {}

    rows = database.scalars(
        select(PageTextBlock).where(PageTextBlock.document_page_id.in_(page_ids))
    )

    blocks_by_page_id: dict[int, list[LayoutBlock]] = {}
    for row in rows:
        blocks_by_page_id.setdefault(row.document_page_id, []).append(
            LayoutBlock(text=row.text, x0=row.x0, y0=row.y0, x1=row.x1, y1=row.y1)
        )

    return blocks_by_page_id


def _with_retrieval_status(
    trace: RetrievalTrace,
    *,
    deterministic_status: str,
    ai_fallback_required: bool,
) -> RetrievalTrace:
    return trace.model_copy(
        update={
            "deterministic_status": deterministic_status,
            "ai_fallback_required": ai_fallback_required,
        }
    )


def _resolve_scalar_from_source_examples(
    target: DocumentTarget,
    page_lookup: dict[int, DocumentPage],
    retrieval: RetrievalTrace | None = None,
    outline: list[SectionBoundary] | None = None,
) -> ScalarTargetResult | None:
    """Use discovery-time evidence before re-parsing page text."""
    if retrieval is None:
        retrieval = RetrievalTrace(
            target_key=target.key,
            candidate_pages=[],
            selected_pages=list(target.page_numbers or []),
            deterministic_status="not_attempted",
            ai_fallback_required=False,
        )
    for example in target.source_examples or []:
        match = _KV_SOURCE_EVIDENCE.match(example.strip())
        if not match:
            continue

        value = match.group("value").strip()
        if not value:
            continue
        if reject_as_field_value(
            value, value_type=target.value_type, field_key=target.key
        ):
            continue

        page_number = int(match.group("page"))
        page = page_lookup.get(page_number)
        page_text = page.final_text if page else ""
        label = match.group("label").strip()
        snippet = f"{label}: {value}"

        verified = validate_source_value(
            value=value,
            source_text=snippet,
            page_text=page_text,
        )
        if not verified:
            continue

        validation = build_validation_result(
            value=value,
            value_type=target.value_type,
            source_text=snippet,
            page_text=page_text,
            source_presence_ok=True,
        )
        # Wrong-but-confident is worse than blank: never promote a
        # discovery-time candidate that fails validation (labels, mashups).
        if validation.status == "failed":
            continue

        confidence = explain_confidence(
            method="source_evidence",
            occurrence_count=target.occurrence_count,
            page=page,
            source_grounded=True,
            validation_passed=True,
            exact_label_match=True,
        )
        return _scalar_result(
            target=target,
            value=value,
            page_number=page_number,
            page=page,
            method="source_evidence",
            confidence=confidence,
            validation=validation,
            evidence={
                "page_number": page_number,
                "source_text": snippet,
                "source_reference": f"page {page_number}",
                "section": section_for_value(
                    outline,
                    page_number=page_number,
                    page_text=page_text,
                    value=value,
                ),
                "raw_ocr": value,
                "normalized_value": value,
                "extraction_method": "source_evidence",
                "validation_status": validation.status,
                "review_status": "pending",
            },
            retrieval=_with_retrieval_status(
                retrieval,
                deterministic_status="resolved",
                ai_fallback_required=False,
            ),
            verified=True,
        )

    return None


def _needs_review_null_result(
    *,
    target: DocumentTarget,
    page: DocumentPage | None,
    page_number: int,
    retrieval: RetrievalTrace,
    reason: str,
) -> ScalarTargetResult:
    """Blank Needs Review — never surface a neighboring label as the value."""

    validation = ValidationResult(
        status="failed",
        checks=[],
        warnings=[reason],
    )
    confidence = explain_confidence(
        method="layout_form_cell",
        page=page,
        source_grounded=False,
        validation_passed=False,
        match_exactness=0.0,
        exact_label_match=False,
        ocr_confidence=None,
        layout_confidence=0.0,
    )
    return _scalar_result(
        target=target,
        value=None,
        page_number=page_number,
        page=page,
        method="unresolved_value_region",
        confidence=confidence,
        validation=validation,
        evidence={
            "page_number": page_number,
            # No value was resolved, so there is no source text; the reason
            # is kept in field_evidence and validation.warnings.
            "source_text": "",
            "source_reference": f"page {page_number}",
            "raw_ocr": None,
            "normalized_value": None,
            "extraction_method": "unresolved_value_region",
            "validation_status": "failed",
            "review_status": "needs_review",
            "field_evidence": {
                "field": target.key,
                "value": None,
                "consensus_reason": reason,
                "review_status": "needs_review",
            },
        },
        retrieval=_with_retrieval_status(
            retrieval,
            deterministic_status="unresolved",
            ai_fallback_required=False,
        ),
        verified=False,
    )


def _resolve_scalar_target(
    target: DocumentTarget,
    page_lookup: dict[int, DocumentPage],
    all_pages: list[DocumentPage],
    known_labels: frozenset[str] | None = None,
    blocks_by_page_id: dict[int, list[LayoutBlock]] | None = None,
    pdf_path: Any = None,
    outline: list[SectionBoundary] | None = None,
) -> tuple[ScalarTargetResult | None, RetrievalTrace, bool]:
    """Return (result, retrieval_trace, escalate_to_ai).

    escalate_to_ai is True when deterministic extraction is unresolved or
    ambiguous and AI should see the same retrieved evidence set.
    """

    retrieval = build_retrieval_trace(
        target=target,
        pages=all_pages,
        max_pages=settings.ai_max_pages,
    )

    from_evidence = _resolve_scalar_from_source_examples(
        target, page_lookup, retrieval, outline=outline
    )
    if from_evidence is not None:
        return from_evidence, from_evidence.retrieval or retrieval, False

    candidate_pages = pages_from_trace(
        trace=retrieval,
        page_lookup=page_lookup,
        all_pages=all_pages,
        max_pages=settings.ai_max_pages,
    )

    candidates: list[ExtractionCandidate] = []

    for page in candidate_pages:
        is_scanned = bool(
            getattr(page, "is_scanned", False)
            or getattr(page, "requires_ocr", False)
            or getattr(page, "ocr_layout_json", None)
        )
        candidates.extend(
            layout_candidates_for_target(
                page=page,
                requested_label=target.label,
                value_type=target.value_type,
                known_labels=known_labels,
            )
        )

        if page.form_fields_json:
            matches = search_form_fields(
                form_fields=page.form_fields_json,
                requested_concept=target.label,
            )
            for name, value, score in matches[:3]:
                if reject_as_field_value(
                    value,
                    value_type=target.value_type,
                    known_labels=known_labels,
                    field_key=target.key,
                ):
                    continue
                snippet = f"{name}: {value}"
                verified = validate_source_value(
                    value=value,
                    source_text=snippet,
                    page_text=page.final_text or "",
                )
                if verified:
                    candidates.append(
                        ExtractionCandidate(
                            value=str(value),
                            raw_ocr=str(value),
                            method="form_field",
                            layout_confidence=float(score),
                            source_page=page.page_number,
                        )
                    )

        layout_value = extract_labeled_value_from_layout(
            blocks=(blocks_by_page_id or {}).get(page.id, []),
            requested_label=target.label,
            known_labels=known_labels,
        )
        if layout_value and not reject_as_field_value(
            layout_value,
            value_type=target.value_type,
            known_labels=known_labels,
            field_key=target.key,
        ):
            verified = validate_source_value(
                value=layout_value,
                source_text=layout_value,
                page_text=page.final_text or "",
            )
            if verified:
                candidates.append(
                    ExtractionCandidate(
                        value=layout_value,
                        raw_ocr=layout_value,
                        method="layout_proximity",
                        layout_confidence=0.9,
                        source_page=page.page_number,
                    )
                )

        # Flattened-text proximity invents cross-cell mashups on scanned
        # government forms. Prefer geometry; only fall back to text when
        # the page has no layout and is not OCR-scanned.
        if not is_scanned:
            label_value = extract_labeled_value(
                text=page.final_text or "",
                requested_label=target.label,
                known_labels=known_labels,
            )
            if label_value and not reject_as_field_value(
                label_value,
                value_type=target.value_type,
                known_labels=known_labels,
                field_key=target.key,
            ):
                verified = validate_source_value(
                    value=label_value,
                    source_text=label_value,
                    page_text=page.final_text or "",
                )
                if verified:
                    candidates.append(
                        ExtractionCandidate(
                            value=label_value,
                            raw_ocr=label_value,
                            method="label_value",
                            layout_confidence=0.9,
                            source_page=page.page_number,
                        )
                    )

    consensus = resolve_candidates(
        candidates,
        value_type=target.value_type,
        known_labels=known_labels,
        field_key=target.key,
    )

    # Targeted second-pass OCR when layout hit exists but consensus is weak.
    if (
        consensus.decision != "auto_select"
        and pdf_path is not None
        and any(item.source_bbox for item in candidates)
    ):
        for item in candidates:
            if not item.source_bbox or item.source_page is None:
                continue
            page = page_lookup.get(item.source_page)
            if page is None:
                continue
            second = maybe_targeted_second_pass(
                pdf_path=pdf_path,
                page=page,
                bbox=item.source_bbox,
                language=getattr(page, "ocr_language", None) or "eng",
            )
            if second is not None:
                candidates.append(second)
                break
        consensus = resolve_candidates(
            candidates,
            value_type=target.value_type,
            known_labels=known_labels,
            field_key=target.key,
        )

    if consensus.decision == "reject" or consensus.selected is None:
        if not candidates:
            # No candidate of any kind was found — this is a genuine
            # "not found", not a weak/ambiguous extraction. Let it fall
            # through to AI fallback (if enabled) and, failing that,
            # land in unresolved_targets so the UI shows a real
            # "Not Found" with no confidence score, instead of a
            # manufactured ~25% that reads as a weak-but-real signal.
            return None, retrieval, True

        page_hint = candidate_pages[0] if candidate_pages else None
        page_number = page_hint.page_number if page_hint else (
            (target.page_numbers or [1])[0]
        )
        reason = (
            "conflicting candidates; value region could not be resolved confidently"
            if consensus.decision == "needs_review"
            else "value region could not be resolved confidently"
        )
        # Wrong-but-confident is worse than blank: do not escalate to AI
        # with label-contaminated OCR context for unresolved form cells.
        null_result = _needs_review_null_result(
            target=target,
            page=page_hint,
            page_number=page_number,
            retrieval=retrieval,
            reason=reason,
        )
        return null_result, null_result.retrieval or retrieval, False

    selected = consensus.selected
    page = page_lookup.get(selected.source_page or 0)
    page_text = page.final_text if page else ""
    snippet = selected.value
    validation = build_validation_result(
        value=selected.value,
        value_type=target.value_type,
        source_text=snippet,
        page_text=page_text or "",
        source_presence_ok=True,
    )
    if validation.status == "failed" or reject_as_field_value(
        selected.value,
        value_type=target.value_type,
        known_labels=known_labels,
        field_key=target.key,
    ):
        null_result = _needs_review_null_result(
            target=target,
            page=page,
            page_number=selected.source_page
            or (page.page_number if page else 1),
            retrieval=retrieval,
            reason="candidate failed label/value validation",
        )
        return null_result, null_result.retrieval or retrieval, False

    confidence = explain_confidence(
        method=selected.method,
        match_exactness=float(selected.layout_confidence or 0.9),
        occurrence_count=target.occurrence_count,
        page=page,
        source_grounded=True,
        validation_passed=validation.status == "passed",
        ambiguous_candidates=len(consensus.candidates),
        exact_label_match=selected.method.startswith("layout_form")
        or selected.method in {"form_field", "label_value"},
        ocr_confidence=selected.ocr_confidence,
        layout_confidence=selected.layout_confidence,
    )
    if consensus.decision == "needs_review" and confidence.score > 0.59:
        # Surface as low/needs-review even when OCR chars were confident.
        confidence = confidence.model_copy(
            update={
                "score": 0.59,
                "band": "low",
                "components": (
                    confidence.components.model_copy(update={"final": 0.59})
                    if confidence.components
                    else None
                ),
                "signals": confidence.signals.model_copy(update={"ambiguity": True}),
            }
        )

    evidence_payload = consensus.evidence_payload(field_key=target.key)
    evidence_payload["validation_status"] = validation.status
    bbox = selected.source_bbox
    retrieval = _with_retrieval_status(
        retrieval,
        deterministic_status=(
            "ambiguous" if consensus.decision == "needs_review" else "resolved"
        ),
        ai_fallback_required=False,
    )

    return (
        _scalar_result(
            target=target,
            value=selected.value,
            page_number=selected.source_page or (page.page_number if page else 1),
            page=page,
            method=selected.method,
            confidence=confidence,
            validation=validation,
            evidence={
                "page_number": selected.source_page
                or (page.page_number if page else 1),
                "source_text": snippet,
                "source_reference": f"page {selected.source_page or '?'}",
                "section": section_for_value(
                    outline,
                    page_number=selected.source_page
                    or (page.page_number if page else 1),
                    page_text=page_text,
                    value=snippet,
                ),
                "x0": bbox[0] if bbox and len(bbox) == 4 else None,
                "y0": bbox[1] if bbox and len(bbox) == 4 else None,
                "x1": bbox[2] if bbox and len(bbox) == 4 else None,
                "y1": bbox[3] if bbox and len(bbox) == 4 else None,
                "raw_ocr": selected.raw_ocr,
                "normalized_value": consensus.normalized_value,
                "extraction_method": selected.method,
                "ocr_confidence": selected.ocr_confidence,
                "layout_confidence": selected.layout_confidence,
                "validation_status": validation.status,
                "review_status": consensus.review_status,
                "field_evidence": evidence_payload,
            },
            retrieval=retrieval,
            verified=True,
        ),
        retrieval,
        False,
    )


_CLAUSE_TARGET_KEYS = {"far_clauses", "dfars_clauses"}


def _resolve_clause_target(
    target: DocumentTarget,
    page_lookup: dict[int, DocumentPage],
    all_pages: list[DocumentPage],
) -> TableTargetResult | None:
    if target.target_type != "clause" and target.key not in _CLAUSE_TARGET_KEYS:
        return None

    candidate_pages = [
        page_lookup[number]
        for number in target.page_numbers
        if number in page_lookup
    ] or all_pages

    family_filter = None
    if target.key == "far_clauses":
        family_filter = "far_clauses"
    elif target.key == "dfars_clauses":
        family_filter = "dfars_clauses"

    citations = scan_pages_for_clause_citations(
        pages=candidate_pages,
        family_filter=family_filter,
    )
    if not citations:
        return None

    columns = ["clause_family", "clause_number", "title", "source_text", "page"]
    rows = [
        {
            "clause_family": citation.clause_family,
            "clause_number": citation.clause_number,
            "title": citation.title,
            "source_text": citation.source_text,
            "page": citation.page_number,
        }
        for citation in citations
    ]
    pages = sorted({citation.page_number for citation in citations})

    return TableTargetResult(
        target=target.key,
        columns=columns,
        rows=rows,
        pages=pages,
    )


def _headers_overlap(a: list[str], b: list[str]) -> float:
    if not a or not b:
        return 0.0
    set_a = {header.strip().lower() for header in a}
    set_b = {header.strip().lower() for header in b}
    if not set_a or not set_b:
        return 0.0
    return len(set_a & set_b) / len(set_a | set_b)


def _resolve_table_target(
    target: DocumentTarget,
    page_lookup: dict[int, DocumentPage],
) -> TableTargetResult | None:
    candidate_pages = [
        page_lookup[number]
        for number in target.page_numbers
        if number in page_lookup
    ]

    for page in candidate_pages:
        for table in page_tables(page.tables_json):
            headers = [str(header) for header in (table.get("headers") or [])]

            if target.columns:
                if _headers_overlap(headers, target.columns) < 0.5:
                    continue
            elif not headers:
                continue

            return TableTargetResult(
                target=target.key,
                columns=headers,
                rows=list(table.get("rows") or []),
                pages=[page.page_number],
            )

    return None


def _ai_scalar_from_value(
    *,
    target: DocumentTarget,
    value: Any,
    page_lookup: dict[int, DocumentPage],
    retrieval: RetrievalTrace | None,
    outline: list[SectionBoundary] | None = None,
) -> ScalarTargetResult | None:
    if not value.verified:
        return None
    if reject_as_field_value(
        value.value, value_type=target.value_type, field_key=target.key
    ):
        return None
    ai_page = page_lookup.get(value.evidence.page_number)
    page_text = ai_page.final_text if ai_page else ""
    source_text = getattr(value.evidence, "source_text", "") or ""
    validation = build_validation_result(
        value=value.value,
        value_type=target.value_type,
        source_text=source_text,
        page_text=page_text or "",
        source_presence_ok=True,
    )
    confidence = explain_confidence(
        method="ai",
        match_exactness=value.confidence,
        page=ai_page,
        source_grounded=True,
        validation_passed=validation.status == "passed",
    )
    trace = None
    if retrieval is not None:
        trace = _with_retrieval_status(
            retrieval,
            deterministic_status=retrieval.deterministic_status
            if retrieval.deterministic_status != "not_attempted"
            else "unresolved",
            ai_fallback_required=True,
        )
    evidence = value.evidence
    if getattr(evidence, "section", None) is None:
        # The AI provider never resolves a section of its own — thread the
        # same document-wide outline the deterministic path uses so an
        # AI-fallback field doesn't fall back to a blank "—" Section.
        evidence = evidence.model_copy(
            update={
                "section": section_for_value(
                    outline,
                    page_number=value.evidence.page_number,
                    page_text=page_text,
                    value=str(value.value) if value.value is not None else None,
                )
            }
        )
    return _scalar_result(
        target=target,
        value=value.value,
        page_number=value.evidence.page_number,
        page=ai_page,
        method="ai",
        confidence=confidence,
        validation=validation,
        evidence=evidence,
        retrieval=trace,
        verified=True,
    )


async def _run_batched_scalar_ai_fallback(
    *,
    targets: list[DocumentTarget],
    retrieval_by_key: dict[str, RetrievalTrace],
    all_pages: list[DocumentPage],
    page_lookup: dict[int, DocumentPage],
    document_name: str,
    ai_provider: AIProvider,
    outline: list[SectionBoundary] | None = None,
) -> tuple[list[ScalarTargetResult], list[str]]:
    if not targets:
        return [], []

    # Union of ranked pages across the batch — never the full PDF.
    ranked_pages: list[DocumentPage] = []
    seen_pages: set[int] = set()
    for target in targets:
        trace = retrieval_by_key.get(target.key) or build_retrieval_trace(
            target=target,
            pages=all_pages,
            max_pages=settings.ai_max_pages,
        )
        for page in pages_from_trace(
            trace=trace,
            page_lookup=page_lookup,
            all_pages=all_pages,
            max_pages=settings.ai_max_pages,
        ):
            if page.page_number in seen_pages:
                continue
            seen_pages.add(page.page_number)
            ranked_pages.append(page)
            if len(ranked_pages) >= settings.ai_max_pages:
                break
        if len(ranked_pages) >= settings.ai_max_pages:
            break

    label_list = "; ".join(f'"{target.label}"' for target in targets)
    instruction = f"Extract the following exact fields: {label_list}."
    context = build_page_context(
        ranked_pages or all_pages[: settings.ai_max_pages],
        maximum_characters=settings.ai_max_context_chars,
    )

    try:
        ai_result = await ai_provider.extract(
            instruction=instruction, page_context=context
        )
    except AIProviderError:
        # Reported once per run by the AI enrichment session (Processing
        # Details), never as a per-call warning in the results.
        return [], []

    scalars: list[ScalarTargetResult] = []
    warnings: list[str] = []
    remaining = list(targets)

    for ai_value in ai_result.get("values", []):
        label = str(ai_value.get("label", "")).lower()

        matched = next(
            (
                target
                for target in remaining
                if target.label.lower() in label
                or label in target.label.lower()
            ),
            None,
        )
        if matched is None:
            continue

        value, warning = map_ai_value(
            ai_value=ai_value,
            page_lookup=page_lookup,
            document_name=document_name,
        )
        if warning:
            warnings.append(warning)
            continue

        scalar = _ai_scalar_from_value(
            target=matched,
            value=value,
            page_lookup=page_lookup,
            retrieval=retrieval_by_key.get(matched.key),
            outline=outline,
        )
        if scalar is None:
            continue
        scalars.append(scalar)
        remaining.remove(matched)

    warnings.extend(ai_result.get("warnings", []))
    return scalars, warnings


async def _run_per_target_ai_fallback(
    *,
    target: DocumentTarget,
    retrieval: RetrievalTrace | None,
    all_pages: list[DocumentPage],
    page_lookup: dict[int, DocumentPage],
    document_name: str,
    ai_provider: AIProvider,
    semaphore: asyncio.Semaphore,
    outline: list[SectionBoundary] | None = None,
) -> tuple[TableTargetResult | ScalarTargetResult | None, list[str]]:
    async with semaphore:
        trace = retrieval or build_retrieval_trace(
            target=target,
            pages=all_pages,
            max_pages=settings.ai_max_pages,
        )
        target_pages = pages_from_trace(
            trace=trace,
            page_lookup=page_lookup,
            all_pages=all_pages,
            max_pages=settings.ai_max_pages,
        )

        instruction = (
            target.suggested_instruction or f"Extract the {target.label}."
        )
        context = build_page_context(
            target_pages, maximum_characters=settings.ai_max_context_chars
        )

        try:
            ai_result = await ai_provider.extract(
                instruction=instruction, page_context=context
            )
        except AIProviderError:
            return None, []

        warnings = list(ai_result.get("warnings", []))

        if target.target_type == "table":
            for ai_value in ai_result.get("values", []):
                raw_value = ai_value.get("value")
                if isinstance(raw_value, list) and raw_value:
                    columns = target.columns
                    if not columns and isinstance(raw_value[0], dict):
                        columns = list(raw_value[0].keys())
                    fallback_page = ai_value.get("page_number")
                    return (
                        TableTargetResult(
                            target=target.key,
                            columns=columns or [],
                            rows=raw_value,
                            pages=target.page_numbers
                            or ([fallback_page] if fallback_page else []),
                        ),
                        warnings,
                    )
            warnings.append(
                f"Could not extract table for '{target.label}'."
            )
            return None, warnings

        for ai_value in ai_result.get("values", []):
            value, warning = map_ai_value(
                ai_value=ai_value,
                page_lookup=page_lookup,
                document_name=document_name,
            )
            if warning:
                warnings.append(warning)
                continue
            if not value.verified:
                warnings.append(
                    f"AI result for '{target.label}' failed source validation."
                )
                continue
            scalar = _ai_scalar_from_value(
                target=target,
                value=value,
                page_lookup=page_lookup,
                retrieval=trace,
                outline=outline,
            )
            if scalar is not None:
                return scalar, warnings

        return None, warnings


async def extract_by_targets(
    *,
    database: Session,
    document: Document,
    target_ids: list[str],
    use_ai_fallback: bool,
    ai_provider: AIProvider,
) -> ExtractTargetsResponse:
    stored = load_document_targets(database=database, document_id=document.id)

    if stored is None:
        raise http_error(
            409,
            TARGET_NOT_FOUND,
            "Discover targets before extracting them.",
        )

    targets_by_id = {target.id: target for target in stored.targets}
    requested = [
        targets_by_id[target_id]
        for target_id in target_ids
        if target_id in targets_by_id
    ]
    unresolved: list[str] = [
        target_id for target_id in target_ids if target_id not in targets_by_id
    ]

    all_pages = list(
        database.scalars(
            select(DocumentPage)
            .where(DocumentPage.document_id == document.id)
            .order_by(DocumentPage.page_number)
        )
    )
    page_lookup = {page.page_number: page for page in all_pages}

    known_labels = frozenset(
        normalize_label(t.label).lower() for t in stored.targets
    )
    blocks_by_page_id = _load_blocks_by_page_id(database=database, pages=all_pages)
    # Built once per extraction run, not per field — a UCF section spans
    # many pages, so every field's evidence resolves its section against
    # this same outline rather than each guessing independently.
    outline = build_document_outline(all_pages)

    pdf_path = None
    try:
        from app.services.document_storage import ensure_local_copy

        pdf_path = ensure_local_copy(
            settings, stored_filename=document.stored_filename
        )
    except Exception:
        pdf_path = None

    scalars: list[ScalarTargetResult] = []
    tables: list[TableTargetResult] = []
    warnings: list[str] = []
    needs_ai: list[DocumentTarget] = []
    retrieval_by_key: dict[str, RetrievalTrace] = {}

    for target in requested:
        if target.target_type == "table":
            resolved_table = _resolve_table_target(target, page_lookup)
            if resolved_table is not None:
                tables.append(resolved_table)
                continue
        elif target.target_type == "clause" or target.key in _CLAUSE_TARGET_KEYS:
            resolved_clause = _resolve_clause_target(
                target, page_lookup, all_pages
            )
            if resolved_clause is not None:
                tables.append(resolved_clause)
                continue
        else:
            resolved_scalar, retrieval, escalate = _resolve_scalar_target(
                target,
                page_lookup,
                all_pages,
                known_labels=known_labels,
                blocks_by_page_id=blocks_by_page_id,
                pdf_path=pdf_path,
                outline=outline,
            )
            retrieval_by_key[target.key] = retrieval
            if resolved_scalar is not None:
                scalars.append(resolved_scalar)
                continue
            if escalate:
                needs_ai.append(target)
                continue

        needs_ai.append(target)
        if target.key not in retrieval_by_key:
            retrieval_by_key[target.key] = build_retrieval_trace(
                target=target,
                pages=all_pages,
                max_pages=settings.ai_max_pages,
            )
            retrieval_by_key[target.key] = _with_retrieval_status(
                retrieval_by_key[target.key],
                deterministic_status="unresolved",
                ai_fallback_required=True,
            )

    resolved_keys = {result.target for result in scalars} | {
        result.target for result in tables
    }

    run_ai = bool(needs_ai and use_ai_fallback)
    session = ai_provider if isinstance(ai_provider, AIEnrichmentSession) else None
    if run_ai and session is not None:
        if not session.available:
            run_ai = False
        else:
            # Deterministic-first: AI is a rescue, considered only once the
            # deterministic result has been assessed as insufficient.
            sufficient, reason = assess_deterministic_sufficiency(
                database, document, requested=len(requested), resolved=len(resolved_keys)
            )
            if sufficient:
                session.mark_not_needed(reason)
                run_ai = False
    elif needs_ai and session is not None:
        session.mark_not_requested()
    elif use_ai_fallback and session is not None and requested:
        session.mark_not_needed("Deterministic extraction resolved every requested field.")

    if run_ai:
        batchable = [
            target
            for target in needs_ai
            if target.target_type not in _TABLE_LIKE_TYPES
        ]
        per_target = [
            target for target in needs_ai if target.target_type in _TABLE_LIKE_TYPES
        ]

        batched_scalars, batch_warnings = await _run_batched_scalar_ai_fallback(
            targets=batchable,
            retrieval_by_key=retrieval_by_key,
            all_pages=all_pages,
            page_lookup=page_lookup,
            document_name=document.original_filename,
            ai_provider=ai_provider,
            outline=outline,
        )
        scalars.extend(batched_scalars)
        warnings.extend(batch_warnings)
        resolved_keys.update(result.target for result in batched_scalars)

        semaphore = asyncio.Semaphore(_MAX_CONCURRENT_AI_CALLS)
        per_target_results = await asyncio.gather(
            *[
                _run_per_target_ai_fallback(
                    target=target,
                    retrieval=retrieval_by_key.get(target.key),
                    all_pages=all_pages,
                    page_lookup=page_lookup,
                    document_name=document.original_filename,
                    ai_provider=ai_provider,
                    semaphore=semaphore,
                    outline=outline,
                )
                for target in per_target
            ]
        )

        for result, target_warnings in per_target_results:
            warnings.extend(target_warnings)
            if result is None:
                continue
            if isinstance(result, TableTargetResult):
                tables.append(result)
            else:
                scalars.append(result)
            resolved_keys.add(result.target)

    still_unresolved: list[str] = list(unresolved)
    skipped_internal = 0
    for target in needs_ai:
        if target.key in resolved_keys:
            continue
        if is_internal_form_name(target.key) or is_internal_form_name(
            target.label or ""
        ):
            skipped_internal += 1
            continue
        still_unresolved.append(target.key)

    if skipped_internal:
        warnings.append(
            f"{skipped_internal} internal form field"
            f"{' was' if skipped_internal == 1 else 's were'} skipped "
            "because no readable value could be mapped."
        )

    return ExtractTargetsResponse(
        document_id=document.id,
        scalars=scalars,
        tables=tables,
        unresolved_targets=still_unresolved,
        warnings=warnings,
    )
