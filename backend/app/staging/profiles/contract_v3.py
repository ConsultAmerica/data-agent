"""contract_v3@1 — the canonical V3 contract model registered as a staging
profile. Pure adapter: reads `get_normalized_v3_document` (the same
assembly the V3 CSV/XLSX exports use), never re-extracts, and leaves the V3
tables and V3 export schema untouched.
"""

from __future__ import annotations

import re

from sqlalchemy.orm import Session

from app.contract_structure.builder import load_contract_structure, materialize_contract_structure
from app.contract_structure.forms import FINANCIAL
from app.models.document import Document
from app.schemas.v3_document import NormalizedV3Document, RowProvenance
from app.services.v3_reader import get_normalized_v3_document
from app.staging.models import ExportCapability, ProfileView, ValidationCheck
from app.staging.profile import (
    SOURCE_SHEET,
    ExportSheet,
    AdapterResult,
    DatasetDefinition,
    ExportArtifact,
    FieldDefinition,
    FieldRule,
    RawRecord,
    StagingProfile,
)
from app.staging.profiles.contract_presentation import (
    CONTRACT_DATA,
    CONTRACT_OVERVIEW,
    SUBTYPE_LABELS,
    column_labels,
    contract_data_records,
    contract_overview_records,
)
from app.source_structure.ocr_geometry import PageGeometry
from app.staging.provenance import make_provenance
from app.staging.validation import value_in_evidence

F = FieldDefinition

# (model attribute, V3 column header). The header keys the summary's
# internal per-field provenance.
_SUMMARY_COLUMNS: tuple[tuple[str, str], ...] = (
    ("contract_number", "Contract Number"),
    ("solicitation_rfp", "Solicitation / RFP"),
    ("contract_vehicle", "Contract Vehicle"),
    ("agency_office", "Agency / Office"),
    ("contractor", "Contractor"),
    ("award_date", "Award Date"),
    ("ceiling_max_aggregate", "Ceiling / Max Aggregate"),
    ("minimum_guarantee", "Minimum Guarantee"),
    ("base_period", "Base Period"),
    ("options", "Options"),
    ("max_duration", "Max Duration"),
    ("task_order_range", "Task Order Range"),
    ("naics", "NAICS"),
    ("size_standard", "Size Standard"),
)

CONTRACT_SUMMARY = DatasetDefinition(
    dataset_id="contract_summary",
    display_name="Contract Summary",
    cardinality="single",
    description="One row per contract: identification, parties, dates, financial terms.",
    identity_fields=("contract.contract_number",),
    fields=(
        F("contract.contract_number", "contract_number", "Contract Number", "code", expected=True),
        F("contract.solicitation_number", "solicitation_rfp", "Solicitation / RFP", "code", expected=True),
        F("contract.contract_vehicle", "contract_vehicle", "Contract Vehicle", expected=True),
        F("contract.agency_office", "agency_office", "Agency / Office", expected=True),
        F("contract.contractor_name", "contractor", "Contractor", expected=True),
        F("contract.award_date", "award_date", "Award Date", "date", expected=True),
        F(
            "contract.ceiling_amount",
            "ceiling_max_aggregate",
            "Ceiling / Max Aggregate",
            expected=True,
            grounding="derived",
            rules=(FieldRule("evidence_mentions", terms=("ceiling", "maximum")),),
        ),
        F(
            "contract.minimum_guarantee",
            "minimum_guarantee",
            "Minimum Guarantee",
            "money",
            expected=True,
            rules=(
                FieldRule("positive_amount", message="A minimum guarantee of zero is implausible."),
                FieldRule(
                    "evidence_mentions",
                    terms=("minimum",),
                    message="Evidence does not describe a minimum guarantee.",
                ),
            ),
        ),
        F(
            "contract.base_period",
            "base_period",
            "Base Period",
            expected=True,
            grounding="derived",
            rules=(FieldRule("evidence_mentions", terms=("base period", "base")),),
        ),
        F(
            "contract.options",
            "options",
            "Options",
            expected=True,
            grounding="derived",
            rules=(FieldRule("evidence_mentions", terms=("option",)),),
        ),
        F(
            "contract.max_duration",
            "max_duration",
            "Max Duration",
            expected=True,
            grounding="derived",
            rules=(FieldRule("evidence_mentions", terms=("term", "duration", "years", "months")),),
        ),
        F("contract.task_order_range", "task_order_range", "Task Order Range", expected=True),
        F(
            "contract.naics",
            "naics",
            "NAICS",
            "code",
            expected=True,
            rules=(FieldRule("pattern", pattern=r"\d{6}", message="NAICS must be 6 digits."),),
        ),
        F("contract.size_standard", "size_standard", "Size Standard", expected=True),
    ),
)

# --- Source-adaptive contract datasets (app.contract_structure) -------------
# Built from the PDF layout, independent of V3: the V3 tables, columns and
# exports above/below are unchanged. Visible labels and column headings are
# the source's own; canonical ids stay stable.

CONTRACT_DETAILS = DatasetDefinition(
    dataset_id="contract_details",
    display_name="Contract Details",
    cardinality="repeating",
    description="Document-level fields under the labels the source prints, grouped by section.",
    identity_fields=("contract.detail.field_id",),
    fields=(
        F("contract.detail.label", "label", "Field", grounding="none"),
        # Checkbox answers ("Yes", "Negotiated (RFP)") are read from a mark, not
        # copied; the adapter checks literal values against their evidence.
        F("contract.detail.value", "value", "Value", grounding="derived"),
        F("contract.detail.section", "section", "Section", grounding="none"),
        F("contract.detail.source_label", "source_label", "Source Label", grounding="none"),
        F("contract.detail.field_id", "field_id", "Field ID", grounding="none"),
    ),
)

