"""The document's own layout, rebuilt from its source structure: headings in
order, form rows under their captions, tables with their printed headers,
each joined to what extraction and review recorded for it.

Nothing here replaces a value. A row's document value is what the page
shows; the extracted / reviewed value comes from the metadata row it was
matched to, and any disagreement between the two is flagged for review.

This is the one place the hierarchy is decided — section › numbered item ›
sub-field, table › row — and each record's data quality. Original
Structure, Smart Review and every export read it from here; none of them
re-derives it.
"""

from __future__ import annotations

import json
import logging
import re
import threading
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.document import Document
from app.models.document_metadata_field import DocumentMetadataField
from app.models.structure_record_review import StructureRecordReview
from app.services.evidence_text import source_text_of
from app.source_structure.models import FieldCandidate, StructuredSourceDocument, TableCandidate
from app.source_structure.service import get_or_build_source_structure
from app.source_structure.text_shapes import infer_value_type, normalize_space
from app.staging.validation import OCR_VERIFY_MIN_CONFIDENCE

logger = logging.getLogger(__name__)

# Flags (each one puts the row in Needs Review).
LABEL_VALUE_MISMATCH = "label_value_mismatch"  # extraction read another value for this label
EVIDENCE_OTHER_FIELD = "evidence_other_field"  # extraction's value sits under another label
CONFLICTING_VALUES = "conflicting_values"  # one canonical field, several different values
PAGE_MISMATCH = "page_mismatch"  # extraction recorded another page for this value
CELL_COLUMN_MISMATCH = "cell_column_mismatch"  # a cell's value doesn't fit its column
MISSED_VALUE = "missed_value"  # extraction found nothing where the page shows a value

FLAG_LABELS = {
    LABEL_VALUE_MISMATCH: "Extraction read a different value for this label",
    EVIDENCE_OTHER_FIELD: "The extracted value belongs to another label",
    CONFLICTING_VALUES: "Several different values were extracted for this field",
    PAGE_MISMATCH: "Extraction recorded a different source page",
    CELL_COLUMN_MISMATCH: "Value doesn't match the rest of its column",
    MISSED_VALUE: "Extraction found no value, but the document shows one",
}

# Data quality: what the source and extraction say about a value, apart
# from its review status. Exactly one per field; per table cell, only the
# cells worth a second look are listed (an empty cell is printed blank).
CONFIRMED = "confirmed"  # read from the source, nothing contradicts it
UNREADABLE = "unreadable"  # the source text can't be read ("�", "#####")
MISSING_EXTRACTION = "missing_extraction"  # the page shows a value, extraction has none
BLANK = "blank"  # printed blank on the source, intentionally empty
CONFLICTING = "conflicting"  # candidates disagree with each other or the page
UNVERIFIED_OCR = "unverified_ocr"  # read by OCR below the verify bar, not yet reviewed
EXTRACTED = "extracted"  # extracted with nothing to check it against on the page

QUALITY_LABELS = {
    CONFIRMED: "Confirmed source value",
    UNREADABLE: "Unreadable source value",
    MISSING_EXTRACTION: "Missing — Review Required",
    BLANK: "Blank in source",
    CONFLICTING: "Conflicting candidates",
    UNVERIFIED_OCR: "Unverified OCR result",
    EXTRACTED: "Extracted value",
}

# Where a record sits on the source, kept apart from its quality: a value
# without coordinates is not, for that reason, a wrong value.
EXACT, PAGE_ONLY, NO_LOCATION = "exact", "page", "none"
SOURCE_LOCATION_LABELS = {
    EXACT: "Exact region on the page",
    PAGE_ONLY: "Source page only (no exact position recorded)",
    NO_LOCATION: "No source position recorded",
}
_CONFLICT_FLAGS = {CONFLICTING_VALUES, LABEL_VALUE_MISMATCH, EVIDENCE_OTHER_FIELD}
# A run of "#" is a value too wide for its printed cell; U+FFFD a glyph that
# couldn't be decoded.
_UNREADABLE_TEXT = re.compile("^#{3,}$|\ufffd")
_REVIEWED = {"Approved", "Corrected"}

# "3. Briefed Through", "9a) Prime Contractor": a numbered form item.
_NUMBERED_ITEM = re.compile(r"^(\d{1,3}[a-z]?[.)])\s+(\S.*)$")

# Document-level metadata shown once above each table, found by the printed
# wording of the field that holds it: metadata_aliases.json, extended by
# the file METADATA_ALIASES_PATH names.
_ALIASES_FILE = Path(__file__).with_name("metadata_aliases.json")


def _alias_key(label: str | None) -> str:
    return normalize_space(label or "").lower().strip(" :.")


@lru_cache(maxsize=1)
def metadata_aliases() -> dict[str, frozenset[str]]:
    """Concept → printed wordings, in display order."""

    from app.core.config import get_settings

    sources = [json.loads(_ALIASES_FILE.read_text(encoding="utf-8"))]
    extra = get_settings().metadata_aliases_path
    if extra:
        try:
            sources.append(json.loads(Path(extra).read_text(encoding="utf-8")))
        except (OSError, ValueError):
            logger.exception("Metadata aliases at %s couldn't be read; using the built-in list", extra)
    aliases: dict[str, set[str]] = {}
    for source in sources:
        for concept, wordings in source.items():
            if concept.startswith("_") or not isinstance(wordings, list):
                continue
            aliases.setdefault(concept, {_alias_key(concept)}).update(_alias_key(w) for w in wordings if isinstance(w, str))
    return {concept: frozenset(wordings) for concept, wordings in aliases.items()}


def metadata_concept(label: str | None) -> str | None:
    """The metadata a printed label names ("Legal Entity" → Contractor
    Name), or None."""

    key = _alias_key(label)
    return next((concept for concept, wordings in metadata_aliases().items() if key in wordings), None)


_CONTRACT_NUMBER = "Contract Number"

