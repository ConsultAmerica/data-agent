import re
from dataclasses import dataclass
from typing import Literal

from app.models.document_page import DocumentPage
from app.services.label_rejection import reject_as_field_value
from app.services.request_interpreter import STOP_WORDS

MAX_PAIRS_PER_PAGE = 40

ScanMethod = Literal[
    "form_field",
    "table_2col",
    "inline_regex",
    "stacked_line",
]


# NOTE: every gap/leading/trailing whitespace token below uses [ \t]
# (horizontal whitespace only), never the bare \s class. \s matches \n in
# Python's re module, so a bare \s{2,} "gap" would happily span a blank
# line and glue one line's label to a value two lines down — these
# patterns are all meant to stay within a single line.

# A "." separates label from value only when it doesn't follow a digit:
# in "Federal Income Tax 200.00" the dot is a decimal point, not the end
# of a label "Federal Income Tax 200" with the value "00".
_INLINE_LABEL_VALUE = re.compile(
    r"^[ \t]*([A-Z][A-Za-z0-9 /#.'\-]{2,40}?)[ \t]*(?::{1,3}|(?<!\d)\.{1,3})[ \t]*(\S.{0,120})[ \t]*$",
    re.MULTILINE,
)

# "Gross Pay 2,000.00", "Subtotal 8.48  Tax 0.68  Total 9.16" — a Title
# Case or ALL CAPS label followed by a money amount, with no colon. Pay
# stubs, receipts and statements print totals this way. A later pair on
# the same line starts right after the previous amount.
_LABEL_AMOUNT = re.compile(
    r"(?:^|(?<=\.\d\d))[ \t]*((?:[A-Z][A-Za-z/#&'\-]*)(?:[ \t][A-Z][A-Za-z/#&'\-]*){0,3})"
    r"[ \t]*:?[ \t]+(\(?-?\$?\d[\d,]*\.\d{2}\)?)(?=[ \t]|$)",
    re.MULTILINE,
)

# Many government-form labels (NAICS, PSC CD, DATE ISSUED, TYPE OF
# SOLICITATION, ...) carry no trailing punctuation at all — the label and
# its value are separated only by a wide column gap. An all-caps label
# requirement plus a 2+ space gap distinguishes this from ordinary prose
# (single-space word separation).
_INLINE_LABEL_VALUE_WIDE_GAP = re.compile(
    r"^[ \t]*([A-Z][A-Z0-9 /#.'\-]{1,40})[ \t]{2,}(\S.{0,120})[ \t]*$",
    re.MULTILINE,
)

_DOT_LEADER = re.compile(
    r"^[ \t]*([A-Za-z][A-Za-z0-9 /#'\-]{2,40}?)[ \t]*\.{4,}[ \t]*(\S.{0,80})[ \t]*$",
    re.MULTILINE,
)

# A label-only line must not itself contain a wide column gap (2+ spaces
# followed by more text) — that pattern is a same-line "LABEL   VALUE"
# form field (already handled by _INLINE_LABEL_VALUE), not a genuine
# label-on-its-own-line layout. Without this guard, wide-column forms get
# mis-parsed: the whole "LABEL   VALUE" line becomes the "label" and the
# next, unrelated line becomes the "value".
_STACKED_LABEL = re.compile(
    r"^(?!.*[ \t]{2,}\S)([A-Z][A-Z0-9 /#.'\-]{2,40})\n(?!\s*$)([^\n]{1,120})$",
    re.MULTILINE,
)

_ALL_CAPS = re.compile(r"^[A-Z0-9 /#.'\-]+$")

_NUMERIC_ONLY = re.compile(r"^[\s\d.,$%()-]+$")

