"""invoice@1 — Invoice staging profile.

Interpretation and validation ONLY: it reads the schema-neutral source
structure (label/value candidates, tables, regions — app/source_structure/)
and never reopens or re-parses the source file. The same code therefore
serves native PDF, scanned PDF (OCR geometry already mapped to PDF points)
and HTML.

    structure ─► map labels (controlled aliases, invoice_vocabulary.py)
              ─► interpret regions (letterhead supplier, labelled blocks,
                 title → invoice type)
              ─► line tables (header aliases → structural roles), merged
                 across pages only on strong continuation evidence
              ─► validation (line extensions, lines vs subtotal, totals,
                 amount due) as per-cell checks → Needs Review, never edits
              ─► RawRecords for the shared staging engine
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.document import Document
from app.models.document_staging_workbook import DocumentStagingWorkbook
from app.services.invoice_matching import match_supplier, validate_po
from app.services.v3_reader import get_normalized_v3_document
from app.source_structure.models import (
    FieldCandidate,
    StructuredRegion,
    StructuredSourceDocument,
    TableCandidate,
    TableCell,
)
from app.source_structure.service import get_or_build_source_structure
from app.source_structure.text_shapes import normalize_space
from app.staging.models import (
    CellProvenance,
    ExportCapability,
    SourceColumn,
    SourceColumnValue,
    ValidationCheck,
)
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
from app.staging.profiles.invoice_vocabulary import (
    CONTACT_LABELS,
    LINE_HEADER_ALIASES,
    SCALAR_ALIASES,
    Alias,
    charge_type,
    normalize_label,
    rate_in_label,
)
from app.staging.structure_provenance import (
    field_provenance,
    region_provenance,
    source_column,
    table_cell_provenance,
)
from app.staging.provenance import system_provenance
from app.staging.validation import to_number

F = FieldDefinition

_MONEY = re.compile(r"^\s*[-(]?\s*(?:[$€£¥]|USD|EUR|GBP)?\s*-?\d[\d,]*\.\d{2}\)?\s*$")

# --- datasets -------------------------------------------------------------------

INVOICE_SUMMARY = DatasetDefinition(
    dataset_id="invoice_summary",
    display_name="Invoice Summary",
    cardinality="single",
    description="Invoice identification, dates, currency and terms.",
    identity_fields=("invoice.invoice_number",),
    fields=(
        F("invoice.invoice_number", "invoice_number", "Invoice Number", "code", expected=True),
        F("invoice.invoice_date", "invoice_date", "Invoice Date", "date", expected=True),
        F("invoice.due_date", "due_date", "Due Date", "date", expected=True),
        F("invoice.currency", "currency", "Currency", expected=True, grounding="derived"),
        F("invoice.payment_terms", "payment_terms", "Payment Terms", expected=True),
        F("invoice.type", "invoice_type", "Invoice Type", grounding="derived"),
    ),
)

SUPPLIER = DatasetDefinition(
    dataset_id="supplier",
    display_name="Supplier",
    cardinality="single",
    description="Who issued the invoice.",
    identity_fields=("invoice.supplier.name",),
    fields=(
        F("invoice.supplier.name", "name", "Supplier Name", expected=True),
        F("invoice.supplier.number", "number", "Supplier Number", "code"),
        F("invoice.supplier.tax_id", "tax_id", "Tax ID", "code"),
        F("invoice.supplier.address", "address", "Address"),
        F("invoice.supplier.email", "email", "Email"),
        F("invoice.supplier.phone", "phone", "Phone"),
        F("invoice.supplier.remit_to", "remit_to", "Remit To"),
    ),
)

CUSTOMER = DatasetDefinition(
    dataset_id="customer",
    display_name="Customer / Bill-To",
    cardinality="single",
    description="Who is billed, and where goods or services are delivered.",
    identity_fields=("invoice.customer.name",),
    fields=(
        F("invoice.customer.name", "name", "Customer Name", expected=True),
        F("invoice.customer.number", "number", "Customer Number", "code"),
        F("invoice.customer.bill_to_address", "bill_to_address", "Bill-To Address", expected=True),
        F("invoice.customer.ship_to_address", "ship_to_address", "Ship-To Address"),
    ),
)

REFERENCE = DatasetDefinition(
    dataset_id="reference",
    display_name="PO / Contract Reference",
    cardinality="single",
    description="Purchase order, contract, receipt and order references stated on the invoice.",
    fields=(
        F("invoice.reference.po_number", "po_number", "PO Number", "code"),
        F("invoice.reference.contract_number", "contract_number", "Contract Number", "code"),
        F("invoice.reference.receipt_number", "receipt_number", "Receipt Number", "code"),
        F("invoice.reference.order_number", "order_number", "Order Number", "code"),
    ),
)

INVOICE_LINES = DatasetDefinition(
    dataset_id="invoice_lines",
    display_name="Invoice Lines",
    cardinality="repeating",
    description="One row per invoice line; tables continued across pages are merged only on strong evidence.",
    identity_fields=("invoice.line.line_number", "invoice.line.description"),
    fields=(
        F("invoice.line.line_number", "line_number", "Line"),
        F("invoice.line.item_number", "item_number", "Item / Part"),
        F("invoice.line.description", "description", "Description"),
        F("invoice.line.quantity", "quantity", "Quantity", "number"),
        F("invoice.line.uom", "uom", "UOM"),
        F("invoice.line.unit_price", "unit_price", "Unit Price", "money"),
        F("invoice.line.amount", "amount", "Line Amount", "money", expected=True),
        F("invoice.line.tax", "tax", "Tax", "money"),
        F("invoice.line.po_line", "po_line", "PO Line"),
        F("invoice.line.other_values", "other_values", "Other Columns", grounding="derived"),
        F("invoice.line.source_table", "source_table", "Table", grounding="none"),
    ),
)

TAXES_CHARGES = DatasetDefinition(
    dataset_id="taxes_charges",
    display_name="Taxes / Charges",
    cardinality="repeating",
    description="Each tax, freight, handling, discount, surcharge or other charge as stated.",
    identity_fields=("invoice.charge.label", "invoice.charge.amount"),
    fields=(
        F("invoice.charge.type", "charge_type", "Type", grounding="derived"),
        F("invoice.charge.label", "label", "Label as Stated", grounding="derived"),
        F("invoice.charge.rate", "rate", "Rate", grounding="derived"),
        F("invoice.charge.amount", "amount", "Amount", "money", expected=True),
    ),
)

DISTRIBUTIONS = DatasetDefinition(
    dataset_id="distributions",
    display_name="Distributions",
    cardinality="repeating",
    description="Accounting distributions (GL account, cost center, project) stated on the invoice.",
    identity_fields=("invoice.distribution.dimension", "invoice.distribution.value"),
    fields=(
        F("invoice.distribution.dimension", "dimension", "Dimension", grounding="derived"),
        F("invoice.distribution.value", "value", "Value", expected=True),
        F("invoice.distribution.amount", "amount", "Amount", "money"),
    ),
)

TOTALS = DatasetDefinition(
    dataset_id="totals",
    display_name="Totals",
    cardinality="single",
    description="Document totals as stated, with arithmetic checks.",
    fields=(
        F("invoice.total.subtotal", "subtotal", "Subtotal", "money"),
        F("invoice.total.tax", "tax", "Tax", "money"),
        F("invoice.total.freight", "freight", "Freight", "money"),
        F("invoice.total.discount", "discount", "Discount", "money"),
        F("invoice.total.invoice_amount", "invoice_amount", "Invoice Total", "money"),
        F("invoice.total.amount_paid", "amount_paid", "Amount Paid", "money"),
        F("invoice.total.amount_due", "amount_due", "Amount Due", "money"),
    ),
)

OTHER_FIELDS = DatasetDefinition(
    dataset_id="other_fields",
    display_name="Other Fields",
    cardinality="repeating",
    description=(
        "Meaningful source fields that don't map to a canonical invoice field "
        "(e.g. shipping or commercial details) — kept as stated, never forced "
        "into a mapping."
    ),
    identity_fields=("invoice.other.name", "invoice.other.value"),
    fields=(
        F("invoice.other.name", "name", "Field", grounding="derived"),
        F("invoice.other.value", "value", "Value", expected=True),
        F("invoice.other.value_type", "value_type", "Type", grounding="none"),
        F("invoice.other.found_by", "found_by", "Found By", grounding="none"),
    ),
)

ALL_FIELDS = DatasetDefinition(
    dataset_id="all_fields",
    display_name="All Fields",
    cardinality="repeating",
    description=(
        "Everything found, normalized: the invoice fields (summary, supplier, "
        "customer, references, totals), each tax/charge, every invoice line cell "
        "(\"Line 1 / Part Number\"), and Other Fields — each with its own evidence."
    ),
    identity_fields=("invoice.field.category", "invoice.field.name", "invoice.field.value"),
    fields=(
        F("invoice.field.category", "category", "Category", grounding="none"),
        F("invoice.field.name", "name", "Field", grounding="derived"),
        F("invoice.field.value", "value", "Value", expected=True),
        F("invoice.field.value_type", "value_type", "Type", grounding="none"),
        F("invoice.field.found_by", "found_by", "Found By", grounding="none"),
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

INVOICE_VALIDATION = DatasetDefinition(
    dataset_id="invoice_validation",
    display_name="Supplier & PO Validation",
    cardinality="repeating",
    role="qa",
    description="The invoice matched against the supplier master and purchase orders.",
    identity_fields=("invoice.validation.check",),
    fields=(
        F("invoice.validation.check", "check", "Check", grounding="none"),
        F("invoice.validation.result", "result", "Result", grounding="none"),
        F("invoice.validation.details", "details", "Details", grounding="none"),
    ),
)

ERP_STAGING = DatasetDefinition(
    dataset_id="erp_staging",
    display_name="ERP Staging",
    cardinality="repeating",
    # The invoice reshaped for the ERP (like FAR's Oracle output), not
    # extracted data: its values' evidence is on the business datasets.
    role="transform",
    description=(
        "The Payables header staged for the ERP: extracted values joined to supplier master and PO data. "
        "\"Not Validated\" = every expected field recognized and matched (ready for ERP validation); "
        "\"Incomplete\" = needs attention. The Oracle import file layout comes from your FBDI/REST template."
    ),
    identity_fields=("invoice.erp.field",),
    fields=(
        F("invoice.erp.field", "field", "Field", grounding="none"),
        F("invoice.erp.value", "value", "Value", grounding="none"),
        F("invoice.erp.source", "source", "Source", grounding="none"),
        F("invoice.erp.status", "status", "Status", grounding="none"),
    ),
)

RECOGNITION_COMPLETE = "Not Validated"
RECOGNITION_INCOMPLETE = "Incomplete"

_SCALAR_DATASET = {
    "invoice.invoice_number": ("invoice_summary", "invoice_number"),
    "invoice.invoice_date": ("invoice_summary", "invoice_date"),
    "invoice.due_date": ("invoice_summary", "due_date"),
    "invoice.currency": ("invoice_summary", "currency"),
    "invoice.payment_terms": ("invoice_summary", "payment_terms"),
    "invoice.type": ("invoice_summary", "invoice_type"),
    "invoice.supplier.name": ("supplier", "name"),
    "invoice.supplier.number": ("supplier", "number"),
    "invoice.supplier.tax_id": ("supplier", "tax_id"),
    "invoice.supplier.remit_to": ("supplier", "remit_to"),
    "invoice.customer.name": ("customer", "name"),
    "invoice.customer.number": ("customer", "number"),
    "invoice.customer.bill_to_address": ("customer", "bill_to_address"),
    "invoice.customer.ship_to_address": ("customer", "ship_to_address"),
    "invoice.reference.po_number": ("reference", "po_number"),
    "invoice.reference.contract_number": ("reference", "contract_number"),
    "invoice.reference.receipt_number": ("reference", "receipt_number"),
    "invoice.reference.order_number": ("reference", "order_number"),
    "invoice.total.subtotal": ("totals", "subtotal"),
    "invoice.total.invoice_amount": ("totals", "invoice_amount"),
    "invoice.total.amount_paid": ("totals", "amount_paid"),
    "invoice.total.amount_due": ("totals", "amount_due"),
    "invoice.total.tax": ("totals", "tax"),
}

_DISTRIBUTION_LABELS = {
    "gl account": "GL Account", "gl code": "GL Account", "account code": "GL Account",
    "cost center": "Cost Center", "cost centre": "Cost Center", "project": "Project",
    "project number": "Project", "cost code": "Cost Code", "department": "Department",
}
_TITLE_WORDS = re.compile(r"\b(invoice|credit|debit|statement|receipt|bill|quote|quotation)\b", re.I)
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
_PHONE = re.compile(r"(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]?\d{3}[\s.-]?\d{3,4}")
_ISO = re.compile(r"\b(USD|EUR|GBP|CAD|AUD|NZD|JPY|CHF|CNY|INR|SEK|NOK|DKK|MXN|SGD|HKD|ZAR)\b")
_CONTINUATION = re.compile(r"\bcontinued\b|\bcont'?d\b|\bcarried forward\b|\bpage \d+ of \d+\b", re.I)
_ADDRESS_ALIASES = {"invoice.customer.bill_to_address", "invoice.customer.ship_to_address", "invoice.supplier.remit_to", "invoice.customer.name"}


# --- intermediate forms ------------------------------------------------------------


@dataclass
class Labeled:
    """A label/value pair from any structural source (label/value candidate,
    a table total row, or a heading-labelled block)."""

    label: str
    value: str
    provenance: CellProvenance
    found_by: str
    value_type: str | None = None
    page: int | None = None
    y: float = 0.0
    quality_score: float = 1.0
    quality_flags: list[str] = field(default_factory=list)


@dataclass
class Assigned:
    value: str
    provenance: CellProvenance
    checks: list[ValidationCheck] = field(default_factory=list)


def _fail(check: str, message: str) -> ValidationCheck:
    return ValidationCheck(check=check, passed=False, message=message)


def _order_key(item: Labeled) -> tuple:
    return (item.page or 0, item.y)


# --- collecting labelled values ------------------------------------------------------


# A whole value that is only a document title ("INVOICE", "Credit Memo").
_TITLE_ONLY = re.compile(r"^\s*(?:tax\s+)?(?:invoice|credit\s+(?:memo|note)|debit\s+note|statement|receipt|bill)\s*$", re.I)


def _is_title_pair(candidate) -> bool:
    """A letterhead name and the document title on one line read as a
    label/value pair ("Fabrikam Partners  …  INVOICE"); it is neither a
    field nor a value."""

    return bool(_TITLE_ONLY.match(candidate.raw_value or "")) and not _TITLE_WORDS.search(candidate.label_text or "")


def _from_candidates(document: Document, structure: StructuredSourceDocument) -> list[Labeled]:
    items = []
    for candidate in structure.field_candidates:
        if candidate.acceptance != "accepted" or _is_title_pair(candidate):
            continue
        items.append(
            Labeled(
                label=candidate.label_text,
                value=candidate.raw_value.strip(),
                provenance=field_provenance(document, candidate),
                found_by=candidate.structural_relation.replace("_", " "),
                value_type=candidate.value_type_hint,
                page=candidate.page,
                y=(candidate.value_bbox or candidate.label_bbox or (0, 0, 0, 0))[1],
                quality_score=candidate.quality_score,
                quality_flags=list(candidate.quality_flags),
            )
        )
    return items


def _from_total_rows(document: Document, tables: list[TableCandidate]) -> list[Labeled]:
    items = []
    for table in tables:
        for r in table.total_row_indices:
            if r >= len(table.rows):
                continue
            row = table.rows[r]
            filled = [c for c in row if c.text]
            if len(filled) < 2:
                continue
            label, value = filled[0], filled[-1]
            items.append(
                Labeled(
                    label=label.text,
                    value=value.text,
                    provenance=table_cell_provenance(document, table, row, value, label.text),
                    found_by="table total row",
                    page=table.page,
                    y=(value.bbox or (0, 0, 0, 0))[1],
                )
            )
    return items


def _from_labelled_blocks(document: Document, structure: StructuredSourceDocument) -> list[Labeled]:
    """Blocks labelled by an enclosing/preceding heading instead of a
    'Label:' run: HTML <h3>Billed To</h3><address>…, or a PDF heading
    'Ship To' above a paragraph."""

    items: list[Labeled] = []
    blocks = [r for r in structure.regions if r.region_type in ("CONTACT_BLOCK", "PARAGRAPH")]
    headings = [r for r in structure.regions if r.region_type == "HEADING"]
    for block in blocks:
        label = None
        if block.source_locator and block.source_locator.section_path:
            label = block.source_locator.section_path[-1]
        elif block.bbox:
            above = [
                h for h in headings
                if h.page == block.page and h.bbox
                and 0 <= block.bbox[1] - h.bbox[3] <= 25 and abs(h.bbox[0] - block.bbox[0]) <= 15
            ]
            label = above[-1].text if above else None
        if not label:
            continue
        alias = SCALAR_ALIASES.get(normalize_label(label))
        if alias is None or alias.canonical not in _ADDRESS_ALIASES:
            continue
        items.append(
            Labeled(
                label=label,
                value=block.text.strip(),
                provenance=region_provenance(document, block, kind="labelled_block"),
                found_by="heading-labelled block",
                value_type="address",
                page=block.page,
                y=(block.bbox or (0, 0, 0, 0))[1],
            )
        )
    return items


# --- scalar assignment -----------------------------------------------------------------


class Scalars:
    """canonical id → assigned value, with conflict and ambiguity checks."""

    def __init__(self):
        self.assigned: dict[str, Assigned] = {}
        self._ambiguous_only: set[str] = set()

    def offer(self, canonical: str, item: Labeled, alias: Alias | None, all_fields: list[Labeled]) -> None:
        checks: list[ValidationCheck] = []
        if alias and alias.ambiguous:
            checks.append(_fail("ambiguous_label", alias.note or f"The label '{item.label}' is ambiguous."))
        if item.quality_score < 0.6:
            checks.append(
                _fail(
                    "weak_structural_pairing",
                    "Weak label/value pairing (" + ", ".join(f.replace("_", " ") for f in item.quality_flags) + ").",
                )
            )
        existing = self.assigned.get(canonical)
        if existing is None:
            self.assigned[canonical] = Assigned(item.value, item.provenance, checks)
            if alias and alias.ambiguous:
                self._ambiguous_only.add(canonical)
            return
        if normalize_space(existing.value).lower() == normalize_space(item.value).lower():
            return  # the same value restated (e.g. a header repeated per page)
        if canonical in self._ambiguous_only and not (alias and alias.ambiguous):
            # A specific label beats a generic one; keep the generic in All Fields.
            self.assigned[canonical] = Assigned(item.value, item.provenance, checks)
            self._ambiguous_only.discard(canonical)
            return
        if alias and alias.ambiguous:
            all_fields.append(item)
            return
        existing.checks.append(
            _fail(
                "conflicting_values",
                f"Another value '{item.value}' was found for this field"
                + (f" on page {item.page}" if item.page else "")
                + ".",
            )
        )


# --- All Fields -----------------------------------------------------------------------------


_LINE_LABELS = {f.key: f.display_label for f in INVOICE_LINES.fields}


def _line_cell_fields(lines: list[RawRecord]) -> list[RawRecord]:
    """Every invoice line cell as its own All Fields row, with context —
    Category "Invoice Lines", Field "Line 3 / Unit Price" — and the cell's
    own provenance and checks (a flagged amount stays flagged)."""

    records: list[RawRecord] = []
    for number, line in enumerate(lines, start=1):
        label = f"Line {line.values.get('line_number') or number}"
        for key, value in line.values.items():
            if key in ("source_table",) or value in (None, ""):
                continue
            records.append(
                RawRecord(
                    record_id=f"{line.record_id}:{key}",
                    values={
                        "category": "Invoice Lines",
                        "name": f"{label} / {_LINE_LABELS.get(key, key)}",
                        "value": value,
                        "value_type": "table cell",
                        "found_by": "invoice line table",
                    },
                    provenance=line.cell_provenance.get(key) or line.provenance,
                    cell_checks={"value": line.cell_checks[key]} if key in line.cell_checks else {},
                )
            )
    return records


def _all_fields_union(
    scalars: "Scalars",
    supplier_values: dict,
    supplier_prov: dict,
    supplier_checks: dict,
    totals_values: dict,
    totals_prov: dict,
    charges: list,
    unmapped: list,
) -> list[RawRecord]:
    """All Fields = every field this invoice produced (with its own
    provenance and checks, so a flagged value stays flagged here), each
    tax/charge, then the unmapped label/value pairs."""

    labels = {
        f.canonical_field: (dataset.display_name, f.display_label, f.value_type)
        for dataset in (INVOICE_SUMMARY, SUPPLIER, CUSTOMER, REFERENCE, TOTALS)
        for f in dataset.fields
    }
    records: list[RawRecord] = []

    def add(record_id: str, canonical: str, value, provenance, checks, found_by: str) -> None:
        if value in (None, ""):
            return
        category, name, value_type = labels.get(canonical, ("Invoice", canonical, "text"))
        records.append(
            RawRecord(
                record_id=record_id,
                values={"category": category, "name": name, "value": value, "value_type": value_type, "found_by": found_by},
                provenance=provenance,
                cell_checks={"value": checks} if checks else {},
            )
        )

    for canonical, assigned in scalars.assigned.items():
        add(f"field:{canonical}", canonical, assigned.value, assigned.provenance, assigned.checks, "invoice field")
    for key, value in supplier_values.items():
        canonical = f"invoice.supplier.{key}"
        if canonical not in scalars.assigned:
            add(f"field:{canonical}", canonical, value, supplier_prov.get(key), supplier_checks.get(key), "invoice field")
    for key, value in totals_values.items():
        canonical = f"invoice.total.{key}"
        if canonical not in scalars.assigned:
            add(f"field:{canonical}", canonical, value, totals_prov.get(key), None, "invoice field")
    for i, (kind, item) in enumerate(charges):
        records.append(
            RawRecord(
                record_id=f"field:charge:{i}",
                values={"category": "Taxes / Charges", "name": item.label, "value": item.value, "value_type": "money", "found_by": kind},
                provenance=item.provenance,
            )
        )
    for i, item in enumerate(unmapped):
        records.append(
            RawRecord(
                record_id=f"field:{i}",
                values={"category": "Other Field", "name": item.label, "value": item.value, "value_type": item.value_type, "found_by": item.found_by},
                provenance=item.provenance,
            )
        )
    return records


# --- supplier (letterhead) --------------------------------------------------------------


def _letterhead(structure: StructuredSourceDocument):
    """The issuer block: the top-most prominent heading on the first page
    that isn't a document title, plus the text blocks directly under it."""

    headings = [r for r in structure.regions if r.region_type == "HEADING"]
    if structure.source_type == "html":
        header_headings = [h for h in headings if h.source_locator and "/header" in (h.source_locator.dom_path or "")]
        name_region = (header_headings or headings[:1] or [None])[0]
        if name_region is None or _TITLE_WORDS.search(name_region.text):
            return None, []
        prefix = (name_region.source_locator.dom_path or "").rsplit("/", 1)[0]
        blocks = [
            r for r in structure.regions
            if r.region_type in ("CONTACT_BLOCK", "PARAGRAPH")
            and r.source_locator and (r.source_locator.dom_path or "").startswith(prefix)
            and not (r.source_locator.section_path and len(r.source_locator.section_path) > 1)
        ]
        return name_region, blocks

    first_page = min((r.page for r in structure.regions if r.page), default=None)
    # A heading, or a one-line block set apart by weight/size — how
    # letterheads are typeset.
    prominent = headings + [
        r for r in structure.regions
        if r.region_type in ("PARAGRAPH", "CONTACT_BLOCK")
        and r.structural_metadata.get("lines") == 1 and r.structural_metadata.get("bold")
    ]
    candidates = [
        h for h in prominent
        if h.page == first_page and h.bbox and h.bbox[1] < 250
        and not _TITLE_WORDS.search(h.text) and len(re.findall(r"[A-Za-z]", h.text)) >= 3
    ]
    # The issuer's name typeset on the same line as the title can come out
    # as a label/value pair instead of a heading: its "label" is the name.
    by_id = {r.region_id: r for r in structure.regions}
    for candidate in structure.field_candidates:
        if (
            candidate.page == first_page and candidate.label_bbox and candidate.label_bbox[1] < 250
            and _is_title_pair(candidate) and len(re.findall(r"[A-Za-z]", candidate.label_text)) >= 3
        ):
            source = next((by_id[i] for i in candidate.source_region_ids if i in by_id), None)
            if source is not None:
                candidates.append(
                    source.model_copy(update={"text": candidate.label_text, "bbox": candidate.label_bbox, "region_type": "HEADING"})
                )
    if not candidates:
        return None, []
    name_region = min(candidates, key=lambda h: (round(h.bbox[1] / 10), h.bbox[0]))
    x0, bottom = name_region.bbox[0], name_region.bbox[3]
    blocks = [
        r for r in structure.regions
        if r.page == first_page and r.region_type in ("CONTACT_BLOCK", "PARAGRAPH") and r.bbox
        and abs(r.bbox[0] - x0) <= 15 and bottom - 2 <= r.bbox[1] <= bottom + 70
    ]
    # A run further along the same letterhead line ("Tel …   billing@…")
    # is part of the block even though it doesn't start at the left edge.
    for r in structure.regions:
        if r in blocks or not r.bbox or r.page != first_page or r.region_type not in ("CONTACT_BLOCK", "PARAGRAPH"):
            continue
        if any(
            b.bbox and min(b.bbox[3], r.bbox[3]) - max(b.bbox[1], r.bbox[1]) > 0.5 * (r.bbox[3] - r.bbox[1])
            and b.bbox[0] + 20 < r.bbox[0] <= b.bbox[2] + 60
            for b in blocks
        ):
            blocks.append(r)
    return name_region, sorted(blocks, key=lambda r: (r.bbox[1], r.bbox[0]))


