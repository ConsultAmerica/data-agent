"""driving_licence@1 — driving licences (US/Canadian AAMVA cards, EU/UK
photocard licences and similar).

Fields are read from the printed card: a label then its value, on the
same line ("DOB 01/15/1990", "4b. 12.03.2031") or on the line below. Both
the abbreviated US field names (DLN, DOB, EXP, ISS, CLASS, HGT…) and the
EU numbered fields (1. surname, 2. first names, 3. birth, 4a. issue,
4b. expiry, 4c. authority, 5. number, 8. address, 9. categories) are
understood.

Checks are internal consistency only (dates are real dates and in order,
the licence is or isn't expired on the processing date). Nothing here
verifies that a licence is genuine or currently valid with the issuer.
"""

from __future__ import annotations

import re
from datetime import date

from dateutil import parser as date_parser
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.document import Document
from app.models.document_page import DocumentPage
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
from app.staging.profiles.passport import (
    EXPIRING_WITHIN_DAYS,
    QA_REVIEW,
    _Reading,
    _lines,
    _pages,
    _read_viz,
    expiry_status,
)
from app.staging.provenance import make_provenance

F = FieldDefinition

LICENCE_DATA = DatasetDefinition(
    dataset_id="licence_data",
    display_name="Licence Data",
    cardinality="repeating",
    description="Each field as printed on the licence, with the label it was read under.",
    identity_fields=("licence.field.name",),
    fields=(
        F("licence.field.name", "field", "Field", grounding="none"),
        F("licence.field.value", "value", "Value"),
        F("licence.field.label", "label", "Printed Label", grounding="none"),
    ),
)

LICENCE_CHECKS = DatasetDefinition(
    dataset_id="licence_checks",
    display_name="Checks",
    cardinality="repeating",
    description="Date and completeness checks. Internal consistency only — not proof of authenticity.",
    identity_fields=("licence.check.name",),
    fields=(
        F("licence.check.name", "check", "Check", grounding="none"),
        F("licence.check.result", "result", "Result", grounding="none"),
        F("licence.check.details", "details", "Details", grounding="none"),
    ),
)

VALIDITY = DatasetDefinition(
    dataset_id="validity",
    display_name="Validity",
    cardinality="single",
    description="Licence dates and whether it is still valid on the processing date.",
    fields=(
        F("licence.validity.status", "status", "Status", grounding="none"),
        F("licence.validity.expiry_date", "expiry_date", "Expiry Date", "date", expected=True, grounding="derived"),
        F("licence.validity.days_remaining", "days_remaining", "Days Remaining", "integer", grounding="none"),
        F("licence.validity.issue_date", "issue_date", "Issue Date", "date", grounding="derived"),
        F("licence.validity.age", "age", "Holder Age", "integer", grounding="none"),
    ),
)

# field key → (display label, label phrases). Phrases are matched as whole
# words after folding to lower case; EU field numbers keep their dot so a
# date like "01.02.2030" never reads as a label.
LABELS: dict[str, tuple[str, tuple[str, ...]]] = {
    "licence_number": ("Licence Number", (
        "dl", "dln", "dl no", "dl no.", "dl#", "lic no", "lic no.", "lic#", "license no", "license no.",
        "licence no", "licence no.", "license number", "licence number", "driver license number",
        "driver licence number", "license #", "4d", "4d.", "5.",
    )),
    "surname": ("Surname", ("ln", "last name", "surname", "family name", "1.")),
    "given_names": ("Given Names", ("fn", "first name", "first names", "given names", "given name", "2.")),
    "full_name": ("Name", ("name", "full name")),
    "birth_date": ("Date of Birth", ("dob", "date of birth", "birth date", "born", "3.")),
    "issue_date": ("Issue Date", ("iss", "issued", "issue date", "date of issue", "4a", "4a.")),
    "expiry_date": ("Expiry Date", (
        "exp", "expires", "expiry", "expiration", "expiry date", "expiration date", "valid until",
        "valid to", "4b", "4b.",
    )),
    "authority": ("Issuing Authority", ("issuing authority", "authority", "4c", "4c.")),
    "address": ("Address", ("address", "addr", "8.")),
    "vehicle_class": ("Class / Categories", ("class", "categories", "category", "cat", "9.")),
    "endorsements": ("Endorsements", ("end", "endorsements", "endorse", "9a", "9a.")),
    "restrictions": ("Restrictions", ("rstr", "restr", "restrictions", "restriction", "12.")),
    "sex": ("Sex", ("sex", "gender", "15")),
    "height": ("Height", ("hgt", "height", "ht", "16")),
    "weight": ("Weight", ("wgt", "weight", "wt", "17")),
    "eye_colour": ("Eye Colour", ("eyes", "eye", "eye color", "eye colour", "18")),
    "donor": ("Organ Donor", ("donor", "organ donor")),
}