# Internal PDF form field names (XFA, AcroForm, LiveCycle).
# Use multi-signal scoring so a lone "[0]" or "Page" in a real label
# is not enough to reject it.
_STRONG_INTERNAL = re.compile(
    r"topmostSubform|\bsubform\b|\bxfa\b|\bform\d+\b",
    re.IGNORECASE,
)
_PAGE_HIERARCHY = re.compile(r"\bPage\d+\b|\bPG\d+[A-Z]*\b", re.IGNORECASE)
_ARRAY_INDEX = re.compile(r"\[\d+\]")
_WIDGET_TYPE = re.compile(
    r"TextField\d*|CheckBox\d*|RadioButton\d*|SignatureField\d*"
    r"|NumericField\d*|DateTimeField\d*|DropDownList\d*",
    re.IGNORECASE,
)
_PURE_WIDGET = re.compile(
    r"^(TextField|CheckBox|RadioButton|SignatureField|NumericField"
    r"|DateTimeField|DropDownList)\d*$",
    re.IGNORECASE,
)
_PURE_PAGE_TOKEN = re.compile(r"^(Page\d+|PG\d+[A-Z]*)$", re.IGNORECASE)

_KEEP_UPPER_TOKENS = {
    "DODAAC",
    "CAGE",
    "NAICS",
    "PSC",
    "WAWF",
    "CLIN",
    "FAR",
    "DFARS",
    "SF",
    "ACO",
    "PCO",
    "TIN",
    "EIN",
    "DUNS",
    "UEI",
    "POC",
    "FOB",
    "CD",
    # Pay stubs, receipts, cheques and ID documents.
    "ID",
    "YTD",
    "SSN",
    "PO",
    "GPA",
    "VAT",
    "GST",
    "MICR",
    "ABA",
    "IBAN",
    "SWIFT",
    "DOB",
}


def is_internal_form_name(name: str) -> bool:
    """
    Return True if the name looks like an internal PDF form field path.

    Requires multiple hierarchy signals so legitimate labels that happen
    to contain brackets (e.g. "Item [0] Code") are not rejected alone.
    """
    if not name or not name.strip():
        return True

    stripped = name.strip()
    if stripped.startswith("#"):
        return True
    if _PURE_WIDGET.fullmatch(stripped) or _PURE_PAGE_TOKEN.fullmatch(stripped):
        return True

    signals = 0
    if _STRONG_INTERNAL.search(stripped):
        signals += 2
    if _PAGE_HIERARCHY.search(stripped):
        signals += 1
    if _ARRAY_INDEX.search(stripped):
        signals += 1
    if _WIDGET_TYPE.search(stripped):
        signals += 1

    return signals >= 2


def format_display_label(label: str) -> str:
    """
    Polish form/KV labels for the schema picker.

    SOLICITATION NO. → Solicitation No.
    CONTRACT NO → Contract No.
    DATE ISSUED → Date Issued
    REQUISITION/PURCHASE REQUEST/PROJECT NO.
        → Requisition / Purchase Request / Project No.
    """
    cleaned = " ".join((label or "").split()).strip().rstrip(":")
    if not cleaned:
        return cleaned

    segments: list[str] = []
    for segment in cleaned.split("/"):
        words: list[str] = []
        for word in segment.strip().split():
            bare = word.rstrip(".")
            upper = bare.upper()
            if upper in _KEEP_UPPER_TOKENS:
                words.append(upper)
            elif upper in {"NO", "NOS"}:
                words.append("No." if upper == "NO" else "Nos.")
            elif bare.isupper() or bare.islower():
                words.append(bare.capitalize())
            else:
                words.append(word)
        if words:
            segments.append(" ".join(words))

    return " / ".join(segments)


def map_form_value_to_visible_label(text: str, value: str) -> str | None:
    """
    Map a form-field value to a nearby human-readable label in page text.

    Example: XFA path topmostSubform[0].Page1[0].PG11I[0] with value
    FA300224C0008 and nearby text "SOLICITATION NO. FA300224C0008"
    → returns "Solicitation No."
    """
    cleaned_value = " ".join((value or "").split()).strip()
    cleaned_text = text or ""
    if not cleaned_text or len(cleaned_value) < 2:
        return None

    escaped = re.escape(cleaned_value)
    same_line = re.compile(
        rf"(?P<label>[A-Za-z][A-Za-z0-9 /#.'\-]{{1,60}}?)\s*[:#.-]\s*{escaped}\b",
        re.IGNORECASE | re.MULTILINE,
    )
    match = same_line.search(cleaned_text)
    if match:
        label = " ".join(match.group("label").split()).strip().rstrip(".:-")
        if (
            label
            and not is_internal_form_name(label)
            and is_plausible_kv_label(label)
        ):
            return format_display_label(label)

    # Stacked layout: previous line is the label, current line is the value.
    lines = cleaned_text.splitlines()
    for index, line in enumerate(lines):
        line_stripped = line.strip()
        if cleaned_value not in line_stripped:
            continue
        if index == 0:
            continue
        # Prefer lines that are mostly the value itself.
        if line_stripped != cleaned_value and not line_stripped.startswith(
            cleaned_value
        ):
            continue
        prev = lines[index - 1].strip().rstrip(".:-")
        prev = " ".join(prev.split())
        if (
            prev
            and not is_internal_form_name(prev)
            and is_plausible_kv_label(prev)
        ):
            return format_display_label(prev)

    return None


