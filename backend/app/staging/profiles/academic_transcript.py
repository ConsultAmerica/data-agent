"""academic_transcript@1 — academic transcripts, mark sheets and grade
reports from any institution.

Resolution: a structural recognizer, consulted only when keyword family
classification was not confident (the same path invoice@1 uses), so no
document another profile claims is ever re-routed here.

The adapter reads the document's positioned words (native text or the
persisted OCR word layer) through transcript_layout, which rebuilds the
LOGICAL record — label/value fields, course tables, summaries, sections —
from physical fragments. Every staged value keeps:

    source_label   the label exactly as printed
    display label  professional wording (vocabulary / labels.humanize_label)
    provenance     page, the value's word boxes, literal evidence, OCR
                   confidence — plus every physical fragment it was built
                   from (RawRecord.source_columns)

HTML transcripts are read from the DOM structure (field candidates and
header-bearing tables).
"""

from __future__ import annotations

import re
from collections import Counter

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.document import Document
from app.models.document_page import DocumentPage
from app.source_structure.models import StructuredSourceDocument, TableCandidate
from app.source_structure.service import document_page_words, get_or_build_source_structure
from app.staging.labels import humanize_label
from app.staging.models import CellProvenance, ExportCapability, SourceColumn, SourceColumnValue
from app.staging.profile import (
    SOURCE_SHEET,
    ExportSheet,
    AdapterResult,
    DatasetDefinition,
    FieldDefinition,
    RawRecord,
    Recognition,
    StagingProfile,
)
from app.staging.profiles import transcript_vocabulary as V
from app.staging.profiles.transcript_checks import academic_checks
from app.staging.profiles.transcript_layout import (
    Column,
    CourseRow,
    CourseTable,
    Fragment,
    Pair,
    SectionEntry,
    SummaryItem,
    TranscriptLayout,
    evidence_of,
    fragments_text,
    reconstruct,
    union_bbox,
)
from app.staging.provenance import make_provenance
from app.staging.structure_provenance import field_provenance, table_cell_provenance

F = FieldDefinition


def _field_columns(dataset_id: str, *, scope: bool = False) -> tuple[FieldDefinition, ...]:
    """Field / Value / … columns of a field-style dataset. Each dataset has
    its own canonical ids (transcript.<dataset>.value); the semantic field
    a row holds (e.g. transcript.student.name) is its Field ID value."""

    prefix = "transcript.field" if dataset_id == "all_fields" else f"transcript.{dataset_id}"
    return (
        F(f"{prefix}.name", "name", "Field", grounding="derived"),
        F(f"{prefix}.value", "value", "Value", expected=True),
        *((F(f"{prefix}.scope", "scope", "Applies To", grounding="derived"),) if scope else ()),
        F(f"{prefix}.category", "category", "Category", grounding="none"),
        F(f"{prefix}.source_label", "source_label", "Source Label", grounding="none"),
        F(f"{prefix}.field_id", "field_id", "Field ID", grounding="none"),
    )


def _identity(dataset_id: str) -> tuple[str, str]:
    prefix = "transcript.field" if dataset_id == "all_fields" else f"transcript.{dataset_id}"
    return (f"{prefix}.name", f"{prefix}.value")


STUDENT_PROGRAM = DatasetDefinition(
    dataset_id="student_program",
    display_name="Student & Program",
    cardinality="repeating",
    description="Who the record belongs to and what they studied, as printed on the document.",
    identity_fields=_identity("student_program"),
    fields=_field_columns("student_program"),
)

