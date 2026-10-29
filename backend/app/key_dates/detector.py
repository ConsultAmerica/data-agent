"""Find the dated events a document states about itself.

Sources (each result says which, with page and evidence):

* mrz — a passport / visa / ID-card machine-readable zone: expiry (and
  birth is ignored); confidence reflects the check digits.
* contract_schedule — period-of-performance ends from the contract's
  staged schedule (services/obligations.contract_period_ends).
* text — a date next to an expiry-type label ("Date of expiry", "Valid
  until", "Expires on", "Renewal date", "Termination date", "Period of
  performance … through …"), on the same line or the line below.

A date the document doesn't state is never inferred (no "issue + 10
years"). Every date keeps the text it was read from. A numeric date both of
whose readings are valid (03/04/2026) is ambiguous: it is resolved only by
the document's own context (its other, unambiguous numeric dates, or a US
federal form, month-first) and is otherwise flagged for review, never
silently decided.
"""

from __future__ import annotations

import calendar
import re
from dataclasses import dataclass, field
from datetime import date

from dateutil import parser as date_parser
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.document import Document
from app.models.document_page import DocumentPage
from app.validators.mrz import parse_mrz

EXTRACTOR_VERSION = "key-dates-v2"

KINDS = ("expiry", "valid_until", "renewal", "termination", "period_end", "due", "issue", "award", "effective", "start")
# Kinds that mean "the document (or what it grants) stops being valid".
EXPIRING_KINDS = {"expiry", "valid_until", "termination", "period_end"}

_LABELS: tuple[tuple[str, str], ...] = (
    ("expiry", r"date\s+of\s+expir(?:y|ation)|expir(?:y|ation)\s+date|expiration|expires?(?:\s+on)?|exp\.?\s+date|date\s+d'expiration"),
    ("valid_until", r"valid\s+(?:until|thru|through|to|till)|good\s+(?:until|through|thru)|validity\s+(?:date|period\s+ends?)|valid\s+up\s+to"),
    ("renewal", r"renewal\s+date|renews?\s+on|auto(?:matically)?[-\s]?renews?\s+on|next\s+renewal"),
    ("termination", r"termination\s+date|terminates?\s+on|end\s+of\s+(?:the\s+)?(?:agreement|contract|term)"),
    ("period_end", r"period\s+of\s+performance|contract\s+(?:end|completion)\s+date|end\s+date|completion\s+date|term\s+ends?"),
    ("due", r"due\s+date|payment\s+due|due\s+on"),
    ("issue", r"date\s+of\s+issue|issue\s+date|issued\s+on|date\s+issued"),
    ("award", r"award\s+date|date\s+of\s+award|awarded\s+on|date\s+awarded"),
    ("effective", r"effective\s+date|effective\s+(?:as\s+of|from|on)"),
    ("start", r"start\s+date|commencement\s+date|begin(?:ning)?\s+date|coverage\s+(?:start|begins)"),
)
_LABEL_RE = [(kind, re.compile(rf"(?<![A-Za-z])(?:{pattern})(?![A-Za-z])", re.I)) for kind, pattern in _LABELS]

_MONTH = r"(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?"
_DATE = re.compile(
    r"(?<!\d)(?:"
    r"\d{4}-\d{1,2}-\d{1,2}"                       # 2032-04-15
    r"|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}"             # 04/15/2032, 15.04.2032
    rf"|\d{{1,2}}[\s-]{_MONTH}(?:/[A-Za-zÀ-ÿ]+)?[\s,-]+\d{{2,4}}"  # 15 APR 2032, 15-Apr-32
    rf"|{_MONTH}\s+\d{{1,2}},?\s+\d{{4}}"           # April 15, 2032
    rf"|{_MONTH}\s+\d{{4}}"                         # April 2032
    r"|(?:0?[1-9]|1[0-2])/\d{2}(?!\d)"              # 08/27 (MM/YY, cards)
    r")",
    re.I,
)
_RANGE_SEP = re.compile(r"\s*(?:to|through|thru|until|-|–)\s*$", re.I)