def _name_tokens(name: str) -> list[str]:
    stop = {"inc", "llc", "ltd", "co", "corp", "company", "gmbh", "bv", "b", "v", "plc", "the", "and", "services", "group"}
    return [t for t in re.findall(r"[a-z0-9]+", name.lower()) if t not in stop and len(t) >= 3]


def _corroborated(name: str, emails: list[str], remit_to: str | None) -> str | None:
    tokens = _name_tokens(name)
    if remit_to and normalize_space(remit_to).lower().startswith(normalize_space(name).lower()[:12]):
        return "matches the Remit To name"
    for email in emails:
        domain = email.split("@", 1)[1].split(".")[0].lower().replace("-", "")
        if any(t in domain for t in tokens) or "".join(tokens[:2]) in domain:
            return "matches the email domain"
    return None


# --- line tables -------------------------------------------------------------------------------


def _numeric_column(table: TableCandidate, column: int) -> bool:
    hints = table.column_hints.get(column, [])
    if "numeric_amount_column" in hints or "quantity_column" in hints:
        return True
    values = [row[column].text for row in table.rows if column < len(row) and row[column].text]
    return bool(values) and sum(1 for v in values if to_number(v) is not None and not re.search(r"[A-Za-z]{2,}", v)) >= 0.7 * len(values)


