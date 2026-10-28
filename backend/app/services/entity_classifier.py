import re
from typing import Literal

TargetType = Literal[
    "field",
    "table",
    "section",
    "contact",
    "date",
    "amount",
    "identifier",
    "clause",
    "obligation",
    "signature",
    "custom",
]

_IDENTIFIER_LABEL_KEYWORDS = (
    "naics",
    "psc",
    "cage",
    "dodaac",
    "solicitation no",
    "solicitation number",
    "contract no",
    "contract number",
    "requisition",
    "purchase request",
    "project no",
    "project number",
    "clin",
    "duns",
    "uei",
    "max net",
    "wawf",
    "routing",
)

_DATE_LABEL_KEYWORDS = (
    "date",
    "effective",
    "expir",
    "issued",
    "deadline",
    "due",
)

_AMOUNT_LABEL_KEYWORDS = (
    "amount",
    "price",
    "total",
    "cost",
    "value",
    "fee",
    "rate",
    "max net",
    "$",
)

_CONTACT_LABEL_KEYWORDS = (
    "officer",
    "contracting officer",
    "point of contact",
    "poc",
    "name of",
    "telephone",
    "phone",
    "email",
)

NAICS_PATTERN = re.compile(r"^\d{6}$")
PSC_PATTERN = re.compile(r"^[A-Z0-9]{4}$")
CAGE_PATTERN = re.compile(r"^[A-Z0-9]{5}$")
DODAAC_PATTERN = re.compile(r"^[A-Z0-9]{6}$")
DATE_VALUE_PATTERN = re.compile(
    r"^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$"
    r"|^\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}$"
)
MONEY_VALUE_PATTERN = re.compile(r"^\$?\s*[\d,]+(?:\.\d{2})?$")
_DECIMAL_AMOUNT = re.compile(r"^\(?-?\$?\s*\d[\d,]*\.\d{2}\)?$")


def _label_has_any(label: str, keywords: tuple[str, ...]) -> bool:
    lowered = label.lower()
    return any(keyword in lowered for keyword in keywords)


def classify_target_type(
    raw_label: str,
    value: str,
) -> TargetType:
    label = raw_label or ""
    stripped_value = (value or "").strip()

    if _label_has_any(label, _IDENTIFIER_LABEL_KEYWORDS):
        return "identifier"

    if _label_has_any(label, _DATE_LABEL_KEYWORDS):
        # "Change Due 10.84", "Balance Due 1,200.00": a date word in the
        # label, but the value is plainly money, not a date.
        if _DECIMAL_AMOUNT.match(stripped_value):
            return "amount"
        return "date"

    if _label_has_any(label, _AMOUNT_LABEL_KEYWORDS):
        return "amount"

    if _label_has_any(label, _CONTACT_LABEL_KEYWORDS):
        return "contact"

    has_weak_label_hint = bool(label.strip())

    if has_weak_label_hint and stripped_value:
        candidate = stripped_value.upper()

        if NAICS_PATTERN.match(stripped_value):
            return "identifier"

        if CAGE_PATTERN.match(candidate) or DODAAC_PATTERN.match(candidate):
            return "identifier"

        if PSC_PATTERN.match(candidate):
            return "identifier"

        if DATE_VALUE_PATTERN.match(stripped_value):
            return "date"

        if MONEY_VALUE_PATTERN.match(stripped_value) and "$" in stripped_value:
            return "amount"

    return "field"
