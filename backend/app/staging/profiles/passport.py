"""passport@1 — passport (and other ICAO travel document) data pages.

Two independent readings of the same document are compared:

* the visual inspection zone (VIZ): printed labels ("Surname / Nom",
  "Date of expiry") with the value on the line below, in columns;
* the machine-readable zone (MRZ), parsed and check-digit validated by
  app/validators/mrz.py.

Every field shows both readings and whether they agree; a disagreement or
a failed check digit makes the values Needs Review. Values are never
corrected. Passing checks mean the document is internally consistent —
not that it is genuine (no external verification is performed).
"""

from __future__ import annotations

import difflib
import re
import unicodedata
from dataclasses import dataclass
from datetime import date

from dateutil import parser as date_parser
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.document import Document
from app.models.document_page import DocumentPage
from app.source_structure.service import document_page_words
from app.staging.models import ExportCapability, ValidationCheck
from app.staging.profile import (
    SOURCE_SHEET,
    AdapterResult,
    DatasetDefinition,
    ExportSheet,
    FieldDefinition,
    RawRecord,
    Recognition,
    StagingProfile,
)
from app.staging.provenance import make_provenance
from app.validators.mrz import MrzResult, parse_mrz, parse_mrz_date

F = FieldDefinition

# How close an expiry must be to read as "expiring" (days).
EXPIRING_WITHIN_DAYS = 180

PASSPORT_DATA = DatasetDefinition(
    dataset_id="passport_data",
    display_name="Passport Data",
    cardinality="repeating",
    description="Each field as printed on the data page and as encoded in the machine-readable zone.",
    identity_fields=("passport.field.name",),
    fields=(
        F("passport.field.name", "field", "Field", grounding="none"),
        F("passport.field.printed", "printed", "Printed (visual zone)"),
        F("passport.field.mrz", "mrz", "Machine-readable zone", grounding="derived"),
        F("passport.field.consistency", "consistency", "Consistency", grounding="none"),
    ),
)

MRZ_CHECKS = DatasetDefinition(
    dataset_id="mrz_checks",
    display_name="MRZ Validation",
    cardinality="repeating",
    description="ICAO 9303 check digits and date validity. Internal consistency only — not proof of authenticity.",
    identity_fields=("passport.check.name",),
    fields=(
        F("passport.check.name", "check", "Check", grounding="none"),
        F("passport.check.result", "result", "Result", grounding="none"),
        F("passport.check.details", "details", "Details", grounding="none"),
    ),
)

VALIDITY = DatasetDefinition(
    dataset_id="validity",
    display_name="Validity",
    cardinality="single",
    description="Document dates and whether it is still valid on the processing date.",
    fields=(
        F("passport.validity.status", "status", "Status", grounding="none"),
        F("passport.validity.expiry_date", "expiry_date", "Date of Expiry", "date", expected=True, grounding="derived"),
        F("passport.validity.days_remaining", "days_remaining", "Days Remaining", "integer", grounding="none"),
        F("passport.validity.issue_date", "issue_date", "Date of Issue", "date", grounding="derived"),
        F("passport.validity.mrz_format", "mrz_format", "MRZ Format", grounding="none"),
    ),
)

QA_REVIEW = DatasetDefinition(
    dataset_id="qa_review",
    display_name="Review",
    cardinality="repeating",
    role="qa",
    identity_fields=("qa.check", "qa.details"),
    fields=(
        F("qa.check", "qa_check", "Check", grounding="none"),
        F("qa.result", "result", "Result", grounding="none"),
        F("qa.details", "details", "Details", grounding="none"),
        F("qa.action", "action", "Action", grounding="none"),
    ),
)

# --- visual zone vocabulary --------------------------------------------------------------

# field key → (display label, label phrases; bilingual labels are split on "/")
VIZ_LABELS: dict[str, tuple[str, tuple[str, ...]]] = {
    "document_type": ("Type", ("type",)),
    "issuing_state": ("Issuing State", ("code of issuing state", "issuing state code", "country code", "code")),
    "document_number": ("Passport No.", ("passport no", "passport no.", "passport number", "document no", "document number", "no du passeport", "no. du passeport")),
    "surname": ("Surname", ("surname", "surnames", "last name", "nom")),
    "given_names": ("Given Names", ("given names", "given name", "first name", "prenoms", "prénoms")),
    "nationality": ("Nationality", ("nationality", "nationalite", "nationalité")),
    "birth_date": ("Date of Birth", ("date of birth", "birth date", "date de naissance")),
    "sex": ("Sex", ("sex", "sexe")),
    "birth_place": ("Place of Birth", ("place of birth", "lieu de naissance")),
    "issue_date": ("Date of Issue", ("date of issue", "issue date", "date de delivrance", "date de délivrance")),
    "authority": ("Authority", ("authority", "issuing authority", "autorite", "autorité")),
    "expiry_date": ("Date of Expiry", ("date of expiry", "expiry date", "expiration date", "date d'expiration", "date of expiration")),
}