def _column_roles(table: TableCandidate) -> dict[str, int]:
    """Canonical line field → column index: header aliases first, validated
    against the column's structural shape, then structural hints fill gaps."""

    roles: dict[str, int] = {}
    numeric_fields = {"quantity", "unit_price", "amount", "tax"}
    if table.header_cells:
        for index, header in enumerate(table.headers):
            role = LINE_HEADER_ALIASES.get(normalize_label(header))
            if role is None:
                # "Part Number / Description": one column carrying two
                # fields — each part names a role; the cell is split later.
                parts = {LINE_HEADER_ALIASES.get(normalize_label(p)) for p in re.split(r"\s*(?:/|&|\+)\s*", header) if p.strip()}
                if {"item_number", "description"} <= parts and not _numeric_column(table, index):
                    roles.setdefault("item_number", index)
                    roles.setdefault("description", index)
                continue
            numeric = _numeric_column(table, index)
            if role in numeric_fields and not numeric:
                continue
            if role in ("uom", "description") and numeric:
                continue
            if role == "amount" or role not in roles:
                roles[role] = index  # rightmost "amount" wins (Unit Price … Total)

    def hinted(hint: str) -> list[int]:
        return sorted(c for c, hs in table.column_hints.items() if hint in hs and c not in roles.values())

    if "description" not in roles and hinted("description_column"):
        roles["description"] = hinted("description_column")[0]
    if "quantity" not in roles and hinted("quantity_column"):
        roles["quantity"] = hinted("quantity_column")[0]
    if "uom" not in roles and hinted("unit_column"):
        roles["uom"] = hinted("unit_column")[0]
    amounts = hinted("numeric_amount_column")
    if "amount" not in roles and amounts:
        roles["amount"] = amounts.pop()
    if "unit_price" not in roles and amounts:
        roles["unit_price"] = amounts.pop()
    identifiers = hinted("identifier_column")
    if identifiers and "line_number" not in roles and "item_number" not in roles:
        column = identifiers[0]
        values = [row[column].text for row in table.rows if column < len(row) and row[column].text]
        small_ints = all(v.isdigit() and int(v) < 10000 for v in values)
        roles["line_number" if small_ints else "item_number"] = column
    return roles