# Table columns that name the record a group of rows belongs to. When one
# holds the same value in every row it is that group's metadata: shown once
# above the table instead of in each row (the cells themselves are kept).
_SHARED_COLUMN = re.compile(
    r"^(?:item|contract|contractor|vendor|supplier|customer|po|purchase order|invoice|account|"
    r"oracle project|project|order)(?: (?:name|no\.?|number|#|id|code))?$",
    re.I,
)

# A printed range of two dates ("01/01/2025 - 12/31/2025"): the one composite
# value split into sub-fields, because both parts are certain.
_MONTH = r"(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?"
_DATE = (
    rf"(?:\d{{1,2}}[/.-]\d{{1,2}}[/.-]\d{{2,4}}|\d{{4}}-\d{{2}}-\d{{2}}|{_MONTH}\s+\d{{1,2}},?\s+\d{{4}}"
    rf"|\d{{1,2}}[ -]{_MONTH}[ -]\d{{2,4}})"
)
_DATE_RANGE = re.compile(
    rf"^\s*(?:from\s+)?({_DATE})\s*(?:[-–—]|\s(?:to|through|thru|until)\s)\s*({_DATE})\s*$", re.I
)

# Abbreviations in technical field names ("contract_no", "award_dt").
_ABBREVIATIONS = {
    "no": "Number", "num": "Number", "nbr": "Number", "dt": "Date", "amt": "Amount", "qty": "Quantity",
    "id": "ID", "po": "PO", "desc": "Description", "addr": "Address", "acct": "Account", "inv": "Invoice",
    "uom": "UOM", "cage": "CAGE", "tin": "TIN", "ein": "EIN", "dob": "Date of Birth",
}
_TECHNICAL_NAME = re.compile(r"[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+|[a-z]+(?:[A-Z][a-z0-9]*)+")

# A structure review's status as the grid shows it.
_STRUCTURE_REVIEW_LABELS = {"accepted": "Approved", "edited": "Corrected", "rejected": "Rejected", "added": "Added"}

_REVIEW_LABELS = {
    "pending": "Pending review",
    "accepted": "Approved",
    "edited": "Corrected",
    "rejected": "Rejected",
    "unknown": "Marked unknown",
}

# Value types that a column is consistently of; text is compatible with all.
# More extraction rows than this under one key make it a repeating record.
_REPEATING_KEY = 3
_TYPED_COLUMNS = {"date", "currency", "number", "percentage"}
_COLUMN_MAJORITY = 0.7


# "Section C - Description/Specifications": a Uniform Contract Format part,
# a top-level section wherever it's printed (a heading or a paragraph line).
_UCF_SECTION = re.compile(r"^\s*SECTION\s+([A-M])\s*[-–—:]\s*(\S.{2,90})$", re.IGNORECASE)
# Printed text that is a value, not a heading: codes, dates, form footers.
_CODE_LIKE = re.compile(r"^[A-Z0-9][A-Z0-9./()\-]*\d[A-Z0-9./()\-]*(?:\s+[A-Z0-9]{1,6})?$")
_DATE_LIKE = re.compile(
    r"^\(?\s*(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\.?\s+\d{4})\s*\)?$",
    re.IGNORECASE,
)
_FORM_FOOTER = re.compile(r"^(?:STANDARD|OPTIONAL)\s+FORM\s+\d+", re.IGNORECASE)
# Column captions that a bold table header line shares with headings.
_COLUMN_WORDS = {
    "title", "unit", "unit price", "price", "amount", "quantity", "qty", "description", "item", "items",
    "date", "total", "no", "no.", "number", "name", "page", "requirements", "value", "status", "type",
}


def _heading_is_value(text: str, page_values: set[str]) -> bool:
    plain = normalize_space(text)
    lowered = plain.lower().strip(" :")
    return (
        not plain
        or lowered in _COLUMN_WORDS
        or bool(_CODE_LIKE.match(plain))
        or bool(_DATE_LIKE.match(plain))
        or bool(_FORM_FOOTER.match(plain))
        or _norm(plain) in page_values
    )


def _section_headings(structure: StructuredSourceDocument, candidates: list[FieldCandidate]) -> list[tuple[int, float, str, int]]:
    """(page, y, title, level) for each heading that opens a section.
    Uniform Contract Format parts ("Section C - ...") are level 1; any other
    printed heading is a level-2 subsection when the document has them, or
    level 1 when it doesn't. Text that is a field value, a code, a date or
    a column caption never opens a section."""

    values_by_page: dict[int, set[str]] = {}
    for c in candidates:
        if c.raw_value.strip():
            values_by_page.setdefault(c.page or 0, set()).add(_norm(c.raw_value))
    ucf: list[tuple[int, float, str, int]] = []
    other: list[tuple[int, float, str, int]] = []
    seen_ucf: set[str] = set()
    for region in structure.regions:
        if region.region_type not in ("HEADING", "PARAGRAPH"):
            continue
        page, y = region.page or 0, _y(region.bbox)
        lines = [normalize_space(line) for line in region.text.split("\n") if line.strip()]
        for offset, line in enumerate(lines):
            match = _UCF_SECTION.match(line)
            # A part is printed once as its heading; later mentions repeat it.
            if match and match.group(1).upper() not in seen_ucf:
                seen_ucf.add(match.group(1).upper())
                ucf.append((page, y + offset * 0.01, f"Section {match.group(1).upper()} - {match.group(2).strip()}", 1))
        if region.region_type == "HEADING" and lines and not _UCF_SECTION.match(lines[0]):
            title = normalize_space(region.text)
            if not _heading_is_value(title, values_by_page.get(page, set())):
                other.append((page, y, title, 1))
    if len(ucf) >= 2:
        other = [(p, y, t, 2) for p, y, t, _ in other]
    else:
        ucf = []
    return sorted(ucf + other, key=lambda h: (h[0], h[1]))


def _norm(text: str | None) -> str:
    return re.sub(r"[^a-z0-9$.,/%-]+", " ", (text or "").lower()).strip(" .,:;")


