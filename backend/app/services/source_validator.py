import re
import unicodedata

_PUNCTUATION_VARIANTS = {
    "‐": "-",  # hyphen
    "‑": "-",  # non-breaking hyphen
    "‒": "-",  # figure dash
    "–": "-",  # en dash
    "—": "-",  # em dash
    "‘": "'",  # left single quote
    "’": "'",  # right single quote
    "“": '"',  # left double quote
    "”": '"',  # right double quote
    " ": " ",  # non-breaking space
}


def normalize_text(
    value: str,
) -> str:

    value = unicodedata.normalize(
        "NFKC",
        value,
    )

    for variant, replacement in (
        _PUNCTUATION_VARIANTS.items()
    ):
        value = value.replace(
            variant,
            replacement,
        )

    value = value.lower()

    value = re.sub(
        r"\s+",
        " ",
        value,
    )

    return value.strip()


_NUMBER = re.compile(r"(?<![\w.])[-(]?\$?\d[\d,]*(?:\.\d+)?\)?")
_DATE_LIKE = re.compile(
    r"\b(?:\d{4}-\d{1,2}-\d{1,2}"
    r"|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}"
    r"|\d{1,2}\s+[A-Za-z]{3,9}\.?,?\s+\d{4}"
    r"|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})\b"
)


def _compact(value: str) -> str:
    return re.sub(r"[^0-9a-z]", "", normalize_text(value))


def _as_number(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    negative = text.startswith("(") and text.endswith(")") or text.startswith("-")
    digits = re.sub(r"[^\d.]", "", text)
    if not re.fullmatch(r"\d+(?:\.\d+)?", digits or ""):
        return None
    # Only plain numeric shapes ("$2,500.00", "1500", "-3.25"), not ids
    # like "W912DR-26" whose digits happen to parse.
    if re.search(r"[A-Za-z]", re.sub(r"(?i)\b(usd|eur|gbp|cad|aud)\b", "", text)):
        return None
    number = float(digits)
    return -number if negative else number


def _numbers_in(text: str) -> list[float]:
    found = []
    for match in _NUMBER.finditer(text):
        number = _as_number(match.group(0))
        if number is not None:
            found.append(abs(number))
    return found


def _as_date(value: object):
    from datetime import date, datetime

    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value).strip()
    if not _DATE_LIKE.fullmatch(text):
        return None
    try:
        from dateutil import parser

        return parser.parse(text).date()
    except (ValueError, OverflowError):
        return None


def _dates_in(text: str) -> list:
    dates = []
    for match in _DATE_LIKE.finditer(text):
        parsed = _as_date(match.group(0))
        if parsed is not None:
            dates.append(parsed)
    return dates


def value_supported_by(value: object, text: str) -> bool:
    """Whether a scalar value can be read from `text`: literally (after
    normalization), as a compacted identifier ("W912DR-26-C-0042" vs
    "W912DR 26 C 0042"), as the same number ("2500.00" vs "$2,500.00")
    or as the same date ("2026-03-01" vs "March 1, 2026")."""

    if value is None or not text:
        return False
    rendered = str(value).strip()
    if not rendered:
        return False
    if normalize_text(rendered) in normalize_text(text):
        return True
    compact = _compact(rendered)
    if len(compact) >= 3 and compact in _compact(text):
        return True
    number = _as_number(value)
    if number is not None and any(
        abs(abs(number) - found) < 0.005 for found in _numbers_in(text)
    ):
        return True
    parsed = _as_date(value)
    if parsed is not None and parsed in _dates_in(text):
        return True
    return False


def _scalar_leaves(value: object) -> list[object]:
    if isinstance(value, dict):
        return [leaf for item in value.values() for leaf in _scalar_leaves(item)]
    if isinstance(value, (list, tuple)):
        return [leaf for item in value for leaf in _scalar_leaves(item)]
    if value is None or isinstance(value, bool):
        return []
    if isinstance(value, str) and not value.strip():
        return []
    return [value]


def validate_source_value(
    *,
    value: object,
    source_text: str,
    page_text: str,
    strict: bool = False,
) -> bool:
    """Whether `value` is grounded in the page.

    Default (deterministic extractors): the value is on the page, or the
    quoted source text is. Those extractors read the value out of the
    text they quote (often a "label: value" snippet whose two parts sit
    in separate cells, or a normalized form like "FAR 52.232-8"), so the
    quote is genuine evidence for them.

    strict=True (AI-produced values): a model can quote real text and
    still return a different value, so the quote alone is not enough —
    see _strictly_grounded.
    """

    if strict:
        return _strictly_grounded(value=value, source_text=source_text, page_text=page_text)

    if value is None:
        return False

    if isinstance(
        value,
        (
            list,
            dict,
        ),
    ):
        return bool(
            source_text.strip()
        )

    normalized_value = normalize_text(
        str(value)
    )

    normalized_source = normalize_text(
        source_text
    )

    normalized_page = normalize_text(
        page_text
    )

    if (
        normalized_value
        in normalized_page
    ):
        return True

    if (
        normalized_source
        and normalized_source
        in normalized_page
    ):
        return True

    return False


def _strictly_grounded(*, value: object, source_text: str, page_text: str) -> bool:
    """The quoted source text (when given) must itself be on the page, and
    the value must be supported by that quote or by the page — a quote on
    the page is not enough if the value isn't in it. Lists/dicts are
    grounded when every scalar element is."""

    if value is None:
        return False

    quote = (source_text or "").strip()
    normalized_page = normalize_text(page_text or "")
    quote_on_page = bool(quote) and normalize_text(quote) in normalized_page
    if quote and not quote_on_page:
        return False

    def supported(leaf: object) -> bool:
        return (quote_on_page and value_supported_by(leaf, quote)) or value_supported_by(
            leaf, page_text or ""
        )

    if isinstance(value, (list, dict, tuple)):
        leaves = _scalar_leaves(value)
        return bool(quote_on_page) and bool(leaves) and all(supported(leaf) for leaf in leaves)

    return supported(value)
