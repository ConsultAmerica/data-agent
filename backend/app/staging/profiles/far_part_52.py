"""far_part_52@1 — FAR Part 52 regulation staging profile.

    FAR HTML ─► DOM records (app/far/dom.py); FAR PDF ─► page-text records (app/far/text.py)
             ─► canonical FAR model, persisted (document_far_records)
             ─► presentation: FAR Clauses & Provisions (FAR semantics),
                Oracle Output (target shape, kept separate), Source
             ─► validation as QA rows; FAR workbook, CSVs, canonical JSON,
                and the technical transformation workbook (01–08 + 99)

Resolution needs strong structural evidence from the document itself (a
Part 52 heading or Subpart 52.x headings, plus many numbered FAR headings
opening their own sections); a contract that merely cites FAR clauses, or
a file merely named "part_52", is never recognized. Deterministic — no AI.
"""

from __future__ import annotations

import re
from pathlib import Path

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.far import exports as far_exports
from app.far import regulation, views
from app.far.canonical import (
    PROVENANCE_KEY,
    SUBPART,
    is_pdf_source,
    load_far_records,
    materialize_far_records,
    page_texts,
)
from app.far.dom import recognize_far_part
from app.far.text import recognize_far_text
from app.models.document import Document
from app.models.document_far_record import DocumentFarRecord
from app.services.document_storage import ensure_local_copy
from app.staging.models import (
    CellProvenance,
    ExportCapability,
    ProfileView,
    SourceLocator,
    ValidationCheck,
)
from app.staging.profile import (
    AdapterResult,
    DatasetDefinition,
    ExportArtifact,
    FieldDefinition,
    RawRecord,
    Recognition,
    StagingProfile,
)
from app.staging.provenance import make_provenance

F = FieldDefinition
FAMILY = "far_regulation"
_HTML_SUFFIXES = {".html", ".htm"}
_EVIDENCE_CHARS = 300

# The FAR interpretation of the source — FAR semantics only.
_FAR_RECORD_FIELDS = (
    ("far_number", "FAR Number", "code", "evidence", True),
    ("title", "Title", "text", "evidence", True),
    ("record_type", "Record Type", "text", "derived", True),
    ("far_part", "FAR Part", "text", "derived", False),
    ("far_part_title", "FAR Part Title", "text", "derived", False),
    ("far_subpart", "FAR Subpart", "text", "derived", False),
    ("far_subpart_title", "FAR Subpart Title", "text", "derived", False),
    ("far_section", "FAR Section", "code", "derived", False),
    ("record_status", "Record Status", "text", "derived", False),
    ("revision_date", "Revision Date", "text", "derived", False),
    ("description", "Description", "text", "evidence", False),
    ("prescription", "Prescription / Usage", "text", "evidence", False),
    ("prescription_reference", "Prescription Reference", "text", "derived", False),
    ("alternate", "Alternate", "text", "evidence", False),
    # Part 53 (Forms) only.
    ("form_number", "Form Number", "text", "derived", False),
    ("form_name", "Form Name", "text", "derived", False),
    ("form_type", "Form Type", "text", "derived", False),
    ("prescribing_reference", "Prescribing FAR Reference", "text", "derived", False),
    ("form_usage", "Form Usage", "text", "derived", False),
    ("supersession", "Replacement / Supersession", "text", "derived", False),
    ("cross_references", "Cross References", "text", "derived", False),
    ("provision_text", "Provision Text", "text", "derived", False),
    ("clause_text", "Clause Text", "text", "derived", False),
    ("section_text", "Section Text", "text", "derived", False),
    ("source_reference", "Source Reference", "text", "none", False),
)

