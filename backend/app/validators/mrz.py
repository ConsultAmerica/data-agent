"""ICAO Doc 9303 machine-readable zone parsing and check digits.

Supports TD3 (passports, 2 × 44), TD2 (2 × 36) and TD1 (ID cards, 3 × 30).
Returns the fields exactly as printed plus one result per check digit;
it never corrects a character. A passing MRZ is internally consistent —
not proof the document is genuine.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date

_WEIGHTS = (7, 3, 1)
_MRZ_LINE = re.compile(r"^[A-Z0-9<]+$")


def char_value(char: str) -> int:
    if char.isdigit():
        return int(char)
    if "A" <= char <= "Z":
        return ord(char) - ord("A") + 10
    if char == "<":
        return 0
    raise ValueError(f"not an MRZ character: {char!r}")


def check_digit(data: str) -> int:
    return sum(char_value(c) * _WEIGHTS[i % 3] for i, c in enumerate(data)) % 10


def _digit_ok(data: str, digit: str) -> bool:
    if digit == "<":
        # An all-filler optional field may carry "<" as its check digit.
        return set(data) <= {"<"}
    return digit.isdigit() and check_digit(data) == int(digit)


@dataclass
class MrzCheck:
    name: str
    passed: bool


@dataclass
class MrzResult:
    format: str  # TD1 | TD2 | TD3
    document_code: str
    issuing_state: str
    surname: str
    given_names: str
    document_number: str
    nationality: str
    birth_date_raw: str
    sex: str
    expiry_date_raw: str
    optional_data: str
    checks: list[MrzCheck] = field(default_factory=list)

    @property
    def check_digits_valid(self) -> bool:
        return all(check.passed for check in self.checks)

    def birth_date(self, today: date | None = None) -> date | None:
        return parse_mrz_date(self.birth_date_raw, kind="birth", today=today)

    def expiry_date(self, today: date | None = None) -> date | None:
        return parse_mrz_date(self.expiry_date_raw, kind="expiry", today=today)


def parse_mrz_date(raw: str, *, kind: str, today: date | None = None) -> date | None:
    """YYMMDD → date. Birth dates are never in the future (so a year above
    today's two-digit year is 19xx); expiry dates are read as 20xx unless
    that is more than 50 years ahead."""

    if not re.fullmatch(r"\d{6}", raw or ""):
        return None
    today = today or date.today()
    yy, mm, dd = int(raw[:2]), int(raw[2:4]), int(raw[4:])
    if kind == "birth":
        year = 2000 + yy if 2000 + yy <= today.year else 1900 + yy
    else:
        year = 2000 + yy if 2000 + yy <= today.year + 50 else 1900 + yy
    try:
        return date(year, mm, dd)
    except ValueError:
        return None


def _names(field_text: str) -> tuple[str, str]:
    surname, _, given = field_text.partition("<<")
    return surname.replace("<", " ").strip(), given.replace("<", " ").strip()


def _clean_lines(text: str) -> list[str]:
    lines = [re.sub(r"\s+", "", line).upper() for line in (text or "").splitlines()]
    return [line for line in lines if line]


def parse_mrz(text: str) -> MrzResult | None:
    """Parse an MRZ block (lines separated by newlines). None when the
    lines don't have a supported MRZ shape."""

    lines = _clean_lines(text)
    if not lines or not all(_MRZ_LINE.match(line) for line in lines):
        return None
    shape = (len(lines), {len(line) for line in lines})
    if shape == (2, {44}):
        return _parse_td3(*lines)
    if shape == (2, {36}):
        return _parse_td2(*lines)
    if shape == (3, {30}):
        return _parse_td1(*lines)
    return None


def _parse_td3(l1: str, l2: str) -> MrzResult:
    surname, given = _names(l1[5:44])
    result = MrzResult(
        format="TD3",
        document_code=l1[0:2].replace("<", ""),
        issuing_state=l1[2:5],
        surname=surname,
        given_names=given,
        document_number=l2[0:9].replace("<", ""),
        nationality=l2[10:13],
        birth_date_raw=l2[13:19],
        sex=l2[20],
        expiry_date_raw=l2[21:27],
        optional_data=l2[28:42].replace("<", ""),
    )
    result.checks = [
        MrzCheck("document_number", _digit_ok(l2[0:9], l2[9])),
        MrzCheck("birth_date", _digit_ok(l2[13:19], l2[19])),
        MrzCheck("expiry_date", _digit_ok(l2[21:27], l2[27])),
        MrzCheck("optional_data", _digit_ok(l2[28:42], l2[42])),
        MrzCheck("composite", _digit_ok(l2[0:10] + l2[13:20] + l2[21:43], l2[43])),
    ]
    return result


def _parse_td2(l1: str, l2: str) -> MrzResult:
    surname, given = _names(l1[5:36])
    result = MrzResult(
        format="TD2",
        document_code=l1[0:2].replace("<", ""),
        issuing_state=l1[2:5],
        surname=surname,
        given_names=given,
        document_number=l2[0:9].replace("<", ""),
        nationality=l2[10:13],
        birth_date_raw=l2[13:19],
        sex=l2[20],
        expiry_date_raw=l2[21:27],
        optional_data=l2[28:35].replace("<", ""),
    )
    result.checks = [
        MrzCheck("document_number", _digit_ok(l2[0:9], l2[9])),
        MrzCheck("birth_date", _digit_ok(l2[13:19], l2[19])),
        MrzCheck("expiry_date", _digit_ok(l2[21:27], l2[27])),
        MrzCheck("composite", _digit_ok(l2[0:10] + l2[13:20] + l2[21:35], l2[35])),
    ]
    return result


def _parse_td1(l1: str, l2: str, l3: str) -> MrzResult:
    surname, given = _names(l3)
    result = MrzResult(
        format="TD1",
        document_code=l1[0:2].replace("<", ""),
        issuing_state=l1[2:5],
        surname=surname,
        given_names=given,
        document_number=l1[5:14].replace("<", ""),
        nationality=l2[15:18],
        birth_date_raw=l2[0:6],
        sex=l2[7],
        expiry_date_raw=l2[8:14],
        optional_data=(l1[15:30] + l2[18:29]).replace("<", ""),
    )
    result.checks = [
        MrzCheck("document_number", _digit_ok(l1[5:14], l1[14])),
        MrzCheck("birth_date", _digit_ok(l2[0:6], l2[6])),
        MrzCheck("expiry_date", _digit_ok(l2[8:14], l2[14])),
        MrzCheck("composite", _digit_ok(l1[5:30] + l2[0:7] + l2[8:15] + l2[18:29], l2[29])),
    ]
    return result
