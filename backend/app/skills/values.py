"""Reading printed values as dates and amounts — for checks only. A value
is never rewritten: what the document prints is what is shown and
exported; these parsers only say whether it reads as its type."""

from __future__ import annotations

from datetime import date, datetime
import re

_DATE_FORMATS = (
    "%m/%d/%Y", "%m/%d/%y", "%m-%d-%Y", "%Y-%m-%d", "%Y/%m/%d", "%d %b %Y", "%d %B %Y", "%b %d, %Y", "%B %d, %Y",
    "%b %d %Y", "%B %d %Y", "%d-%b-%Y", "%d-%b-%y", "%d.%m.%Y", "%Y%m%d", "%d %b %y",
)
_DATE_IN_TEXT = re.compile(
    r"\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{2,4}|"
    r"[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}-[A-Za-z]{3}-\d{2,4})\b"
)
_MONEY = re.compile(r"^\(?-?\s*(?:[A-Z]{3}\s*)?[$€£¥]?\s*-?\s*\d[\d,]*(?:\.\d+)?\s*(?:[A-Z]{3})?\)?$")


def parse_date(text: str | None) -> date | None:
    value = (text or "").strip().rstrip(".,;")
    if not value:
        return None
    value = re.sub(r"\s+", " ", value.replace(".", " ") if re.search(r"[A-Za-z]{3}\.", value) else value)
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            continue
    return None


def dates_in(text: str | None) -> list[tuple[str, date]]:
    """Every date written in a text, in order: ("07/01/2025 - 06/30/2026")."""

    found = []
    for match in _DATE_IN_TEXT.finditer(text or ""):
        parsed = parse_date(match.group(1))
        if parsed:
            found.append((match.group(1), parsed))
    return found


def parse_money(text: str | None) -> float | None:
    value = (text or "").strip()
    if not value or not _MONEY.match(value):
        return None
    negative = value.startswith("(") or "-" in value
    digits = re.sub(r"[^\d.]", "", value)
    if not digits or digits.count(".") > 1:
        return None
    number = float(digits)
    return -number if negative else number


def normalized(text: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (text or "").lower()).strip()