def _is_line_table(table: TableCandidate) -> bool:
    if table.acceptance != "accepted":
        return False
    roles = _column_roles(table)
    return "amount" in roles and ("description" in roles or "item_number" in roles)


def _header_key(table: TableCandidate) -> str:
    return table.continuation.header_signature if table.continuation else "|".join(normalize_label(h) for h in table.headers)


def _geometry_compatible(a: TableCandidate, b: TableCandidate) -> bool | None:
    def centers(table: TableCandidate) -> dict[int, float]:
        cells = table.header_cells or (table.rows[0] if table.rows else [])
        return {c.column_index: (c.bbox[0] + c.bbox[2]) / 2 for c in cells if c.bbox}

    ca, cb = centers(a), centers(b)
    shared = set(ca) & set(cb)
    if len(shared) < 2:
        return None
    close = sum(1 for c in shared if abs(ca[c] - cb[c]) <= 25)
    return close >= 0.7 * len(shared)


@dataclass
class LogicalTable:
    parts: list[TableCandidate]
    merge_evidence: list[str] = field(default_factory=list)


def merge_line_tables(
    tables: list[TableCandidate], structure: StructuredSourceDocument, invoice_numbers_by_page: dict[int, set[str]]
) -> list[LogicalTable]:
    """Merge a table with the one on the next page only on STRONG evidence:
    same column count and compatible headers (identical, or the next page
    has no header row) are required, the invoice identity must not change,
    and at least two points from: the extractor's continuation hint (table
    ends near the page bottom / next starts near the top), matching column
    geometry, continuation wording on the page."""

    continuation_pages = {
        r.page for r in structure.regions
        if r.page and r.region_type in ("PARAGRAPH", "NARRATIVE", "CONTACT_BLOCK", "HEADING") and _CONTINUATION.search(r.text)
    }
    ordered = sorted(tables, key=lambda t: (t.page or 0, t.bbox[1] if t.bbox else 0))
    logical: list[LogicalTable] = []
    for table in ordered:
        if logical:
            current = logical[-1]
            last = current.parts[-1]
            if last.page is not None and table.page == last.page + 1:
                evidence: list[str] = []
                same_columns = len(last.headers) == len(table.headers)
                headers_ok = (not table.header_cells) or _header_key(table) == _header_key(current.parts[0])
                a_numbers = invoice_numbers_by_page.get(last.page, set())
                b_numbers = invoice_numbers_by_page.get(table.page, set())
                identity_ok = not (a_numbers and b_numbers and not (a_numbers & b_numbers))
                score = 0
                if last.continuation and last.continuation.next_candidate_id == table.candidate_id:
                    score += 2
                    evidence.append("continuation hint (page-bottom → page-top)")
                geometry = _geometry_compatible(last, table)
                if geometry:
                    score += 1
                    evidence.append("column geometry matches")
                if last.page in continuation_pages:
                    score += 1
                    evidence.append("continuation wording on page")
                if same_columns and headers_ok and identity_ok and geometry is not False and score >= 2:
                    current.parts.append(table)
                    current.merge_evidence.append(f"page {last.page}→{table.page}: " + ", ".join(evidence))
                    continue
        logical.append(LogicalTable(parts=[table]))
    return logical


@dataclass
class LineStats:
    physical_tables: int = 0
    logical_tables: int = 0
    rows_seen: int = 0
    lines: int = 0
    repeated_headers_skipped: int = 0
    wrapped_rows_joined: int = 0
    total_rows_used: int = 0
    pages: set[int] = field(default_factory=set)
    merge_evidence: list[str] = field(default_factory=list)


