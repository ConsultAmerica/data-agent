"""Review routing decisions from intelligence signals."""

from app.schemas.document_target import ScalarTargetResult
from app.schemas.extraction_intelligence import (
    ConfidenceDetail,
    ConfidenceSignals,
    RetrievalTrace,
    ValidationCheck,
    ValidationResult,
)
from app.services.review_routing import (
    REASON_AI_ESCALATION,
    REASON_AMBIGUOUS,
    REASON_LOW_CONFIDENCE,
    REASON_NO_SOURCE_EVIDENCE,
    REASON_NOT_SOURCE_GROUNDED,
    REASON_VALIDATION_FAILED,
    decide_review_for_scalar,
)


def _scalar(**overrides) -> ScalarTargetResult:
    defaults = {
        "target": "contract_number",
        "normalized_key": "contract_number",
        "value": "W912DR-26-C-0042",
        "page": 1,
        "confidence": 0.92,
        "confidence_band": "high",
        "verified": True,
        "extraction_method": "source_evidence",
        "display_method": "Native",
        "evidence": {
            "page_number": 1,
            "source_text": "Contract Number: W912DR-26-C-0042",
            "source_reference": "page 1",
        },
        "validation": ValidationResult(
            status="passed",
            checks=[ValidationCheck(type="format", status="passed")],
            warnings=[],
        ),
        "confidence_detail": ConfidenceDetail(
            score=0.92,
            band="high",
            signals=ConfidenceSignals(
                exact_label_match=True,
                label_proximity="strong",
                native_text=True,
                format_validation=True,
                source_grounded=True,
                corroborating_occurrences=1,
                ambiguity=False,
                ai_fallback=False,
            ),
        ),
        "retrieval": RetrievalTrace(
            target_key="contract_number",
            selected_pages=[1],
            deterministic_status="resolved",
            ai_fallback_required=False,
        ),
    }
    defaults.update(overrides)
    return ScalarTargetResult(**defaults)


def test_clean_high_confidence_is_ready_to_accept() -> None:
    decision = decide_review_for_scalar(_scalar())
    assert decision["status"] == "ready_to_accept"
    assert decision["priority"] == "high"
    assert decision["reasons"] == []
    assert decision["review_status"] == "pending"


def test_auto_accept_only_when_enabled() -> None:
    decision = decide_review_for_scalar(
        _scalar(), auto_accept_high_confidence=True
    )
    assert decision["review_status"] == "accepted"


def test_low_confidence_routes_to_needs_review() -> None:
    decision = decide_review_for_scalar(
        _scalar(confidence=0.4, confidence_band="low")
    )
    assert decision["status"] == "needs_review"
    assert REASON_LOW_CONFIDENCE in decision["reasons"]


def test_validation_failure_routes() -> None:
    decision = decide_review_for_scalar(
        _scalar(
            validation=ValidationResult(
                status="failed",
                checks=[ValidationCheck(type="format", status="failed")],
                warnings=["empty"],
            )
        )
    )
    assert REASON_VALIDATION_FAILED in decision["reasons"]


def test_ai_escalation_and_ambiguity_route() -> None:
    decision = decide_review_for_scalar(
        _scalar(
            extraction_method="ai",
            retrieval=RetrievalTrace(
                target_key="contract_number",
                selected_pages=[1, 2],
                deterministic_status="ambiguous",
                ai_fallback_required=True,
            ),
        )
    )
    assert REASON_AI_ESCALATION in decision["reasons"]
    assert REASON_AMBIGUOUS in decision["reasons"]


def test_ungrounded_routes() -> None:
    decision = decide_review_for_scalar(_scalar(verified=False))
    assert REASON_NOT_SOURCE_GROUNDED in decision["reasons"]


def test_value_without_source_page_needs_review_even_when_clean() -> None:
    no_page = {"page_number": 0, "source_text": "W912DR-26-C-0042", "source_reference": ""}
    decision = decide_review_for_scalar(
        _scalar(evidence=no_page), auto_accept_high_confidence=True
    )
    assert decision["status"] == "needs_review"
    assert REASON_NO_SOURCE_EVIDENCE in decision["reasons"]
    assert decision["review_status"] == "pending"
    assert decision["priority"] == "low"  # listed first in the queue


def test_value_without_source_text_needs_review() -> None:
    no_text = {"page_number": 3, "source_text": "  ", "source_reference": "page 3"}
    decision = decide_review_for_scalar(
        _scalar(evidence=no_text), auto_accept_high_confidence=True
    )
    assert decision["status"] == "needs_review"
    assert REASON_NO_SOURCE_EVIDENCE in decision["reasons"]
    assert decision["review_status"] == "pending"


def test_missing_evidence_is_never_stored_as_page_one() -> None:
    from app.services.target_result_store import _evidence_dict

    assert _evidence_dict(None)["page_number"] == 0
