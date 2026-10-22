"""Step 2: SF33/gov-form label vocabulary + field-specific semantic
validation for Contract Summary candidates.

Generic government-form field recognition (SF33 numbered items and their
common synonyms across similar forms), not specific to the regression
contract. Confirmed need: Step 1's routing accepted a label/value pairing
purely on proximity, with no check that the VALUE actually looks like the
kind of thing the LABEL asks for - "Date Issued" happily took a
solicitation-number-shaped string because nothing checked it looked like a
date. Semantic validation closes that gap and directly implements the P0
rule: identifier fields require identifier-compatible values, dates must
parse as plausible dates, etc.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass

# (substrings to match against a normalized label, field_key). First match
# wins - ordered so more specific phrases are checked before shorter ones
# they contain (e.g. "solicitation number" before a bare "number").
_LABEL_TO_FIELD: tuple[tuple[tuple[str, ...], str], ...] = (
    (("contract number", "contract no"), "contract_number"),
    (("solicitation number", "solicitation no", "solicitation / rfp"), "solicitation_number"),
    (("type of solicitation",), "type_of_solicitation"),
    (("requisition/purchase number", "requisition/purchase", "purchase request number"), "purchase_request_number"),
    (("date issued",), "date_issued"),
    (("award date",), "award_date"),
    (("effective date",), "effective_date"),
    (("naics",), "naics"),
    (("psc code", "product service code"), "psc_code"),
    (("ueid", "unique entity id", "unique entity identifier"), "ueid"),
    (("issued by",), "issued_by"),
    (("administered by",), "administered_by"),
    (("name and address of offeror", "name of offeror or contractor", "name of offeror"), "offeror_name"),
    (("contractor name", "name of contractor"), "contractor_name"),
    (("name of contracting officer", "contracting officer"), "contracting_officer_name"),
    (("e-mail address", "email address", "e-mail", "email"), "email"),
    (("telephone number", "telephone", "phone number"), "telephone"),
    # Only bare SF33 item 20 / explicit award amount — not "Obligated Amount".
    (("20. amount", "award amount", "total amount"), "amount"),
    (("10a. name", "10a name"), "contact_name"),
    (("15a. name", "15a name"), "offeror_name"),
)

# Exact V3 Contract Summary columns from docs/v3-schema-manifest.md §11.
# Fields recognized on forms but absent from this wide header stay in
# GENERAL_ACCEPTED_FIELD / evaluated separately in the Step 2 gate.
FIELD_KEY_TO_V3_COLUMN: dict[str, str] = {
    "contract_number": "Contract Number",
    "solicitation_number": "Solicitation / RFP",
    "award_date": "Award Date",
    "contractor_name": "Contractor",
    "offeror_name": "Contractor",
    "issued_by": "Agency / Office",
    "naics": "NAICS",
}
# Deliberately NOT mapped here: "amount" (SF33 Block 20 "AMOUNT"). Quality-
# gate finding: for this contract that block holds the award/obligated
# amount for THIS award action, which for an IDIQ equals the Minimum
# Guarantee ($2,500.00) — not the contract ceiling. Routing it into
# "Ceiling / Max Aggregate" silently duplicated the minimum-guarantee value
# into the ceiling column. It stays a GENERAL_ACCEPTED_FIELD (All Fields)
# entry instead; `contract_summary_builder._max_ceiling_value` derives the
# real ceiling from its own narrative language rather than this form field.

# Fields the Step 2 regression gate must evaluate even when they are not
# 1:1 V3 Contract Summary columns (source-supported SF33 / award facts).
STEP2_EVALUATED_SUMMARY_FIELDS: tuple[str, ...] = (
    "contract_number",
    "solicitation_number",
    "award_date",
    "date_issued",
    "ueid",
    "contracting_officer_name",
    "telephone",
    "email",
    "naics",
    "contractor_name",
    "issued_by",
    "amount",
)


# Quality-gate follow-up: single common words that are never themselves a
# complete business-field label — every confirmed bad All Fields example
# (FOR -> INFORMATION, NAME -> AND, SIGNATURE -> AWARD, SEC. -> ...) is a
# single word matching this set. A safety-net denylist, not the primary
# mechanism (that's `match_label`'s vocabulary + the multi-word heuristic
# in `is_plausible_business_label` below).
_SINGLE_WORD_NOISE_LABELS = frozenset(
    {
        "for", "and", "or", "the", "a", "an", "of", "to", "in", "on", "by",
        "name", "signature", "award", "information", "sec", "date", "check",
        "see", "note", "continued", "page", "item", "no", "block", "part",
        "section", "title", "date/time", "initials", "sic",
    }
)

# Multi-word phrases that are structural/navigational, not business labels,
# even though they pass the "multi-word" bar the general heuristic below
# otherwise trusts.
_MULTI_WORD_NOISE_LABELS = frozenset(
    {
        "table of contents",
        "continued on next page",
        "see continuation sheet",
        "this space intentionally left blank",
    }
)

_STOPWORDS_LOCAL = frozenset(
    "the a an of to in on for and or but is are was were be been being "
    "this that these those shall will would should may might must not "
    "whether if as by with from at it its their his her our your".split()
)

# Quality-gate finding: a wrapped, multi-line table cell ("Contractor shall
# email response to the OASIS+ Program Management Office (PMO) at the date
# specified within the data call(s).") got truncated down to "Contractor
# shall email" during line-association and passed the length/stopword-ratio
# checks above (3 short words, no stopwords). Real form-field labels are
# noun phrases ("Contract Number", "E-mail Address"); a label containing a
# modal auxiliary verb is structurally a narrative/instruction sentence
# fragment instead — this is a shape signal, not specific to any one
# contract's wording.
_NARRATIVE_VERB_MARKERS = frozenset({"shall", "must", "should", "will", "shall.", "must.", "will."})


def is_plausible_business_label(label_text: str) -> bool:
    """Quality-gate follow-up: gates unrecognized (no `match_label` hit)
    form-cell labels before they can become GENERAL_ACCEPTED_FIELD/All
    Fields records. A label recognized by `match_label` always bypasses
    this (trusted vocabulary); this function only judges labels outside
    that vocabulary, using shape rather than a fixed list — per the P0
    instruction, "do not solve this by hardcoding only the examples
    above." Rejects: single common words (structural fragments), known
    navigational phrases, and prose-length text (real form labels are
    short noun phrases, not instructions/sentences).
    """

    normalized = label_text.strip().lower().strip(":.")
    if not normalized:
        return False
    if normalized in _MULTI_WORD_NOISE_LABELS:
        return False

    words = normalized.split()
    if len(words) == 1:
        # A single word is a business label only if it's a real noun that
        # isn't a generic structural/stopword fragment — the confirmed bad
        # examples are ALL single words, and no legitimate SF33-style
        # field is truly one bare common word.
        return normalized not in _SINGLE_WORD_NOISE_LABELS and normalized not in _STOPWORDS_LOCAL

    if len(words) > 8:
        # Real form labels are short noun phrases; anything this long is
        # instructional/prose text masquerading as a label (e.g. "CHECK IF
        # REMITTANCE ADDRESS IS DIFFERENT FROM ABOVE - ENTER...").
        return False

    if any(w.strip(",.;:-").lower() in _NARRATIVE_VERB_MARKERS for w in words):
        # A modal auxiliary verb ("shall"/"must"/"should"/"will") means this
        # is a sentence fragment (e.g. "Contractor shall email"), not a
        # noun-phrase field label, regardless of its short length.
        return False

    stopword_hits = sum(1 for w in words if w.strip(",.;:-") in _STOPWORDS_LOCAL)
    if stopword_hits / len(words) > 0.6:
        # Mostly stopwords (e.g. "IS DIFFERENT FROM ABOVE") reads as prose
        # fragment, not a label.
        return False

    return True


def match_label(label_text: str) -> str | None:
    normalized = label_text.lower().strip()
    # Reject long prose masquerading as a form label.
    if len(normalized.split()) > 10:
        return None
    if "obligated amount" in normalized:
        return None
    # Quality-gate finding: a vocabulary phrase (e.g. "email") can appear as
    # a SUBSTRING of a narrative sentence fragment ("Contractor shall email
    # response to...") that a table-wrap artifact truncated down to
    # "Contractor shall email" — that substring match must not short-circuit
    # past the modal-verb sentence-fragment check below just because a
    # vocabulary word happens to occur in it.
    if any(
        word.strip(",.;:-") in _NARRATIVE_VERB_MARKERS
        for word in normalized.split()
    ):
        return None
    for phrases, field_key in _LABEL_TO_FIELD:
        if any(phrase in normalized for phrase in phrases):
            return field_key
    return None


_CONTRACT_ID_RE = re.compile(r"^[0-9A-Z]{4,8}[- ]?[0-9A-Z]{1,3}[- ]?[0-9A-Z]{3,10}$")
_DATE_RE = re.compile(r"^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$|^\d{4}-\d{2}-\d{2}$")
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$")
_PHONE_RE = re.compile(r"^\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}$|^\d{3}[-. ]?\d{4}$")
_UEID_RE = re.compile(r"^[0-9A-Z]{12}$")
_NAICS_RE = re.compile(r"^\d{6}$")
_MONEY_RE = re.compile(r"^\$?[\d,]+(\.\d{1,2})?$")
# A person's name has at least two parts ("Doris Castro", "DORIS CASTRO");
# a single capitalized word is usually a heading or noun ("Officials").
_NAME_LIKE_RE = re.compile(r"^[A-Z][a-zA-Z'.\-]+(\s+[A-Z][a-zA-Z'.\-]+){1,3}$")
_PSC_RE = re.compile(r"^[A-Z0-9]{1,4}$")


@dataclass(frozen=True)
class ValidationResult:
    is_valid: bool
    reason: str


def _validate_identifier(value: str) -> ValidationResult:
    if _CONTRACT_ID_RE.match(value.strip()):
        return ValidationResult(True, "matches_contract_identifier_shape")
    return ValidationResult(False, "does_not_match_identifier_shape")


def _validate_date(value: str) -> ValidationResult:
    if _DATE_RE.match(value.strip()):
        return ValidationResult(True, "matches_date_shape")
    return ValidationResult(False, "does_not_parse_as_date")


def _validate_naics(value: str) -> ValidationResult:
    if _NAICS_RE.match(value.strip()):
        return ValidationResult(True, "six_digit_naics_code")
    return ValidationResult(False, "not_a_six_digit_code")


def _validate_ueid(value: str) -> ValidationResult:
    if _UEID_RE.match(value.strip()):
        return ValidationResult(True, "twelve_char_alphanumeric_ueid_shape")
    return ValidationResult(False, "not_twelve_char_alphanumeric")


def _validate_email(value: str) -> ValidationResult:
    if _EMAIL_RE.match(value.strip()):
        return ValidationResult(True, "valid_email_shape")
    return ValidationResult(False, "not_a_valid_email_shape")


def _validate_phone(value: str) -> ValidationResult:
    cleaned = value.strip()
    if _PHONE_RE.match(cleaned):
        return ValidationResult(True, "valid_phone_shape")
    # Digits-only 10-digit / 7-digit forms after composition.
    digits = re.sub(r"\D", "", cleaned)
    if len(digits) == 10 or len(digits) == 7:
        return ValidationResult(True, "valid_phone_shape")
    return ValidationResult(False, "not_a_valid_phone_shape")


def _validate_name(value: str) -> ValidationResult:
    if _NAME_LIKE_RE.match(value.strip()):
        return ValidationResult(True, "person_name_shape")
    return ValidationResult(False, "not_name_like_could_be_heading_or_prose")


def _validate_amount(value: str) -> ValidationResult:
    if _MONEY_RE.match(value.strip()):
        return ValidationResult(True, "monetary_shape")
    return ValidationResult(False, "not_a_monetary_value")


def _validate_psc(value: str) -> ValidationResult:
    if _PSC_RE.match(value.strip()):
        return ValidationResult(True, "psc_code_shape")
    return ValidationResult(False, "not_psc_code_shape")


def _validate_freeform(value: str) -> ValidationResult:
    return ValidationResult(bool(value.strip()) and len(value) < 200, "freeform_no_shape_check")


_VALIDATORS: dict[str, Callable[[str], ValidationResult]] = {
    "contract_number": _validate_identifier,
    "solicitation_number": _validate_identifier,
    "type_of_solicitation": _validate_freeform,
    "date_issued": _validate_date,
    "award_date": _validate_date,
    "effective_date": _validate_date,
    "naics": _validate_naics,
    "psc_code": _validate_psc,
    "ueid": _validate_ueid,
    "email": _validate_email,
    "telephone": _validate_phone,
    "contracting_officer_name": _validate_name,
    "contact_name": _validate_name,
    "purchase_request_number": _validate_freeform,
    "issued_by": _validate_freeform,
    "administered_by": _validate_freeform,
    "contractor_name": _validate_freeform,
    "offeror_name": _validate_freeform,
    "amount": _validate_amount,
}


def validate_value(field_key: str, value: str) -> ValidationResult:
    validator = _VALIDATORS.get(field_key)
    if validator is None:
        return ValidationResult(True, "no_validator_defined_for_field")
    return validator(value)