_PHRASES = sorted(
    ((phrase, key) for key, (_, phrases) in VIZ_LABELS.items() for phrase in phrases),
    key=lambda item: -len(item[0].split()),
)

# Fields compared across the two zones, in display order.
COMPARED = (
    ("document_number", "document_number"),
    ("surname", "surname"),
    ("given_names", "given_names"),
    ("nationality", "nationality"),
    ("birth_date", "birth_date_raw"),
    ("sex", "sex"),
    ("expiry_date", "expiry_date_raw"),
    ("issuing_state", "issuing_state"),
    ("document_type", "document_code"),
)
PRINTED_ONLY = ("birth_place", "issue_date", "authority")

_MRZ_LINE = re.compile(r"^[A-Z0-9<]{28,46}$")


@dataclass
class _Line:
    page: int
    words: list
    method: str

    @property
    def text(self) -> str:
        return " ".join(w.text for w in self.words)

    @property
    def bbox(self) -> tuple[float, float, float, float]:
        return (min(w.x0 for w in self.words), min(w.y0 for w in self.words),
                max(w.x1 for w in self.words), max(w.y1 for w in self.words))


@dataclass
class _Reading:
    value: str
    line: _Line
    bbox: tuple[float, float, float, float]


def _lines(pages) -> list[_Line]:
    lines: list[_Line] = []
    for number, words, method in pages:
        current: list = []
        for word in sorted(words, key=lambda w: ((w.y0 + w.y1) / 2, w.x0)):
            height = max(1.0, word.y1 - word.y0)
            if current and abs((current[-1].y0 + current[-1].y1) / 2 - (word.y0 + word.y1) / 2) > height * 0.5:
                lines.append(_Line(number, sorted(current, key=lambda w: w.x0), method))
                current = []
            current.append(word)
        if current:
            lines.append(_Line(number, sorted(current, key=lambda w: w.x0), method))
    return lines


def _fold(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c)).lower()


def _label_spans(line: _Line, phrases=None) -> list[tuple[int, int, str]]:
    """(first word, last word, field key) for each VIZ label on the line.

    Longer labels also match when OCR garbled a letter or two ("Sumame",
    "Date af Issue", "Oate of Expy"); short ones ("Sex", "DL", "4b.") must
    match exactly, or values would be read as labels."""

    phrases = _PHRASES if phrases is None else phrases
    tokens = [re.sub(r"[^\w.'/]", "", _fold(w.text)) for w in line.words]
    spans, i = [], 0
    while i < len(tokens):
        for phrase, key in phrases:
            parts = phrase.split()
            window = [t.rstrip(":") for t in tokens[i:i + len(parts)]]
            if len(window) != len(parts):
                continue
            if window != parts and not _fuzzy_label(window, parts):
                continue
            end = i + len(parts) - 1
            # Swallow a bilingual continuation ("/ Nom", "/Nom").
            while end + 1 < len(tokens) and (tokens[end + 1].startswith("/") or tokens[end].endswith("/")):
                end += 1
            if not any(s[2] == key for s in spans):
                spans.append((i, end, key))
            i = end
            break
        i += 1
    return spans


_FUZZY_MIN_CHARS = 6
_FUZZY_RATIO = 0.75
# Each word must still resemble its counterpart ("th" for "birth", "af"
# for "of"), so "date of issue" never reads as "date of birth".
_FUZZY_WORD_RATIO = 0.5


def _fuzzy_label(window: list[str], parts: list[str]) -> bool:
    phrase = "".join(parts)
    if len(phrase) < _FUZZY_MIN_CHARS or not all(re.fullmatch(r"[a-z]+", t) for t in window):
        return False
    # Every word must be close, not only the whole: "date of birth" is not
    # "date of issue".
    return all(
        difflib.SequenceMatcher(None, a, b).ratio() >= _FUZZY_WORD_RATIO for a, b in zip(window, parts)
    ) and difflib.SequenceMatcher(None, "".join(window), phrase).ratio() >= _FUZZY_RATIO


