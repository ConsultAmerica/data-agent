"""Automatic review routing from extraction intelligence signals.

Does not invent new durable status values beyond the existing
pending/accepted/edited/rejected/unknown set. Fresh extracts stay
``pending`` (needs human governance) unless auto-accept is enabled for
clean high-confidence fields. Reasons are persisted for the Review Queue.
"""

from __future__ import annotations

from typing import Any, Literal

from app.schemas.document_target import ScalarTargetResult
from app.services.evidence_text import source_text_of

ReviewDecisionStatus = Literal["needs_review", "ready_to_accept"]
# Queue order, not urgency: the review queue sorts ascending
# (api/dashboard.py), so "low" — failed validation, ambiguity, low
# confidence, no evidence — is listed FIRST and "high" (clean, ready to
# accept) last. Stored on every field; don't flip the meaning without
# migrating existing rows.
ReviewPriority = Literal["high", "medium", "low"]

REASON_LOW_CONFIDENCE = "low_confidence"
REASON_VALIDATION_FAILED = "validation_failed"
REASON_NOT_SOURCE_GROUNDED = "not_source_grounded"
REASON_AMBIGUOUS = "ambiguous_candidates"
REASON_AI_ESCALATION = "ai_escalation"
REASON_UNRESOLVED_METHOD = "unresolved_or_weak_method"
REASON_EXTRACTION_DIFFERS = "extraction_differs_from_reviewed"
REASON_NO_SOURCE_EVIDENCE = "no_source_evidence"


def has_source_evidence(evidence: Any) -> bool:
    """A source page (>= 1) and the source text the value was read from."""

    if evidence is None:
        return False
    page = getattr(evidence, "page_number", None)
    text = (getattr(evidence, "source_text", None) or "").strip()
    return isinstance(page, int) and page >= 1 and bool(text)


def decide_review_for_scalar(
    scalar: ScalarTargetResult,
    *,
    auto_accept_high_confidence: bool = False,
) -> dict[str, Any]:
    """Return a review_decision dict stored on evidence_json."""

    reasons: list[str] = []

    band = (scalar.confidence_band or "medium").lower()
    if band == "low" or (scalar.confidence is not None and scalar.confidence < 0.6):
        reasons.append(REASON_LOW_CONFIDENCE)

    validation = scalar.validation
    if validation is not None and validation.status == "failed":
        reasons.append(REASON_VALIDATION_FAILED)
    elif scalar.validation_status == "failed":
        reasons.append(REASON_VALIDATION_FAILED)

    if not scalar.verified:
        reasons.append(REASON_NOT_SOURCE_GROUNDED)

    retrieval = scalar.retrieval
    if retrieval is not None:
        if retrieval.deterministic_status == "ambiguous":
            reasons.append(REASON_AMBIGUOUS)
        if retrieval.ai_fallback_required or scalar.extraction_method == "ai":
            reasons.append(REASON_AI_ESCALATION)

    detail = scalar.confidence_detail
    if detail is not None and detail.signals.ambiguity:
        if REASON_AMBIGUOUS not in reasons:
            reasons.append(REASON_AMBIGUOUS)
    if detail is not None and detail.signals.ai_fallback:
        if REASON_AI_ESCALATION not in reasons:
            reasons.append(REASON_AI_ESCALATION)

    evidence = scalar.evidence
    review_hint = getattr(evidence, "review_status", None) if evidence else None
    if review_hint == "needs_review" and REASON_AMBIGUOUS not in reasons:
        reasons.append(REASON_AMBIGUOUS)

    if not has_source_evidence(evidence):
        reasons.append(REASON_NO_SOURCE_EVIDENCE)

    if not reasons and band == "medium":
        # Medium stays in queue for spot-check but is "ready_to_accept".
        decision_status: ReviewDecisionStatus = "ready_to_accept"
        priority: ReviewPriority = "medium"
    elif not reasons and band == "high":
        decision_status = "ready_to_accept"
        priority = "high"
    else:
        decision_status = "needs_review"
        if (
            REASON_VALIDATION_FAILED in reasons
            or REASON_AMBIGUOUS in reasons
            or REASON_NO_SOURCE_EVIDENCE in reasons
            or band == "low"
        ):
            priority = "low"
        elif REASON_AI_ESCALATION in reasons:
            priority = "medium"
        else:
            priority = "medium"

    review_status = "pending"
    if (
        auto_accept_high_confidence
        and decision_status == "ready_to_accept"
        and priority == "high"
        and scalar.verified
    ):
        review_status = "accepted"

    return {
        "status": decision_status,
        "priority": priority,
        "reasons": reasons,
        "review_status": review_status,
    }


def human_reason_labels(reasons: list[str]) -> list[str]:
    labels = {
        REASON_LOW_CONFIDENCE: "Low confidence",
        REASON_VALIDATION_FAILED: "Validation failed",
        REASON_NOT_SOURCE_GROUNDED: "Not source-grounded",
        REASON_AMBIGUOUS: "Ambiguous candidates",
        REASON_AI_ESCALATION: "AI escalation",
        REASON_UNRESOLVED_METHOD: "Weak extraction method",
        REASON_EXTRACTION_DIFFERS: "New extraction differs from reviewed value",
    }
    return [labels.get(reason, reason) for reason in reasons]


# Same bar as the frontend's batch filter (lib/documents.ts
# isLowRiskQueueField, HIGH_BAND_MIN in lib/confidence-policy.ts).
LOW_RISK_MIN_CONFIDENCE = 0.85


def low_risk_blockers(field: Any) -> list[str]:
    """Why a pending field must not be accepted in bulk (empty = may be).

    Bulk accept is for values nothing flagged: high confidence, no
    routing reasons, real source evidence, validation not failed.
    """

    blockers: list[str] = []
    evidence = field.evidence_json if isinstance(field.evidence_json, dict) else {}
    confidence = field.confidence or 0.0
    if confidence > 1:
        confidence /= 100
    if confidence < LOW_RISK_MIN_CONFIDENCE:
        blockers.append(REASON_LOW_CONFIDENCE)
    decision = evidence.get("review_decision") or {}
    blockers.extend(r for r in decision.get("reasons") or [] if r not in blockers)
    if decision.get("status") == "needs_review" and not decision.get("reasons"):
        blockers.append("needs_review")
    page = evidence.get("page_number")
    text = source_text_of(evidence).strip()
    if not (isinstance(page, int) and page >= 1 and text):
        if REASON_NO_SOURCE_EVIDENCE not in blockers:
            blockers.append(REASON_NO_SOURCE_EVIDENCE)
    if evidence.get("validation_status") == "failed" and REASON_VALIDATION_FAILED not in blockers:
        blockers.append(REASON_VALIDATION_FAILED)
    return blockers