@dataclass(frozen=True)
class ScannedPair:
    raw_label: str
    normalized_label: str
    value: str
    method: ScanMethod
    confidence: float
    # Original XFA/AcroForm field path when the display label was mapped.
    source_field_path: str | None = None


def _normalize_label(label: str) -> str:
    normalized = " ".join(label.strip().lower().split())
    return normalized.rstrip(".:-").strip()


def _looks_like_noise(label: str) -> bool:
    normalized = _normalize_label(label)
    if not normalized:
        return True
    words = normalized.split()
    if all(word in STOP_WORDS for word in words):
        return True
    return False


_PROSE_PHRASES = (
    " shall ",
    " will ",
    " must ",
    " hereby ",
    " pursuant ",
    " whereas ",
    " provided that ",
    " in the event ",
    " for those ",
    " those ",
    " requiring ",
    " prevail ",
    " upon ",
    " hereinafter ",
    " thereof ",
    " hereunder ",
    " pursuant to ",
    " in accordance ",
    " subject to ",
    " in the ",
    " of the ",
    " to the ",
    " for the ",
    " and the ",
    " that the ",
)

_FILLER_WORDS = {
    "the",
    "in",
    "for",
    "those",
    "that",
    "this",
    "with",
    "from",
    "to",
    "of",
    "be",
    "and",
    "or",
    "a",
    "an",
    "as",
    "at",
    "by",
    "on",
    "is",
    "are",
    "requiring",
    "prevail",
    "such",
    "any",
    "all",
    "each",
    "their",
    "these",
    "upon",
}

_FORM_LABEL_SUFFIXES = (
    "no.",
    "no",
    "cd",
    "amt",
    "date",
    "code",
    "type",
    "id",
    "name",
    "office",
    "dodaac",
    "cage",
    "naics",
    "psc",
)


def _looks_like_form_label(label: str) -> bool:
    normalized = label.strip().lower()
    words = normalized.split()

    if len(normalized) <= 28 and len(words) <= 4:
        return True

    return any(
        normalized.endswith(suffix) for suffix in _FORM_LABEL_SUFFIXES
    )


def is_plausible_kv_label(label: str) -> bool:
    """
    Reject contract prose misread as label/value pairs during discovery.
    Real form labels are short, directive, and rarely read like sentences.
    """
    normalized = " ".join(label.split())
    if not normalized or _looks_like_noise(normalized):
        return False

    if is_internal_form_name(normalized):
        return False

    lowered = f" {normalized.lower()} "
    if any(token in lowered for token in _PROSE_PHRASES):
        return False

    words = normalized.split()
    if len(words) > 6 and not _looks_like_form_label(normalized):
        return False

    if len(normalized) > 42 and not _looks_like_form_label(normalized):
        return False

    filler_count = sum(1 for word in words if word.lower() in _FILLER_WORDS)
    if filler_count >= 2 and not _looks_like_form_label(normalized):
        return False

    # Repeated substantive tokens (e.g. "task orders ... task orders").
    substantive = [word.lower() for word in words if len(word) > 3]
    if len(substantive) != len(set(substantive)):
        return False

    # Mixed-case sentence fragments (not title-case form labels).
    lowercase_words = sum(1 for word in words if word.islower() and len(word) > 2)
    if lowercase_words >= 3 and not _ALL_CAPS.match(normalized):
        return False

    return True


