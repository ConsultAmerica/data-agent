"""Written (legal) amounts on cheques → numbers, for numeric/written
consistency. English only; returns None rather than guessing."""

from __future__ import annotations

import re
from decimal import Decimal

_UNITS = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
    "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16,
    "seventeen": 17, "eighteen": 18, "nineteen": 19,
}
_TENS = {
    "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60,
    "seventy": 70, "eighty": 80, "ninety": 90,
}
_SCALES = {"thousand": 1_000, "million": 1_000_000, "billion": 1_000_000_000}
_FILLER = {"and", "dollars", "dollar", "only", "exactly", "usd", "no", "cents", "cent"}


def _words_to_int(words: list[str]) -> int | None:
    total, current, seen = 0, 0, False
    for word in words:
        if word in _UNITS:
            current += _UNITS[word]
        elif word in _TENS:
            current += _TENS[word]
        elif word == "hundred":
            current = (current or 1) * 100
        elif word in _SCALES:
            total += (current or 1) * _SCALES[word]
            current = 0
        elif word in _FILLER:
            continue
        else:
            return None
        seen = True
    return total + current if seen else None


def written_amount(text: str) -> Decimal | None:
    """'One thousand two hundred thirty-four and 56/100 dollars' → 1234.56.
    Cents may be written as NN/100, 'xx/100' (none), or in words + cents."""

    if not text or not text.strip():
        return None
    lowered = text.lower().replace("-", " ").replace(",", " ")
    lowered = re.sub(r"\*+", " ", lowered)
    cents = Decimal(0)
    fraction = re.search(r"(\d{1,2}|xx|no)\s*/\s*100", lowered)
    if fraction:
        token = fraction.group(1)
        cents = Decimal(0) if token in {"xx", "no"} else Decimal(int(token)) / 100
        lowered = lowered[: fraction.start()] + lowered[fraction.end():]
    else:
        # "... dollars and fifty six cents"
        split = re.split(r"\b(?:dollars?|usd)\b", lowered, maxsplit=1)
        if len(split) == 2 and re.search(r"\bcents?\b", split[1]):
            cent_words = re.findall(r"[a-z]+", split[1])
            cent_value = _words_to_int(cent_words)
            if cent_value is None or cent_value > 99:
                return None
            cents = Decimal(cent_value) / 100
            lowered = split[0]
    words = re.findall(r"[a-z]+", lowered)
    whole = _words_to_int(words)
    if whole is None:
        return None
    return Decimal(whole) + cents


def amounts_agree(numeric: str | float | Decimal, written: str) -> bool | None:
    """True/False when both sides parse; None when either can't be read
    (that is a review item, not a mismatch)."""

    value = written_amount(written)
    if value is None:
        return None
    try:
        number = Decimal(re.sub(r"[^\d.]", "", str(numeric)))
    except Exception:  # noqa: BLE001 - unreadable numeric amount
        return None
    return abs(number - value) < Decimal("0.005")
