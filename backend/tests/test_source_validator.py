"""Grounding. Strict mode (AI-produced values): accepted only when the
value can be read from its source. Default mode (deterministic
extractors) keeps its original behaviour — they read values out of the
text they quote."""

import pytest

from app.services.source_validator import validate_source_value, value_supported_by

PAGE = (
    "Contract Number: W912DR-26-C-0042\n"
    "Minimum guarantee $2,500.00 Ceiling 1,250,000\n"
    "Award date March 1, 2026"
)


@pytest.mark.parametrize(
    ("value", "quote"),
    [
        ("W912DR-26-C-0042", "Contract Number: W912DR-26-C-0042"),
        ("W912DR26C0042", "Contract Number: W912DR-26-C-0042"),  # compacted id
        ("2500.00", "Minimum guarantee $2,500.00"),  # normalized money
        (2500, "Minimum guarantee $2,500.00"),
        ("2026-03-01", "Award date March 1, 2026"),  # normalized date
        ("W912DR-26-C-0042", ""),  # no quote: value itself on page
    ],
)
def test_grounded_values_pass(value, quote) -> None:
    assert validate_source_value(strict=True, value=value, source_text=quote, page_text=PAGE)


def test_quote_on_page_does_not_ground_a_different_value() -> None:
    # Previously passed: the quote was on the page, the value was not.
    assert not validate_source_value(
        strict=True,
        value="9,999.00", source_text="Minimum guarantee $2,500.00", page_text=PAGE
    )


def test_quote_not_on_page_fails_even_if_value_is() -> None:
    assert not validate_source_value(
        strict=True,
        value="W912DR-26-C-0042", source_text="an invented quote", page_text=PAGE
    )


def test_list_values_need_a_real_quote_and_every_element() -> None:
    quote = "Minimum guarantee $2,500.00 Ceiling 1,250,000"
    assert validate_source_value(strict=True, value=["2500", "1250000"], source_text=quote, page_text=PAGE)
    assert not validate_source_value(strict=True, value=["2500", "7777"], source_text=quote, page_text=PAGE)
    # Previously any non-empty quote passed without looking at the page.
    assert not validate_source_value(strict=True, value=["2500"], source_text="not on page", page_text=PAGE)
    assert not validate_source_value(strict=True, value=[], source_text=quote, page_text=PAGE)


def test_dict_values_check_every_leaf() -> None:
    quote = "Minimum guarantee $2,500.00 Ceiling 1,250,000"
    assert validate_source_value(
        strict=True,
        value={"minimum": "2500.00", "ceiling": 1250000, "note": None},
        source_text=quote,
        page_text=PAGE,
    )
    assert not validate_source_value(
        strict=True,
        value={"minimum": "2500.00", "ceiling": "999"}, source_text=quote, page_text=PAGE
    )


def test_identifier_digits_are_not_matched_as_numbers() -> None:
    assert not value_supported_by("W912DR", "total 912")
    assert not value_supported_by("A1", "line 1")


def test_none_and_blank_values_are_never_grounded() -> None:
    assert not validate_source_value(strict=True, value=None, source_text="", page_text=PAGE)
    assert not validate_source_value(strict=True, value="  ", source_text="", page_text=PAGE)


def test_default_mode_keeps_deterministic_behaviour() -> None:
    page = "CONTRACT NO:\n\n     MSA-2024-117\n52.232-8 DATE"
    # A synthesized "label: value" snippet whose parts sit in separate cells.
    assert validate_source_value(value="MSA-2024-117", source_text="CONTRACT NO: MSA-2024-117", page_text=page)
    # A normalized value ("FAR " prefix) grounded by its quote.
    assert validate_source_value(value="FAR 52.232-8", source_text="52.232-8 DATE", page_text=page)
    # Strict mode refuses the second: the value as written is not in the source.
    assert not validate_source_value(strict=True, value="FAR 52.232-8", source_text="52.232-8 DATE", page_text=page)