def _words_box(words) -> tuple[float, float, float, float]:
    return (min(w.x0 for w in words), min(w.y0 for w in words),
            max(w.x1 for w in words), max(w.y1 for w in words))


def _looks_like_labels(words) -> bool:
    """Title Case words with no digits ("Tracking Number") read as labels;
    document values are capitals or carry digits ("DOE", "D1234567")."""

    texts = [w.text.strip(":/ ") for w in words if w.text.strip(":/ ")]
    return bool(texts) and all(
        re.fullmatch(r"[A-Z][a-z]+", t) or re.fullmatch(r"[a-z]{2,}", t) for t in texts
    ) and any(re.fullmatch(r"[A-Z][a-z]+", t) for t in texts)


def _is_label_line(line: _Line, spans) -> bool:
    """Mostly labels (values on the line below), unless a label is followed
    by a colon and a value ("Surname: DOE")."""

    labelled = sum(end - start + 1 for start, end, _ in spans)
    colon_after_label = any(
        line.words[end].text.rstrip().endswith(":") and end + 1 < len(line.words) for _, end, _ in spans
    )
    return labelled >= len(line.words) * 0.6 and not colon_after_label


def _read_viz(lines: list[_Line], phrases=None) -> dict[str, _Reading]:
    """Pairs labels with values in two passes.

    1. Column values: under each label of a label line, the words of the
       next line that start in that label's column (bounded by the next
       word on the label line, so "Date of birth  Citizenship Number" does
       not take both values).
    2. Same-line values ("DL D1234567", "Surname: DOE"): the words after a
       label up to the next label — only words pass 1 didn't already give
       to a column — and, when there are none, the value under the label.
    """

    readings: dict[str, _Reading] = {}
    spans_by_line = [_label_spans(line, phrases) for line in lines]
    label_word_ids = {
        id(word)
        for line, spans in zip(lines, spans_by_line)
        for start, end, _ in spans
        for word in line.words[start:end + 1]
    }
    used: set[int] = set()

    def take(key: str, words, line: _Line) -> None:
        words = [w for w in words if w.text.strip(":/ ") and id(w) not in used and id(w) not in label_word_ids]
        if not words or key in readings:
            return
        used.update(id(w) for w in words)
        readings[key] = _Reading(" ".join(w.text for w in words).strip(": "), line, _words_box(words))

    def column_value(index: int, span) -> None:
        # Geometry of the label words themselves: OCR can merge rows into
        # one "line" around a tall title, so the line's box is no guide.
        line = lines[index]
        start, end, key = span
        label = line.words[start:end + 1]
        lx0, lx1 = min(w.x0 for w in label), max(w.x1 for w in label)
        ly0, ly1 = min(w.y0 for w in label), max(w.y1 for w in label)
        height = max(1.0, ly1 - ly0)
        middle = (ly0 + ly1) / 2
        # The column ends at the next word on the label's own row.
        right = min(
            (w.x0 for w in line.words if w.x0 > lx1 and abs((w.y0 + w.y1) / 2 - middle) <= height),
            default=float("inf"),
        )
        below = [
            w
            for candidate in lines[index:index + 4]
            if candidate.page == line.page
            for w in candidate.words
            if w.y0 > middle and w.y0 - ly1 <= height * 3
            and lx0 - height <= w.x0 < right - height * 0.5
            and id(w) not in used and id(w) not in label_word_ids
        ]
        if below:
            top = min(w.y0 for w in below)
            row = sorted((w for w in below if w.y0 - top <= height), key=lambda w: w.x0)
            take(key, row, next(c for c in lines[index:index + 4] if row[0] in c.words))

    for index, (line, spans) in enumerate(zip(lines, spans_by_line)):
        if spans and _is_label_line(line, spans):
            for span in spans:
                column_value(index, span)
    for index, (line, spans) in enumerate(zip(lines, spans_by_line)):
        if not spans or _is_label_line(line, spans):
            continue
        for position, (_, end, key) in enumerate(spans):
            if key in readings:
                continue
            stop = spans[position + 1][0] if position + 1 < len(spans) else len(line.words)
            after = line.words[end + 1:stop]
            if _looks_like_labels(after):
                # "Date of Expiry  Tracking Number  Booklet Number": labels
                # this profile doesn't know; the value is below.
                column_value(index, spans[position])
            take(key, after, line)
            if key not in readings:
                column_value(index, spans[position])
    # A label line with nothing under it: its values may follow the labels.
    for line, spans in zip(lines, spans_by_line):
        if spans and _is_label_line(line, spans):
            for position, (_, end, key) in enumerate(spans):
                if key not in readings:
                    stop = spans[position + 1][0] if position + 1 < len(spans) else len(line.words)
                    take(key, line.words[end + 1:stop], line)
    return readings