# Course slots. Which appear, and under which caption, is decided per
# document (AdapterResult.column_labels); empty slots are not shown.
_COURSE_SLOTS: tuple[tuple[str, str, str], ...] = (
    ("section", "Section", "text"),
    ("academic_year", "Academic Year", "text"),
    ("term", "Term", "text"),
    ("grade_level", "Grade Level", "text"),
    ("department", "Department", "text"),
    ("code", "Course Code", "text"),
    ("title", "Course Title", "text"),
    ("credits", "Credits", "number"),
    ("contact_hours", "Contact Hours", "number"),
    ("credits_attempted", "Credits Attempted", "number"),
    ("credits_earned", "Credits Earned", "number"),
    ("score", "Marks", "text"),
    ("max_score", "Maximum Marks", "text"),
    ("theory", "Theory", "text"),
    ("practical", "Practical", "text"),
    ("grade", "Grade", "text"),
    ("grade_points", "Grade Points", "number"),
    ("extra_1", "Additional Value", "text"),
    ("extra_2", "Additional Value", "text"),
    ("extra_3", "Additional Value", "text"),
    ("extra_4", "Additional Value", "text"),
)
_EXTRA_SLOTS = ("extra_1", "extra_2", "extra_3", "extra_4")
_CONTEXT_SLOTS = ("section", "academic_year", "term", "grade_level")


def _course_field(slot: str) -> str:
    return f"transcript.course.{slot}"


ACADEMIC_RECORD = DatasetDefinition(
    dataset_id="academic_record",
    display_name="Academic Record",
    cardinality="repeating",
    description="One row per course or unit, with the columns this document prints.",
    identity_fields=(_course_field("code"), _course_field("title")),
    fields=tuple(
        F(_course_field(slot), slot, label, value_type)  # type: ignore[arg-type]
        for slot, label, value_type in _COURSE_SLOTS
    ),
)

ACADEMIC_SUMMARY = DatasetDefinition(
    dataset_id="academic_summary",
    display_name="Academic Summary",
    cardinality="repeating",
    description="GPA, credit totals, standing and honors as printed.",
    identity_fields=_identity("academic_summary"),
    fields=_field_columns("academic_summary", scope=True),
)

OTHER_INFORMATION = DatasetDefinition(
    dataset_id="other_information",
    display_name="Other Information",
    cardinality="repeating",
    description="Institution details, grading system, requirements, notes and certification.",
    identity_fields=_identity("other_information"),
    fields=_field_columns("other_information"),
)

ALL_FIELDS = DatasetDefinition(
    dataset_id="all_fields",
    display_name="All Fields",
    cardinality="repeating",
    description="Every logical field of the transcript, flattened.",
    identity_fields=_identity("all_fields"),
    fields=_field_columns("all_fields"),
)

