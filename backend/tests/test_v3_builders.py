"""Unit tests for the V3 dataset builders (backend/app/services/*_builder.py)
that turn ClassifiedCandidate/ParsedClinRow/ClauseCitation-shaped input into
the canonical V3 rows. Builders are pure functions (no DB) except
`build_clause_references`, which needs a session for FAR Master enrichment.
"""

from types import SimpleNamespace

import pytest

from app.database.session import SessionLocal
from app.models.far_master_clause import FarMasterClause
from app.schemas.candidate_classification import ClassifiedCandidate
from app.services.all_fields_builder import build_all_fields
from app.services.attachment_builder import build_attachments
from app.services.clause_builder import build_clause_references
from app.services.clin_builder import build_clins
from app.services.clin_block_detector import ParsedClinRow
from app.services.contract_summary_builder import build_contract_summary
from app.services.funding_builder import build_funding_lines
from app.services.performance_delivery_builder import build_performance_delivery
from app.services.qa_review_builder import build_qa_review


def _document(document_id: str = "doc-1", filename: str = "Contract.pdf"):
    return SimpleNamespace(id=document_id, original_filename=filename)


def _candidate(**overrides) -> ClassifiedCandidate:
    defaults = dict(
        category="GENERAL_ACCEPTED_FIELD",
        confidence=0.8,
        reason_codes=[],
        source_page=3,
        evidence="Some evidence text",
        region_type="FORM_FIELD_VALUE",
        label="A Label",
        value="A Value",
        extraction_method="native",
    )
    defaults.update(overrides)
    return ClassifiedCandidate(**defaults)


def _page(page_number: int, text: str):
    return SimpleNamespace(page_number=page_number, final_text=text, tables_json=None)


# --- all_fields_builder ---


def test_build_all_fields_keeps_general_accepted_fields_only():
    candidates = [
        _candidate(category="GENERAL_ACCEPTED_FIELD", label="Place of Performance", value="Guam"),
        _candidate(category="STRUCTURAL_HEADING", label="B.8", value="heading text"),
        _candidate(category="NOISE", label=None, value=None),
    ]
    rows = build_all_fields(document=_document(), candidates=candidates)
    assert len(rows) == 1
    assert rows[0].label == "Place of Performance"
    assert rows[0].value == "Guam"
    assert rows[0].extraction_source == "v3"


def test_build_all_fields_deduplicates_identical_label_value_pairs():
    candidates = [
        _candidate(label="X", value="Y", source_page=1),
        _candidate(label="X", value="Y", source_page=5),
    ]
    rows = build_all_fields(document=_document(), candidates=candidates)
    assert len(rows) == 1


def test_build_all_fields_drops_candidates_with_no_value():
    candidates = [_candidate(value=None)]
    rows = build_all_fields(document=_document(), candidates=candidates)
    assert rows == []


def test_weak_form_associations_are_not_verified():
    candidates = [
        _candidate(label="UNITED STATES OF AMERICA", value="SIGN", confidence=0.9),
        _candidate(
            label="NAME OF CONTRACTING OFFICER (Type or print)",
            value="UNITED STATES",
            confidence=0.9,
        ),
        _candidate(
            label="CHECK IF REMITTANCE ADDRESS IS",
            value="SUCH ADDRESS IN SCHEDULE.",
            confidence=0.9,
        ),
        _candidate(label="Email", value="paul.lewis.16@us.af.mil", confidence=0.9),
    ]
    rows = build_all_fields(document=_document(), candidates=candidates)
    by_label = {row.label: (row.evidence_json or {})["qa_status"] for row in rows}
    # Pure form chrome ("SIGN", "UNITED STATES") is never stored as a value,
    # so a reviewer is never asked to approve it.
    assert "UNITED STATES OF AMERICA" not in by_label
    assert "NAME OF CONTRACTING OFFICER (Type or print)" not in by_label
    # Doubtful but possibly real pairs still go to a reviewer.
    assert by_label["CHECK IF REMITTANCE ADDRESS IS"] == "Needs Review"
    assert by_label["Email"] == "Verified"


# --- clin_builder ---


def test_build_clins_maps_parsed_rows_and_marks_undefined_quantity():
    rows = [
        ParsedClinRow(
            clin="0001",
            description="Base period supplies",
            quantity="UNDEFINED",
            unit="Each",
            unit_price=None,
            amount="0.00",
            psc="1234",
            pricing_arrangement="NTE",
            base_option="Option 1",
            page_number=3,
            source_text="0001 Base period supplies ...",
            confidence=0.9,
            parent_line_item=None,
            relationship=None,
            reason_codes=["matched_detected_table_row"],
        )
    ]
    built = build_clins(document=_document(), clin_rows=rows)
    assert len(built) == 1
    row = built[0]
    assert row.clin == "0001"
    assert row.max_quantity_text == "UNDEFINED"
    assert row.quantity is None  # never coerced to 0
    assert row.amount == 0.0
    assert row.qa_status == "Verified"