def _find_mrz(lines: list[_Line]) -> tuple[MrzResult, list[_Line]] | None:
    compact = [re.sub(r"\s+", "", line.text).upper() for line in lines]
    for start in range(len(lines)):
        for size in (3, 2):
            block = compact[start:start + size]
            if len(block) < size or not all(_MRZ_LINE.match(b) and "<" in b for b in block):
                continue
            parsed = parse_mrz("\n".join(block))
            if parsed is not None:
                return parsed, lines[start:start + size]
    return None


def _viz_date(text: str, kind: str, today: date) -> date | None:
    cleaned = re.sub(r"/\s*[A-Za-zÀ-ÿ]+", "", text)  # "12 AUG/AOÛT 74" -> "12 AUG 74"
    cleaned = re.sub(r"[^\w .\-]", " ", cleaned).strip()
    match = re.fullmatch(r"(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{2})", cleaned)
    if match:  # two-digit year: same century rule as the MRZ
        try:
            month = date_parser.parse(f"1 {match.group(2)} 2000").month
        except (ValueError, OverflowError):
            return None
        return parse_mrz_date(f"{match.group(3)}{month:02d}{int(match.group(1)):02d}", kind=kind, today=today)
    try:
        return date_parser.parse(cleaned, dayfirst=True, fuzzy=False).date()
    except (ValueError, OverflowError):
        return None


def _letters(text: str) -> str:
    return re.sub(r"[^A-Z]", "", _fold(text).upper())


def _compare(key: str, printed: str | None, mrz: str | None, today: date) -> tuple[str, bool | None, str | None]:
    """(consistency label, agrees?, message). None = not comparable."""

    if printed is None and mrz is None:
        return "Not found", None, None
    if printed is None:
        return "Only in MRZ", None, None
    if mrz is None:
        return "Only printed", None, None
    if key in ("birth_date", "expiry_date"):
        kind = "birth" if key == "birth_date" else "expiry"
        a, b = _viz_date(printed, kind, today), parse_mrz_date(mrz, kind=kind, today=today)
        if a is None or b is None:
            return "Not comparable", None, "The printed date could not be read as a date."
        return ("Match", True, None) if a == b else ("Mismatch", False, f"Printed {a.isoformat()} but the MRZ encodes {b.isoformat()}.")
    if key in ("surname", "given_names"):
        viz, enc = _letters(printed), _letters(mrz)
        # The MRZ may truncate long names and transliterate (Ä → A or AE).
        variants = {viz, _letters(printed.replace("Ä", "AE").replace("Ö", "OE").replace("Ü", "UE"))}
        if enc in variants or any(v.startswith(enc) and len(enc) >= 3 for v in variants):
            return "Match", True, None
        return "Mismatch", False, f"Printed '{printed}' but the MRZ encodes '{mrz}'."
    if key == "sex":
        a, b = printed.strip()[:1].upper(), mrz.strip()[:1].upper().replace("<", "X")
        return ("Match", True, None) if a == b else ("Mismatch", False, f"Printed '{printed}' but the MRZ encodes '{mrz}'.")
    if key in ("nationality", "issuing_state") and not re.fullmatch(r"[A-Za-z<]{3}", printed.strip()):
        return "Not comparable", None, "The printed value is a name, the MRZ a country code."
    if re.sub(r"[\s<]", "", printed).upper() == re.sub(r"[\s<]", "", mrz).upper():
        return "Match", True, None
    return "Mismatch", False, f"Printed '{printed}' but the MRZ encodes '{mrz}'."


def _mrz_display(key: str, raw: str | None, today: date) -> str | None:
    if raw is None:
        return None
    if key in ("birth_date", "expiry_date"):
        parsed = parse_mrz_date(raw, kind="birth" if key == "birth_date" else "expiry", today=today)
        return parsed.isoformat() if parsed else raw
    if key == "sex":
        return {"<": "unspecified"}.get(raw, raw)
    return raw or None