def _tokens(text: str | None) -> set[str]:
    return {t for t in re.split(r"[^a-z0-9]+", (text or "").lower()) if len(t) > 1 and not t.isdigit()}


def _label_similarity(a: str, b: str) -> float:
    ta, tb = _tokens(a), _tokens(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


@dataclass
class _Field:
    candidate: FieldCandidate
    heading: str | None
    flags: list[str] = field(default_factory=list)
    match: DocumentMetadataField | None = None
    # Further metadata rows describing the same printed field.
    others: list[DocumentMetadataField] = field(default_factory=list)
    record_key: str = ""
    # Printed again at the top of a later page (a running header).
    repeated: bool = False


def _usable(candidate: FieldCandidate) -> bool:
    # Accepted pairs, and blanks printed on the form (empty underlines).
    return candidate.acceptance == "accepted" or candidate.reasons == ["empty_value"]


def _y(box) -> float:
    return box[1] if box else 0.0


def _page_of(metadata: DocumentMetadataField) -> int | None:
    page = (metadata.evidence_json or {}).get("page_number") if isinstance(metadata.evidence_json, dict) else None
    return page if isinstance(page, int) and page >= 1 else None


def _extracted_value(metadata: DocumentMetadataField) -> str:
    evidence = metadata.evidence_json if isinstance(metadata.evidence_json, dict) else {}
    machine = evidence.get("machine_value")
    return str(machine if machine not in (None, "") else (metadata.original_value or metadata.value or ""))


def _row_number(table: TableCandidate, row_index: int) -> int | None:
    if not table.rows or row_index >= len(table.rows) or not table.rows[row_index]:
        return None
    text = table.rows[row_index][0].text.strip()
    return int(text) if text.isdigit() else None


def _continues(previous: TableCandidate, following: TableCandidate, between: bool) -> bool:
    """Merge only with evidence of the same table: the structure linked them
    (position, column count, header repeated or absent), nothing else sits
    between them but a running page header, and numbered rows carry on at
    their own step (36 then 37; 260 then 270)."""

    if between or previous.continuation is None or following.continuation is None:
        return False
    if previous.continuation.next_candidate_id != following.candidate_id:
        return False
    last, first = _row_number(previous, len(previous.rows) - 1), _row_number(following, 0)
    if last is not None or first is not None:
        before = _row_number(previous, len(previous.rows) - 2) if len(previous.rows) > 1 else None
        step = last - before if last is not None and before is not None and last > before else 1
        return last is not None and first in {last + 1, last + step}
    return True


def _column_flags(headers: list[str], rows: list[list[str]]) -> dict[tuple[int, int], str]:
    flags: dict[tuple[int, int], str] = {}
    for column in range(len(headers)):
        types = [(index, infer_value_type(row[column])) for index, row in enumerate(rows) if column < len(row) and row[column].strip()]
        if len(types) < 4:
            continue
        counts: dict[str, int] = {}
        for _, kind in types:
            counts[kind] = counts.get(kind, 0) + 1
        dominant, count = max(counts.items(), key=lambda item: item[1])
        if dominant not in _TYPED_COLUMNS or count / len(types) < _COLUMN_MAJORITY:
            continue
        # "#########" (a value too wide for its printed cell), "0/10/2025".
        for index, kind in types:
            if kind != dominant:
                flags[(index, column)] = CELL_COLUMN_MISMATCH
    return flags


def _attach(target: _Field, row: DocumentMetadataField) -> None:
    if target.match is None:
        target.match = row
        return
    target.others.append(row)
    values = {_norm(_extracted_value(m)) for m in (target.match, *target.others)} - {""}
    if len(values) > 1:
        target.flags.append(CONFLICTING_VALUES)
    # Prefer the row that read a value as the one shown.
    if not _norm(_extracted_value(target.match)) and _norm(_extracted_value(row)):
        target.others.remove(row)
        target.others.append(target.match)
        target.match = row


def _match_metadata(fields: list[_Field], metadata_rows: list[DocumentMetadataField]) -> list[DocumentMetadataField]:
    """Attach each metadata row to the layout field it describes; returns
    the rows that have no place in the layout. Rows that read a value are
    placed first, so an empty duplicate can't take a value's place."""

    unplaced: list[DocumentMetadataField] = []
    by_key: dict[str, set[str]] = {}
    rows_per_key: dict[str, int] = {}
    for row in metadata_rows:
        rows_per_key[row.field_key] = rows_per_key.get(row.field_key, 0) + 1
        value = _norm(row.value)
        if value:
            by_key.setdefault(row.field_key, set()).add(value)
    # A key read many times is a repeating record (a value per line item),
    # not one field with conflicting values.
    by_key = {key: values for key, values in by_key.items() if rows_per_key[key] <= _REPEATING_KEY}

    ordered = sorted(metadata_rows, key=lambda m: (not _norm(_extracted_value(m)), m.id))
    for row in ordered:
        extracted = _norm(_extracted_value(row))
        page = _page_of(row)
        same_page = [f for f in fields if page is None or f.candidate.page == page]
        by_value = [f for f in same_page if extracted and _norm(f.candidate.raw_value) == extracted]
        by_label = sorted(
            (f for f in same_page if _label_similarity(f.candidate.label_text, row.label) >= 0.6),
            key=lambda f: (f.match is not None, -_label_similarity(f.candidate.label_text, row.label)),
        )
        target: _Field | None = None
        if by_value:
            # Prefer the value under the label that names it.
            target = max(by_value, key=lambda f: (_label_similarity(f.candidate.label_text, row.label), f.match is None))
            if by_label and by_label[0] is not target and _label_similarity(target.candidate.label_text, row.label) < 0.2:
                target.flags.append(EVIDENCE_OTHER_FIELD)
        elif by_label:
            target = by_label[0]
            printed = _norm(target.candidate.raw_value)
            if not extracted and printed:
                target.flags.append(MISSED_VALUE)
            elif extracted and printed != extracted:
                target.flags.append(LABEL_VALUE_MISMATCH)
        elif extracted:
            # The value is printed under this label on another page.
            elsewhere = [f for f in fields if _norm(f.candidate.raw_value) == extracted
                         and _label_similarity(f.candidate.label_text, row.label) >= 0.6]
            if elsewhere:
                target = elsewhere[0]
                target.flags.append(PAGE_MISMATCH)
        if target is None:
            unplaced.append(row)
            continue
        _attach(target, row)
        if len(by_key.get(row.field_key, ())) > 1:
            target.flags.append(CONFLICTING_VALUES)
    return unplaced


def _review(match: DocumentMetadataField | None, flags: list[str]) -> str:
    if flags and (match is None or match.review_status == "pending"):
        return "Needs review"
    if match is None:
        return "Not reviewed"
    return _REVIEW_LABELS.get(match.review_status, match.review_status)


def _slug(text: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")[:60]


def item_parts(group: str | None, label: str) -> tuple[str, str, str, bool]:
    """(Item #, item name, field name, has sub-fields): "1.", "Contractor
    Information", "Cage", True for a row printed under item 1's caption;
    "3.", "Briefed Through", "Briefed Through", False for an item that is
    its own field; no item name for an unnumbered, uncaptioned label."""

    if group:
        numbered = _NUMBERED_ITEM.match(group.strip())
        if numbered:
            return numbered.group(1), numbered.group(2), label, True
        return "", group.strip(), label, True
    numbered = _NUMBERED_ITEM.match(label.strip())
    if numbered:
        return numbered.group(1), numbered.group(2), numbered.group(2), False
    return "", "", label, False


def display_label(label: str) -> str:
    """A readable name for a technical field identifier ("contract_no" →
    "Contract Number"); printed wording is returned as it is."""

    text = label.strip()
    if not _TECHNICAL_NAME.fullmatch(text):
        return label
    words = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", text).replace("_", " ").split()
    return " ".join(_ABBREVIATIONS.get(word.lower(), word.capitalize()) for word in words)


def composite_parts(value: str | None) -> list[dict[str, str]]:
    """Sub-fields of a value that reliably holds two: only a range of two
    dates. Anything else is left whole; nothing is invented."""

    match = _DATE_RANGE.match(value or "")
    if not match:
        return []
    return [{"label": "Start Date", "value": match.group(1)}, {"label": "End Date", "value": match.group(2)}]


def _is_artifact(payload: dict[str, Any]) -> bool:
    """A "field" made by the layout reader, not printed: no value, no
    extraction row, no flag, no review, and a label with no words."""

    return (
        payload["metadata"] is None
        and not payload["flags"]
        and "structure_review" not in payload
        and not (payload.get("document_value") or "").strip()
        and not (payload.get("effective_value") or "").strip()
        and len(re.findall(r"[A-Za-z]", payload["label"] or "")) < 2
    )


def _shared_columns(headers: list[str], rows: list[dict[str, Any]], printed: bool) -> list[dict[str, Any]]:
    """Columns naming the group every row belongs to (one contract or item
    number in each row): their value once, for display above the table. A
    column whose value changes between rows stays in the rows."""

    if not printed or len(rows) < 2:
        return []
    shared = []
    for column, header in enumerate(headers):
        if not (_SHARED_COLUMN.match(normalize_space(header).strip(" :")) or metadata_concept(header)):
            continue
        values = {normalize_space(((row.get("reviewed_cells") or row["cells"]) + [""] * len(headers))[column]) for row in rows}
        if len(values) == 1 and next(iter(values)):
            shared.append({"column": column, "label": header, "value": next(iter(values))})
    # A table is never reduced to its metadata alone.
    return shared if len(shared) < len(headers) else []


def _unreadable(*texts: str | None) -> bool:
    return any(text and _UNREADABLE_TEXT.search(text.strip()) for text in texts)


def _ocr_unverified(method: str | None, confidence: float | None, contested: bool) -> bool:
    # The staging validator's bar: every OCR word at OCR_VERIFY_MIN_CONFIDENCE.
    return method == "ocr" and (contested or confidence is None or confidence < OCR_VERIFY_MIN_CONFIDENCE)


def _field_quality(payload: dict[str, Any], candidate: FieldCandidate | None) -> str:
    codes = {flag["code"] for flag in payload["flags"]}
    printed = payload.get("document_value")
    extracted = payload.get("extracted_value") or ""
    if _unreadable(printed, extracted):
        return UNREADABLE
    if codes & _CONFLICT_FLAGS:
        return CONFLICTING
    if candidate is None:
        return MISSING_EXTRACTION if not extracted.strip() else EXTRACTED
    if MISSED_VALUE in codes:
        return MISSING_EXTRACTION
    if not (printed or "").strip() and not extracted.strip():
        return BLANK
    if payload["review_status"] not in _REVIEWED and _ocr_unverified(
        candidate.extraction_method, candidate.ocr_confidence, candidate.ocr_contested
    ):
        return UNVERIFIED_OCR
    return CONFIRMED


def _set_quality(payload: dict[str, Any], candidate: FieldCandidate | None) -> None:
    code = _field_quality(payload, candidate)
    payload["quality"] = code
    payload["quality_label"] = QUALITY_LABELS[code]
    if code == UNVERIFIED_OCR and candidate is not None:
        payload["ocr_confidence"] = candidate.ocr_confidence
        payload["ocr_contested"] = candidate.ocr_contested
    _set_location(payload)


def _set_location(record: dict[str, Any]) -> None:
    """Exact region, page only, or nothing: how far the source can be shown."""

    if record.get("value_bbox") or record.get("bbox"):
        code = EXACT
    elif record.get("page"):
        code = PAGE_ONLY
    else:
        code = NO_LOCATION
    record["source_location"] = code


def _box_union(boxes: list[Any]) -> list[float] | None:
    boxes = [b for b in boxes if b]
    if not boxes:
        return None
    return [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]


def _field_payload(item: _Field, review: StructureRecordReview | None = None) -> dict[str, Any]:
    c = item.candidate
    m = item.match
    flags = list(dict.fromkeys(item.flags))
    document_value = c.raw_value
    payload = {
        "kind": "field",
        "id": c.candidate_id,
        "record_key": item.record_key,
        "group": c.section_label,
        "label": c.label_text,
        "document_value": document_value,
        "blank": not document_value.strip(),
        # What extraction read (the matched metadata row) and the value now
        # in effect after review; the page's own value when unmatched.
        "extracted_value": _extracted_value(m) if m else document_value,
        "effective_value": (m.value if m else document_value),
        "evidence": c.evidence_text,
        "review_status": _review(m, flags),
        "value_type": c.value_type_hint,
        "found_by": c.structural_relation.replace("_", " "),
        "page": c.page,
        "bbox": list(c.label_bbox or c.value_bbox or []) or None,
        "value_bbox": list(c.value_bbox) if c.value_bbox else None,
        "flags": [{"code": code, "message": FLAG_LABELS[code]} for code in flags],
        "metadata": _metadata_payload(m) if m else None,
        "other_metadata": [_metadata_payload(o) for o in item.others],
    }
    if item.repeated:
        payload["repeated_header"] = True
    # Fields with an extraction row are reviewed there; the others here.
    if m is None and review is not None:
        payload["review_status"] = _STRUCTURE_REVIEW_LABELS.get(review.status, review.status)
        if review.status != "rejected" and isinstance(review.reviewed_value, str):
            payload["effective_value"] = review.reviewed_value
        payload["structure_review"] = _review_payload(review)
    _set_quality(payload, c)
    payload["parts"] = composite_parts(payload["effective_value"])
    return payload


def _review_payload(review: StructureRecordReview) -> dict[str, Any]:
    return {
        "status": review.status,
        "original_value": review.original_value,
        "reviewed_value": review.reviewed_value,
        "reason": review.reason,
        "reviewed_by": review.actor_name,
        "reviewed_at": review.updated_at.isoformat() if review.updated_at else None,
    }


def _metadata_field_payload(m: DocumentMetadataField, placed_by_page: bool = False) -> dict[str, Any]:
    """An extracted value the layout has no printed field for."""

    payload = {
        "kind": "field",
        "id": f"metadata-{m.id}",
        "record_key": f"metadata:{m.id}",
        "group": None,
        "label": m.label,
        "document_value": None,
        "blank": not (m.value or "").strip(),
        "extracted_value": _extracted_value(m),
        "effective_value": m.value,
        "evidence": source_text_of(m.evidence_json if isinstance(m.evidence_json, dict) else {}) or None,
        "review_status": _review(m, []),
        "value_type": m.value_type or "text",
        "found_by": (m.extraction_method or "").replace("_", " "),
        "page": _page_of(m),
        "bbox": None,
        "value_bbox": None,
        "flags": [],
        "metadata": _metadata_payload(m),
        "other_metadata": [],
        # Shown in the section printed on its page; its exact spot is unknown.
        "placed_by_page": placed_by_page,
    }
    _set_quality(payload, None)
    payload["parts"] = composite_parts(payload["effective_value"])
    return payload


def _document_title(structure: StructuredSourceDocument) -> str | None:
    """The title printed on page 1: a short line set clearly larger than
    everything else on the page."""

    first = [r for r in structure.regions if (r.page or 0) == 1 and r.region_type in ("HEADING", "PARAGRAPH")]
    sized = [(float((r.structural_metadata or {}).get("font_size") or 0), r) for r in first]
    sized = [(size, r) for size, r in sized if size > 0]
    if len(sized) < 3:
        return None
    sizes = sorted(size for size, _ in sized)
    median = sizes[len(sizes) // 2]
    best_size, best = max(sized, key=lambda item: (item[0], -_y(item[1].bbox)))
    text = normalize_space(best.text)
    if (
        best_size >= 1.4 * median
        and 1 <= len(text.split()) <= 12
        and re.search(r"[A-Za-z]{3}", text)
        and not _heading_is_value(text, set())
    ):
        return text
    return None


def _title_leading_section(sections: list[dict[str, Any]], document_title: str | None) -> None:
    """Fields printed before the first heading: titled by the document's
    title; else they are the cover of the first part printed by the next
    page (an SF 33 cover is Section A), which they then open; else they take
    the first heading on their page."""

    lead = sections[0]
    if document_title:
        lead["title"] = document_title
        return
    for entry in sections[1:]:
        if entry["page"] > lead["page"] + 1:
            break
        if entry["level"] == 1 and entry["title"]:
            lead["title"] = entry["title"]
            if not entry["items"]:
                sections.remove(entry)
            return
    lead["title"] = next((e["title"] for e in sections[1:] if e["page"] == lead["page"] and e["title"]), None)


def _metadata_payload(m: DocumentMetadataField) -> dict[str, Any]:
    evidence = m.evidence_json if isinstance(m.evidence_json, dict) else {}
    validation = evidence.get("validation") if isinstance(evidence.get("validation"), dict) else {}
    return {
        "id": m.id,
        "field_key": m.field_key,
        "label": m.label,
        "value": m.value,
        "original_value": m.original_value,
        "review_status": m.review_status,
        "confidence": m.confidence,
        "extraction_method": m.extraction_method,
        "source_text": source_text_of(evidence) or None,
        "page": _page_of(m),
        "validation_status": validation.get("status") or evidence.get("validation_status"),
    }


_LOWER_START = re.compile(r"^[a-z]")
_LETTER_END = re.compile(r"[a-z]$")


def _is_broken_prose(tables: list[TableCandidate]) -> bool:
    """A table with no printed header that is really text cut into a grid
    (boxes drawn around a schedule's prose, or columns guessed from
    alignment): mostly empty cells, text in fewer than two columns, fewer
    than two rows with text, or words split across neighbouring cells
    ("addr" | "ess"). A table with a printed header is never set aside."""

    first = tables[0]
    if first.header_cells:
        return False
    rows = [[cell.text.strip() for cell in row] for table in tables for row in table.rows]
    if not rows:
        return True
    width = max(len(row) for row in rows)
    filled = [row for row in rows if any(row)]
    used = {i for row in rows for i, text in enumerate(row) if text}
    cells = sum(1 for row in rows for text in row if text)
    if len(filled) < 2 or len(used) < 2 or cells / max(1, len(rows) * width) < 0.25:
        return True
    pairs = splits = 0
    for row in rows:
        texts = [text for text in row if text]
        for left, right in zip(texts, texts[1:]):
            pairs += 1
            if _LETTER_END.search(left) and _LOWER_START.match(right):
                splits += 1
    return pairs >= 3 and splits / pairs > 0.3


def _table_payload(
    tables: list[TableCandidate], heading: str | None, table_key: str, reviews: dict[str, StructureRecordReview]
) -> dict[str, Any]:
    first = tables[0]
    headers = list(first.headers) if first.header_cells else [h for h in first.headers]
    rows: list[dict[str, Any]] = []
    texts: list[list[str]] = []
    issues_of: list[list[tuple[int, str]]] = []
    for table in tables:
        for index, row in enumerate(table.rows):
            cells = [cell.text for cell in row]
            texts.append(cells)
            rows.append({
                "source_location": EXACT if any(cell.bbox for cell in row) else (PAGE_ONLY if table.page else NO_LOCATION),
                "id": f"{table.candidate_id}:r{index}",
                "record_key": f"{table_key}:row:{len(rows)}",
                "parent_id": table_key,
                "page": table.page,
                # The row's printed region, for source navigation.
                "bbox": _box_union([cell.bbox for cell in row]),
                "cells": cells,
            })
            issues_of.append([
                (column, UNREADABLE if _unreadable(cell.text) else UNVERIFIED_OCR)
                for column, cell in enumerate(row)
                if cell.text.strip() and (
                    _unreadable(cell.text)
                    or _ocr_unverified(
                        "ocr" if cell.ocr_confidence is not None else table.extraction_method,
                        cell.ocr_confidence,
                        cell.ocr_contested,
                    )
                )
            ])
    flags = _column_flags(headers, texts)
    for (row_index, column), code in flags.items():
        rows[row_index].setdefault("flags", []).append(
            {"code": code, "column": column, "message": FLAG_LABELS[code]}
        )
        rows[row_index]["review_status"] = "Needs review"
    # Rows a reviewer added (missing from the printed table), after it.
    for key in sorted(k for k in reviews if k.startswith(f"{table_key}:added:")):
        review = reviews[key]
        cells = [str(v) for v in (review.reviewed_value or [])]
        rows.append({"id": key, "record_key": key, "page": None, "cells": cells, "added": True})
    for index, row in enumerate(rows):
        review = reviews.get(row["record_key"])
        if review is not None:
            row["review_status"] = _STRUCTURE_REVIEW_LABELS.get(review.status, review.status)
            if review.status != "rejected" and isinstance(review.reviewed_value, list):
                row["reviewed_cells"] = [str(v) for v in review.reviewed_value]
            row["structure_review"] = _review_payload(review)
        if row.get("added"):
            row["parent_id"] = table_key
            continue
        issues = issues_of[index]
        if row.get("review_status") in _REVIEWED:
            # A reviewer checked the row against the source.
            issues = [(column, code) for column, code in issues if code != UNVERIFIED_OCR]
        if issues:
            row["cell_issues"] = [
                {"column": column, "quality": code, "message": QUALITY_LABELS[code]} for column, code in issues
            ]
    return {
        "kind": "table",
        "id": first.candidate_id,
        "shared_columns": _shared_columns(headers, rows, bool(first.header_cells)),
        "record_key": table_key,
        "title": heading,
        "headers": headers,
        "headers_printed": bool(first.header_cells),
        "pages": sorted({t.page for t in tables if t.page}),
        "continued": len(tables) > 1,
        "detection_method": first.detection_method,
        "rows": rows,
        "row_count": len(rows),
    }


def _apply_hierarchy(section_id: str, items: list[dict[str, Any]]) -> None:
    """Each field's place under its numbered item: the item's id, number
    and name, the field's own wording, and whether it opens the item (the
    only row that shows the item's number and name)."""

    previous: str | None = None
    for item in items:
        if item["kind"] != "field":
            item["parent_id"] = section_id
            previous = None
            continue
        number, name, field_name, has_subfields = item_parts(item.get("group"), item["label"])
        item["field_name"] = display_label(field_name)
        if not name:
            item["item"] = None
            item["item_start"] = True
            item["parent_id"] = section_id
            previous = None
            continue
        item_id = f"item:{section_id}:{_slug(number) or 'x'}:{_slug(name)}"
        item["item"] = {"id": item_id, "number": number, "name": name, "has_subfields": has_subfields}
        item["item_start"] = item_id != previous
        item["parent_id"] = item_id
        previous = item_id


def _context_label(item: dict[str, Any]) -> str | None:
    if item["kind"] != "field" or item.get("placed_by_page"):
        return None
    return metadata_concept(item.get("field_name") or item["label"])


def _apply_table_context(sections: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The contract metadata each table belongs to, shown once above it.

    A block of metadata printed in the table's own section, before it, is
    its own ("printed": the document already shows it there). A table with
    none takes the nearest block printed before it ("inherited"), never the
    first one in the document: a brief can describe several contracts.
    Returns the document's first block."""

    def entries(block: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
        # The concept, and the label as the document printed it.
        return [
            {"label": label, "printed_label": normalize_space(block[label].get("field_name") or block[label]["label"]).strip(" :"),
             "value": (block[label].get("effective_value") or "").strip(),
             "record_key": block[label]["record_key"], "page": block[label].get("page")}
            for label in metadata_aliases() if label in block
        ]

    first: list[dict[str, Any]] = []
    inherited: list[dict[str, Any]] = []
    for section in sections:
        block: dict[str, dict[str, Any]] = {}
        for item in section["items"]:
            label = _context_label(item)
            if label:
                block.setdefault(label, item)
                continue
            if item["kind"] != "table":
                continue
            if block:
                inherited = entries(block)
                first = first or inherited
                item["context"], item["context_source"] = inherited, "printed"
                block = {}
            else:
                item["context"] = [e for e in inherited if e["value"]]
                item["context_source"] = "inherited" if item["context"] else None
        if block:
            inherited = entries(block)
            first = first or inherited
    return [e for e in first if e["value"]]


def _reconcile_context(table: dict[str, Any]) -> None:
    """The table's own columns outrank metadata inherited from earlier in
    the document. Rows naming another contract (or several) mark a contract
    boundary: nothing is inherited across it. A column already shown once
    above the table isn't said a second time."""

    if table.get("context_source") != "inherited":
        return
    shared = {metadata_concept(e["label"]): e["value"] for e in table["shared_columns"]}
    own_contract = [i for i, h in enumerate(table["headers"]) if metadata_concept(h) == _CONTRACT_NUMBER]
    inherited = {e["label"]: e["value"] for e in table["context"]}
    crosses = (own_contract and _CONTRACT_NUMBER not in shared) or (
        _CONTRACT_NUMBER in shared and _CONTRACT_NUMBER in inherited
        and _norm(shared[_CONTRACT_NUMBER]) != _norm(inherited[_CONTRACT_NUMBER])
    )
    table["context"] = [] if crosses else [e for e in table["context"] if e["label"] not in shared]
    if not table["context"]:
        table["context_source"] = None


def build_original_layout(
    structure: StructuredSourceDocument,
    metadata_rows: list[DocumentMetadataField],
    reviews: list[StructureRecordReview] | None = None,
) -> dict[str, Any]:
    by_key = {r.record_key: r for r in reviews or []}
    candidates = [c for c in structure.field_candidates if _usable(c)]
    headings = _section_headings(structure, candidates)
    # A heading is never a field: a blank "field" captioned with a heading's
    # own words is that heading read twice.
    heading_text = {(p, _norm(t)) for p, _, t, _ in headings}
    candidates = [
        c for c in candidates
        if c.raw_value.strip() or (c.page or 0, _norm(c.label_text)) not in heading_text
    ]
    tables = [t for t in structure.table_candidates if t.acceptance == "accepted"]

    # One reading-order stream of headings, fields and tables.
    stream: list[tuple[int, float, str, Any]] = [(p, y, "heading", (t, level)) for p, y, t, level in headings]
    stream += [(c.page or 0, _y(c.label_bbox or c.value_bbox), "field", c) for c in candidates]
    stream += [(t.page or 0, _y(t.bbox), "table", t) for t in tables]
    stream.sort(key=lambda item: (item[0], item[1]))

    fields: list[_Field] = []
    sections: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    pending_tables: list[TableCandidate] = []
    # Running-header fields waiting until the table they interrupt ends.
    held: list[_Field] = []
    printed_in_section: set[tuple[str, str]] = set()
    last_kind = None

    parent: str | None = None

    def section(title: str | None, page: int, level: int = 1) -> dict[str, Any]:
        printed_in_section.clear()
        entry = {
            "id": f"section-{len(sections) + 1}", "title": title, "page": page, "items": [],
            "level": level, "parent": parent if level > 1 else None,
        }
        sections.append(entry)
        return entry

    def flush_tables() -> None:
        nonlocal pending_tables, held
        if pending_tables and current is not None:
            current["items"].append(("table", pending_tables))
        if current is not None:
            current["items"].extend(("field", entry) for entry in held)
        pending_tables, held = [], []

    for page, _, kind, item in stream:
        if kind == "heading":
            title, level = item
            # The same heading again on a later page is a running page
            # header (an invoice's letterhead), not a new section: what
            # follows it continues the section, and a table can carry on.
            if current is not None and title == current["title"] and level == current["level"] and page > current["page"]:
                continue
            flush_tables()
            if level == 1:
                parent = title
            current = section(title, page, level)
        elif kind == "field":
            printed = (_norm(item.label_text), _norm(item.raw_value))
            if pending_tables and printed[1] and printed in printed_in_section and page > (pending_tables[-1].page or 0):
                # A field the section already printed, repeated at the top
                # of the page a table continues on: kept, after the table.
                entry = _Field(candidate=item, heading=current["title"], repeated=True)
                fields.append(entry)
                held.append(entry)
                continue
            flush_tables()
            if current is None:
                current = section(None, page)
            printed_in_section.add(printed)
            entry = _Field(candidate=item, heading=current["title"])
            fields.append(entry)
            current["items"].append(("field", entry))
        else:
            if current is None:
                current = section(None, page)
            if pending_tables and _continues(pending_tables[-1], item, between=last_kind != "table"):
                pending_tables.append(item)
            else:
                flush_tables()
                pending_tables = [item]
        last_kind = kind
    flush_tables()

    unplaced = _match_metadata(fields, metadata_rows)

    # Stable keys: page, numbered item, label and occurrence for a field.
    seen: dict[str, int] = {}
    for entry in fields:
        c = entry.candidate
        base = f"field:{c.page or 0}:{_slug(c.section_label)}:{_slug(c.label_text)}"
        entry.record_key = f"{base}:{seen.get(base, 0)}"
        seen[base] = seen.get(base, 0) + 1

    # Leading fields printed before the first heading: under the document's
    # title when it has one, never a made-up "Document start".
    if sections and sections[0]["title"] is None:
        _title_leading_section(sections, _document_title(structure))
    # Subsections printed before any part heading belong to the first section.
    if sections:
        for entry in sections[1:]:
            if entry["level"] == 1:
                break
            entry["parent"] = entry["parent"] or sections[0]["title"]
    has_parts = any(entry["level"] == 2 for entry in sections)

    # An extracted value with no exact position still has a page: it goes to
    # the section printed on that page rather than a catch-all list.
    still_unplaced: list[DocumentMetadataField] = []
    for m in unplaced:
        page = _page_of(m)
        home = None
        if page is not None:
            for entry in sections:
                if entry["page"] <= page:
                    home = entry
        if home is None:
            still_unplaced.append(m)
        else:
            home["items"].append(("metadata", m))

    out_sections = []
    tables_on_page: dict[int, int] = {}
    dropped_tables = 0
    artifacts = 0
    for entry in sections:
        items = []
        for kind, value in entry["items"]:
            if kind == "field":
                payload = _field_payload(value, by_key.get(value.record_key))
                # Left out of the view and exports; the record is untouched.
                if _is_artifact(payload):
                    artifacts += 1
                    continue
                items.append(payload)
            elif kind == "metadata":
                items.append(_metadata_field_payload(value, placed_by_page=True))
            else:
                page = value[0].page or 0
                table_key = f"table:{page}:{tables_on_page.get(page, 0)}"
                tables_on_page[page] = tables_on_page.get(page, 0) + 1
                # Keys are numbered before this check, so they stay stable.
                if _is_broken_prose(value):
                    dropped_tables += 1
                    continue
                items.append(_table_payload(value, entry["title"], table_key, by_key))
        # A printed contract part stays listed even with nothing of its own.
        if items or (has_parts and entry["level"] == 1):
            _apply_hierarchy(entry["id"], items)
            out_sections.append({
                "id": entry["id"], "title": entry["title"], "page": entry["page"],
                "level": entry["level"], "parent": entry["parent"], "items": items,
            })
    # A subsection's parent part, by id as well as by title.
    part_id: str | None = None
    for entry in out_sections:
        if entry["level"] == 1:
            part_id = entry["id"]
        entry["parent_id"] = None if entry["level"] == 1 else part_id

    unplaced_items = [_metadata_field_payload(m) for m in sorted(still_unplaced, key=lambda m: m.id)]
    _apply_hierarchy("unplaced", unplaced_items)
    # Shown once above each table, never repeated in its rows.
    context = _apply_table_context(out_sections)
    for table in (i for s in out_sections for i in s["items"] if i["kind"] == "table"):
        _reconcile_context(table)

    all_items = [i for s in out_sections for i in s["items"] if not i.get("placed_by_page")]
    field_items = [i for i in all_items if i["kind"] == "field"]
    table_items = [i for i in all_items if i["kind"] == "table"]
    quality = {code: 0 for code in QUALITY_LABELS}
    for item in [i for s in out_sections for i in s["items"] if i["kind"] == "field"] + unplaced_items:
        quality[item["quality"]] += 1
    cell_issues = {UNREADABLE: 0, UNVERIFIED_OCR: 0}
    for table in table_items:
        for row in table["rows"]:
            for issue in row.get("cell_issues") or []:
                cell_issues[issue["quality"]] += 1
    return {
        "sections": out_sections,
        "document_title": _document_title(structure),
        "document_context": context,
        "quality_labels": QUALITY_LABELS,
        "unplaced": unplaced_items,
        "stats": {
            "sections": len(out_sections),
            "fields": len(field_items),
            "blank_fields": sum(1 for i in field_items if i["blank"]),
            "tables": len(table_items),
            "table_rows": sum(i["row_count"] for i in table_items),
            "needs_review": sum(1 for i in field_items if i["flags"])
            + sum(1 for t in table_items for r in t["rows"] if r.get("flags")),
            "unplaced": len(still_unplaced),
            "placed_by_page": len(unplaced) - len(still_unplaced),
            # Headerless alignment "tables" that were paragraphs cut into columns.
            "tables_set_aside": dropped_tables,
            # Empty "fields" with no printed label: reader artifacts, not shown.
            "artifacts_hidden": artifacts,
            "quality": quality,
            "cell_issues": cell_issues,
            "source_location": {
                code: sum(1 for i in [i for s in out_sections for i in s["items"] if i["kind"] == "field"] + unplaced_items
                          if i.get("source_location") == code)
                for code in SOURCE_LOCATION_LABELS
            },
        },
        "source_location_labels": SOURCE_LOCATION_LABELS,
    }


_build_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _build_lock(document_id: str) -> threading.Lock:
    with _locks_guard:
        return _build_locks.setdefault(document_id, threading.Lock())


def structure_for(database: Session, document: Document) -> StructuredSourceDocument:
    """The document's source structure, built once: a request arriving while
    it's being built (after processing) waits for that build instead of
    starting another."""

    with _build_lock(document.id):
        return get_or_build_source_structure(database, document)


def prebuild_structure_soon(document_id: str) -> None:
    """Build and store the layout in the background after processing, so the
    first Original Structure view of a large document opens at once."""

    from app.core.config import get_settings

    if not get_settings().prebuild_layout:
        return

    def run() -> None:
        from app.database.session import SessionLocal

        database = SessionLocal()
        try:
            document = database.get(Document, document_id)
            if document is not None:
                structure_for(database, document)
        except Exception:  # noqa: BLE001 - the view builds it on demand instead
            logger.exception("Pre-building the layout of %s failed", document_id)
        finally:
            database.close()

    threading.Thread(target=run, name=f"layout-{document_id[:8]}", daemon=True).start()


def original_layout_for(database: Session, document: Document) -> dict[str, Any]:
    structure = structure_for(database, document)
    metadata_rows = list(
        database.scalars(
            select(DocumentMetadataField)
            .where(DocumentMetadataField.document_id == document.id)
            .order_by(DocumentMetadataField.id)
        )
    )
    reviews = list(
        database.scalars(select(StructureRecordReview).where(StructureRecordReview.document_id == document.id))
    )
    layout = build_original_layout(structure, metadata_rows, reviews)
    return {"document_id": document.id, "source_type": structure.source_type, "pages": structure.stats.pages, **layout}