def _acceptable_pair_value(value: str) -> bool:
    """Reject values that are clearly neighboring form labels."""

    if not value or not str(value).strip():
        return False
    return reject_as_field_value(value) is None


def _scan_form_fields(page: DocumentPage) -> list[ScannedPair]:
    pairs: list[ScannedPair] = []
    page_text = page.final_text or ""
    for raw_label, value in (page.form_fields_json or {}).items():
        if not value or not str(value).strip():
            continue
        label_str = str(raw_label).strip()
        value_str = str(value).strip()
        if not _acceptable_pair_value(value_str):
            continue
        source_field_path: str | None = None

        # Raw XFA/AcroForm paths are never shown as targets. Prefer a
        # nearby visible label when the filled value appears in page text.
        if is_internal_form_name(label_str):
            mapped = map_form_value_to_visible_label(page_text, value_str)
            if not mapped:
                continue
            source_field_path = label_str
            label_str = mapped
        else:
            label_str = format_display_label(label_str)

        if not is_plausible_kv_label(label_str):
            continue

        pairs.append(
            ScannedPair(
                raw_label=label_str,
                normalized_label=_normalize_label(label_str),
                value=value_str,
                method="form_field",
                confidence=0.95,
                source_field_path=source_field_path,
            )
        )
    return pairs


def _scan_two_column_tables(page: DocumentPage) -> list[ScannedPair]:
    pairs: list[ScannedPair] = []
    for table in page.tables_json or []:
        headers = [str(h) for h in (table.get("headers") or [])]
        if len(headers) != 2:
            continue
        for row in table.get("rows") or []:
            if isinstance(row, dict):
                values = list(row.values())
            elif isinstance(row, (list, tuple)):
                values = list(row)
            else:
                continue
            if len(values) != 2:
                continue
            label, value = str(values[0]).strip(), str(values[1]).strip()
            if not label or not value:
                continue
            if not _acceptable_pair_value(value):
                continue
            if _NUMERIC_ONLY.match(label):
                continue
            display = format_display_label(label)
            pairs.append(
                ScannedPair(
                    raw_label=display,
                    normalized_label=_normalize_label(display),
                    value=value,
                    method="table_2col",
                    confidence=0.85,
                )
            )
    return pairs


_INLINE_PATTERNS: tuple[tuple[re.Pattern[str], float], ...] = (
    (_INLINE_LABEL_VALUE, 0.78),
    (_INLINE_LABEL_VALUE_WIDE_GAP, 0.8),
    (_DOT_LEADER, 0.76),
    (_LABEL_AMOUNT, 0.78),
)

# A dot-leader match ("ATTACHMENT J-1 ........ 69") is a table-of-contents
# / navigation line by construction — the dots ARE the leader connecting a
# heading to its page number. Once matched, the captured "value" is just
# the bare trailing page number, indistinguishable in shape from a real
# short numeric field value, so it must be rejected right here using the
# fact that *this specific pattern* fired, not by re-guessing from the
# bare number alone downstream (where that guess would be unsafe/too
# broad against legitimate short numeric values like quantities or codes).
_TOC_PAGE_NUMBER_VALUE = re.compile(r"^\d{1,4}$")


# "Employee: Jane Doe   Employee ID 4471" — a wide gap, then a second
# label with its own value. Only a remainder that is unmistakably another
# label (a colon, or an ID/No./Number/# token) splits the value, so an
# address with a double space ("1 Main St  Suite 4") is left whole.
_TRAILING_PAIR = re.compile(
    r"[ \t]{2,}([A-Z][A-Za-z /]{1,30}?(?:[ \t]*:|[ \t]+(?:ID|No\.?|Number|#)))[ \t]*(\S.*)$"
)


_WIDE_GAP_SPLIT = re.compile(r"[ \t]{2,}")
_COLON_PAIR = re.compile(r"^([A-Z][A-Za-z /#.'\-]{1,30}?)[ \t]*:[ \t]*(\S.*)$")
# A letter's greeting ("Dear Ms. Patel,") is not a label and its value.
_SALUTATION = re.compile(r"^(dear|hi|hello|to whom)\b", re.IGNORECASE)