def test_build_clins_preserves_slin_hierarchy_internally():
    rows = [
        ParsedClinRow(
            clin="0001AA", description=None, quantity=None, unit=None,
            unit_price=None, amount=None, psc=None, pricing_arrangement=None,
            base_option=None, page_number=1, source_text="0001AA ...",
            confidence=0.7, parent_line_item="0001", relationship="SLIN",
        )
    ]
    built = build_clins(document=_document(), clin_rows=rows)
    assert built[0].parent_line_item == "0001"
    assert built[0].relationship == "SLIN"


# --- funding_builder ---


def test_build_funding_lines_classifies_task_order_narrative():
    candidates = [
        _candidate(
            category="FUNDING",
            evidence="Funds are obligated only upon issuance of a task order.",
            confidence=0.55,
        )
    ]
    rows = build_funding_lines(document=_document(), candidates=candidates)
    assert len(rows) == 1
    assert rows[0].funding_level == "Task Orders"
    assert rows[0].qa_status == "Needs Review"


def test_build_funding_lines_extracts_dollar_amount():
    candidates = [
        _candidate(category="FUNDING", evidence="Obligated Amount: $2,500.00", confidence=0.9)
    ]
    rows = build_funding_lines(document=_document(), candidates=candidates)
    assert rows[0].amount == 2500.00
    assert rows[0].qa_status == "Verified"


# --- clause_builder (needs a DB session for FAR Master lookup) ---


@pytest.fixture
def db_session():
    session = SessionLocal()
    session.execute(
        __import__("sqlalchemy").delete(FarMasterClause).where(
            FarMasterClause.far_number == "52.204-21"
        )
    )
    session.add(
        FarMasterClause(
            far_number="52.204-21",
            far_record_id="FAR-52.204-21",
            official_display_title="52.204-21 Basic Safeguarding of Covered Contractor Information Systems",
            record_type="Clause",
            effective_date="Nov 2021",
            prescribed_in="4.1903",
            has_alternates=False,
            clause_title="Basic Safeguarding of Covered Contractor Information Systems",
        )
    )
    session.commit()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


def test_build_clause_references_matches_far_master(db_session):
    candidates = [
        _candidate(
            category="CLAUSE",
            regulation="FAR",
            clause_number="52.204-21",
            label="52.204-21",
            value="Basic Safeguarding of Covered Contractor Information Systems (Nov 2021)",
            evidence="52.204-21 Basic Safeguarding of Covered Contractor Information Systems (Nov 2021)",
            confidence=0.9,
            reason_codes=["classification_basis_explicit_listing"],
        )
    ]
    rows = build_clause_references(database=db_session, document=_document(), candidates=candidates)
    assert len(rows) == 1
    assert rows[0].far_master_match_status == "matched"
    assert rows[0].qa_status == "Verified"
    assert rows[0].citation_context == "listing"


def test_build_clause_references_flags_unmatched_far_number(db_session):
    candidates = [
        _candidate(
            category="CLAUSE", regulation="FAR", clause_number="52.999-99",
            label="52.999-99", value="Not a real clause",
            evidence="52.999-99 Not a real clause", confidence=0.9,
        )
    ]
    rows = build_clause_references(database=db_session, document=_document(), candidates=candidates)
    assert rows[0].far_master_match_status == "not_found"
    assert rows[0].qa_status == "Needs Review"


def test_build_clause_references_dfars_has_no_master_lookup(db_session):
    candidates = [
        _candidate(
            category="DFARS", regulation="DFARS", clause_number="252.216-7002",
            label="252.216-7002", value="Alternate A", evidence="252.216-7002 Alternate A",
            confidence=0.9,
        )
    ]
    rows = build_clause_references(database=db_session, document=_document(), candidates=candidates)
    assert rows[0].far_master_match_status == "not_applicable"
    assert rows[0].clause_family == "DFARS"


def test_build_clause_references_incidental_routes_as_far_reference(db_session):
    candidates = [
        _candidate(
            category="FAR_REFERENCE", regulation="FAR", clause_number="52.219-14",
            label="52.219-14", value=None,
            evidence="in accordance with FAR 52.219-14", confidence=0.8,
        )
    ]
    rows = build_clause_references(database=db_session, document=_document(), candidates=candidates)
    assert rows[0].citation_context == "incidental"
    assert rows[0].contract_clause == "No"


# --- performance_delivery_builder ---


def test_build_performance_delivery_classifies_record_type():
    candidates = [
        _candidate(
            category="PERFORMANCE_DELIVERY",
            evidence="The period of performance is 5 years from 01/01/2025 to 12/31/2029.",
            confidence=0.7,
        )
    ]
    rows = build_performance_delivery(document=_document(), candidates=candidates)
    assert rows[0].record_type == "Period of Performance"
    assert rows[0].start_date == "01/01/2025"
    assert rows[0].end_timing == "12/31/2029"