@dataclass
class KeyDate:
    kind: str
    date: date
    label: str
    source: str
    page: int | None
    evidence: str | None
    confidence: float
    details: dict = field(default_factory=dict)


def parse_date_text(text: str, *, kind: str) -> tuple[date | None, float]:
    """(date, confidence). Month-year forms resolve to the month's last day
    for end-type kinds, its first day otherwise."""

    raw = re.sub(r"/[A-Za-zÀ-ÿ]+", "", text.strip())  # bilingual "AUG/AOUT"
    month_year = re.fullmatch(rf"({_MONTH})\s+(\d{{4}})", raw, re.I)
    mm_yy = re.fullmatch(r"(0?[1-9]|1[0-2])/(\d{2})", raw)
    try:
        if month_year or mm_yy:
            if month_year:
                month = date_parser.parse(f"1 {month_year.group(1)} 2000").month
                year = int(month_year.group(2))
            else:
                month, year = int(mm_yy.group(1)), 2000 + int(mm_yy.group(2))
            day = calendar.monthrange(year, month)[1] if kind in EXPIRING_KINDS or kind == "due" else 1
            return date(year, month, day), 0.7
        numeric = re.fullmatch(r"(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})", raw)
        dayfirst = bool(numeric) and (int(numeric.group(1)) > 12 or "." in raw)
        parsed = date_parser.parse(raw, dayfirst=dayfirst, fuzzy=False).date()
        return parsed, 0.9
    except (ValueError, OverflowError):
        return None, 0.0


_NUMERIC = re.compile(r"(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})")


def numeric_readings(text: str) -> tuple[date | None, date | None]:
    """(month-first, day-first) readings of a d/d/y date; None where a
    reading isn't a real date. Non-numeric forms give (None, None)."""

    match = _NUMERIC.fullmatch(text.strip())
    if not match:
        return None, None
    a, b, year = int(match.group(1)), int(match.group(2)), int(match.group(3))
    if year < 100:
        year += 2000
    readings: list[date | None] = []
    for month, day in ((a, b), (b, a)):
        try:
            readings.append(date(year, month, day))
        except ValueError:
            readings.append(None)
    return readings[0], readings[1]


def is_ambiguous(text: str) -> bool:
    """Both readings are valid and differ (03/04/2026; not 04/04/2026 or
    25/04/2026). A dotted date (15.04.2026) is day-first by convention."""

    if "." in text:
        return False
    month_first, day_first = numeric_readings(text)
    return month_first is not None and day_first is not None and month_first != day_first


def document_convention(lines: list[tuple[int, str]]) -> str | None:
    """"month_first" or "day_first" when the document's unambiguous numeric
    dates all point one way; None when they don't say or disagree."""

    seen: set[str] = set()
    for _, text in lines:
        for match in _NUMERIC.finditer(text):
            a, b = int(match.group(1)), int(match.group(2))
            if a > 12 >= b:
                seen.add("day_first")
            elif b > 12 >= a:
                seen.add("month_first")
    return seen.pop() if len(seen) == 1 else None


def _from_mrz(lines: list[tuple[int, str]]) -> list[KeyDate]:
    compact = [(page, re.sub(r"\s+", "", text).upper()) for page, text in lines]
    found = []
    for start in range(len(compact)):
        for size in (3, 2):
            block = compact[start:start + size]
            if len(block) < size or len({p for p, _ in block}) != 1:
                continue
            if not all(re.fullmatch(r"[A-Z0-9<]{28,46}", t) and "<" in t for _, t in block):
                continue
            parsed = parse_mrz("\n".join(t for _, t in block))
            if parsed is None:
                continue
            expiry = parsed.expiry_date()
            if expiry is not None:
                kind_name = {"P": "Passport", "V": "Visa", "I": "Identity card", "A": "Identity card", "C": "Identity card"}.get(
                    (parsed.document_code or "?")[0], "Travel document"
                )
                found.append(KeyDate(
                    "expiry", expiry, f"{kind_name} expiry (machine-readable zone)", "mrz", block[0][0],
                    "\n".join(t for _, t in block), 0.99 if parsed.check_digits_valid else 0.6,
                    {"document_code": parsed.document_code, "check_digits_valid": parsed.check_digits_valid},
                ))
            return found
    return found


