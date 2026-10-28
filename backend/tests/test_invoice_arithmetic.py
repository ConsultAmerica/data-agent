"""invoice@1 arithmetic checks must FAIL when the document doesn't add up
(the fixture suite only ever exercised the passing path). A failed check
makes the cell Needs Review; the stated value is never rewritten."""

from __future__ import annotations

from app.staging.profile import RawRecord
from app.staging.profiles.invoice_v1 import Assigned, Labeled, Scalars, _validate_totals


def _scalars(**values: str) -> Scalars:
    scalars = Scalars()
    for key, value in values.items():
        scalars.assigned[f"invoice.total.{key}"] = Assigned(value=value, provenance=None)
    return scalars


def _lines(*amounts: str) -> list[RawRecord]:
    return [RawRecord(record_id=f"line-{i}", values={"amount": a}) for i, a in enumerate(amounts)]


def _charge(kind: str, value: str) -> tuple[str, Labeled]:
    return kind, Labeled(label=kind, value=value, provenance=None, found_by="test")


def _failed(scalars: Scalars) -> dict[str, list[str]]:
    return {
        key: [c.check for c in assigned.checks if not c.passed]
        for key, assigned in scalars.assigned.items()
        if any(not c.passed for c in assigned.checks)
    }


def _qa(rows) -> dict[str, str]:
    return {check: result for check, result, _ in rows}


def test_consistent_invoice_passes_every_check() -> None:
    scalars = _scalars(subtotal="300.00", invoice_amount="324.00", amount_due="324.00")
    qa = _validate_totals(scalars, [_charge("tax", "24.00")], _lines("100.00", "200.00"))
    assert _failed(scalars) == {}
    assert set(_qa(qa).values()) == {"PASS"}


def test_lines_not_adding_up_to_subtotal_fails() -> None:
    scalars = _scalars(subtotal="310.00", invoice_amount="334.00")
    qa = _validate_totals(scalars, [_charge("tax", "24.00")], _lines("100.00", "200.00"))
    assert _failed(scalars) == {"invoice.total.subtotal": ["lines_vs_subtotal"]}
    assert _qa(qa)["Arithmetic: lines vs subtotal"] == "REVIEW"
    # The stated subtotal is kept as printed.
    assert scalars.assigned["invoice.total.subtotal"].value == "310.00"


def test_total_not_matching_subtotal_plus_charges_fails() -> None:
    scalars = _scalars(subtotal="300.00", invoice_amount="330.00")
    qa = _validate_totals(
        scalars, [_charge("tax", "24.00"), _charge("freight", "5.00")], _lines("100.00", "200.00")
    )
    assert _failed(scalars) == {"invoice.total.invoice_amount": ["total_arithmetic"]}
    assert _qa(qa)["Arithmetic: document total"] == "REVIEW"


def test_discount_is_subtracted() -> None:
    scalars = _scalars(subtotal="300.00", invoice_amount="294.00")
    _validate_totals(scalars, [_charge("tax", "24.00"), _charge("discount", "-30.00")], _lines())
    assert _failed(scalars) == {}


def test_amount_due_not_matching_total_minus_paid_fails() -> None:
    scalars = _scalars(invoice_amount="324.00", amount_paid="100.00", amount_due="324.00")
    qa = _validate_totals(scalars, [], [])
    assert _failed(scalars) == {"invoice.total.amount_due": ["amount_due_arithmetic"]}
    assert _qa(qa)["Arithmetic: amount due"] == "REVIEW"


def test_rounding_within_tolerance_passes_but_a_cent_per_line_more_does_not() -> None:
    within = _scalars(subtotal="300.01")
    _validate_totals(within, [], _lines("100.00", "200.00"))
    assert _failed(within) == {}

    beyond = _scalars(subtotal="300.05")
    _validate_totals(beyond, [], _lines("100.00", "200.00"))
    assert _failed(beyond) == {"invoice.total.subtotal": ["lines_vs_subtotal"]}


def test_missing_line_amount_skips_the_line_check_instead_of_guessing() -> None:
    scalars = _scalars(subtotal="999.00")
    qa = _validate_totals(scalars, [], _lines("100.00", ""))
    assert "Arithmetic: lines vs subtotal" not in _qa(qa)
    assert _failed(scalars) == {}