def _union_bbox(a, b):
    if not a or not b:
        return a or b
    return (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))


def _code_shaped(token: str) -> bool:
    """Lexically a code on its own: no lowercase, has a digit or hyphen."""

    return len(token) >= 2 and not any(ch.islower() for ch in token) and (
        any(ch.isdigit() for ch in token) or "-" in token
    )


def _column_leads_with_codes(table: TableCandidate, column: int) -> bool:
    """Structural evidence that a combined "Part Number / Description"
    column really starts each cell with an identifier: most of its cells
    (at least two) begin with a lexically code-shaped token."""

    leads = [
        row[column].text.strip().partition(" ")[0]
        for row in table.rows
        if column < len(row) and row[column].text.strip()
    ]
    coded = sum(1 for token in leads if _code_shaped(token))
    return coded >= 2 and coded >= 0.5 * len(leads)


def _split_code(text: str, column_leads_with_codes: bool = False) -> tuple[str | None, str]:
    """"P-100 Premium copy paper" → ("P-100", "Premium copy paper"): a
    leading code-like token (no lowercase, has a digit or hyphen) is the
    part number; the rest is the description. Otherwise no code.

    Column semantics outrank lexical shape: when the header names the
    column "Part Number / Description" AND the column's cells demonstrably
    lead with codes, a purely alphabetic all-caps leading token ("TRV
    Travel and mileage") is that row's identifier too. Without that
    column evidence an uppercase first word stays description."""

    first, _, rest = text.strip().partition(" ")
    code_like = _code_shaped(first) or (
        column_leads_with_codes
        and 2 <= len(first) <= 10
        and first.isalpha()
        and first.isupper()
    )
    return (first, rest.strip()) if code_like and rest.strip() else (None, text.strip())


def _line_records(
    document: Document, logical: LogicalTable, label: str, stats: LineStats
) -> list[RawRecord]:
    records: list[RawRecord] = []
    header_norm = [normalize_label(h) for h in logical.parts[0].headers]
    for table in logical.parts:
        roles = _column_roles(table)
        mapped = set(roles.values())
        stats.pages.add(table.page) if table.page else None
        for r, row in enumerate(table.rows):
            stats.rows_seen += 1
            if r in table.total_row_indices:
                stats.total_rows_used += 1
                continue
            texts = [normalize_label(c.text) for c in row]
            if texts and texts == header_norm[: len(texts)] and any(texts):
                stats.repeated_headers_skipped += 1
                continue
            by_col = {c.column_index: c for c in row}

            def cell(role: str) -> TableCell | None:
                column = roles.get(role)
                found = by_col.get(column) if column is not None else None
                return found if found and found.text else None

            anchors = [cell(k) for k in ("line_number", "item_number", "quantity", "amount")]
            if not any(anchors):
                description = cell("description")
                if description and records and "description" in records[-1].values:
                    # Wrapped description text: continue the previous line.
                    previous = records[-1]
                    previous.values["description"] = f"{previous.values['description']} {description.text}"
                    prov = previous.cell_provenance.get("description")
                    if prov and prov.source_page == table.page:
                        prov.source_bbox = _union_bbox(prov.source_bbox, description.bbox)
                        prov.evidence_text = f"{prov.evidence_text}\n{description.text}"
                    stats.wrapped_rows_joined += 1
                continue

            anchor_cell = cell("line_number") or cell("item_number")
            anchor = anchor_cell.text if anchor_cell else next((c.text for c in row if c.text), None)
            values: dict[str, object] = {"source_table": label}
            provenance: dict[str, CellProvenance] = {}
            columns: dict[str, SourceColumn] = {}
            shared = roles.get("item_number") is not None and roles.get("item_number") == roles.get("description")
            leads_with_codes = shared and _column_leads_with_codes(table, roles["item_number"])
            for role in ("line_number", "item_number", "description", "quantity", "uom", "unit_price", "amount", "tax", "po_line"):
                found = cell(role)
                if found is None:
                    continue
                text = found.text
                if shared and role in ("item_number", "description"):
                    code, rest = _split_code(found.text, leads_with_codes)
                    text = code if role == "item_number" else rest
                    if not text:
                        continue
                values[role] = text
                provenance[role] = table_cell_provenance(document, table, row, found, anchor)
                provenance[role].highlight_text = text
                columns[role] = source_column(table, found.column_index)
            other = [
                f"{table.headers[c] if table.header_cells and c < len(table.headers) else f'Column {c + 1}'}: {x.text}"
                for c, x in sorted(by_col.items())
                if c not in mapped and x.text
            ]
            if other:
                values["other_values"] = "; ".join(other)

            checks: dict[str, list[ValidationCheck]] = {}
            quantity, price, amount = (to_number(values.get(k)) for k in ("quantity", "unit_price", "amount"))
            if quantity is not None and price is not None and amount is not None:
                expected = quantity * price
                tolerance = max(0.01, abs(quantity) * 0.005)
                if abs(expected - amount) > tolerance + 0.005:
                    checks["amount"] = [
                        _fail(
                            "line_extension",
                            f"Quantity × unit price = {expected:,.2f}, but the line amount is {amount:,.2f}.",
                        )
                    ]
                else:
                    checks["amount"] = [ValidationCheck(check="line_extension", passed=True)]

            records.append(
                RawRecord(
                    record_id=f"{table.candidate_id}:row:{r}",
                    values=values,
                    provenance=table_cell_provenance(document, table, row, row[0], anchor),
                    cell_provenance=provenance,
                    cell_source_columns=columns,
                    cell_checks=checks,
                    source_columns=[
                        SourceColumnValue(
                            **source_column(table, c.column_index).model_dump(),
                            raw_value=c.text,
                            provenance=table_cell_provenance(document, table, row, c, anchor),
                        )
                        for c in row
                        if c.text
                    ],
                )
            )
    stats.lines += len(records)
    return records


# --- totals validation ----------------------------------------------------------------------


def _close(a: float, b: float, components: int) -> bool:
    return abs(a - b) <= 0.01 * max(1, components) + 0.005


def _validate_totals(
    scalars: Scalars, charges: list[tuple[str, Labeled]], lines: list[RawRecord]
) -> list[tuple[str, str, str]]:
    """Adds arithmetic checks to the stated totals (never rewrites them).
    Returns QA rows (check, result, details)."""

    qa: list[tuple[str, str, str]] = []

    def value(canonical: str) -> float | None:
        assigned = scalars.assigned.get(canonical)
        return to_number(assigned.value) if assigned else None

    def mark(canonical: str, ok: bool, check: str, message: str) -> None:
        assigned = scalars.assigned.get(canonical)
        if assigned is not None:
            assigned.checks.append(ValidationCheck(check=check, passed=ok, message=None if ok else message))

    amounts = [to_number(r.values.get("amount")) for r in lines]
    subtotal = value("invoice.total.subtotal")
    if lines and all(a is not None for a in amounts):
        line_sum = sum(amounts)
        if subtotal is not None:
            ok = _close(line_sum, subtotal, len(amounts))
            message = f"Sum of {len(amounts)} line(s) = {line_sum:,.2f}; stated subtotal = {subtotal:,.2f}."
            mark("invoice.total.subtotal", ok, "lines_vs_subtotal", message)
            qa.append(("Arithmetic: lines vs subtotal", "PASS" if ok else "REVIEW", message))
    else:
        line_sum = None

    base = subtotal if subtotal is not None else line_sum
    charge_total, discount_total, used = 0.0, 0.0, 0
    for kind, item in charges:
        number = to_number(item.value)
        if number is None:
            continue
        used += 1
        if kind == "discount":
            discount_total += abs(number)
        else:
            charge_total += number
    explicit_tax = value("invoice.total.tax")
    if explicit_tax is not None and not any(kind == "tax" for kind, _ in charges):
        charge_total += explicit_tax
        used += 1

    invoice_amount = value("invoice.total.invoice_amount")
    amount_paid = value("invoice.total.amount_paid")
    amount_due = value("invoice.total.amount_due")
    if base is not None:
        expected = base + charge_total - discount_total
        target, canonical = (
            (invoice_amount, "invoice.total.invoice_amount")
            if invoice_amount is not None
            else (amount_due, "invoice.total.amount_due") if amount_paid is None else (None, None)
        )
        if target is not None:
            ok = _close(expected, target, used + 1)
            parts = ["subtotal" if subtotal is not None else "sum of lines"]
            if charge_total:
                parts.append("charges")
            if discount_total:
                parts.append("− discounts")
            message = f"{' + '.join(parts)} = {expected:,.2f}; stated total = {target:,.2f}."
            mark(canonical, ok, "total_arithmetic", message)
            qa.append(("Arithmetic: document total", "PASS" if ok else "REVIEW", message))
    if invoice_amount is not None and amount_due is not None:
        expected_due = invoice_amount - abs(amount_paid or 0.0)
        ok = _close(expected_due, amount_due, 2)
        message = f"Invoice total − amount paid = {expected_due:,.2f}; stated amount due = {amount_due:,.2f}."
        mark("invoice.total.amount_due", ok, "amount_due_arithmetic", message)
        qa.append(("Arithmetic: amount due", "PASS" if ok else "REVIEW", message))
    return qa