def test_build_performance_delivery_widens_truncated_evidence_to_full_sentence():
    # Quality-gate regression: a NARRATIVE region's captured text is an
    # arbitrary fixed-width window, not sentence-bounded — the regression
    # contract produced mid-sentence fragments like "will not be awarded a
    # full ten year period of performance. Each award made after the
    # initial" as `requirement`. Given the source page's full text, the
    # builder must widen to the complete containing sentence.
    page = SimpleNamespace(
        page_number=32,
        final_text=(
            "Contracts awarded after the initial award date, resulting from an "
            "on-ramp/open solicitation period, will not be awarded a full ten "
            "year period of performance. Each award made after the initial "
            "contract awards will have a base period of no more than five years."
        ),
    )
    candidates = [
        _candidate(
            category="PERFORMANCE_DELIVERY",
            evidence="will not be awarded a full ten year period of performance. Each award made after the",
            confidence=0.55,
            source_page=32,
        )
    ]
    rows = build_performance_delivery(document=_document(), candidates=candidates, pages=[page])
    # Widened to the full sentence(s) actually containing the evidence
    # window — no mid-sentence truncation on either end.
    assert rows[0].requirement.startswith(
        "Contracts awarded after the initial award date"
    )
    assert rows[0].requirement.rstrip().endswith("five years.")


def test_build_performance_delivery_flags_unresolved_cross_reference():
    # Quality-gate regression: "See Section F.3, Period of Performance, for
    # ..." is a pointer to a value stated elsewhere in the document, not a
    # resolved performance value itself — must never be presented as if it
    # were one.
    candidates = [
        _candidate(
            category="PERFORMANCE_DELIVERY",
            evidence="See Section F.3, Period of Performance, for the OASIS+ SB IDIQ and task orders.",
            confidence=0.55,
            source_page=15,
        )
    ]
    rows = build_performance_delivery(document=_document(), candidates=candidates)
    assert rows[0].qa_status == "Needs Review"
    assert "unresolved_cross_reference" in rows[0].evidence_json["reason_codes"]


# --- attachment_builder ---


def test_build_attachments_parses_reference_and_portfolio_status():
    candidates = [
        _candidate(
            category="ATTACHMENT",
            evidence="Attachment J-1 OASIS+ Labor Categories remains with the executed contract.",
            confidence=0.55,
        )
    ]
    rows = build_attachments(document=_document(), candidates=candidates)
    assert "J-1" in rows[0].attachment_reference
    assert rows[0].included_in_portfolio == "Yes"


# --- contract_summary_builder ---


def test_build_contract_summary_maps_form_candidates_and_narrative():
    candidates = [
        _candidate(
            category="CONTRACT_SUMMARY",
            label="CONTRACT NUMBER",
            value="47QRCA25DSF07",
            reason_codes=["field_key_contract_number"],
            source_page=2,
            evidence="2. CONTRACT NUMBER -> 47QRCA25DSF07",
            confidence=0.95,
        )
    ]
    pages = [
        _page(1, "GSA OASIS+ MAC Program Small Business IDIQ"),
        _page(
            45,
            "OASIS+ has a five year base period of performance with one option "
            "period of five years that may extend the cumulative term of the "
            "contract to ten years.",
        ),
    ]
    summary = build_contract_summary(document=_document(), pages=pages, candidates=candidates)
    assert summary.contract_number == "47QRCA25DSF07"
    assert summary.contract_vehicle is not None
    assert summary.base_period == "5 years"
    assert "option period" in (summary.options or "")


# --- qa_review_builder ---


def test_build_qa_review_pass_when_all_verified():
    document = _document()
    rows = build_qa_review(
        document=document,
        contract_summary=SimpleNamespace(qa_status="Verified"),
        clins=[SimpleNamespace(qa_status="Verified")],
        funding=[],
        performance_delivery=[],
        attachments=[],
        clause_references=[],
    )
    by_check = {row.qa_check: row for row in rows}
    assert by_check["Contract Summary"].result == "PASS"
    assert by_check["CLINs"].result == "PASS"
    assert by_check["Funding"].result == "PASS"  # empty is OK for Funding


def test_build_qa_review_flags_review_when_needs_review_present():
    document = _document()
    rows = build_qa_review(
        document=document,
        contract_summary=None,
        clins=[SimpleNamespace(qa_status="Needs Review"), SimpleNamespace(qa_status="Verified")],
        funding=[],
        performance_delivery=[],
        attachments=[],
        clause_references=[],
    )
    by_check = {row.qa_check: row for row in rows}
    assert by_check["CLINs"].result == "REVIEW"
    assert "1 of 2" in by_check["CLINs"].details