def _text_details(original: str) -> dict:
    details: dict = {"original_text": original.strip()}
    if is_ambiguous(original):
        month_first, day_first = numeric_readings(original)
        details.update(ambiguous=True, interpretations=[month_first.isoformat(), day_first.isoformat()])
    return details


def _from_text(lines: list[tuple[int, str]]) -> list[KeyDate]:
    found: list[KeyDate] = []
    for index, (page, text) in enumerate(lines):
        for kind, label_re in _LABEL_RE:
            for label in label_re.finditer(text):
                after = text[label.end():label.end() + 80]
                candidates = [(m, text) for m in _DATE.finditer(after)][:2]
                if not candidates and index + 1 < len(lines) and lines[index + 1][0] == page:
                    nxt = lines[index + 1][1]
                    candidates = [(m, nxt) for m in _DATE.finditer(nxt[:80])][:1]
                if not candidates:
                    continue
                match, source_line = candidates[0]
                evidence = (text if source_line is text else f"{text}\n{source_line}").strip()[:400]
                # "Period of performance: 01/01/2026 through 12/31/2026" → the end,
                # and the range's first date is the period's start.
                if len(candidates) > 1 and kind in ("period_end", "valid_until") and candidates[1][1] is text:
                    between = after[candidates[0][0].end():candidates[1][0].start()]
                    if _RANGE_SEP.fullmatch(between):
                        first = candidates[0][0].group(0)
                        start, start_confidence = parse_date_text(first, kind="start")
                        if start is not None:
                            found.append(KeyDate("start", start, f"{label.group(0).strip()} (start)", "text", page,
                                                 evidence, start_confidence, _text_details(first)))
                        match = candidates[1][0]
                parsed, confidence = parse_date_text(match.group(0), kind=kind)
                if parsed is None:
                    continue
                found.append(KeyDate(kind, parsed, label.group(0).strip(), "text", page, evidence, confidence,
                                     _text_details(match.group(0))))
                break  # one label match per kind per line
    return found


def _page_lines(database: Session, document: Document) -> list[tuple[int, str]]:
    rows = database.execute(
        select(DocumentPage.page_number, DocumentPage.final_text)
        .where(DocumentPage.document_id == document.id)
        .order_by(DocumentPage.page_number)
    ).all()
    return [(number, line.strip()) for number, text in rows for line in (text or "").splitlines() if line.strip()]


def detect_key_dates(database: Session, document: Document, *, profile_id: str | None = None) -> list[KeyDate]:
    lines = _page_lines(database, document)
    dates = _from_mrz(lines)
    if profile_id == "contract_v3":
        from app.services.obligations import contract_period_ends

        for end in contract_period_ends(database, document.id):
            dates.append(KeyDate(
                "period_end", end["date"], end["label"], "contract_schedule", end["page"], end["evidence"],
                0.85, {"option": end["is_option"]},
            ))
    dates.extend(_from_text(lines))
    # Ambiguous numeric dates: resolved only by the document's own context.
    convention = document_convention(lines)
    context = "document_dates" if convention else None
    if convention is None and profile_id == "contract_v3":
        convention, context = "month_first", "us_federal_form"
    for item in dates:
        if not item.details.get("ambiguous") or convention is None:
            continue
        month_first, day_first = numeric_readings(item.details["original_text"])
        chosen = month_first if convention == "month_first" else day_first
        if chosen is not None:
            item.date = chosen
            item.details = {**item.details, "ambiguous": False, "resolved_by": context, "convention": convention}
    # One entry per (kind, date): the most trusted source wins.
    rank = {"mrz": 0, "contract_schedule": 1, "text": 2}
    best: dict[tuple[str, date], KeyDate] = {}
    for item in sorted(dates, key=lambda d: (rank.get(d.source, 9), -d.confidence)):
        best.setdefault((item.kind, item.date), item)
    return sorted(best.values(), key=lambda d: (d.date, KINDS.index(d.kind)))