# --- recognizer (used only when family resolution was not confident) ----------------------


def recognize_invoice(structure: StructuredSourceDocument) -> Recognition:
    labels = set()
    for candidate in structure.field_candidates:
        if candidate.acceptance == "accepted":
            alias = SCALAR_ALIASES.get(normalize_label(candidate.label_text))
            if alias:
                labels.add(alias.canonical)
    for table in structure.table_candidates:
        for r in table.total_row_indices:
            if r < len(table.rows):
                filled = [c for c in table.rows[r] if c.text]
                if filled:
                    alias = SCALAR_ALIASES.get(normalize_label(filled[0].text))
                    if alias:
                        labels.add(alias.canonical)
    reasons: list[str] = []
    if "invoice.invoice_number" not in labels:
        return Recognition(0.0, ["no invoice-number label"])
    score = 0.4
    reasons.append("invoice-number label")
    if labels & {"invoice.invoice_date", "invoice.due_date"}:
        score += 0.15
        reasons.append("invoice/due date")
    if labels & {"invoice.total.subtotal", "invoice.total.invoice_amount", "invoice.total.amount_due"}:
        score += 0.15
        reasons.append("invoice totals")
    if labels & {"invoice.customer.bill_to_address", "invoice.customer.ship_to_address", "invoice.customer.name"}:
        score += 0.1
        reasons.append("bill-to/ship-to")
    if any(_is_line_table(t) for t in structure.table_candidates):
        score += 0.2
        reasons.append("line-item table")
    if any(r.region_type == "HEADING" and re.search(r"\binvoice\b", r.text, re.I) for r in structure.regions):
        score += 0.1
        reasons.append("invoice title")
    return Recognition(round(min(score, 1.0), 2), reasons)


# --- adapter ---------------------------------------------------------------------------------