def _pages(database: Session, document: Document):
    return document_page_words(database, document)


def adapt_passport(database: Session, document: Document, *, today: date | None = None) -> AdapterResult:
    today = today or date.today()
    lines = _lines(_pages(database, document))
    viz = _read_viz(lines)
    found = _find_mrz(lines)
    mrz, mrz_lines = found if found else (None, [])

    def provenance(reading: _Reading | None, lines_used: list[_Line], kind: str):
        if reading is not None:
            return make_provenance(
                document, page=reading.line.page, evidence=reading.line.text, bbox=reading.bbox,
                extraction_method=f"{reading.line.method}:{kind}",
            )
        if lines_used:
            boxes = [line.bbox for line in lines_used]
            return make_provenance(
                document, page=lines_used[0].page, evidence="\n".join(line.text for line in lines_used),
                bbox=(min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)),
                extraction_method=f"{lines_used[0].method}:{kind}",
            )
        return None

    data_records: list[RawRecord] = []
    qa_messages: list[tuple[str, str, str]] = []
    for key, attr in COMPARED:
        printed = viz.get(key)
        raw = getattr(mrz, attr, None) if mrz else None
        if attr in ("birth_date_raw", "expiry_date_raw", "sex") and raw is not None and not str(raw).strip("<"):
            raw = None
        consistency, agrees, message = _compare(key, printed.value if printed else None, raw, today)
        checks: dict[str, list[ValidationCheck]] = {}
        if agrees is False:
            failed = [ValidationCheck(check="viz_mrz_consistency", passed=False, message=message)]
            checks = {"printed": failed, "mrz": list(failed)}
            qa_messages.append((f"Consistency: {VIZ_LABELS[key][0]}", "REVIEW", message or ""))
        if key == "document_number" and mrz is not None:
            digit = next(c for c in mrz.checks if c.name == "document_number")
            if not digit.passed:
                checks.setdefault("mrz", []).append(
                    ValidationCheck(check="mrz_check_digit", passed=False, message="Document number check digit fails.")
                )
        data_records.append(
            RawRecord(
                record_id=f"field:{key}",
                values={
                    "field": VIZ_LABELS[key][0],
                    "printed": printed.value if printed else None,
                    "mrz": _mrz_display(key, raw, today),
                    "consistency": consistency,
                },
                cell_provenance={
                    k: p for k, p in (
                        ("printed", provenance(printed, [], "visual_zone")),
                        ("mrz", provenance(None, mrz_lines, "mrz")),
                    ) if p is not None
                },
                cell_checks=checks,
            )
        )
    for key in PRINTED_ONLY:
        printed = viz.get(key)
        if printed is None:
            continue
        data_records.append(
            RawRecord(
                record_id=f"field:{key}",
                values={"field": VIZ_LABELS[key][0], "printed": printed.value, "mrz": None, "consistency": "Printed only"},
                cell_provenance={"printed": provenance(printed, [], "visual_zone")},
            )
        )

    check_records: list[RawRecord] = []
    if mrz is None:
        check_records.append(RawRecord("check:mrz", {"check": "Machine-readable zone", "result": "NOT FOUND",
                                                     "details": "No ICAO 9303 MRZ was found on the page."}))
        qa_messages.append(("Machine-readable zone", "REVIEW", "No MRZ found; nothing to validate against."))
    else:
        for check in mrz.checks:
            label = {"document_number": "Document number check digit", "birth_date": "Date of birth check digit",
                     "expiry_date": "Date of expiry check digit", "optional_data": "Personal number check digit",
                     "composite": "Composite check digit"}[check.name]
            check_records.append(RawRecord(f"check:{check.name}", {
                "check": label, "result": "PASS" if check.passed else "FAIL",
                "details": "ICAO 9303 7-3-1 check digit." if check.passed else "The check digit does not match the data it protects.",
            }))
            if not check.passed:
                qa_messages.append((label, "REVIEW", "MRZ check digit fails — the MRZ was misread or altered."))

    birth = mrz.birth_date(today) if mrz else None
    expiry = mrz.expiry_date(today) if mrz else None
    if expiry is None and viz.get("expiry_date"):
        expiry = _viz_date(viz["expiry_date"].value, "expiry", today)
    issue = _viz_date(viz["issue_date"].value, "issue", today) if viz.get("issue_date") else None
    for name, ok, detail in (
        ("Date of birth is a real date", birth is not None if mrz else None, "Encoded birth date is a valid calendar date."),
        ("Issued after birth", (issue > birth) if issue and birth else None, "Issue date is after the date of birth."),
        ("Expiry after issue", (expiry > issue) if expiry and issue else None, "Expiry date is after the issue date."),
    ):
        if ok is None:
            continue
        check_records.append(RawRecord(f"check:{name}", {"check": name, "result": "PASS" if ok else "FAIL",
                                                          "details": detail if ok else f"Failed: {detail}"}))
        if not ok:
            qa_messages.append((name, "REVIEW", f"Failed: {detail}"))

    status, days = expiry_status(expiry, today)
    if status == "Expired":
        qa_messages.append(("Validity", "REVIEW", f"The document expired on {expiry.isoformat()}."))
    expiry_reading = viz.get("expiry_date")
    validity = RawRecord(
        "validity",
        {
            "status": status,
            "expiry_date": expiry.isoformat() if expiry else None,
            "days_remaining": days,
            "issue_date": issue.isoformat() if issue else None,
            "mrz_format": mrz.format if mrz else None,
        },
        cell_provenance={
            k: p for k, p in (
                ("expiry_date", provenance(expiry_reading, mrz_lines, "validity")),
                ("issue_date", provenance(viz.get("issue_date"), [], "visual_zone")),
            ) if p is not None
        },
        cell_checks={"expiry_date": [ValidationCheck(check="not_expired", passed=False,
                                                     message=f"Expired on {expiry.isoformat()}.")]} if status == "Expired" else {},
    )
    qa_records = [
        RawRecord(f"qa:{i}", {"qa_check": c, "result": r, "details": d, "action": "Review against the document."})
        for i, (c, r, d) in enumerate(qa_messages)
    ]
    return AdapterResult(
        records={"passport_data": data_records, "mrz_checks": check_records, "validity": [validity], "qa_review": qa_records},
        outcome_provenance=document.ingestion_provenance,
    )


