"""Generic form-label rejection for scanned government/business forms.

A candidate such as "3. SOLICITATION NUMBER" — or a mashup of several
labels — must never be accepted as another field's *value* merely because
OCR confidence was high.

Wrong-but-confident is worse than blank.
"""

from __future__ import annotations

import re

# Single SF-33 / OF-347 style marker line.
_NUMBERED_LABEL = re.compile(
    r"^(?:\d{1,2}\.|[A-Z]\.)\s+[A-Z][A-Z0-9 /#.'\-]{1,80}$"
)
_BARE_FORM_LABEL = re.compile(
    r"^(?:"
    r"SOLICITATION(?:\s+NUMBER)?|"
    r"TYPE OF SOLICITATION|"
    r"REQUISITION(?:/PURCHASE)?(?:\s+NUMBER)?|"
    r"CONTRACT(?:\s+NUMBER|\s+NO\.?)?|"
    r"ISSUED BY|ISSUED TO|SHIP TO|"
    r"DATE ISSUED|EFFECTIVE DATE|"
    r"NAME|TELEPHONE|EMAIL|ADDRESS|NUMBER|NO\.?|CODE|DATE|TYPE|"
    r"OFFEROR|AWARD|EXT\.?|EXTENSION|"
    r"PAGE\s+\d+\s+OF\s+\d+"
    r")$"
)

# Printed-form instructions in parentheses ("(Type or print)",
# "(mm/dd/yyyy)", "(See instructions)") are boilerplate guidance printed
# next to a blank, not a filled-in value.
_PARENTHETICAL_INSTRUCTION = re.compile(r"^\([A-Za-z0-9 /,.'\-]{2,50}\)$")

# Field markers anywhere (lettered or numbered form cells).
_FIELD_MARKER = re.compile(r"(?:^|[\s/|]+)\d{1,2}\.\s+[A-Z]{2,}")
_LETTERED_MARKER = re.compile(r"(?:^|[\s/|]+)[A-Z]\.\s+[A-Z]{2,}")

# Contaminated multi-cell OCR joined by slash or pipe.
_MULTI_LABEL_MASHUP = re.compile(
    r"(?:\d{1,2}\.|[A-Z]\.)\s+[A-Z][A-Z0-9 /#.'\-]{1,40}"
    r"(?:\s*[|/]\s*(?:\d{1,2}\.|[A-Z]\.)\s+[A-Z])"
)

_SENTENCE_LIKE = re.compile(r"[.!?].*\s+\w+")
_ID_THEN_PROSE = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._/\-]{4,40}\s*[,;:]\s+\S+"
)
_CODE_THEN_NEXT_FIELD = re.compile(
    r"^CODE\s+\S+.+(?:\d{1,2}\.|[A-Z]\.)\s+[A-Z]{2,}",
    re.IGNORECASE,
)

# Table-of-contents / navigation lines: "ATTACHMENT J-1 ........ 69",
# "SECTION B ............. 9". A run of 3+ dot leaders (optionally spaced,
# as OCR often inserts spaces between dots) followed by a bare 1-4 digit
# page number is a page reference, never an extracted field value. This
# is deliberately narrow (dots required) so it never catches ordinary
# numeric field values (amounts, quantities, NAICS codes, ...).
_DOTTED_LEADER = re.compile(r"(?:\.\s?){3,}\s*\d{1,4}\s*$")

# FAR/DFARS clause citation shape: "52.217-9" / "505(b)(6)" optionally
# followed by a comma and the clause's Title Case name — this is a
# *reference*, produced by the dedicated clause-citation scanner, not a
# scalar business field value.
_CLAUSE_CITATION_VALUE = re.compile(
    r"^\d{1,4}(?:\.\d{1,3})?(?:-\d{1,3})?(?:\([a-zA-Z0-9]{1,4}\)){0,4}"
    r"\s*[-,]\s*[A-Z][A-Za-z0-9 /&'\-]{2,80}$"
)


def looks_like_toc_entry(value: str | None) -> bool:
    """True for dotted-leader table-of-contents navigation lines."""

    if not value:
        return False
    text = " ".join(str(value).strip().split())
    if not text:
        return False
    return bool(_DOTTED_LEADER.search(text))


