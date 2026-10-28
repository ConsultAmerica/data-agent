"""Deterministic validators against published reference vectors.

MRZ specimens are ICAO Doc 9303's own (fictional "UTO" Utopia documents);
no real identity or banking data is used.
"""

from datetime import date
from decimal import Decimal

import pytest

from app.validators.amounts import amounts_agree, written_amount
from app.validators.checksums import (
    aba_prefix_plausible,
    aba_routing_valid,
    iban_valid,
    luhn_valid,
    npi_valid,
)
from app.validators.mrz import check_digit, parse_mrz, parse_mrz_date

TD3 = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C36UTO7408122F1204159ZE184226B<<<<<10"
TD2 = "I<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<\nD231458907UTO7408122F1204159<<<<<<<6"
TD1 = (
    "I<UTOD231458907<<<<<<<<<<<<<<<\n"
    "7408122F1204159UTO<<<<<<<<<<<6\n"
    "ERIKSSON<<ANNA<MARIA<<<<<<<<<<"
)


@pytest.mark.parametrize(("text", "fmt", "number"), [(TD3, "TD3", "L898902C3"), (TD2, "TD2", "D23145890"), (TD1, "TD1", "D23145890")])
def test_icao_specimens_parse_and_pass_every_check(text, fmt, number) -> None:
    result = parse_mrz(text)
    assert result is not None
    assert result.format == fmt
    assert result.document_number == number
    assert (result.surname, result.given_names) == ("ERIKSSON", "ANNA MARIA")
    assert result.issuing_state == "UTO" and result.nationality == "UTO"
    assert result.sex == "F"
    assert result.birth_date() == date(1974, 8, 12)
    assert result.expiry_date() == date(2012, 4, 15)
    assert result.check_digits_valid


def test_check_digit_reference_values() -> None:
    assert check_digit("L898902C3") == 6
    assert check_digit("740812") == 2
    assert check_digit("120415") == 9


@pytest.mark.parametrize("position", range(0, 9))
def test_any_altered_document_number_character_fails(position: int) -> None:
    line1, line2 = TD3.split("\n")
    original = line2[position]
    # Shift the character's MRZ value by one. (Not any substitution: the
    # algorithm can't see a change by a multiple of 10 at weight 1, e.g.
    # "3" -> "X" (33) — a known limit of ICAO check digits.)
    replacement = str((int(original) + 1) % 10) if original.isdigit() else chr(ord(original) + 1)
    altered = line2[:position] + replacement + line2[position + 1:]
    result = parse_mrz(f"{line1}\n{altered}")
    assert result is not None
    failed = {check.name for check in result.checks if not check.passed}
    assert "document_number" in failed and "composite" in failed


def test_altered_birth_date_fails_its_digit_and_composite() -> None:
    line1, line2 = TD3.split("\n")
    altered = line2[:13] + "740813" + line2[19:]
    failed = {c.name for c in parse_mrz(f"{line1}\n{altered}").checks if not c.passed}
    assert failed == {"birth_date", "composite"}


@pytest.mark.parametrize(
    "text",
    ["", "not an mrz", "P<UTO\nL898", TD3.replace("<", "#"), TD3 + "\nEXTRA"],
)
def test_unsupported_shapes_are_not_parsed(text: str) -> None:
    assert parse_mrz(text) is None


def test_mrz_dates_infer_century_and_reject_impossible_dates() -> None:
    today = date(2026, 10, 26)
    assert parse_mrz_date("990101", kind="birth", today=today) == date(1999, 1, 1)
    assert parse_mrz_date("250101", kind="birth", today=today) == date(2025, 1, 1)
    assert parse_mrz_date("300101", kind="expiry", today=today) == date(2030, 1, 1)
    assert parse_mrz_date("990231", kind="birth", today=today) is None
    assert parse_mrz_date("99A101", kind="birth", today=today) is None


@pytest.mark.parametrize(("routing", "valid"), [("011000015", True), ("021000021", True), ("021000022", False), ("02100002", False), ("02100002A", False)])
def test_aba_routing_checksum(routing: str, valid: bool) -> None:
    assert aba_routing_valid(routing) is valid


def test_aba_prefix_ranges() -> None:
    assert aba_prefix_plausible("021000021")
    assert aba_prefix_plausible("261000000")
    assert not aba_prefix_plausible("501000000")


@pytest.mark.parametrize(
    ("iban", "valid"),
    [
        ("GB82 WEST 1234 5698 7654 32", True),
        ("DE89370400440532013000", True),
        ("GB82WEST12345698765433", False),  # one digit off
        ("GB82WEST123456987654", False),  # wrong length for GB
        ("XX", False),
    ],
)
def test_iban(iban: str, valid: bool) -> None:
    assert iban_valid(iban) is valid


def test_luhn_and_npi() -> None:
    assert luhn_valid("79927398713")
    assert not luhn_valid("79927398710")
    assert npi_valid("1234567893")  # CMS's published example
    assert not npi_valid("1234567890")
    assert not npi_valid("123456789")


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("One thousand two hundred thirty-four and 56/100 dollars", Decimal("1234.56")),
        ("Five hundred dollars and fifty six cents", Decimal("500.56")),
        ("Twelve and xx/100", Decimal("12")),
        ("Two million three hundred thousand and 00/100", Decimal("2300000")),
        ("***Ninety-nine and 99/100***", Decimal("99.99")),
    ],
)
def test_written_amounts(text: str, expected: Decimal) -> None:
    assert written_amount(text) == expected


def test_unreadable_written_amount_is_none_not_zero() -> None:
    assert written_amount("lorem ipsum") is None
    assert written_amount("") is None
    assert amounts_agree("12.00", "lorem ipsum") is None


def test_numeric_and_written_amounts_agree_or_not() -> None:
    assert amounts_agree("$1,234.56", "One thousand two hundred thirty-four and 56/100") is True
    assert amounts_agree("1,243.56", "One thousand two hundred thirty-four and 56/100") is False