LINE_ITEMS = DatasetDefinition(
    dataset_id="line_items",
    display_name="Line Items",
    cardinality="repeating",
    source_adaptive_columns=True,
    description="Schedule line items (CLINs) under the source's column headings, merged across continuation pages.",
    identity_fields=("contract.line.item_number",),
    fields=(
        F("contract.line.item_number", "item_number", "Item No.", "code", expected=True),
        F("contract.line.description", "description", "Supplies/Services"),
        F("contract.line.quantity", "quantity", "Quantity"),
        F("contract.line.unit", "unit", "Unit"),
        F("contract.line.unit_price", "unit_price", "Unit Price"),
        F("contract.line.amount", "amount", "Amount"),
    ),
)

DELIVERY_INFORMATION = DatasetDefinition(
    dataset_id="delivery_information",
    display_name="Delivery Information",
    cardinality="repeating",
    source_adaptive_columns=True,
    description="Delivery schedule rows under the source's column headings.",
    identity_fields=("contract.delivery.clin",),
    fields=(
        F("contract.delivery.clin", "clin", "CLIN", "code", expected=True),
        F("contract.delivery.delivery_date", "delivery_date", "Delivery Date"),
        F("contract.delivery.quantity", "quantity", "Quantity"),
        F("contract.delivery.ship_to", "ship_to", "Ship To Address"),
        F("contract.delivery.dodaac_cage", "dodaac_cage", "DODAAC / CAGE"),
    ),
)

CONTRACT_SECTIONS = DatasetDefinition(
    dataset_id="contract_sections",
    display_name="Contract Sections",
    cardinality="repeating",
    description="Uniform Contract Format sections and their numbered subsections, with full text.",
    identity_fields=("contract.body.number", "contract.body.title"),
    grid_fields=("contract.body.number", "contract.body.title", "contract.body.section"),
    fields=(
        F("contract.body.number", "number", "Number", "code", expected=True),
        F("contract.body.title", "title", "Title", expected=True),
        F("contract.body.section", "section", "Section"),
        F("contract.body.text", "text", "Text"),
    ),
)

_BODY_TABLE_WIDTH = 8
SECTION_TABLES = DatasetDefinition(
    dataset_id="section_tables",
    display_name="Section Tables",
    cardinality="repeating",
    description="Tables printed inside the contract sections, one row per record, under their own headings.",
    identity_fields=("contract.body_table.c1",),
    fields=(
        F("contract.body_table.table_id", "table_id", "Table", grounding="none"),
        F("contract.body_table.section", "section", "Section", grounding="none"),
        F("contract.body_table.subsection", "subsection", "Subsection", grounding="none"),
        F("contract.body_table.headers", "headers", "Headings", grounding="none"),
        *(F(f"contract.body_table.c{i}", f"c{i}", f"Column {i}") for i in range(1, _BODY_TABLE_WIDTH + 1)),
    ),
)

CONTRACT_ATTACHMENTS = DatasetDefinition(
    dataset_id="contract_attachments",
    display_name="Attachments",
    cardinality="repeating",
    description="The contract's list of attachments (Section J).",
    identity_fields=("contract.attachment_item.reference",),
    fields=(
        F("contract.attachment_item.reference", "reference", "Reference", "code", expected=True),
        F("contract.attachment_item.title", "title", "Title", expected=True),
        F("contract.attachment_item.group", "group", "List", grounding="none"),
        F("contract.attachment_item.section", "section", "Section", grounding="none"),
    ),
)

CONTRACT_CLAUSES = DatasetDefinition(
    dataset_id="contract_clauses",
    display_name="Clauses",
    cardinality="repeating",
    description=(
        "Clauses with the incorporation context of the section heading they appear under; "
        "full-text clauses keep their complete text."
    ),
    identity_fields=("contract.contract_clause.clause_number",),
    # Section and heading travel with each row so the view can group the
    # clauses as the contract does; blank columns are not shown.
    grid_fields=(
        "contract.contract_clause.clause_number",
        "contract.contract_clause.title",
        "contract.contract_clause.date",
        "contract.contract_clause.alternate",
        "contract.contract_clause.variation_date",
        "contract.contract_clause.incorporation_type",
        "contract.contract_clause.contract_section",
        "contract.contract_clause.source_heading",
    ),
    fields=(
        F("contract.contract_clause.clause_number", "clause_number", "Clause Number", "code", expected=True),
        F("contract.contract_clause.title", "title", "Title", expected=True),
        F("contract.contract_clause.date", "date", "Date"),
        F("contract.contract_clause.regulation", "regulation", "Regulation", grounding="derived"),
        F("contract.contract_clause.incorporation_type", "incorporation_type", "Incorporation Type", grounding="derived"),
        # Joined from the pieces printed around the number and title.
        F("contract.contract_clause.alternate", "alternate", "Alternate / Deviation", grounding="derived"),
        F("contract.contract_clause.variation_date", "variation_date", "Variation Effective Date"),
        F("contract.contract_clause.contract_section", "contract_section", "Contract Section"),
        F("contract.contract_clause.source_heading", "source_heading", "Section Heading"),
        F("contract.contract_clause.text", "text", "Clause Text"),
    ),
)