def looks_like_clause_citation_value(value: str | None) -> bool:
    """True for a FAR/DFARS clause citation ("505(b)(6), Post-award...")."""

    if not value:
        return False
    text = " ".join(str(value).strip().split())
    if not text:
        return False
    return bool(_CLAUSE_CITATION_VALUE.match(text))


# Bare nested paragraph/clause numbering ("11.1.1. except", "12.1.3.2.1.",
# "23.1.3", "1.2.2. (Cost") — a section/paragraph pointer picked up next to
# a heading, not a business field value. Distinct from
# _CLAUSE_CITATION_VALUE, which requires a trailing "- Title" / ", Title"
# clause name; this shape has no such suffix, just the bare numbering with
# at most a short trailing fragment truncated by the OCR crop.
_PARAGRAPH_REFERENCE_VALUE = re.compile(
    r"^\d{1,3}(?:\.\d{1,3}){1,5}\.?(?:\s+\S.{0,20})?$"
)


def looks_like_paragraph_reference_value(value: str | None) -> bool:
    """True for a bare nested paragraph/clause numbering reference."""

    if not value:
        return False
    text = " ".join(str(value).strip().split())
    if not text:
        return False
    return bool(_PARAGRAPH_REFERENCE_VALUE.match(text))

# Compact identifiers we accept; everything else with spaces is suspect
# when the field semantics imply an ID.
_COMPACT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/\-]{2,47}$")

_IDENTIFIER_TYPES = frozenset(
    {
        "identifier",
        "id",
        "contract_number",
        "solicitation_number",
        "contract_no",
        "requisition_number",
    }
)


def is_word_not_identifier(value: str) -> bool:
    """A word or sentence fragment picked up from prose where an ID belongs:
    "Contract Number: assigned." on a clause page, "WAWF: point of contact.".
    That is digit-free, has lowercase letters, and is a single word or ends
    in a sentence period. Upper-case codes ("N/A", "SB-DBMACC") and the
    form's own placeholder statements ("Specified on task order", "Not
    Applicable") are left alone."""

    text = " ".join(str(value).split())
    if not text or any(ch.isdigit() for ch in text) or not any(ch.islower() for ch in text):
        return False
    return " " not in text or text.endswith(".")
_DATE_TYPES = frozenset({"date", "effective_date", "date_issued"})
_NAME_TYPES = frozenset({"name", "text", "party", None})


def count_field_markers(value: str) -> int:
    text = " ".join(str(value).strip().split())
    if not text:
        return 0
    numbered = len(_FIELD_MARKER.findall(" " + text))
    lettered = len(_LETTERED_MARKER.findall(" " + text))
    # Avoid double-counting the leading marker when both patterns fire.
    leading = 1 if re.match(r"^(?:\d{1,2}\.|[A-Z]\.)\s+[A-Z]", text) else 0
    return max(numbered + lettered, leading)


def looks_like_form_label(value: str | None) -> bool:
    if value is None:
        return True
    text = " ".join(str(value).strip().split())
    if not text:
        return True
    if _NUMBERED_LABEL.match(text):
        return True
    if _BARE_FORM_LABEL.match(text.upper()):
        return True
    if _PARENTHETICAL_INSTRUCTION.match(text):
        return True
    if _MULTI_LABEL_MASHUP.search(text):
        return True
    if count_field_markers(text) >= 2:
        return True
    # Long Title-Case phrases with no digits are usually labels, not IDs.
    if (
        len(text) > 28
        and not any(ch.isdigit() for ch in text)
        and text == text.title()
    ):
        return True
    # ALL-CAPS table/column-header captions ("DESCRIPTION OF SUPPLIES/
    # SERVICES AMOUNT") read like a normal organization name in caps
    # (also common on government forms) EXCEPT for the "/"-joined
    # multi-concept shape a real name never has — require it so this
    # doesn't reject legitimate all-caps contractor/entity names.
    words = text.split()
    if (
        "/" in text
        and len(words) >= 3
        and len(text) > 20
        and not any(ch.isdigit() for ch in text)
        and text == text.upper()
    ):
        return True
    return False