_PHRASES = sorted(
    ((phrase, key) for key, (_, phrases) in LABELS.items() for phrase in phrases),
    key=lambda item: -len(item[0].split()),
)

DISPLAY_ORDER = (
    "licence_number", "surname", "given_names", "full_name", "birth_date", "sex", "address",
    "issue_date", "expiry_date", "authority", "vehicle_class", "endorsements", "restrictions",
    "height", "weight", "eye_colour", "donor",
)
DATE_FIELDS = {"birth_date": "birth", "issue_date": "issue", "expiry_date": "expiry"}

_LICENCE_WORDS = re.compile(
    r"driver'?s?\s+licen[cs]e|driving\s+licen[cs]e|permis\s+de\s+conduire|f[üu]hrerschein"
    r"|licencia\s+de\s+conducir|operator'?s?\s+licen[cs]e|commercial\s+driver",
    re.IGNORECASE,
)


def licence_date(text: str) -> date | None:
    """A printed licence date: 01/15/1990, 15.01.1990, 1990-01-15,
    15 JAN 1990. Day-first unless the US slash form is unambiguous."""

    cleaned = re.sub(r"[^\w/.\- ]", " ", text).strip()
    match = re.search(r"\d{1,4}[/.\-]\d{1,2}[/.\-]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4}", cleaned)
    if not match:
        return None
    token = match.group(0)
    try:
        # US cards print MM/DD/YYYY with slashes; EU cards DD.MM.YYYY.
        return date_parser.parse(token, dayfirst="/" not in token, fuzzy=False).date()
    except (ValueError, OverflowError):
        return None