# One transformation dataset with the target clause-library columns. Only
# values the source supports or an approved deterministic rule produces are
# filled; everything else stays empty until a rule or reference is approved.
_TRANSFORMATION_COLUMNS = (
    ("action", "Action"), ("date_published", "Date Published"), ("number", "Number"), ("title", "Title"),
    ("display_name", "Display Name"), ("intent", "Intent"), ("language", "Language"),
    ("clause_type", "Clause Type"), ("status", "Status"), ("description", "Description"),
    ("provision_yn", "Provision Yn"), ("global_yn", "Global Yn"), ("lock_text_yn", "Lock Text Yn"),
    ("insert_by_reference", "Insert By Reference"), ("text", "Text"), ("start_date", "Start Date"),
    ("attribute_category", "Attribute Category"), ("attribute1", "Attribute 1"), ("source_xml", "Source XML"),
)
_DERIVED_TRANSFORMATION = {"display_name", "insert_by_reference"}

CLAUSE_TRANSFORMATION = DatasetDefinition(
    dataset_id="clause_transformation",
    display_name="Clause Transformation",
    cardinality="repeating",
    description="Clause records in the target clause-library columns (source-supported values only).",
    identity_fields=("contract.clause_transform.number",),
    fields=tuple(
        F(
            f"contract.clause_transform.{key}",
            key,
            label,
            grounding="derived" if key in _DERIVED_TRANSFORMATION else "evidence",
        )
        for key, label in _TRANSFORMATION_COLUMNS
    ),
)

CLINS = DatasetDefinition(
    dataset_id="clins",
    display_name="CLINs",
    cardinality="repeating",
    description="One row per CLIN / SLIN / sub-CLIN.",
    identity_fields=("contract.clin.clin", "contract.clin.description"),
    grid_fields=(
        "contract.clin.clin",
        "contract.clin.description",
        "contract.clin.option_base",
        "contract.clin.pricing_type",
        "contract.clin.max_quantity",
        "contract.clin.unit",
        "contract.clin.max_amount",
    ),
    fields=(
        F("contract.clin.clin", "clin", "CLIN", "code", expected=True),
        F("contract.clin.option_base", "option_base", "Option/Base", grounding="derived"),
        F("contract.clin.description", "description", "Description"),
        F("contract.clin.pricing_type", "pricing_type", "Pricing Type", grounding="derived"),
        F("contract.clin.max_quantity", "max_quantity", "Max Quantity"),
        F("contract.clin.unit", "unit", "Unit"),
        F("contract.clin.unit_price", "unit_price", "Unit Price", "money"),
        F("contract.clin.max_amount", "max_amount", "Max Amount", "money"),
        F("contract.clin.status", "status", "Status", grounding="derived"),
        F("contract.clin.fob", "fob", "FOB", grounding="derived"),
        F("contract.clin.purchase_request", "purchase_request", "Purchase Request", grounding="derived"),
        F("contract.clin.psc", "psc", "PSC", "code", grounding="derived"),
        F("contract.clin.pop_start", "pop_start", "POP Start", grounding="derived"),
        F("contract.clin.pop_end", "pop_end", "POP End", grounding="derived"),
        F("contract.clin.ship_to", "ship_to", "Ship To", grounding="derived"),
        F("contract.clin.dodaac", "dodaac", "DODAAC", "code", grounding="derived"),
    ),
)

FUNDING = DatasetDefinition(
    dataset_id="funding",
    display_name="Funding",
    cardinality="repeating",
    description="One row per funding line / obligation / funding requirement.",
    identity_fields=("contract.funding.funding_level", "contract.funding.funding_status"),
    fields=(
        F("contract.funding.funding_level", "funding_level", "Funding Level", grounding="derived"),
        F("contract.funding.clin", "clin", "CLIN", "code"),
        F("contract.funding.funding_status", "funding_status", "Funding Status", grounding="derived"),
        F("contract.funding.amount", "amount", "Amount", "money"),
        F(
            "contract.funding.accounting_appropriation",
            "accounting_appropriation",
            "Accounting / Appropriation",
            grounding="derived",
        ),
        F("contract.funding.purchase_request", "purchase_request", "Purchase Request", grounding="derived"),
    ),
)

PERFORMANCE_DELIVERY = DatasetDefinition(
    dataset_id="performance_delivery",
    display_name="Performance & Delivery",
    cardinality="repeating",
    identity_fields=("contract.performance.record_type", "contract.performance.requirement"),
    fields=(
        F("contract.performance.record_type", "record_type", "Record Type", grounding="derived"),
        F("contract.performance.clin", "clin", "CLIN", "code", grounding="derived"),
        F("contract.performance.start", "start", "Start", grounding="derived"),
        F("contract.performance.end_timing", "end_timing", "End / Timing", grounding="derived"),
        F(
            "contract.performance.location_destination",
            "location_destination",
            "Location / Destination",
            grounding="derived",
        ),
        F("contract.performance.requirement", "requirement", "Requirement", grounding="derived"),
    ),
)