def _split_trailing_pair(value: str) -> tuple[str, tuple[str, str] | None]:
    match = _TRAILING_PAIR.search(value)
    if not match or match.start() == 0:
        return value, None
    return value[: match.start()].strip(), (match.group(1).rstrip(" :\t"), match.group(2).strip())


def _scan_inline_regex(text: str) -> list[ScannedPair]:
    pairs: list[ScannedPair] = []
    for pattern, confidence in _INLINE_PATTERNS:
        for match in pattern.finditer(text):
            label, value = match.group(1).strip(), match.group(2).strip()
            # A label never spans a column gap: in "FIRST NATIONAL BANK
            # Check No: 1001" only the text after the gap is the label.
            label = _WIDE_GAP_SPLIT.split(label)[-1]
            if _SALUTATION.match(label):
                continue
            if pattern is _INLINE_LABEL_VALUE_WIDE_GAP:
                # "FIRST NATIONAL BANK      Check No: 1001": the caps text is
                # a heading; the real pair is the "Label: value" after it.
                inner = _COLON_PAIR.match(value)
                if inner:
                    label, value = inner.group(1).strip(), inner.group(2).strip()
            value, trailing = _split_trailing_pair(value)
            if trailing is not None:
                second_label, second_value = trailing
                second_display = format_display_label(second_label)
                if _acceptable_pair_value(second_value) and not _looks_like_noise(second_label):
                    pairs.append(
                        ScannedPair(
                            raw_label=second_display,
                            normalized_label=_normalize_label(second_display),
                            value=second_value,
                            method="inline_regex",
                            confidence=confidence,
                        )
                    )
            if not label or not value or _looks_like_noise(label):
                continue
            if pattern is _DOT_LEADER and _TOC_PAGE_NUMBER_VALUE.match(value):
                continue
            if not _acceptable_pair_value(value):
                continue
            # All-caps government form labels (SOLICITATION NO., DODAAC, ...)
            # are high-signal — keep them above the primary detection floor.
            boosted = confidence
            if _ALL_CAPS.match(label):
                boosted = max(confidence, 0.82)
            display = format_display_label(label)
            pairs.append(
                ScannedPair(
                    raw_label=display,
                    normalized_label=_normalize_label(display),
                    value=value,
                    method="inline_regex",
                    confidence=boosted,
                )
            )
    return pairs


def _scan_stacked_lines(text: str) -> list[ScannedPair]:
    pairs: list[ScannedPair] = []
    for match in _STACKED_LABEL.finditer(text):
        label, value = match.group(1).strip(), match.group(2).strip()
        if not label or not value or _looks_like_noise(label):
            continue
        if not _acceptable_pair_value(value):
            continue
        if _ALL_CAPS.match(value):
            continue
        # The next line is itself "Label: value" — the line above is a
        # heading, not that line's label.
        if _INLINE_LABEL_VALUE.match(value):
            continue
        display = format_display_label(label)
        pairs.append(
            ScannedPair(
                raw_label=display,
                normalized_label=_normalize_label(display),
                value=value,
                method="stacked_line",
                # All-caps stacked labels are common on SF/OF forms —
                # keep them at/above the primary detection floor (0.75).
                confidence=0.82 if _ALL_CAPS.match(label) else 0.62,
            )
        )
    return pairs


def scan_page_for_labeled_pairs(
    *,
    page: DocumentPage,
) -> list[ScannedPair]:
    text = page.final_text or ""

    all_pairs = (
        _scan_form_fields(page)
        + _scan_two_column_tables(page)
        + _scan_inline_regex(text)
        + _scan_stacked_lines(text)
    )

    best_by_label: dict[str, ScannedPair] = {}
    for pair in all_pairs:
        existing = best_by_label.get(pair.normalized_label)
        if existing is None or pair.confidence > existing.confidence:
            best_by_label[pair.normalized_label] = pair

    ranked = sorted(
        best_by_label.values(),
        key=lambda pair: pair.confidence,
        reverse=True,
    )

    return ranked[:MAX_PAIRS_PER_PAGE]
