"""V3 All Fields must not ask reviewers to approve non-values.

Cases come from the SF1442 award N4019223D2803: section headings with their
first sub-paragraph marker ("REQUIRED INSURANCE" -> "a."), the next form
label under a heading ("ACCOUNTING AND APPROPRIATION DATA" -> "ITEM",
"UNITED STATES OF AMERICA" -> "BY"), and a noun as a person's name
("Contracting Officer's Representative" -> "Officials").
"""

from types import SimpleNamespace

import pytest

from app.services.all_fields_builder import association_is_defensible, build_all_fields, not_a_value
from app.services.contract_summary_fields import validate_value


@pytest.mark.parametrize("value", ["a.", "(b)", "iv.", "xii)", "1.", "12)", "ITEM", "BY", "Signature", "Date:"])
def test_non_values_are_dropped(value):
    assert not_a_value(value) is not None


@pytest.mark.parametrize(
    "value",
    [
        "N/A",  # "not applicable" is information; it goes to a reviewer
        "See Item 7",
        "10",
        "$600,000,000.00",
        "ACQR5858342",
        "Doris.Castro@fe.navy.mil",
        "671-339-8465",
        "civil.",  # made of Roman-numeral letters, but a word
        "By and through its agent",
        "Specified on task order",
    ],
)
def test_real_values_are_kept(value):
    assert not_a_value(value) is None


def test_person_names_need_two_parts():
    assert not validate_value("contracting_officer_name", "Officials").is_valid
    assert validate_value("contracting_officer_name", "DORIS CASTRO").is_valid
    assert validate_value("contracting_officer_name", "Doris A. Castro").is_valid
    assert not association_is_defensible("Contracting Officer's Representative", "Officials")


def _candidate(label: str, value: str):
    return SimpleNamespace(
        category="GENERAL_ACCEPTED_FIELD", label=label, value=value, confidence=0.85,
        reason_codes=[], source_page=1, evidence=f"{label} {value}", region_type="FORM_FIELD_VALUE",
        extraction_method="native", bbox=None, x0=None, y0=None, x1=None, y1=None,
    )


def test_builder_keeps_values_and_skips_markers_and_chrome(monkeypatch):
    monkeypatch.setattr("app.services.all_fields_builder.evidence_bbox", lambda candidate: {})
    rows = build_all_fields(
        document=SimpleNamespace(id="d1"),
        candidates=[
            _candidate("REQUIRED INSURANCE", "a."),
            _candidate("ACCOUNTING AND APPROPRIATION DATA", "ITEM"),
            _candidate("UNITED STATES OF AMERICA", "BY"),
            _candidate("REQUISITION/PURCHASE REQUEST NO.", "ACQR5858342"),
            _candidate("CALENDAR DAYS", "10"),
            _candidate("ORDER NUMBER", "N/A"),
        ],
    )
    assert [(row.label, row.value) for row in rows] == [
        ("REQUISITION/PURCHASE REQUEST NO.", "ACQR5858342"),
        ("CALENDAR DAYS", "10"),
        ("ORDER NUMBER", "N/A"),
    ]