def adapt_invoice(database: Session, document: Document) -> AdapterResult:
    structure = get_or_build_source_structure(database, document)
    all_fields: list[Labeled] = []
    distributions: list[Labeled] = []
    contacts: list[tuple[str, Labeled]] = []
    charges: list[tuple[str, Labeled]] = []
    scalars = Scalars()

    labelled = sorted(
        _from_candidates(document, structure)
        + _from_total_rows(document, structure.table_candidates)
        + _from_labelled_blocks(document, structure),
        key=_order_key,
    )
    invoice_numbers_by_page: dict[int, set[str]] = defaultdict(set)
    for item in labelled:
        normalized = normalize_label(item.label)
        alias = SCALAR_ALIASES.get(normalized)
        if alias and alias.canonical == "invoice.invoice_number" and item.page:
            invoice_numbers_by_page[item.page].add(normalize_space(item.value).lower())
        contact_kind = CONTACT_LABELS.get(normalized) or next(
            (kind for suffix, kind in CONTACT_LABELS.items() if normalized.endswith(" " + suffix)), None
        )
        if contact_kind:
            contacts.append((contact_kind, item))
        elif alias:
            scalars.offer(alias.canonical, item, alias, all_fields)
        elif (kind := charge_type(normalized)) and to_number(item.value) is not None:
            charges.append((kind, item))
        elif normalized in _DISTRIBUTION_LABELS:
            distributions.append(item)
        else:
            all_fields.append(item)

    # A money-valued line inside the totals block (between Subtotal and the
    # invoice total / amount due) is a charge even without a known keyword
    # ("Insurance", "Environmental Fee"): its label is kept as stated.
    bounds = [
        i for i in labelled
        if (alias := SCALAR_ALIASES.get(normalize_label(i.label)))
        and alias.canonical in ("invoice.total.subtotal", "invoice.total.invoice_amount", "invoice.total.amount_due")
    ]
    subtotals = [i for i in bounds if SCALAR_ALIASES[normalize_label(i.label)].canonical == "invoice.total.subtotal"]
    finals = [i for i in bounds if i not in subtotals]
    if subtotals and finals:
        top, bottom = subtotals[0], max(finals, key=lambda i: i.y)
        for item in list(all_fields):
            if (
                item.page == top.page == bottom.page
                and top.y < item.y < bottom.y
                and _MONEY.search(item.value or "")
                and to_number(item.value) is not None
            ):
                all_fields.remove(item)
                charges.append(("other", item))

    # Customer name: the first line of a bill-to / customer block.
    for source in ("invoice.customer.bill_to_address", "invoice.customer.name"):
        assigned = scalars.assigned.get(source)
        if not assigned or (source == "invoice.customer.name" and "\n" not in assigned.value):
            continue
        lines = [l.strip() for l in assigned.value.splitlines() if l.strip()]
        name = next((l for l in lines if not re.match(r"^(attn|attention)\b", l, re.I)), lines[0])
        if source == "invoice.customer.name":
            scalars.assigned.setdefault("invoice.customer.bill_to_address", Assigned(assigned.value, assigned.provenance))
        prov = assigned.provenance.model_copy(update={"highlight_text": name})
        scalars.assigned["invoice.customer.name"] = Assigned(name, prov)
        break

    # Supplier from the letterhead (text, not a logo), corroborated if possible.
    supplier_values: dict[str, object] = {}
    supplier_prov: dict[str, CellProvenance] = {}
    supplier_checks: dict[str, list[ValidationCheck]] = {}
    name_region, blocks = _letterhead(structure)
    emails: list[str] = []
    letter_bottom = None
    if name_region is not None:
        supplier_values["name"] = name_region.text.strip()
        supplier_prov["name"] = region_provenance(document, name_region, highlight=name_region.text.strip(), kind="letterhead")
        letter_bottom = max([name_region.bbox[3] if name_region.bbox else 0] + [b.bbox[3] for b in blocks if b.bbox])
        address_lines: list[str] = []
        for block in blocks:
            for line in block.text.splitlines():
                for email in _EMAIL.findall(line):
                    emails.append(email)
                    supplier_values.setdefault("email", email)
                    supplier_prov.setdefault("email", region_provenance(document, block, highlight=email, kind="letterhead"))
                phone_text = _EMAIL.sub(" ", line)
                phone = _PHONE.search(phone_text)
                if phone and sum(ch.isdigit() for ch in phone.group(0)) >= 10:
                    supplier_values.setdefault("phone", phone.group(0).strip())
                    supplier_prov.setdefault("phone", region_provenance(document, block, highlight=phone.group(0).strip(), kind="letterhead"))
                # Keep the address part of a mixed line ("8800 Foundry Lane,
                # Pueblo, CO 81001 - accounts@…"); drop pure contact lines.
                rest = _EMAIL.sub(" ", line)
                if phone and sum(ch.isdigit() for ch in phone.group(0)) >= 10:
                    rest = rest.replace(phone.group(0), " ")
                rest = re.sub(r"\b(e-?mail|tel|phone|fax)\b\.?:?", " ", rest, flags=re.I)
                rest = normalize_space(rest).strip(" |-–—•·,;")
                if len(re.findall(r"[A-Za-z]", rest)) >= 4:
                    address_lines.append(rest)
        if address_lines and blocks:
            supplier_values["address"] = "\n".join(address_lines)
            supplier_prov["address"] = region_provenance(document, blocks[0], kind="letterhead")
    for kind, item in contacts:
        owner_customer = re.search(r"\b(customer|client|buyer|bill)\b", item.label, re.I)
        in_letterhead = (
            name_region is not None
            and (structure.source_type == "html" or (item.page == name_region.page and letter_bottom is not None and item.y <= letter_bottom + 30))
        )
        if kind in ("email", "phone") and not owner_customer and (in_letterhead or re.search(r"\b(supplier|vendor|remit)\b", item.label, re.I)):
            supplier_values[kind] = item.value
            supplier_prov[kind] = item.provenance
            if kind == "email":
                emails.append(item.value)
        else:
            all_fields.append(item)
    explicit_supplier = scalars.assigned.pop("invoice.supplier.name", None)
    if explicit_supplier is not None:
        supplier_values["name"], supplier_prov["name"] = explicit_supplier.value, explicit_supplier.provenance
        supplier_checks["name"] = explicit_supplier.checks
    elif "name" in supplier_values:
        remit = scalars.assigned.get("invoice.supplier.remit_to")
        why = _corroborated(str(supplier_values["name"]), emails, remit.value if remit else None)
        supplier_checks["name"] = [
            ValidationCheck(check="supplier_identity", passed=True)
            if why
            else _fail("supplier_identity", "Supplier identified from the letterhead position only; confirm.")
        ]
    for key, canonical in (("number", "invoice.supplier.number"), ("tax_id", "invoice.supplier.tax_id"), ("remit_to", "invoice.supplier.remit_to")):
        assigned = scalars.assigned.get(canonical)
        if assigned:
            supplier_values[key], supplier_prov[key] = assigned.value, assigned.provenance
            supplier_checks[key] = assigned.checks

    # Invoice type from the document title.
    title = next(
        (
            r for r in structure.regions
            if r.region_type == "HEADING" and re.search(r"\b(invoice|credit\s+(memo|note))\b", r.text, re.I)
        ),
        None,
    )
    if title is not None and "invoice.type" not in scalars.assigned:
        kind = "Credit Memo" if re.search(r"credit", title.text, re.I) else "Invoice"
        scalars.assigned["invoice.type"] = Assigned(kind, region_provenance(document, title, highlight=title.text, kind="title"))

    # Line tables (merged across pages on strong evidence).
    stats = LineStats()
    line_tables = [t for t in structure.table_candidates if _is_line_table(t)]
    stats.physical_tables = len(line_tables)
    logical_tables = merge_line_tables(line_tables, structure, invoice_numbers_by_page)
    stats.logical_tables = len(logical_tables)
    lines: list[RawRecord] = []
    for index, logical in enumerate(logical_tables, start=1):
        pages = sorted({p.page for p in logical.parts if p.page})
        where = f"pages {pages[0]}–{pages[-1]}" if len(pages) > 1 else (f"page {pages[0]}" if pages else "HTML")
        lines.extend(_line_records(document, logical, f"Table {index} ({where})", stats))
        stats.merge_evidence.extend(logical.merge_evidence)

    # Totals-level charges, and the single-line fallbacks for tax/freight/discount.
    totals_values: dict[str, object] = {}
    totals_prov: dict[str, CellProvenance] = {}
    for kind, target in (("tax", "tax"), ("freight", "freight"), ("discount", "discount")):
        of_kind = [item for k, item in charges if k == kind]
        if len(of_kind) == 1 and not (target == "tax" and "invoice.total.tax" in scalars.assigned):
            totals_values[target], totals_prov[target] = of_kind[0].value, of_kind[0].provenance

    qa_rows = _validate_totals(scalars, charges, lines)

    # Currency: explicit label > ISO code in text > unambiguous symbol > "$".
    currency = scalars.assigned.get("invoice.currency")
    if currency is None:
        iso_region = next(
            (r for r in structure.regions if r.region_type in ("PARAGRAPH", "NARRATIVE", "CONTACT_BLOCK") and _ISO.search(r.text)),
            None,
        )
        money_items = [i for i in labelled if to_number(i.value) is not None and re.search(r"[$€£]", i.value)]
        money_items += [
            Labeled(label="", value=str(r.values.get("amount")), provenance=r.cell_provenance["amount"], found_by="line")
            for r in lines if "amount" in r.cell_provenance and re.search(r"[$€£]", str(r.values.get("amount")))
        ]
        if iso_region is not None:
            code = _ISO.search(iso_region.text).group(1)
            currency = Assigned(code, region_provenance(document, iso_region, highlight=code, kind="currency_statement"))
        elif money_items:
            symbol = re.search(r"[$€£]", money_items[0].value).group(0)
            code = {"€": "EUR", "£": "GBP", "$": "USD"}[symbol]
            prov = money_items[0].provenance.model_copy(update={"evidence_text": money_items[0].value})
            checks = [] if symbol != "$" else [
                _fail("currency_symbol", "Currency inferred from '$', which several currencies use; confirm USD.")
            ]
            currency = Assigned(code, prov, checks)
        if currency is not None:
            scalars.assigned["invoice.currency"] = currency
    elif currency is not None:
        stated = currency.value.strip().upper()
        symbols = {m for i in labelled for m in re.findall(r"[$€£]", i.value)}
        implied = {"€": "EUR", "£": "GBP"}
        conflict = [s for s in symbols if s in implied and implied[s] != stated]
        if conflict:
            currency.checks.append(_fail("currency_conflict", f"Stated currency {stated} but amounts use {', '.join(conflict)}."))

    # Supplier master, PO and recognition status (IDR) ------------------------------------
    def _value(canonical: str):
        assigned = scalars.assigned.get(canonical)
        return assigned.value if assigned else None

    def _prov(canonical: str):
        assigned = scalars.assigned.get(canonical)
        return assigned.provenance if assigned else None

    supplier_match = match_supplier(
        database,
        name=supplier_values.get("name"),
        address=supplier_values.get("remit_to") or supplier_values.get("address"),
        tax_id=supplier_values.get("tax_id"),
    )
    validation_rows: list[tuple[str, str, str]] = []
    if supplier_match.status == "matched":
        site = f", site {supplier_match.site.site_code}" if supplier_match.site else ""
        validation_rows.append(("Supplier", "PASS", f"{supplier_match.supplier.name} ({supplier_match.supplier.supplier_number}) by {supplier_match.method}{site}."))
        if supplier_match.method == "similar name":
            supplier_checks.setdefault("name", []).append(
                _fail("supplier_master", supplier_match.messages[0])
            )
    elif supplier_match.status != "no_master":
        message = " ".join(supplier_match.messages)
        if supplier_match.candidates:
            message += " Closest: " + ", ".join(f"{s.name} ({score:.0%})" for s, score in supplier_match.candidates) + "."
        validation_rows.append(("Supplier", "REVIEW", message))
        if "name" in supplier_values:
            supplier_checks.setdefault("name", []).append(_fail("supplier_master", message))
    else:
        validation_rows.append(("Supplier", "INFO", supplier_match.messages[0]))
    for message in supplier_match.messages if supplier_match.status == "matched" else []:
        if "site" in message.lower() or "address" in message.lower():
            validation_rows.append(("Supplier site", "REVIEW", message))

    po_number = _value("invoice.reference.po_number")
    po = validate_po(database, po_number, supplier_match.supplier if supplier_match.status == "matched" else None)
    validation_rows.extend(po.checks)
    if po.failed and "invoice.reference.po_number" in scalars.assigned:
        scalars.assigned["invoice.reference.po_number"].checks.append(_fail("po_validation", " ".join(po.failed)))

    business_unit = (po.purchase_order.business_unit if po.purchase_order else None) or (
        supplier_match.site.business_unit if supplier_match.site else None
    )
    amount = _value("invoice.total.invoice_amount") or totals_values.get("invoice_amount") or _value("invoice.total.amount_due")
    currency_value = _value("invoice.currency")
    missing = [
        label for label, value in (
            ("invoice number", _value("invoice.invoice_number")),
            ("invoice date", _value("invoice.invoice_date")),
            ("invoice amount", amount),
            ("currency", currency_value),
        ) if not value
    ]
    issues = [f"missing {', '.join(missing)}"] if missing else []
    if supplier_match.status != "matched":
        issues.append("supplier not matched to the supplier master")
    elif supplier_match.method == "similar name":
        issues.append("supplier matched only by a similar name")
    issues.extend(po.failed)
    issues.extend(f"{check} needs review" for check, result, _ in qa_rows if result == "REVIEW")
    recognition = RECOGNITION_INCOMPLETE if issues else RECOGNITION_COMPLETE
    validation_rows.insert(0, (
        "Recognition status", recognition,
        "Every expected field recognized and matched." if not issues else "Needs attention: " + "; ".join(issues) + ".",
    ))
    matched = supplier_match.supplier if supplier_match.status == "matched" else None
    # (field, value, source, status, provenance): invoice values keep the
    # provenance of the value they came from; master/derived values are
    # marked as platform (system) facts.
    system = system_provenance(document)
    amount_prov = _prov("invoice.total.invoice_amount") or totals_prov.get("invoice_amount") or _prov("invoice.total.amount_due")
    erp_rows = [
        ("Recognition Status", recognition, "Dataomatix", "; ".join(issues) if issues else "Ready for ERP validation", system),
        ("Supplier", matched.name if matched else supplier_values.get("name"),
         "Supplier master" if matched else "Invoice", f"Matched by {supplier_match.method}" if matched else "Not matched",
         supplier_prov.get("name") or system),
        ("Supplier Number", matched.supplier_number if matched else None, "Supplier master", None, system),
        ("Supplier Site", supplier_match.site.site_code if supplier_match.site else None, "Supplier master", None, system),
        ("Business Unit", business_unit, "Purchase order" if po.purchase_order and po.purchase_order.business_unit else "Supplier site",
         None if business_unit else "Not derived", system),
        ("Invoice Number", _value("invoice.invoice_number"), "Invoice", None, _prov("invoice.invoice_number") or system),
        ("Invoice Date", _value("invoice.invoice_date"), "Invoice", None, _prov("invoice.invoice_date") or system),
        ("Invoice Amount", amount, "Invoice", None, amount_prov or system),
        ("Currency", currency_value, "Invoice", None, _prov("invoice.currency") or system),
        ("PO Number", po_number, "Invoice",
         ("Validated" if po.purchase_order and not po.failed else "; ".join(po.failed) or None) if po_number else "Non-PO invoice",
         _prov("invoice.reference.po_number") or system),
    ]

    # Assemble records ---------------------------------------------------------------------
    def single(dataset_id: str, extra_values=None, extra_prov=None, extra_checks=None) -> RawRecord:
        values, prov, checks = dict(extra_values or {}), dict(extra_prov or {}), dict(extra_checks or {})
        for canonical, (dataset, key) in _SCALAR_DATASET.items():
            if dataset != dataset_id or canonical not in scalars.assigned or key in values:
                continue
            assigned = scalars.assigned[canonical]
            values[key], prov[key] = assigned.value, assigned.provenance
            if assigned.checks:
                checks[key] = assigned.checks
        return RawRecord(record_id=dataset_id, values=values, cell_provenance=prov, cell_checks=checks)

    def labeled_record(prefix: str, index: int, item: Labeled, values: dict) -> RawRecord:
        return RawRecord(record_id=f"{prefix}:{index}", values=values, provenance=item.provenance)

    staging_record = database.scalars(
        select(DocumentStagingWorkbook).where(DocumentStagingWorkbook.document_id == document.id)
    ).first()
    try:
        v3 = get_normalized_v3_document(database, document.id)
    except ValueError:
        v3 = None

    unmapped = [i for i in all_fields]
    qa_extra = [
        (
            "Invoice lines",
            "PASS" if lines else "REVIEW",
            f"{stats.physical_tables} physical line table(s) → {stats.logical_tables} logical; {stats.lines} line(s)"
            + (f"; {stats.wrapped_rows_joined} wrapped description row(s) joined" if stats.wrapped_rows_joined else "")
            + (f"; {stats.repeated_headers_skipped} repeated header row(s) skipped" if stats.repeated_headers_skipped else "")
            + (f"; merged: {' | '.join(stats.merge_evidence)}" if stats.merge_evidence else "")
            + ".",
        ),
        *qa_rows,
        (
            "Unmapped labels",
            "INFO",
            f"{len(unmapped)} accepted label/value pair(s) kept in All Fields"
            + (": " + ", ".join(sorted({i.label for i in unmapped})[:8]) if unmapped else "")
            + ".",
        ),
    ]
    if staging_record is not None:
        qa_extra.insert(0, ("Profile selection", "INFO", "; ".join(staging_record.resolution_reasons or [])))

    records = {
        "invoice_summary": [single("invoice_summary")],
        "supplier": [
            RawRecord(record_id="supplier", values=supplier_values, cell_provenance=supplier_prov, cell_checks=supplier_checks)
        ],
        "customer": [single("customer")],
        "reference": [single("reference")],
        "invoice_lines": lines,
        "taxes_charges": [
            labeled_record(
                "charge", i, item,
                {"charge_type": kind.title(), "label": item.label, "rate": rate_in_label(item.label), "amount": item.value},
            )
            for i, (kind, item) in enumerate(charges)
        ],
        "distributions": [
            labeled_record("distribution", i, item, {"dimension": _DISTRIBUTION_LABELS[normalize_label(item.label)], "value": item.value})
            for i, item in enumerate(distributions)
        ],
        "totals": [single("totals", totals_values, totals_prov)],
        "other_fields": [
            labeled_record(
                "other", i, item,
                {"name": item.label, "value": item.value, "value_type": item.value_type, "found_by": item.found_by},
            )
            for i, item in enumerate(unmapped)
        ],
        "all_fields": _all_fields_union(
            scalars, supplier_values, supplier_prov, supplier_checks, totals_values, totals_prov, charges, unmapped
        ) + _line_cell_fields(lines),
        "source_documents": [
            RawRecord(record_id=f"source:{i}", values=row.model_dump())
            for i, row in enumerate(v3.source_documents if v3 else [])
        ],
        "erp_staging": [
            RawRecord(record_id=f"erp:{i}", values={"field": f, "value": v, "source": src, "status": st}, provenance=prov)
            for i, (f, v, src, st, prov) in enumerate(erp_rows)
        ],
        "invoice_validation": [
            RawRecord(record_id=f"validation:{i}", values={"check": c, "result": r, "details": d})
            for i, (c, r, d) in enumerate(validation_rows)
        ],
        "qa_review": [
            RawRecord(
                record_id=f"qa:invoice:{i}",
                values={"qa_check": check, "result": result, "details": details, "action": "Review against the source." if result == "REVIEW" else "None."},
            )
            for i, (check, result, details) in enumerate(qa_extra)
        ],
    }
    return AdapterResult(records=records, outcome_provenance=document.ingestion_provenance)