ATTACHMENTS = DatasetDefinition(
    dataset_id="attachments",
    display_name="Attachments",
    cardinality="repeating",
    identity_fields=("contract.attachment.reference", "contract.attachment.title"),
    fields=(
        F("contract.attachment.reference", "attachment_reference", "Attachment / Reference", "code", expected=True),
        F("contract.attachment.title", "title_description", "Title / Description"),
        F(
            "contract.attachment.included_in_portfolio",
            "included_in_portfolio",
            "Included in Portfolio?",
            grounding="derived",
        ),
    ),
)


def _clause_fields(prefix: str) -> tuple[FieldDefinition, ...]:
    return (
        F(f"{prefix}.regulation", "regulation", "Regulation", grounding="derived"),
        F(f"{prefix}.clause_number", "clause_number", "Clause Number", "code", expected=True),
        # Titles/dates are enriched from the FAR Master reference, not
        # read from the contract text.
        F(f"{prefix}.clause_title", "clause_title", "Clause Title", grounding="derived"),
        F(f"{prefix}.alternate_deviation", "alternate_deviation", "Alternate / Deviation", grounding="derived"),
        F(f"{prefix}.effective_date", "effective_date", "Effective Date", grounding="derived"),
        F(f"{prefix}.incorporation_type", "incorporation_type", "Incorporation Type", grounding="derived"),
    )


CLAUSES = DatasetDefinition(
    dataset_id="clauses",
    display_name="Clauses",
    cardinality="repeating",
    description="Clauses incorporated into the contract (FAR and GSAR).",
    identity_fields=("contract.clause.clause_number", "contract.clause.clause_title"),
    fields=_clause_fields("contract.clause"),
)

FAR_REFERENCES = DatasetDefinition(
    dataset_id="far_references",
    display_name="FAR References",
    cardinality="repeating",
    description="Incidental FAR mentions — not incorporated clauses.",
    identity_fields=("contract.far_reference.reference", "contract.far_reference.subject_context"),
    fields=(
        F("contract.far_reference.reference", "far_reference", "FAR Reference", "code", grounding="derived"),
        F("contract.far_reference.reference_type", "reference_type", "Reference Type", grounding="derived"),
        F("contract.far_reference.subject_context", "subject_context", "Subject / Context", grounding="derived"),
        F("contract.far_reference.contract_clause", "contract_clause", "Contract Clause?", grounding="derived"),
    ),
)

DFARS = DatasetDefinition(
    dataset_id="dfars",
    display_name="DFARS",
    cardinality="repeating",
    identity_fields=("contract.dfars.clause_number", "contract.dfars.clause_title"),
    fields=_clause_fields("contract.dfars"),
)

ALL_FIELDS = DatasetDefinition(
    dataset_id="all_fields",
    display_name="All Fields",
    cardinality="repeating",
    description="Other accepted, source-supported label/value fields.",
    identity_fields=("contract.field.name", "contract.field.value"),
    grid_fields=(
        "contract.field.category",
        "contract.field.name",
        "contract.field.value",
    ),
    fields=(
        F("contract.field.category", "category", "Category", grounding="none"),
        F("contract.field.name", "normalized_field", "Field", grounding="derived"),
        F("contract.field.value", "value", "Value", expected=True),
        F("contract.field.extraction_method", "extraction_method", "Extraction Method", grounding="none"),
    ),
)