ACADEMIC_CHECKS = DatasetDefinition(
    dataset_id="academic_checks",
    display_name="Credit & GPA Checks",
    cardinality="repeating",
    # Recalculated, not extracted: shown with the review checks.
    role="qa",
    description="Total credits and the cumulative GPA recalculated from the course rows and compared with what the transcript states.",
    identity_fields=("transcript.check.name",),
    fields=(
        F("transcript.check.name", "check", "Check", grounding="none"),
        F("transcript.check.computed", "computed", "Recalculated", grounding="none"),
        F("transcript.check.stated", "stated", "Stated on Transcript", grounding="none"),
        F("transcript.check.result", "result", "Result", grounding="none"),
        F("transcript.check.details", "details", "Details", grounding="none"),
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

_SHAPE_SPECS: dict[str, V.FieldSpec] = {
    "Institution": V.FieldSpec("transcript.program.institution", "Institution", V.PROGRAM),
    "District": V.FieldSpec("transcript.program.district", "District", V.PROGRAM),
    "Institution Address": V.FieldSpec("transcript.institution.address", "Institution Address", V.INSTITUTION),
    "Institution Phone": V.FieldSpec("transcript.institution.phone", "Institution Phone", V.INSTITUTION),
    "Institution Email": V.FieldSpec("transcript.institution.email", "Institution Email", V.INSTITUTION),
    "Website": V.FieldSpec("transcript.institution.website", "Website", V.INSTITUTION),
}
_LETTERHEAD_FIELDS = {
    "transcript.student.phone", "transcript.student.email", "transcript.student.address",
}
# Fields whose value is a date, number or identifier: a value without a
# single digit is not one (e.g. a template's "Address / phone / email here"
# under "Date of Birth:"), so it is not staged under that field.
_DIGIT_FIELDS = {
    "transcript.student.date_of_birth", "transcript.program.graduation_date", "transcript.program.graduation_year",
    "transcript.program.start_date", "transcript.program.leave_date", "transcript.program.district_entry_date",
    "transcript.program.school_entry_date", "transcript.other.issue_date", "transcript.student.id",
    "transcript.student.admission_number", "transcript.student.roll_number", "transcript.student.registration_number",
    "transcript.student.record_number", "transcript.student.state_id", "transcript.student.certificate_number",
    "transcript.summary.cumulative_gpa", "transcript.summary.term_gpa", "transcript.summary.weighted_gpa",
    "transcript.summary.unweighted_gpa", "transcript.summary.total_credits", "transcript.summary.credits_earned",
    "transcript.summary.credits_attempted", "transcript.summary.gpa_credits", "transcript.summary.quality_points",
    "transcript.summary.class_rank", "transcript.student.phone", "transcript.institution.phone",
}


_NUMERIC_SUMMARY = {f for f in _DIGIT_FIELDS if f.startswith("transcript.summary.")}


def _shape_ok(field_id: str, value: str) -> bool:
    if field_id not in _DIGIT_FIELDS:
        return True
    if not re.search(r"\d", value):
        return False
    # GPA / credit totals are numbers ("3.21", "8.7/10"), not sentences.
    return field_id not in _NUMERIC_SUMMARY or sum(ch.isalpha() for ch in value) <= 3

# --- provenance --------------------------------------------------------------------------


def _provenance(
    document: Document,
    fragments: list[Fragment],
    *,
    evidence: str,
    method: str,
    kind: str,
    region_id: str,
    anchor: str | None,
) -> CellProvenance:
    page = fragments[0].page if fragments else None
    provenance = make_provenance(
        document,
        page=page,
        evidence=evidence,
        bbox=union_bbox(fragments),
        extraction_method=f"{method}:{kind}",
        region_id=region_id,
        anchor=anchor,
    )
    lines = {f.line_index for f in fragments}
    provenance.highlight_text = fragments_text(fragments) if len(lines) == 1 else None
    if method == "ocr":
        words = [w for f in fragments for w in f.words]
        confidences = [w.conf for w in words]
        provenance.ocr_gate = True
        provenance.ocr_confidence = (
            min(confidences) if confidences and None not in confidences else None
        )
        provenance.ocr_contested = any(w.contested for w in words)
    return provenance


def _physical(
    document: Document, fragments: list[tuple[str | None, Fragment]], method: str, region_id: str
) -> list[SourceColumnValue]:
    """The physical pieces a logical value was built from, kept for
    provenance (label pieces, value pieces, table cells)."""

    return [
        SourceColumnValue(
            raw_header=header,
            column_index=index,
            raw_value=fragment.text,
            provenance=_provenance(
                document, [fragment], evidence=fragment.text, method=method, kind="fragment",
                region_id=region_id, anchor=None,
            ),
        )
        for index, (header, fragment) in enumerate(fragments)
        if fragment.words
    ]


# --- field records ------------------------------------------------------------------------


def _pair_spec(pair: Pair) -> V.FieldSpec | None:
    if pair.shape_label:
        return _SHAPE_SPECS.get(pair.shape_label)
    spec = V.field_spec(pair.label)
    if spec is None:
        # Only an explicitly separated "Label: value" is kept without a
        # vocabulary match — under its own (humanized) wording.
        if pair.relation != "separator":
            return None
        return V.FieldSpec("transcript.other.field", humanize_label(pair.label), V.OTHER)
    if pair.context == "institution" or (pair.in_letterhead and spec.field_id in _LETTERHEAD_FIELDS):
        spec = V.INSTITUTION_VARIANTS.get(spec.field_id, spec)
    if spec.category == V.SUMMARY and pair.scope:
        spec = V.TERM_SCOPED.get(spec.field_id, spec)
    return spec


def _field_record(
    document: Document,
    record_id: str,
    *,
    name: str,
    value: str,
    category: str,
    source_label: str | None,
    field_id: str,
    provenance: CellProvenance | None,
    physical: list[SourceColumnValue],
    scope: str | None = None,
) -> RawRecord:
    values = {
        "name": name,
        "value": value,
        "category": category,
        "source_label": source_label,
        "field_id": field_id,
    }
    if scope:
        values["scope"] = scope
    return RawRecord(record_id=record_id, values=values, provenance=provenance, source_columns=physical)


def _summary_spec(label: str, scope: str | None) -> V.FieldSpec:
    spec = V.field_spec(label)
    if spec is None:
        normalized = V.normalize_label(label)
        if "gpa" in normalized.split():
            spec = V.FIELD_ALIASES["gpa"]
        else:
            return V.FieldSpec("transcript.summary.other", humanize_label(label), V.SUMMARY)
    if scope:
        spec = V.TERM_SCOPED.get(spec.field_id, spec)
    return spec


# --- academic record ----------------------------------------------------------------------


def _slot_labels(tables: list[CourseTable]) -> tuple[list[dict[int, str]], dict[str, str]]:
    """Per table: column index → slot; and one caption per slot."""

    assignments: list[dict[int, str]] = []
    captions: dict[str, Counter] = {}
    for table in tables:
        slots: dict[int, str] = {}
        taken: set[str] = set()
        extras = iter(_EXTRA_SLOTS)
        for index, column in enumerate(table.columns):
            if not any(index in row.cells for row in table.rows):
                continue
            if column.role and column.role not in taken:
                slot = column.role
                caption = column.display or humanize_label(column.header)
            else:
                slot = next(extras, None)
                caption = humanize_label(column.header) if column.header else (column.display or "Additional Value")
            if slot is None:
                continue
            taken.add(slot)
            slots[index] = slot
            captions.setdefault(slot, Counter())[caption] += 1
        assignments.append(slots)
    return assignments, {slot: counter.most_common(1)[0][0] for slot, counter in captions.items()}


def _course_records(
    document: Document, tables: list[CourseTable], methods: dict[int, str]
) -> tuple[list[RawRecord], dict[str, str]]:
    assignments, captions = _slot_labels(tables)
    records: list[RawRecord] = []
    for table_index, (table, slots) in enumerate(zip(tables, assignments)):
        method = methods.get(table.page, "native")
        for row_index, row in enumerate(table.rows):
            record_id = f"course:{table.page}:{table.header_line}:{table_index}:{row_index}"
            row_evidence = evidence_of(row.row_frags)
            anchor = next(
                (
                    fragments_text(row.cells[i])
                    for i, slot in slots.items()
                    if slot in ("code", "title") and i in row.cells
                ),
                None,
            )
            values: dict[str, object] = {}
            cell_provenance: dict[str, CellProvenance] = {}
            cell_columns: dict[str, SourceColumn] = {}
            physical: list[tuple[str | None, Fragment]] = []
            for column_index, fragments in sorted(row.cells.items()):
                slot = slots.get(column_index)
                column = table.columns[column_index]
                text = re.sub(r"\s+", " ", fragments_text(fragments)).strip(" |_")
                if not slot or not text:
                    continue
                values[slot] = text
                lines = {f.line_index for f in fragments}
                evidence = row_evidence if len(lines) == 1 else "\n".join([evidence_of(fragments), row_evidence])
                cell_provenance[slot] = _provenance(
                    document, fragments, evidence=evidence, method=method, kind="course_table",
                    region_id=record_id, anchor=anchor,
                )
                cell_columns[slot] = SourceColumn(
                    raw_header=column.header,
                    column_index=column_index,
                    structural_role=column.role,
                    structural_roles=[column.role] if column.role else [],
                )
                physical.extend((column.header, f) for f in fragments)
            for slot in _CONTEXT_SLOTS:
                if slot in values or slot not in row.group:
                    continue
                fragments = row.group_frags.get(slot) or []
                values[slot] = row.group[slot]
                if fragments:
                    cell_provenance[slot] = _provenance(
                        document, fragments, evidence=evidence_of(fragments), method=method,
                        kind="course_group", region_id=record_id, anchor=row.group[slot],
                    )
                    cell_provenance[slot].highlight_text = row.group[slot]
            if not any(values.get(s) for s in ("code", "title")) and len(values) < 2:
                continue
            records.append(
                RawRecord(
                    record_id=record_id,
                    values=values,
                    provenance=_provenance(
                        document, row.row_frags, evidence=row_evidence, method=method, kind="course_table",
                        region_id=record_id, anchor=anchor,
                    ),
                    cell_provenance=cell_provenance,
                    cell_source_columns=cell_columns,
                    source_columns=_physical(document, physical, method, record_id),
                )
            )
    labels = {_course_field(slot): caption for slot, caption in captions.items()}
    for slot in _CONTEXT_SLOTS:
        if any(slot in r.values for r in records) and _course_field(slot) not in labels:
            labels[_course_field(slot)] = dict((s, l) for s, l, _ in _COURSE_SLOTS)[slot]
    return records, labels


# --- HTML (DOM) ------------------------------------------------------------------------------


def _dom_layout(document: Document, structure: StructuredSourceDocument) -> tuple[list[RawRecord], list[Pair], dict[str, str], list[RawRecord]]:
    """HTML transcripts: DOM tables whose header row is course vocabulary,
    and the DOM's own label/value candidates."""

    courses: list[RawRecord] = []
    captions: dict[str, str] = {}
    for table in structure.table_candidates:
        if table.acceptance != "accepted" or not table.header_cells:
            continue
        roles = [V.column_role(h) if h else None for h in table.headers]
        known = {r.role for r in roles if r}
        if not (known & V.ITEM_ROLES and known & (V.RESULT_ROLES | V.CONTEXT_ROLES)):
            continue
        slots: dict[int, str] = {}
        extras = iter(_EXTRA_SLOTS)
        for index, role in enumerate(roles):
            slot = role.role if role and role.role not in slots.values() else next(extras, None)
            if slot:
                slots[index] = slot
                captions.setdefault(
                    _course_field(slot),
                    role.display_label if role and slot == role.role else humanize_label(table.headers[index]),
                )
        for r, row in enumerate(table.rows):
            if r in table.total_row_indices:
                continue
            values: dict[str, object] = {}
            cell_provenance: dict[str, CellProvenance] = {}
            anchor = next((c.text for c in row if c.text), None)
            for cell in row:
                slot = slots.get(cell.column_index)
                if slot and cell.text:
                    values[slot] = cell.text
                    cell_provenance[slot] = table_cell_provenance(document, table, row, cell, anchor)
            if values:
                courses.append(
                    RawRecord(
                        record_id=f"{table.candidate_id}:course:{r}",
                        values=values,
                        provenance=table_cell_provenance(document, table, row, row[0], anchor),
                        cell_provenance=cell_provenance,
                    )
                )
    fields: list[RawRecord] = []
    for candidate in structure.field_candidates:
        if candidate.acceptance != "accepted":
            continue
        spec = V.field_spec(candidate.label_text) or V.FieldSpec(
            "transcript.other.field", humanize_label(candidate.label_text), V.OTHER
        )
        fields.append(
            _field_record(
                document,
                candidate.candidate_id,
                name=spec.display_label,
                value=candidate.raw_value.strip(),
                category=spec.category,
                source_label=candidate.raw_label.strip(),
                field_id=spec.field_id,
                provenance=field_provenance(document, candidate),
                physical=[],
            )
        )
    return courses, [], captions, fields


# --- adapter ---------------------------------------------------------------------------------


def _dataset_for(category: str) -> str:
    if category in (V.STUDENT, V.PROGRAM):
        return "student_program"
    if category == V.SUMMARY:
        return "academic_summary"
    return "other_information"


def adapt_transcript(database: Session, document: Document) -> AdapterResult:
    structure = get_or_build_source_structure(database, document)
    pages = document_page_words(database, document)
    methods = {number: method for number, _, method in pages}

    buckets: dict[str, list[RawRecord]] = {
        "student_program": [],
        "academic_summary": [],
        "other_information": [],
    }
    seen: set[tuple[str, str, str | None]] = set()

    def add(dataset_id: str, record: RawRecord) -> None:
        key = (
            str(record.values.get("field_id")),
            re.sub(r"\s+", " ", str(record.values.get("value"))).lower(),
            record.values.get("scope"),
        )
        if key in seen:
            return
        seen.add(key)
        buckets[dataset_id].append(record)

    course_labels: dict[str, str] = {}
    if pages:
        layout: TranscriptLayout = reconstruct([(number, words) for number, words, _ in pages])
        courses, course_labels = _course_records(document, layout.tables, methods)
        for index, pair in enumerate(layout.pairs):
            spec = _pair_spec(pair)
            if spec is None or not pair.value or not _shape_ok(spec.field_id, pair.value):
                continue
            method = methods.get(pair.page, "native")
            record_id = f"field:{pair.page}:{index}"
            fragments = pair.value_frags
            add(
                _dataset_for(spec.category),
                _field_record(
                    document,
                    record_id,
                    name=spec.display_label,
                    value=pair.value,
                    category=spec.category,
                    source_label=pair.label if pair.label_frags else None,
                    field_id=spec.field_id,
                    provenance=_provenance(
                        document, fragments, evidence=pair.evidence, method=method, kind="label_value",
                        region_id=record_id, anchor=pair.label if pair.label_frags else None,
                    ),
                    physical=_physical(
                        document,
                        [("label", f) for f in pair.label_frags] + [("value", f) for f in pair.value_frags],
                        method,
                        record_id,
                    ),
                    scope=pair.scope if spec.category == V.SUMMARY else None,
                ),
            )
        for index, item in enumerate(layout.summary):
            spec = _summary_spec(item.label, item.scope)
            if not item.value or not _shape_ok(spec.field_id, item.value):
                continue
            method = methods.get(item.page, "native")
            record_id = f"summary:{item.page}:{index}"
            add(
                "academic_summary",
                _field_record(
                    document,
                    record_id,
                    name=spec.display_label,
                    value=item.value,
                    category=V.SUMMARY,
                    source_label=item.label,
                    field_id=spec.field_id,
                    provenance=_provenance(
                        document, item.value_frags, evidence=item.evidence, method=method, kind="summary",
                        region_id=record_id, anchor=item.label,
                    ),
                    physical=_physical(
                        document,
                        [("label", f) for f in item.label_frags] + [("value", f) for f in item.value_frags],
                        method,
                        record_id,
                    ),
                    scope=item.scope,
                ),
            )
        for index, entry in enumerate(layout.entries):
            if not entry.value:
                continue
            method = methods.get(entry.page, "native")
            record_id = f"entry:{entry.page}:{index}"
            name = humanize_label(entry.label) if entry.label else entry.entry_label
            spec = V.field_spec(entry.label) if entry.label else None
            add(
                _dataset_for(entry.category),
                _field_record(
                    document,
                    record_id,
                    name=spec.display_label if spec and spec.category == entry.category else name,
                    value=entry.value,
                    category=entry.category,
                    source_label=entry.label or entry.heading or None,
                    field_id=spec.field_id if spec and spec.category == entry.category
                    else f"transcript.{re.sub(r'[^a-z]+', '_', entry.category.lower()).strip('_')}.entry",
                    provenance=_provenance(
                        document, entry.value_frags, evidence=entry.evidence, method=method, kind="section",
                        region_id=record_id, anchor=entry.label or entry.heading or None,
                    ),
                    physical=_physical(
                        document,
                        [("label", f) for f in entry.label_frags] + [("value", f) for f in entry.value_frags],
                        method,
                        record_id,
                    ),
                ),
            )
    else:
        courses, _, course_labels, fields = _dom_layout(document, structure)
        for record in fields:
            add(_dataset_for(str(record.values["category"])), record)

    page_text = "\n".join(
        text or ""
        for text in database.scalars(
            select(DocumentPage.final_text).where(DocumentPage.document_id == document.id)
        )
    )
    # Before flattening: failed checks mark the stated summary cells.
    checks = academic_checks(courses, buckets["academic_summary"], page_text)
    all_fields = _flatten(buckets, courses, course_labels)
    return AdapterResult(
        records={
            "student_program": buckets["student_program"],
            "academic_record": courses,
            "academic_summary": buckets["academic_summary"],
            "academic_checks": checks,
            "other_information": buckets["other_information"],
            "all_fields": all_fields,
        },
        outcome_provenance=document.ingestion_provenance,
        column_labels={"academic_record": course_labels},
    )


_FIELD_ORDER = ("student_program", "academic_summary", "other_information")


def _flatten(
    buckets: dict[str, list[RawRecord]], courses: list[RawRecord], course_labels: dict[str, str]
) -> list[RawRecord]:
    """All Fields: every logical field — never raw physical cells. Courses
    flatten as "Course N / <column>"."""

    flattened: list[RawRecord] = []
    for dataset_id in ("student_program",):
        for record in buckets[dataset_id]:
            flattened.append(_copy(record, f"all:{record.record_id}"))
    captions = {slot: course_labels.get(_course_field(slot), label) for slot, label, _ in _COURSE_SLOTS}
    for number, course in enumerate(courses, start=1):
        for slot, _, _ in _COURSE_SLOTS:
            value = course.values.get(slot)
            if value in (None, ""):
                continue
            flattened.append(
                RawRecord(
                    record_id=f"all:{course.record_id}:{slot}",
                    values={
                        "name": f"Course {number} / {captions[slot]}",
                        "value": value,
                        "category": V.RECORD,
                        "source_label": (course.cell_source_columns.get(slot).raw_header
                                         if course.cell_source_columns.get(slot) else None),
                        "field_id": _course_field(slot),
                    },
                    provenance=course.cell_provenance.get(slot) or course.provenance,
                )
            )
    for dataset_id in _FIELD_ORDER[1:]:
        for record in buckets[dataset_id]:
            copy = _copy(record, f"all:{record.record_id}")
            scope = record.values.get("scope")
            if scope:
                copy.values["name"] = f"{record.values['name']} ({scope})"
            copy.values.pop("scope", None)
            flattened.append(copy)
    return flattened


def _copy(record: RawRecord, record_id: str) -> RawRecord:
    return RawRecord(
        record_id=record_id,
        values=dict(record.values),
        provenance=record.provenance,
        cell_provenance=dict(record.cell_provenance),
        source_columns=list(record.source_columns),
    )


# --- recognizer --------------------------------------------------------------------------------

_ITEM = re.compile(r"\b(?:course|courses|unit code|unit name|subjects?|module)\b", re.I)
_RESULT = re.compile(
    r"\b(?:grades?|credits?|credit hours|gpa|cgpa|marks|theory|practical|grade points|quality points"
    r"|units earned|units attempted)\b",
    re.I,
)
_PERIOD = re.compile(
    r"\b(?:semester|term|academic year|school year|fall|spring|\d{1,2}(?:st|nd|rd|th) grade|grade \d{1,2})\b"
    r"|\b(?:19|20)\d{2}\s*[-/]\s*(?:19|20)?\d{2}\b",
    re.I,
)
_GPA = re.compile(r"\b(?:gpa|cgpa|grade point average|credits earned|quality points|cumulative)\b", re.I)
_CONTEXT = re.compile(
    r"\b(?:student|university|college|school|academy|admission|graduation|registrar|faculty|enrollment|enrolment)\b",
    re.I,
)


def _header_roles(text: str) -> set[str]:
    words = text.split()
    roles: set[str] = set()
    i = 0
    while i < len(words):
        for n in (3, 2, 1):
            role = V.column_role(" ".join(words[i : i + n])) if i + n <= len(words) else None
            if role:
                roles.add(role.role)
                i += n
                break
        else:
            i += 1
    return roles


def recognize_transcript(structure: StructuredSourceDocument) -> Recognition:
    texts = [r.text for r in structure.regions]
    for table in structure.table_candidates:
        texts.append(" ".join(h for h in table.headers if not h.startswith("Column ")))
        texts.extend(" ".join(c.text for c in row if c.text) for row in table.rows)
    texts.extend(f"{c.raw_label} {c.raw_value}" for c in structure.field_candidates)
    corpus = "\n".join(texts)
    reasons: list[str] = []
    score = 0.0
    if V.TITLE_WORDS.search(corpus):
        score += 0.45
        reasons.append("transcript title")
    if _ITEM.search(corpus) and _RESULT.search(corpus):
        score += 0.25
        reasons.append("course and result wording")
    if any(
        len(roles := _header_roles(line)) >= 3 and roles & V.ITEM_ROLES
        for text in texts
        for line in text.splitlines()
    ):
        score += 0.3
        reasons.append("course-table header")
    if _PERIOD.search(corpus):
        score += 0.1
        reasons.append("terms / academic years")
    if _GPA.search(corpus):
        score += 0.1
        reasons.append("GPA / credit totals")
    if _CONTEXT.search(corpus):
        score += 0.1
        reasons.append("student / institution wording")
    if not reasons or ("transcript title" not in reasons and "course-table header" not in reasons):
        return Recognition(0.0, reasons or ["no academic-record structure"])
    return Recognition(round(min(score, 1.0), 2), reasons)


# --- profile ------------------------------------------------------------------------------------------

ACADEMIC_TRANSCRIPT_PROFILE = StagingProfile(
    # Education records (student identifiers, grades).
    data_class="restricted",
    profile_id="academic_transcript",
    profile_version=1,
    display_name="Academic Transcript",
    description=(
        "Academic transcripts, mark sheets and grade reports: student and program details, "
        "the academic record (courses and results), summaries such as GPA and credits, and "
        "secondary information like grading scales and certification."
    ),
    document_families=("academic_transcript",),
    datasets=(STUDENT_PROGRAM, ACADEMIC_RECORD, ACADEMIC_SUMMARY, ACADEMIC_CHECKS, OTHER_INFORMATION, ALL_FIELDS, QA_REVIEW),
    adapter=adapt_transcript,
    export_sheets=(
        ExportSheet("Student & Program", ("student_program",)),
        ExportSheet("Academic Record", ("academic_record",)),
        ExportSheet("Academic Summary", ("academic_summary",)),
        ExportSheet("Credit & GPA Checks", ("academic_checks",)),
        ExportSheet("Other Information", ("other_information",)),
        ExportSheet(SOURCE_SHEET, ()),
    ),
    export_capabilities=(
        ExportCapability(
            capability_id="professional_excel",
            label="Professional Excel (staging workbook)",
            format="xlsx",
            href="/api/documents/{document_id}/staging-workbook/export.xlsx",
        ),
        *(
            ExportCapability(
                capability_id="dataset_csv",
                label=f"{definition.display_name} CSV",
                format="csv",
                href=f"/api/documents/{{document_id}}/staging-workbook/datasets/{definition.dataset_id}.csv",
                dataset_id=definition.dataset_id,
            )
            for definition in (STUDENT_PROGRAM, ACADEMIC_RECORD, ACADEMIC_SUMMARY, OTHER_INFORMATION, ALL_FIELDS)
        ),
    ),
    oracle_mapping_capability="none",
    auto_qa_dataset="qa_review",
    source_structure="required",
    recognizer=recognize_transcript,
)