FAR_RECORDS = DatasetDefinition(
    dataset_id="far_records",
    display_name="FAR Clauses & Provisions",
    cardinality="repeating",
    description=(
        "Every FAR record in source order — clauses, provisions, sections, subparts and reserved records. "
        "An alternate follows its basic record and keeps its FAR Number. A provision's body is in "
        "Provision Text, a clause's in Clause Text, a regulation section's in Section Text — one per "
        "record; text is verbatim."
    ),
    identity_fields=("far.record.far_number", "far.record.alternate", "far.record.title"),
    grid_fields=tuple(f"far.record.{key}" for key, *_ in _FAR_RECORD_FIELDS),
    # The tab shows the complete file: every field, full texts included.
    full_text_grid=True,
    fields=tuple(
        F(f"far.record.{key}", key, label, value_type, expected=expected, grounding=grounding)
        for key, label, value_type, grounding, expected in _FAR_RECORD_FIELDS
    ),
)

_ORACLE_KEYS = tuple(
    (re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_"), label) for label in views.ORACLE_OUTPUT_COLUMNS
)

ORACLE_OUTPUT = DatasetDefinition(
    dataset_id="far_oracle_output",
    display_name="Oracle Output",
    cardinality="repeating",
    role="transform",
    description=(
        "The FAR records shaped for the Oracle Fusion clause library. Library values (Action, Intent, "
        "Language, Clause Type, Status, Yn flags, Attribute Category) apply to load-eligible records only; "
        "the FAR view is never changed to fit this target."
    ),
    identity_fields=("far.oracle.number", "far.oracle.display_name"),
    grid_fields=tuple(f"far.oracle.{key}" for key, _ in _ORACLE_KEYS),
    fields=tuple(F(f"far.oracle.{key}", key, label, grounding="derived") for key, label in _ORACLE_KEYS),
)

FAR_SOURCE = DatasetDefinition(
    dataset_id="far_source",
    display_name="Source",
    cardinality="repeating",
    role="source",
    description="The source document, what it contains, and how every value traces back to it.",
    identity_fields=("far.source.item",),
    fields=(
        F("far.source.item", "item", "Item", grounding="none"),
        F("far.source.detail", "detail", "Detail", grounding="none"),
    ),
)

QA_REVIEW = DatasetDefinition(
    dataset_id="qa_review",
    display_name="QA Review",
    cardinality="repeating",
    role="qa",
    identity_fields=("qa.check", "qa.details"),
    fields=(
        F("qa.check", "qa_check", "QA Check", grounding="none"),
        F("qa.result", "result", "Result", grounding="none"),
        F("qa.details", "details", "Details", grounding="none"),
        F("qa.action", "action", "Action", grounding="none"),
    ),
)


# --- recognition -----------------------------------------------------------------------------


def recognize_far_document(database: Session, document: Document) -> Recognition:
    """Any FAR Part — Part 52's clauses or a policy Part (15, 46, 49 …) —
    as HTML (its DOM) or as a PDF printed from acquisition.gov (its stored
    page text)."""

    if is_pdf_source(document):
        pages = page_texts(database, document)
        if not any(text for _page, text in pages):
            return Recognition(0.0, ["no page text"])
        recognition = recognize_far_text(pages)
        return Recognition(recognition.score, recognition.reasons)
    if Path(document.stored_filename or "").suffix.lower() not in _HTML_SUFFIXES:
        return Recognition(0.0, ["not an HTML or PDF source"])
    try:
        raw = ensure_local_copy(get_settings(), stored_filename=document.stored_filename).read_bytes()
    except Exception:
        return Recognition(0.0, ["source file unavailable"])
    # Cheap pre-check before parsing: FAR Part / Subpart structure markers.
    if b"Subpart" not in raw and b"Part " not in raw:
        return Recognition(0.0, ["no FAR Part structure markers"])
    recognition = recognize_far_part(raw)
    return Recognition(recognition.score, recognition.reasons)


# --- adapter ---------------------------------------------------------------------------------


def _locator(row: DocumentFarRecord, dom_path: str | None = None) -> SourceLocator:
    prov = row.provenance_json or {}
    return SourceLocator(
        dom_path=dom_path or prov.get("dom_path"),
        element_id=prov.get("element_id"),
        section_path=list(prov.get("section_path") or []),
    )


def _source(document: Document, row: DocumentFarRecord) -> dict:
    """Where a record's provenance points: an HTML record by its DOM path,
    a PDF record by the page its heading is on."""

    if is_pdf_source(document):
        return {"page": (row.provenance_json or {}).get("page"), "extraction_method": "far_text", "source_type": "pdf"}
    return {"page": None, "extraction_method": "far_dom", "source_type": "html"}


def _prov(
    document: Document,
    row: DocumentFarRecord,
    evidence: str | None,
    dom_path: str | None = None,
    *,
    excerpt: bool = False,
) -> CellProvenance | None:
    """Evidence is the source element's own text. A whole-record text
    (derived: the record's blocks) is evidenced by its opening excerpt; a
    literal value's evidence is never shortened."""

    if not evidence:
        return None
    if excerpt and len(evidence) > _EVIDENCE_CHARS:
        evidence = evidence[:_EVIDENCE_CHARS]
    provenance = make_provenance(
        document,
        evidence=evidence,
        locator=_locator(row, dom_path),
        anchor=(row.heading_text or row.far_number)[:80],
        **_source(document, row),
    )
    # The highlight is the evidence element itself — set here so the engine
    # never scans a 40,000-character clause text for a literal match.
    provenance.highlight_text = evidence.split("\n", 1)[0] if excerpt else evidence
    return provenance


def _heading_evidence(row: DocumentFarRecord) -> str:
    return row.heading_text or row.far_number


# --- derivation checks ---------------------------------------------------------------------
# Derived values (normalized dates, prescribing section, clause/provision
# type) are Verified only when the deterministic rule has exactly one
# answer in the retained source evidence; otherwise Needs Review. Agreement
# with any reference workbook is never an input.

_DATE_PAREN = re.compile(r"\(\s*[A-Za-z]{3,9}\.?\s*\d{4}\s*\)")
_SECTION_REF = re.compile(r"\d+\.\d+(?:-\d+)*")
_KIND = re.compile(r"\b(provision|clause)s?\b", re.I)
_END_OF = re.compile(r"^\(End of (provision|clause)\)$", re.I | re.M)


def _check(name: str, ok: bool, message: str) -> ValidationCheck:
    return ValidationCheck(check=name, passed=ok, message=None if ok else message)


def _date_check(date: str | None, evidence: str | None) -> list[ValidationCheck]:
    """Month YYYY from a heading: the heading has exactly one (Month YYYY)
    and the value's month and year are that one."""

    if not date or not evidence:
        return []
    month, _, year = date.partition(" ")
    dates = _DATE_PAREN.findall(evidence)
    return [
        _check(
            "date_in_heading",
            len(dates) == 1 and year in dates[0] and month[:3].casefold() in dates[0].casefold(),
            "The heading does not carry exactly one (Month YYYY) matching this date.",
        )
    ]


def _prescription_lead(text: str) -> str:
    """"As prescribed in 32.205(b) and 32.206, insert ..." -> the part naming
    the prescribing section(s)."""

    return re.split(r",|\binsert\b|\buse\b|\badd\b|\bsubstitute\b", text, maxsplit=1)[0]


def _prescription_reference_check(reference: str | None, prescription: str | None) -> list[ValidationCheck]:
    if not reference or not prescription:
        return []
    refs = set(_SECTION_REF.findall(_prescription_lead(prescription)))
    return [
        _check(
            "single_prescribing_section",
            refs == {reference},
            "The prescription names more than one prescribing section; confirm which applies."
            if len(refs) > 1
            else "The prescribing section could not be confirmed in the prescription text.",
        )
    ]


def _clause_type_check(row: DocumentFarRecord) -> list[ValidationCheck]:
    """Clause / Provision: the prescription's "insert the following X" and
    the record's own "(End of X)" marker must name one kind."""

    if not row.clause_type:
        return []
    kinds: set[str] = set()
    if row.prescription:
        head = row.prescription.split(":", 1)[0]
        insert = re.search(r"\b(?:insert|use)\b(.*)", head, re.I)
        kinds |= {k.lower() for k in _KIND.findall(insert.group(1) if insert else head)}
    kinds |= {k.lower() for k in _END_OF.findall(row.source_text or "")}
    return [
        _check(
            "unambiguous_clause_type",
            kinds == {row.clause_type.lower()},
            "The source names this record both a clause and a provision (prescription vs. end marker); confirm its type.",
        )
    ]


def _status(row: DocumentFarRecord) -> str | None:
    return "Needs Review" if row.issues else None


def _references_evidence(row: DocumentFarRecord, window: int = 60) -> str:
    """Each embedded reference in its own words: "… (see 52.104) …"."""

    text = row.source_text or ""
    snippets = []
    for ref in row.embedded_references or []:
        match = re.search(r"(?<![\d.])" + re.escape(ref) + r"(?!\d)(?!-\d)", text)
        if match:
            snippet = text[max(0, match.start() - window) : match.end() + window].replace("\n", " ").strip()
            snippets.append(f"… {snippet} …")
    return "\n".join(snippets)


def _base_cell_provenance(document: Document, row: DocumentFarRecord) -> dict[str, CellProvenance]:
    prov = row.provenance_json or {}
    heading = _prov(document, row, _heading_evidence(row), prov.get("heading_dom_path"))
    cells: dict[str, CellProvenance] = {}
    if row.official_heading:
        cells["official_heading"] = _prov(document, row, row.official_heading, prov.get("official_heading_dom_path"))
        cells["revision_date"] = cells["official_heading"]
        cells["subtitle"] = cells["official_heading"]
    if row.prescription:
        cells["prescription"] = _prov(document, row, row.prescription, prov.get("prescription_dom_path"))
        cells["prescription_reference"] = cells["prescription"]
    if row.clause_type and prov.get("clause_type_evidence"):
        cells["clause_type"] = _prov(document, row, prov["clause_type_evidence"])
    if row.source_text:
        cells["section_text"] = _prov(document, row, row.source_text, excerpt=True)
        cells["source_text"] = cells["section_text"]
    if row.embedded_references and row.source_text:
        cells["embedded_references"] = _prov(document, row, _references_evidence(row), prov.get("dom_path"))
    if row.content_type == SUBPART and row.subpart_title:
        cells["subtitle"] = heading
    return {k: v for k, v in cells.items() if v is not None} | {"_default": heading}


def _raw(record_id: str, values: dict, cells: dict[str, CellProvenance], row: DocumentFarRecord, checks=None) -> RawRecord:
    default = cells.pop("_default", None)
    return RawRecord(
        record_id=record_id,
        values=values,
        provenance=default,
        cell_provenance=cells,
        builder_status=_status(row),
        cell_checks=checks or {},
    )


def _alternate_cells(document: Document, row: DocumentFarRecord) -> dict[str, CellProvenance]:
    """An alternate's own values point at its heading paragraph; values it
    shares with its basic clause (FAR number, title) at the clause heading."""

    prov = row.provenance_json or {}
    evidence = row.alternate_heading if not row.alternate_instruction else f"{row.alternate_heading}. {row.alternate_instruction}"
    heading = _prov(document, row, evidence, prov.get("dom_path"))
    cells = {
        key: heading
        for key in ("alternate_code", "alternate_date", "version_date", "alternate_heading", "alternate_instruction", "prescription_reference")
    }
    if row.source_text:
        cells["alternate_text"] = cells["source_text"] = _prov(document, row, row.source_text, prov.get("dom_path"), excerpt=True)
    cells["_default"] = _prov(document, row, _heading_evidence(row), prov.get("record_dom_path"))
    return cells


def _far_record(
    document: Document, row: DocumentFarRecord, parents: dict[str, DocumentFarRecord], part_title: str | None = None
) -> RawRecord:
    values = views.far_record_row(row, parents, document.original_filename, part_title)
    keys = {label: key for key, label, *_ in _FAR_RECORD_FIELDS}
    if views.is_alternate_row(row):
        source = _alternate_cells(document, row)
        cells = {
            "revision_date": source.get("version_date"),
            "description": source.get("alternate_heading"),
            "prescription": source.get("alternate_instruction"),
            "prescription_reference": source.get("prescription_reference"),
            "alternate": source.get("alternate_code"),
            "provision_text": source.get("source_text"),
            "clause_text": source.get("source_text"),
        }
        checks = {
            "revision_date": _date_check(row.version_date, row.alternate_heading),
            "prescription_reference": _prescription_reference_check(row.prescription_reference, row.alternate_instruction),
        }
    else:
        source = _base_cell_provenance(document, row)
        cells = {
            "revision_date": source.get("revision_date"),
            "description": source.get("official_heading"),
            "prescription": source.get("prescription"),
            "prescription_reference": source.get("prescription_reference"),
            "record_type": source.get("clause_type"),
            "cross_references": source.get("embedded_references"),
            "provision_text": source.get("section_text"),
            "clause_text": source.get("section_text"),
            "section_text": source.get("section_text"),
        }
        if row.content_type == SUBPART:
            cells["title"] = source.get("subtitle")
        checks = {
            "revision_date": _date_check(row.version_date, row.official_heading),
            "prescription_reference": _prescription_reference_check(row.prescription_reference, row.prescription),
            "record_type": _clause_type_check(row),
        }
    cells = {key: value for key, value in cells.items() if value is not None}
    cells["_default"] = source["_default"]
    return _raw(
        f"far_records:{row.clause_key}",
        {keys[label]: value for label, value in values.items()},
        cells,
        row,
        checks,
    )


def _oracle_record(document: Document, row: DocumentFarRecord) -> RawRecord:
    exported = views.oracle_output_row(row)
    prov = row.provenance_json or {}
    default = make_provenance(
        document,
        evidence=row.official_heading or row.heading_text or row.far_number,
        region_id=row.clause_key,
        anchor=row.official_heading or row.far_number,
        locator=_locator(row, prov.get("dom_path")),
        **_source(document, row),
    )
    # Target values are transformations, not literals in the source: the
    # record's heading is what to highlight (and the engine never searches
    # a whole clause text for a match).
    default.highlight_text = default.evidence_text
    return _raw(
        f"far_oracle_output:{row.clause_key}",
        {key: exported[label] for key, label in _ORACLE_KEYS},
        {"_default": default},
        row,
    )


def adapt_far(database: Session, document: Document) -> AdapterResult:
    rows = load_far_records(database, document)
    summary = (document.ingestion_provenance or {}).get(PROVENANCE_KEY) or {}
    parents = views.far_parents(rows)
    part = views.document_part(rows)
    part_title = regulation.part_title(summary.get("part_heading"))
    qa_rows = [
        RawRecord(
            record_id=f"qa:far:{index}",
            values={
                "qa_check": check["Check"],
                "result": check["Result"],
                "details": check["Notes"],
                "action": "None." if check["Result"] == "PASS" else "Review against the source.",
            },
        )
        for index, check in enumerate(views.validation_rows(rows, summary))
    ]
    records = {
        "far_records": [_far_record(document, row, parents, part_title) for row in rows],
        "far_oracle_output": [_oracle_record(document, row) for row in rows],
        "far_source": [
            RawRecord(record_id=f"far_source:{index}", values={"item": item["Item"], "detail": item["Detail"]})
            for index, item in enumerate(views.source_rows(rows, summary, document.original_filename))
        ],
        "qa_review": qa_rows,
    }
    if part == "52":
        return AdapterResult(records=records, outcome_provenance=document.ingestion_provenance)
    # Any other Part: one FAR Data table; a record's text is its regulatory text.
    return AdapterResult(
        records=records,
        outcome_provenance=document.ingestion_provenance,
        column_labels={"far_records": {"far.record.section_text": "Description / Regulatory Text"}},
        dataset_names={"far_records": "FAR Data"},
        dataset_descriptions={
            "far_records": (
                "Every numbered section and subsection of the Part in source order. Record Type is the record's "
                "regulatory function; Prescription / Usage and Prescription Reference name what it prescribes; "
                "paragraphs stay inside the regulatory text, which is verbatim."
            )
        },
    )


# --- exports ---------------------------------------------------------------------------------

_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def export_far(database: Session, document: Document, export_id: str) -> ExportArtifact | None:
    rows = load_far_records(database, document)
    summary = (document.ingestion_provenance or {}).get(PROVENANCE_KEY) or {}
    filename = document.original_filename
    stem = (filename or "far").rsplit(".", 1)[0]
    if export_id == "far_workbook.xlsx":
        return ExportArtifact(far_exports.build_far_workbook(rows, summary, filename), _XLSX, f"{stem}_FAR.xlsx")
    if export_id == "far_transformation.xlsx":
        content = far_exports.build_far_transformation_workbook(rows, summary)
        return ExportArtifact(content, _XLSX, f"{stem}_FAR_transformation.xlsx")
    if export_id == "far_canonical.json":
        payload = far_exports.build_far_json(rows, summary, {"id": document.id, "filename": filename})
        return ExportArtifact(payload, "application/json", f"{stem}_FAR_canonical.json")
    name = export_id[:-4] if export_id.endswith(".csv") else None
    if name in far_exports.FAR_CSV:
        content = far_exports.build_far_sheet_csv(far_exports.FAR_CSV[name], rows, summary, filename)
        return ExportArtifact(content, "text/csv", f"{stem}_{name}.csv")
    if name in far_exports.CSV_SHEETS:
        return ExportArtifact(far_exports.build_far_csv(name, rows, summary), "text/csv", f"{stem}_{name}.csv")
    return None


def _export(capability_id: str, label: str, fmt: str, export_id: str) -> ExportCapability:
    return ExportCapability(
        capability_id=capability_id,
        label=label,
        format=fmt,
        href=f"/api/documents/{{document_id}}/staging-workbook/exports/{export_id}",
    )


FAR_PART_52_PROFILE = StagingProfile(
    # Published regulation text.
    data_class="public",
    profile_id="far_part_52",
    profile_version=1,
    display_name="FAR Regulation",
    description=(
        "FAR_REGULATION — any FAR Part (1–53): every numbered section and subsection with its regulatory "
        "function, prescriptions and typed cross references; Part 52 adds provision/clause semantics and "
        "alternates, Part 53 form fields; the Oracle Output transformation kept separate."
    ),
    document_families=(FAMILY,),
    datasets=(FAR_RECORDS, ORACLE_OUTPUT, FAR_SOURCE, QA_REVIEW),
    adapter=adapt_far,
    export_capabilities=(
        _export("far_workbook", "FAR Workbook (Excel)", "xlsx", "far_workbook.xlsx"),
        _export("far_records_csv", "FAR Clauses & Provisions (CSV)", "csv", "far_clauses_provisions.csv"),
        _export("far_oracle_csv", "Oracle Output (CSV)", "csv", "oracle_output.csv"),
        _export("far_source_csv", "Source (CSV)", "csv", "source.csv"),
        _export("far_canonical_json", "Canonical FAR Model (JSON)", "json", "far_canonical.json"),
        _export("far_transformation", "Technical: Transformation Workbook (01–08)", "xlsx", "far_transformation.xlsx"),
    ),
    views=(
        ProfileView(view_id="far_records", label="FAR Clauses & Provisions", dataset_ids=["far_records"]),
        ProfileView(view_id="oracle_output", label="Oracle Output", dataset_ids=["far_oracle_output"]),
        ProfileView(view_id="source", label="Source", dataset_ids=["far_source", "qa_review"], kind="source"),
    ),
    oracle_mapping_capability="planned",
    auto_qa_dataset="qa_review",
    source_structure="none",
    document_recognizer=recognize_far_document,
    contract_pipeline=False,
    materializer=materialize_far_records,
    exporter=export_far,
)

__all__ = ["FAR_PART_52_PROFILE"]