def adapt_driving_licence(database: Session, document: Document, *, today: date | None = None) -> AdapterResult:
    today = today or date.today()
    lines = _lines(_pages(database, document))
    readings: dict[str, _Reading] = _read_viz(lines, _PHRASES)

    def provenance(reading: _Reading | None):
        if reading is None:
            return None
        return make_provenance(
            document, page=reading.line.page, evidence=reading.line.text, bbox=reading.bbox,
            extraction_method=f"{reading.line.method}:licence_field",
        )

    dates = {key: licence_date(readings[key].value) for key in DATE_FIELDS if key in readings}
    data_records: list[RawRecord] = []
    for key in DISPLAY_ORDER:
        reading = readings.get(key)
        if reading is None:
            continue
        value = reading.value
        checks: list[ValidationCheck] = []
        # Dates stay as printed (so the value is found on the card); the
        # parsed dates are in Validity.
        if key in DATE_FIELDS and dates.get(key) is None:
            checks.append(ValidationCheck(check="date_format", passed=False,
                                          message=f"'{value}' could not be read as a date."))
        data_records.append(
            RawRecord(
                record_id=f"field:{key}",
                values={"field": LABELS[key][0], "value": value, "label": _printed_label(reading, key)},
                cell_provenance={"value": provenance(reading)},
                cell_checks={"value": checks} if checks else {},
            )
        )

    birth, issue, expiry = dates.get("birth_date"), dates.get("issue_date"), dates.get("expiry_date")
    qa_messages: list[tuple[str, str, str]] = []
    check_records: list[RawRecord] = []

    def check(name: str, ok: bool | None, detail: str) -> None:
        if ok is None:
            return
        check_records.append(RawRecord(f"check:{name}", {
            "check": name, "result": "PASS" if ok else "FAIL", "details": detail if ok else f"Failed: {detail}",
        }))
        if not ok:
            qa_messages.append((name, "REVIEW", f"Failed: {detail}"))

    check("Licence number present", "licence_number" in readings, "A licence number was read from the card.")
    check("Holder name present", any(k in readings for k in ("surname", "given_names", "full_name")),
          "The holder's name was read from the card.")
    check("Date of birth is a real date", birth is not None if "birth_date" in readings else None,
          "The printed date of birth is a valid calendar date.")
    check("Born before today", (birth < today) if birth else None, "The date of birth is in the past.")
    check("Issued after birth", (issue > birth) if issue and birth else None, "The issue date is after the date of birth.")
    check("Expiry after issue", (expiry > issue) if expiry and issue else None, "The expiry date is after the issue date.")

    status, days = expiry_status(expiry, today)
    if status == "Expired":
        qa_messages.append(("Validity", "REVIEW", f"The licence expired on {expiry.isoformat()}."))
    elif status == "Expiring soon":
        qa_messages.append(("Validity", "REVIEW", f"The licence expires within {EXPIRING_WITHIN_DAYS} days."))
    age = None
    if birth:
        age = today.year - birth.year - ((today.month, today.day) < (birth.month, birth.day))
    validity = RawRecord(
        "validity",
        {
            "status": status,
            "expiry_date": expiry.isoformat() if expiry else None,
            "days_remaining": days,
            "issue_date": issue.isoformat() if issue else None,
            "age": age,
        },
        cell_provenance={
            k: p for k, p in (
                ("expiry_date", provenance(readings.get("expiry_date"))),
                ("issue_date", provenance(readings.get("issue_date"))),
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
        records={"licence_data": data_records, "licence_checks": check_records,
                 "validity": [validity], "qa_review": qa_records},
        outcome_provenance=document.ingestion_provenance,
    )


def _printed_label(reading: _Reading, key: str) -> str | None:
    """The label as printed right before the value on the reading's line
    ("DOB", "4b."), when the value is on the label's line."""

    if not reading.value:
        return None
    text = reading.line.text
    match = re.search(rf"(?<!\w){re.escape(reading.value.split()[0])}(?!\w)", text)
    if not match:
        return None
    prefix = text[: match.start()].rstrip(" :")
    for phrase in sorted(LABELS[key][1], key=len, reverse=True):
        if prefix.lower().endswith(phrase) and (len(prefix) == len(phrase) or not prefix[-len(phrase) - 1].isalnum()):
            return prefix[-len(phrase):]
    return None


def recognize_driving_licence(database: Session, document: Document) -> Recognition:
    """The card names itself a driving licence and at least three licence
    field labels are present. Cheap — page text is already stored."""

    text = "\n".join(
        t or "" for t in database.scalars(
            select(DocumentPage.final_text).where(DocumentPage.document_id == document.id)
            .order_by(DocumentPage.page_number).limit(2)
        )
    )
    if not _LICENCE_WORDS.search(text):
        return Recognition(0.0, ["no driving licence title"])
    folded = text.lower()
    found = sorted({
        key for key, (_, phrases) in LABELS.items()
        for phrase in phrases
        if not phrase[0].isdigit() and re.search(rf"(?<![\w]){re.escape(phrase)}(?![\w])", folded)
    })
    if len(found) < 3:
        return Recognition(0.5, [f"driving licence title but only {len(found)} licence field labels"])
    return Recognition(0.92, [f"driving licence title and {len(found)} licence fields ({', '.join(found[:5])})"])


DRIVING_LICENCE_PROFILE = StagingProfile(
    profile_id="driving_licence",
    profile_version=1,
    display_name="Driving Licence",
    description=(
        "Driving licences (US/Canadian and EU/UK layouts): holder, licence number, dates, "
        "class and restrictions read from the card, with date and validity checks."
    ),
    document_families=("driving_licence",),
    datasets=(LICENCE_DATA, LICENCE_CHECKS, VALIDITY, QA_REVIEW),
    adapter=adapt_driving_licence,
    export_capabilities=(
        ExportCapability(
            capability_id="professional_excel",
            label="Professional Excel (staging workbook)",
            format="xlsx",
            href="/api/documents/{document_id}/staging-workbook/export.xlsx",
        ),
    ),
    export_sheets=(
        ExportSheet("Licence Data", ("licence_data",)),
        ExportSheet("Checks", ("licence_checks",)),
        ExportSheet("Validity", ("validity",)),
        ExportSheet(SOURCE_SHEET, ()),
    ),
    document_recognizer=recognize_driving_licence,
    contract_pipeline=False,
    data_class="restricted",
)