def expiry_status(expiry: date | None, today: date) -> tuple[str, int | None]:
    if expiry is None:
        return "Unknown", None
    days = (expiry - today).days
    if days < 0:
        return "Expired", days
    if days <= EXPIRING_WITHIN_DAYS:
        return "Expiring soon", days
    return "Valid", days


def recognize_passport(database: Session, document: Document) -> Recognition:
    """Strong evidence only: an MRZ that parses (any document code) in the
    page text. Cheap — page text is already stored."""

    pages = database.scalars(
        select(DocumentPage.final_text).where(DocumentPage.document_id == document.id).order_by(DocumentPage.page_number)
    ).all()
    lines = [re.sub(r"\s+", "", line).upper() for text in pages for line in (text or "").splitlines()]
    for start in range(len(lines)):
        for size in (3, 2):
            block = lines[start:start + size]
            if len(block) == size and all(_MRZ_LINE.match(b) and "<" in b for b in block):
                parsed = parse_mrz("\n".join(block))
                if parsed is not None:
                    score = 0.97 if parsed.check_digits_valid else 0.85
                    return Recognition(score, [f"ICAO 9303 {parsed.format} machine-readable zone (document code {parsed.document_code or '?'})"])
    return Recognition(0.0, ["no machine-readable zone"])


PASSPORT_PROFILE = StagingProfile(
    profile_id="passport",
    profile_version=1,
    display_name="Passport / Travel Document",
    description=(
        "Passport and ICAO travel document data pages: printed fields and the machine-readable "
        "zone compared field by field, MRZ check digits, and validity dates."
    ),
    document_families=("passport",),
    datasets=(PASSPORT_DATA, MRZ_CHECKS, VALIDITY, QA_REVIEW),
    adapter=adapt_passport,
    export_capabilities=(
        ExportCapability(
            capability_id="professional_excel",
            label="Professional Excel (staging workbook)",
            format="xlsx",
            href="/api/documents/{document_id}/staging-workbook/export.xlsx",
        ),
    ),
    export_sheets=(
        ExportSheet("Passport Data", ("passport_data",)),
        ExportSheet("MRZ Validation", ("mrz_checks",)),
        ExportSheet("Validity", ("validity",)),
        ExportSheet(SOURCE_SHEET, ()),
    ),
    document_recognizer=recognize_passport,
    contract_pipeline=False,
    data_class="restricted",
)