SOURCE_DOCUMENTS = DatasetDefinition(
    dataset_id="source_documents",
    display_name="Source Documents",
    cardinality="repeating",
    role="source",
    identity_fields=("source.document",),
    fields=(
        F("source.document", "source_document", "Source Document", grounding="none"),
        F("source.role", "role", "Role", grounding="none"),
        F("source.pages", "pages", "Pages", "integer", grounding="none"),
        F("source.extraction_status", "extraction_status", "Extraction Status", grounding="none"),
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

# V3 QA Review rows name the dataset they summarize by its sheet name.
_QA_CHECK_TO_DATASET = {
    "Contract Summary": "contract_summary",
    "CLINs": "clins",
    "Funding": "funding",
    "Performance / Delivery": "performance_delivery",
    "Attachments": "attachments",
    "Clauses": "clauses",
    "FAR References": "far_references",
    "DFARS": "dfars",
    "All Fields": "all_fields",
}


def _row_record(
    document: Document,
    geometry: PageGeometry,
    kind: str,
    index: int,
    row,
    *,
    anchor: str | None = None,
) -> RawRecord:
    row_provenance: RowProvenance | None = getattr(row, "row_provenance", None)
    region_id = row_provenance.row_id if row_provenance else f"{kind}:{index}"
    return RawRecord(
        record_id=region_id,
        values=row.model_dump(),
        provenance=make_provenance(
            document,
            page=row.source_page,
            evidence=row.evidence,
            bbox=geometry.pdf_bbox(row.source_page, row_provenance.bbox, row_provenance.bbox_space)
            if row_provenance
            else None,
            extraction_method=(row_provenance.extraction_method if row_provenance else None)
            or getattr(row, "extraction_method", None),
            region_id=region_id,
            anchor=anchor,
        ),
        builder_status=row.qa_status,
    )


def _summary_record(
    document: Document, geometry: PageGeometry, doc: NormalizedV3Document
) -> list[RawRecord]:
    summary = doc.contract_summary
    if summary is None:
        return []
    cell_provenance = {}
    for attr, header in _SUMMARY_COLUMNS:
        field_prov = summary.field_provenance.get(header)
        if not field_prov:
            continue
        cell_provenance[attr] = make_provenance(
            document,
            page=field_prov.get("page"),
            evidence=field_prov.get("evidence"),
            bbox=geometry.pdf_bbox(
                field_prov.get("page"), field_prov.get("bbox"), field_prov.get("bbox_space")
            ),
            extraction_method=field_prov.get("extraction_method"),
            region_id=f"contract_summary:{attr}",
        )
    # The V3 row-level QA verdict is about completeness (how many of the
    # 14 columns were found), not about any one value — so it is NOT
    # applied to cells; each cell is judged on its own provenance.
    return [
        RawRecord(
            record_id="contract_summary",
            values=summary.model_dump(),
            cell_provenance=cell_provenance,
        )
    ]


# V3 summary columns folded into Contract Details when the forms did not
# already supply them (canonical id they correspond to, if any).
_V3_DETAIL_FIELDS = {
    "contract_vehicle": None,
    "agency_office": "contract.issued_by",
    "contractor": "contract.offeror",
    "award_date": "contract.award_date",
    "ceiling_max_aggregate": None,
    "minimum_guarantee": None,
    "base_period": None,
    "options": None,
    "max_duration": None,
    "task_order_range": None,
    "naics": "contract.naics",
    "size_standard": None,
}


# V3 summary columns V3 itself treats as derived (e.g. "5 years" from a
# sentence) keep that rule when shown in Contract Details.
_SUMMARY_GROUNDING = {field.key: field.grounding for field in CONTRACT_SUMMARY.fields}


def _literal_check(value: str, evidence: str) -> list[ValidationCheck]:
    grounded = value_in_evidence(value, evidence, "text")
    return [
        ValidationCheck(
            check="grounded_in_evidence",
            passed=grounded,
            message=None if grounded else "Value does not appear as-is in its source evidence.",
        )
    ]


# Values read from a checkbox mark or composed from a number and its printed
# unit ("10 calendar days") are not literal copies of their evidence.
_DERIVED_DETAIL_IDS = {
    "contract.solicitation_type",
    "contract.bonds_required",
    "contract.bond_due_days",
    "contract.performance_start",
    "contract.performance_period_type",
    "contract.offer_guarantee_required",
    "contract.acceptance_period",
    "contract.page_of_pages",
}


def _details_records(
    document: Document, structure: dict, doc: NormalizedV3Document, geometry: PageGeometry
) -> list[RawRecord]:
    records: list[RawRecord] = []
    present: set[str] = set()
    for field in structure.get("fields", []):
        present.add(field["field_id"])
        provenance = make_provenance(
            document,
            page=field["page"],
            evidence=field["evidence"],
            bbox=field["bbox"],
            extraction_method=field["method"],
            region_id=f"contract_details:{field['field_id']}",
        )
        checks = [] if field["field_id"] in _DERIVED_DETAIL_IDS else _literal_check(field["value"], field["evidence"])
        records.append(
            RawRecord(
                record_id=f"detail:{field['field_id']}",
                values={
                    "label": field["label"],
                    "value": field["value"],
                    "section": field["section"],
                    "source_label": field["source_label"],
                    "field_id": field["field_id"],
                },
                cell_provenance={"value": provenance},
                cell_checks={"value": checks},
            )
        )
    summary = doc.contract_summary
    if summary is not None:
        values = summary.model_dump()
        headers = dict(_SUMMARY_COLUMNS)
        for attr, canonical in _V3_DETAIL_FIELDS.items():
            value = values.get(attr)
            field_prov = summary.field_provenance.get(headers[attr])
            if not value or not field_prov or not field_prov.get("evidence") or (canonical and canonical in present):
                continue
            field_id = canonical or f"contract.{attr}"
            evidence = field_prov.get("evidence")
            derived = _SUMMARY_GROUNDING.get(attr) == "derived"
            records.append(
                RawRecord(
                    record_id=f"detail:{field_id}",
                    values={
                        "label": headers[attr],
                        "value": str(value),
                        "section": FINANCIAL,
                        "source_label": headers[attr],
                        "field_id": field_id,
                    },
                    cell_provenance={
                        "value": make_provenance(
                            document,
                            page=field_prov.get("page"),
                            evidence=evidence,
                            bbox=geometry.pdf_bbox(field_prov.get("page"), field_prov.get("bbox"), field_prov.get("bbox_space")),
                            extraction_method=field_prov.get("extraction_method"),
                            region_id=f"contract_details:{field_id}",
                        )
                    },
                    cell_checks={"value": [] if derived else _literal_check(str(value), evidence)},
                )
            )
    return records


_AMOUNT_CODES = re.compile(r"\d|^(NSP|N/A|UNDEFINED|NOT TO EXCEED|TBD)\b", re.IGNORECASE)


def _amount_checks(values: dict) -> dict[str, list[ValidationCheck]]:
    """An amount cell must carry a figure or a printed code (NSP, N/A);
    a lone label such as "Firm Price" means the figure was not captured."""
    amount = values.get("amount")
    if not amount:
        return {}
    passed = bool(_AMOUNT_CODES.search(amount.strip()))
    return {
        "amount": [
            ValidationCheck(
                check="amount_has_figure",
                passed=passed,
                message=None if passed else "No amount figure was captured for this line item.",
            )
        ]
    }


def _table_records(document: Document, structure: dict, kind: str) -> tuple[list[RawRecord], dict[str, str]]:
    table = structure.get("tables", {}).get(kind)
    if not table:
        return [], {}
    prefix = "contract.line" if kind == "line_items" else "contract.delivery"
    labels = {f"{prefix}.{column['key']}": column["header"] for column in table["columns"]}
    records: list[RawRecord] = []
    for index, record in enumerate(table["records"]):
        item = record["values"].get("item_number") or record["values"].get("clin") or str(index)
        records.append(
            RawRecord(
                record_id=f"{kind}:{index}:{item}",
                values=record["values"],
                # Each cell's evidence is the source text read from that cell
                # (a delivery row's columns interleave line by line).
                cell_provenance={
                    key: make_provenance(
                        document,
                        page=page,
                        evidence=record["values"].get(key) or record["evidence"],
                        bbox=bbox,
                        extraction_method="schedule_table_layout",
                        region_id=f"{kind}:{index}:{key}",
                        anchor=item,
                    )
                    for key, (page, bbox) in record["cell_boxes"].items()
                },
                cell_checks=_amount_checks(record["values"]) if kind == "line_items" else {},
            )
        )
    return records, labels


# A clause list's printed headings -> the clause field they caption.
_CLAUSE_HEADER_FIELDS = (
    (re.compile(r"^variation", re.IGNORECASE), "contract.contract_clause.variation_date"),
    (re.compile(r"^(effective\s+)?date$", re.IGNORECASE), "contract.contract_clause.date"),
    (re.compile(r"^alternate|deviation", re.IGNORECASE), "contract.contract_clause.alternate"),
    (re.compile(r"^(number|far clause|clause)$", re.IGNORECASE), "contract.contract_clause.clause_number"),
    (re.compile(r"^title", re.IGNORECASE), "contract.contract_clause.title"),
)


def _clause_column_labels(structure: dict) -> dict[str, str]:
    """Use the clause lists' own column headings ("Effective Date",
    "Alternate/Deviation", "Variation Effective Date") as captions."""
    labels: dict[str, str] = {}
    for clause in structure.get("clauses", []):
        for header in clause.get("list_columns") or []:
            for pattern, field in _CLAUSE_HEADER_FIELDS:
                if pattern.search(header) and field not in labels:
                    labels[field] = header
                    break
    return labels


def _body_records(document: Document, structure: dict) -> tuple[list[RawRecord], list[RawRecord], list[RawRecord]]:
    body = structure.get("body") or {}
    sections: list[RawRecord] = []
    for index, item in enumerate(body.get("subsections", [])):
        heading = make_provenance(
            document, page=item["page"], evidence=f"{item['number']} {item['title']}", bbox=item["bbox"],
            extraction_method="contract_section_outline", region_id=f"section:{index}", anchor=item["number"],
        )
        cell_provenance = {"number": heading, "title": heading}
        if item.get("text"):
            cell_provenance["text"] = make_provenance(
                document, page=item["page"], evidence=item["text"],
                extraction_method="contract_section_outline", region_id=f"section:{index}:text",
            )
        cell_provenance["section"] = make_provenance(
            document, page=item["page"], evidence=item["section"],
            extraction_method="contract_section_outline", region_id=f"section:{index}:section",
        )
        sections.append(
            RawRecord(
                record_id=f"section:{index}:{item['number']}",
                values={"number": item["number"], "title": item["title"], "section": item["section"], "text": item.get("text") or None},
                cell_provenance=cell_provenance,
            )
        )
    tables: list[RawRecord] = []
    for table in body.get("tables", []):
        headers = table["headers"][:_BODY_TABLE_WIDTH]
        for row_index, row in enumerate(table["rows"]):
            cells = row[: _BODY_TABLE_WIDTH - 1] + ([" ".join(row[_BODY_TABLE_WIDTH - 1:])] if len(row) >= _BODY_TABLE_WIDTH else [])
            page, bbox = table["row_boxes"][row_index] if row_index < len(table["row_boxes"]) else (table["pages"][0], None)
            values = {"table_id": table["table_id"], "section": table["section"], "subsection": table.get("subsection"),
                      "headers": " | ".join(headers)}
            provenance = {}
            for i, cell in enumerate(cells, start=1):
                if cell:
                    values[f"c{i}"] = cell
                    provenance[f"c{i}"] = make_provenance(
                        document, page=page, evidence=cell, bbox=bbox,
                        extraction_method="section_table_layout", region_id=f"{table['table_id']}:{row_index}:{i}",
                    )
            tables.append(RawRecord(record_id=f"table:{table['table_id']}:{row_index}", values=values, cell_provenance=provenance))
    attachments: list[RawRecord] = []
    for index, item in enumerate(body.get("attachments", [])):
        provenance = make_provenance(
            document, page=item["page"], evidence=f"{item['reference']} {item['title']}", bbox=item["bbox"],
            extraction_method="attachment_list", region_id=f"attachment:{index}", anchor=item["reference"],
        )
        attachments.append(
            RawRecord(
                record_id=f"attachment:{index}:{item['reference']}",
                values={"reference": item["reference"], "title": item["title"], "group": item.get("group"), "section": item["section"]},
                provenance=provenance,
            )
        )
    return sections, tables, attachments


def _clause_records(document: Document, structure: dict) -> tuple[list[RawRecord], list[RawRecord]]:
    clauses: list[RawRecord] = []
    transforms: list[RawRecord] = []
    for index, clause in enumerate(structure.get("clauses", [])):
        record_id = f"clause:{index}:{clause['clause_number']}"
        row = make_provenance(
            document,
            page=clause["page"],
            evidence=clause["evidence"],
            bbox=clause["bbox"],
            extraction_method="clause_section_layout",
            region_id=record_id,
            anchor=clause["clause_number"],
        )
        heading = make_provenance(
            document,
            page=clause["page"],
            evidence=clause["source_heading"],
            extraction_method="clause_section_layout",
            region_id=f"{record_id}:context",
        )
        text = clause.get("text")
        text_provenance = (
            make_provenance(
                document,
                page=clause["page"],
                evidence=text,
                extraction_method="clause_section_layout",
                region_id=f"{record_id}:text",
                anchor=clause["clause_number"],
            )
            if text
            else None
        )
        cell_provenance = {
            "incorporation_type": heading,
            "regulation": heading,
            "source_heading": heading,
        }
        if clause.get("contract_section"):
            cell_provenance["contract_section"] = make_provenance(
                document,
                page=clause["page"],
                evidence=clause["contract_section"],
                extraction_method="clause_section_layout",
                region_id=f"{record_id}:section",
            )
        if text_provenance:
            cell_provenance["text"] = text_provenance
        clauses.append(
            RawRecord(
                record_id=record_id,
                values={
                    "clause_number": clause["clause_number"],
                    "title": clause["title"],
                    "date": clause.get("date"),
                    "incorporation_type": clause["incorporation_type"],
                    "regulation": clause["regulation"],
                    "alternate": clause.get("alternate"),
                    "source_heading": clause["source_heading"],
                    "contract_section": clause.get("contract_section"),
                    "variation_date": clause.get("variation_date"),
                    "text": text,
                },
                provenance=row,
                cell_provenance=cell_provenance,
            )
        )
        by_reference = clause["incorporation_type"] == "Incorporated by Reference"
        transform_provenance = {"text": text_provenance} if text_provenance else {}
        transform_provenance["insert_by_reference"] = heading
        transforms.append(
            RawRecord(
                record_id=f"transform:{index}:{clause['clause_number']}",
                values={
                    "number": clause["clause_number"],
                    "title": clause["title"],
                    "display_name": f"{clause['clause_number']} {clause['title']}",
                    "insert_by_reference": "Y" if by_reference else "N",
                    "text": text,
                },
                provenance=row,
                cell_provenance=transform_provenance,
            )
        )
    return clauses, transforms


def _opening_text(database: Session, document: Document, pages: int = 4) -> str:
    """The first pages' text — where the form number / program is named."""

    from sqlalchemy import select

    from app.models.document_page import DocumentPage

    texts = database.scalars(
        select(DocumentPage.final_text)
        .where(DocumentPage.document_id == document.id, DocumentPage.page_number <= pages)
        .order_by(DocumentPage.page_number)
    )
    return "\n".join(text or "" for text in texts)


def adapt_contract_v3(database: Session, document: Document) -> AdapterResult:
    doc = get_normalized_v3_document(database, document.id)
    geometry = PageGeometry(database, document.id)

    structure = load_contract_structure(database, document)
    line_items, line_labels = _table_records(document, structure, "line_items")
    deliveries, delivery_labels = _table_records(document, structure, "delivery_information")
    clauses, transforms = _clause_records(document, structure)
    clause_labels = _clause_column_labels(structure)
    body_sections, body_tables, body_attachments = _body_records(document, structure)

    records: dict[str, list[RawRecord]] = {
        "contract_details": _details_records(document, structure, doc, geometry),
        "line_items": line_items,
        "delivery_information": deliveries,
        "contract_sections": body_sections,
        "section_tables": body_tables,
        "contract_attachments": body_attachments,
        "contract_clauses": clauses,
        "clause_transformation": transforms,
        "contract_summary": _summary_record(document, geometry, doc),
        "clins": [
            _row_record(document, geometry, "clin", i, row, anchor=row.clin or None)
            for i, row in enumerate(doc.clins)
        ],
        "funding": [
            _row_record(document, geometry, "funding", i, row, anchor=row.clin or None)
            for i, row in enumerate(doc.funding)
        ],
        "performance_delivery": [
            _row_record(document, geometry, "performance", i, row)
            for i, row in enumerate(doc.performance_delivery)
        ],
        "attachments": [
            _row_record(document, geometry, "attachment", i, row, anchor=row.attachment_reference or None)
            for i, row in enumerate(doc.attachments)
        ],
        "clauses": [
            _row_record(document, geometry, "clause", i, row, anchor=row.clause_number or None)
            for i, row in enumerate(doc.clauses)
        ],
        "far_references": [
            _row_record(document, geometry, "far_reference", i, row) for i, row in enumerate(doc.far_references)
        ],
        "dfars": [
            _row_record(document, geometry, "dfars", i, row, anchor=row.clause_number or None)
            for i, row in enumerate(doc.dfars)
        ],
        "all_fields": [
            _row_record(document, geometry, "field", i, row) for i, row in enumerate(doc.all_fields)
        ],
        "source_documents": [
            RawRecord(record_id=f"source:{i}", values=row.model_dump())
            for i, row in enumerate(doc.source_documents)
        ],
        "qa_review": [
            RawRecord(
                record_id=f"qa:{i}",
                values=row.model_dump(),
                links_to_dataset=_QA_CHECK_TO_DATASET.get(row.qa_check),
            )
            for i, row in enumerate(doc.qa_review)
        ],
    }
    # The business presentation over the records above (never re-extracted).
    filename = document.original_filename or "contract.pdf"
    from app.classification.service import presentation_subtype

    subtype = presentation_subtype(database, document.id, _opening_text(database, document))
    records["contract_data"] = contract_data_records(records, filename)
    records["contract_overview"] = contract_overview_records(document, records, records["contract_data"], subtype)
    return AdapterResult(
        records=records,
        outcome_provenance=document.ingestion_provenance,
        # Contract Data shows its subtype's columns, in that order.
        dataset_descriptions={
            "contract_data": (
                f"Everything extracted from this {SUBTYPE_LABELS[subtype]}, one record per row, in the columns for "
                "that contract type. Text is verbatim; every value links to its page."
            )
        },
        column_labels={
            "contract_data": column_labels(subtype),
            "line_items": line_labels,
            "delivery_information": delivery_labels,
            "contract_clauses": clause_labels,
        },
    )


_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def export_contract(database: Session, document: Document, export_id: str) -> ExportArtifact | None:
    """The contract workbook (the profile's export sheets), from the staged
    values the Staging Workbook shows."""

    if export_id != "contract_workbook.xlsx":
        return None
    from app.staging.document_labels import document_labels
    from app.staging.export import build_profile_xlsx
    from app.staging.service import get_staging_workbook

    stem = (document.original_filename or "contract").rsplit(".", 1)[0]
    workbook = get_staging_workbook(database, document.id)
    content = build_profile_xlsx(workbook, CONTRACT_V3_PROFILE.export_sheets, document_labels(database, document))
    return ExportArtifact(content, _XLSX, f"{stem}_contract.xlsx")


CONTRACT_V3_PROFILE = StagingProfile(
    profile_id="contract_v3",
    profile_version=1,
    display_name="Contract",
    description=(
        "Federal contract / solicitation / award: every extracted record in one Contract Data view, "
        "a compact Contract Summary, and full source traceability."
    ),
    document_families=("government_contract",),
    datasets=(
        CONTRACT_DATA,
        CONTRACT_OVERVIEW,
        CONTRACT_DETAILS,
        LINE_ITEMS,
        DELIVERY_INFORMATION,
        CONTRACT_ATTACHMENTS,
        CONTRACT_SECTIONS,
        SECTION_TABLES,
        CONTRACT_CLAUSES,
        CLAUSE_TRANSFORMATION,
        CONTRACT_SUMMARY,
        CLINS,
        FUNDING,
        PERFORMANCE_DELIVERY,
        ATTACHMENTS,
        CLAUSES,
        FAR_REFERENCES,
        DFARS,
        ALL_FIELDS,
        SOURCE_DOCUMENTS,
        QA_REVIEW,
    ),
    adapter=adapt_contract_v3,
    export_sheets=(
        ExportSheet("Contract Summary", ("contract_overview",)),
        ExportSheet("Contract Data", ("contract_data",)),
        # The schedule's own line items, else the V3 CLINs.
        ExportSheet("Line Items", ("line_items", "clins"), first_populated=True),
        ExportSheet("Clauses & Provisions", ("contract_clauses", "clauses"), first_populated=True),
        ExportSheet("Other Information", ("delivery_information", "contract_attachments")),
        ExportSheet(SOURCE_SHEET, ()),
    ),
    materializer=materialize_contract_structure,
    # Every export serializes the staged values shown in the workbook. (The
    # V3 tables' own exports remain available from the V3 API only.)
    export_capabilities=(
        ExportCapability(
            capability_id="contract_presentation_xlsx",
            label="Contract Workbook (Excel)",
            format="xlsx",
            href="/api/documents/{document_id}/staging-workbook/export.xlsx",
        ),
        ExportCapability(
            capability_id="contract_summary_csv",
            label="Contract Summary (CSV)",
            format="csv",
            href="/api/documents/{document_id}/staging-workbook/datasets/contract_overview.csv",
            dataset_id="contract_overview",
        ),
        ExportCapability(
            capability_id="contract_data_csv",
            label="Contract Data (CSV)",
            format="csv",
            href="/api/documents/{document_id}/staging-workbook/datasets/contract_data.csv",
            dataset_id="contract_data",
        ),
        ExportCapability(
            capability_id="contract_lines_csv",
            label="Line Items (CSV)",
            format="csv",
            href="/api/documents/{document_id}/staging-workbook/datasets/line_items.csv",
            dataset_id="line_items",
        ),
        ExportCapability(
            capability_id="contract_clauses_csv",
            label="Clauses & Provisions (CSV)",
            format="csv",
            href="/api/documents/{document_id}/staging-workbook/datasets/contract_clauses.csv",
            dataset_id="contract_clauses",
        ),
        ExportCapability(
            capability_id="contract_workbook_json",
            label="Contract Workbook (JSON)",
            format="json",
            href="/api/documents/{document_id}/staging-workbook/export.json",
        ),
    ),
    oracle_mapping_capability="planned",
    # The V3 pipeline is sufficient; structure is still available on
    # demand (e.g. the source-structure endpoints) but not built per job.
    source_structure="optional",
    exporter=export_contract,
    views=(
        ProfileView(view_id="contract_summary", label="Contract Summary", dataset_ids=["contract_overview"]),
        ProfileView(view_id="contract_data", label="Contract Data", dataset_ids=["contract_data"]),
        ProfileView(view_id="source", label="Source", dataset_ids=["source_documents", "qa_review"], kind="source"),
    ),
)