def looks_like_identifier_sentence(value: str | None) -> bool:
    """Reject prose/sentences/labels proposed as compact identifiers."""

    if value is None:
        return True
    text = " ".join(str(value).strip().split())
    if not text:
        return True
    if looks_like_form_label(text):
        return True
    if count_field_markers(text) >= 1 and not _COMPACT_ID.match(
        text.replace(" ", "")
    ):
        # "CODE 47QRCA 8. ADDRESS…" or any marker-bearing non-compact string.
        return True
    if _CODE_THEN_NEXT_FIELD.match(text):
        return True
    if _ID_THEN_PROSE.match(text):
        return True
    if len(text) > 40 and " " in text:
        return True
    if _SENTENCE_LIKE.search(text):
        return True
    if re.search(r"\s+(?:\d{1,2}\.|[A-Z]\.)\s+[A-Z]{2,}", text):
        return True
    if "/" in text and count_field_markers(text) >= 1:
        return True
    return False


# Common function words. A real field value (a name, an ID, a phone
# number, a short address) is dense with proper nouns/digits and sparse
# with these; a stray sentence pulled in from surrounding prose ("...as
# only these two individuals will receive the original file") is the
# opposite — mostly function words holding a clause together.
_FUNCTION_WORDS = frozenset(
    {
        "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
        "up", "to", "in", "on", "at", "by", "of", "for", "and", "or", "as",
        "only", "these", "those", "this", "that", "will", "would", "shall",
        "should", "can", "could", "may", "might", "must", "with", "from",
        "into", "onto", "so", "than", "then", "if", "not", "no", "receive",
        "which", "who", "whom", "their", "its", "his", "her", "our", "your",
    }
)
_NARRATIVE_WORD_COUNT_FLOOR = 8
_NARRATIVE_FUNCTION_WORD_RATIO = 0.35


def looks_like_narrative_fragment(value: str | None) -> bool:
    """Reject mid-sentence OCR slices proposed as dates/names/IDs."""

    if value is None:
        return True
    text = " ".join(str(value).strip().split())
    if not text:
        return True
    lowered = text.lower()
    if lowered.startswith(("of ", "to ", "the ", "and ", "or ", "for ", "any ")):
        return True
    if " of any " in lowered or " current as of " in lowered:
        return True

    words = re.findall(r"[a-z']+", lowered)
    if len(words) >= _NARRATIVE_WORD_COUNT_FLOOR:
        function_count = sum(1 for word in words if word in _FUNCTION_WORDS)
        if function_count / len(words) >= _NARRATIVE_FUNCTION_WORD_RATIO:
            return True

    # A long sentence-case run ending in terminal punctuation is prose
    # even when it's information-dense enough to dodge the function-word
    # ratio above ("Government property includes both Government-
    # furnished and contractor-acquired property necessary to perform
    # this contract."). Real field values — names, IDs, addresses,
    # dates — don't end a multi-word run with a period; that shape is
    # specific to a written sentence.
    if (
        len(words) >= 10
        and text[-1] in ".!?"
        and text[0].isupper()
        and not text.isupper()
    ):
        return True

    return False


# A label noun closing a short all-caps phrase: "FACILITY CODE", "DATE
# SIGNED", "CONTRACT NO." are the form's labels, not values.
_LABEL_NOUN_TAIL = re.compile(
    r"^[A-Z][A-Z/&\-]*(?:\s+[A-Z][A-Z/&\-]*){0,3}\s+"
    r"(?:CODE|NO\.?|NUMBER|DATE|NAME|ADDRESS|TITLE|TELEPHONE|PHONE|EMAIL|SIGNATURE)$"
)
# Only "LABEL:" tokens, no value between them: "FAX: TEL:".
_LABELS_ONLY = re.compile(r"^(?:[A-Za-z][A-Za-z.\-/ ]{0,24}:\s*){1,4}$")
# The printed form's own footer: form number, NSN stock number, edition note.
_FORM_FOOTER = re.compile(
    r"\bSTANDARD FORM\s+\d{2,4}\b|\bNSN\s*\d{4}-\d{2}-\d{3}-\d{4}\b|\bPREVIOUS EDITIONS?\b"
    r"|\bPRESCRIBED BY\s+(?:GSA|OPM|DOD)\b",
    re.IGNORECASE,
)
# The discovered key itself is an identifier ("kv_n4019221r28000019" from a
# solicitation number, "kv_nsn_7540_..." from a stock number): the pair is
# backwards, so the "value" is whatever followed the identifier.
_KEY_IS_IDENTIFIER = re.compile(r"^kv_(?:nsn_|(?=[a-z0-9]*\d{4})[a-z]{0,3}\d[a-z0-9]{5,}$)")
# A FAR/DFARS citation split at its dot: key "..._52", value "216-7, ...".
_SPLIT_CITATION_VALUE = re.compile(r"^\d{3}-\d{1,4}\b")
_CAGE_RE = re.compile(r"^[A-Z0-9]{5}$")