INVOICE_V1_PROFILE = StagingProfile(
    profile_id="invoice",
    profile_version=1,
    display_name="Invoice",
    description=(
        "Supplier invoice staging schema: summary, parties, references, lines, "
        "taxes/charges, distributions and totals, with arithmetic validation."
    ),
    document_families=("invoice",),
    datasets=(
        INVOICE_SUMMARY,
        SUPPLIER,
        CUSTOMER,
        REFERENCE,
        INVOICE_LINES,
        TAXES_CHARGES,
        DISTRIBUTIONS,
        TOTALS,
        OTHER_FIELDS,
        ALL_FIELDS,
        SOURCE_DOCUMENTS,
        ERP_STAGING,
        INVOICE_VALIDATION,
        QA_REVIEW,
    ),
    adapter=adapt_invoice,
    export_sheets=(
        ExportSheet("Invoice Summary", ("invoice_summary",)),
        ExportSheet("Parties", ("supplier", "customer", "reference")),
        ExportSheet("Line Items", ("invoice_lines", "distributions")),
        ExportSheet("Charges & Totals", ("taxes_charges", "totals")),
        ExportSheet("Other Information", ("other_fields",)),
        ExportSheet("ERP Staging", ("erp_staging",)),
        ExportSheet("Supplier & PO Validation", ("invoice_validation",)),
        ExportSheet(SOURCE_SHEET, ()),
    ),
    export_capabilities=(
        ExportCapability(
            capability_id="professional_excel",
            label="Professional Excel (invoice staging workbook)",
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
            for definition in (
                INVOICE_SUMMARY, SUPPLIER, CUSTOMER, REFERENCE, INVOICE_LINES,
                TAXES_CHARGES, DISTRIBUTIONS, TOTALS, OTHER_FIELDS, ALL_FIELDS,
            )
        ),
    ),
    oracle_mapping_capability="planned",
    auto_qa_dataset="qa_review",
    source_structure="required",
    recognizer=recognize_invoice,
)