def pairing_rejection(text: str, field_key: str | None = None) -> str | None:
    """Why a label/value pair is not a real field, judged from the value's
    shape and, for discovered pairs, the key it was filed under."""

    if _LABELS_ONLY.match(text) and ":" in text:
        return "value_is_labels_only"
    if _LABEL_NOUN_TAIL.match(text):
        return "value_is_a_label"
    if _FORM_FOOTER.search(text):
        return "form_footer"
    key = (field_key or "").lower()
    if key:
        if _KEY_IS_IDENTIFIER.match(key):
            return "label_is_an_identifier"
        if (key.endswith("_52") or key.endswith("_252")) and _SPLIT_CITATION_VALUE.match(text):
            return "split_clause_citation"
        if key in {"cage_code", "cage"} and not _CAGE_RE.match(text.replace(" ", "").upper()):
            return "cage_code_shape"
    return None


def reject_as_field_value(
    value: str | None,
    *,
    value_type: str | None = None,
    known_labels: frozenset[str] | None = None,
    field_key: str | None = None,
) -> str | None:
    """Return a rejection reason, or None if the value is acceptable.

    Applies to *all* discovered field types — not only identifiers.
    """

    if value is None or not str(value).strip():
        return "empty_value"
    text = " ".join(str(value).strip().split())
    if known_labels and text.lower() in {label.lower() for label in known_labels}:
        return "matches_known_label"
    if looks_like_toc_entry(text):
        return "toc_entry"
    effective_type_early = (value_type or "").lower() or None
    if effective_type_early != "clause" and looks_like_clause_citation_value(text):
        return "clause_citation_reference"
    if looks_like_form_label(text):
        return "looks_like_form_label"
    pair_reason = pairing_rejection(text, field_key)
    if pair_reason:
        return pair_reason
    # Leftover label tokens after a failed split ("NUMBER", "NO.", "CODE").
    if text.upper() in {
        "NUMBER",
        "NO",
        "NO.",
        "CODE",
        "DATE",
        "TYPE",
        "NAME",
        "ADDRESS",
        "TELEPHONE",
        "EMAIL",
    }:
        return "bare_label_token"
    if count_field_markers(text) >= 2:
        return "multi_label_mashup"
    if _MULTI_LABEL_MASHUP.search(text):
        return "multi_label_mashup"
    if _CODE_THEN_NEXT_FIELD.match(text):
        return "cross_cell_contamination"

    effective_type = (value_type or "").lower() or None
    key = (field_key or "").lower()

    if (
        effective_type in _IDENTIFIER_TYPES
        or key in _IDENTIFIER_TYPES
        or key.endswith("_number")
        or key.endswith("_no")
        or key.endswith("_id")
    ):
        if looks_like_identifier_sentence(text):
            return "identifier_looks_like_prose_or_label"
        if is_word_not_identifier(text):
            return "identifier_is_a_word"
        if not _COMPACT_ID.match(text.replace(" ", "")):
            if " " in text or "," in text:
                return "identifier_not_compact"

    if effective_type in _DATE_TYPES or "date" in key:
        if looks_like_form_label(text) or count_field_markers(text) >= 1:
            return "date_looks_like_form_label"
        if looks_like_narrative_fragment(text):
            return "date_looks_like_narrative"

    if effective_type in {"name"} or key in {"name", "issued_by", "ship_to"}:
        if looks_like_form_label(text) or count_field_markers(text) >= 1:
            return "name_looks_like_form_heading"
        if looks_like_narrative_fragment(text):
            return "name_looks_like_narrative"

    # "clause" is the one type where long prose IS the correct value
    # (a full FAR/DFARS clause). "text"/"address" used to be exempted
    # too, but that's too broad a loophole — most generic discovered
    # fields default to "text", which silently disabled narrative
    # rejection for the majority of real fields. The word-ratio check
    # above is tuned to leave genuine short descriptive values alone.
    if looks_like_narrative_fragment(text) and effective_type not in {"clause"}:
        return "narrative_fragment"

    return None
