"""Universal Professional Staging Workbook model — the profile-independent
envelope every staging profile (contract_v3, generic_business_document, and
later invoice, purchase_order, …) is rendered through.

This is a VIEW over the strongly-typed persisted domain tables (for
contract_v3: the V3 tables), assembled at read time by a profile adapter.
It is never persisted as generic JSON.

    StagingWorkbook
    ├── profile (id, version, dataset/column definitions, exports)
    ├── outcome (explicit — never a blank workbook)
    ├── datasets[]
    │   └── records[]
    │       └── cells{canonical_field: StagingCell}
    │           ├── provenance (where the value came from)
    │           ├── validation (which checks ran, which failed)
    │           └── review_status (Verified | Needs Review | Missing)
    ├── qa_summary
    └── processing_metadata
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_serializer

# The only three user-facing cell states. Internal statuses (rejected,
# noise, superseded) never become staging cells at all.
ReviewStatus = Literal["Verified", "Needs Review", "Missing"]

VERIFIED: ReviewStatus = "Verified"
NEEDS_REVIEW: ReviewStatus = "Needs Review"
MISSING: ReviewStatus = "Missing"

SourceType = Literal["pdf", "image", "html", "xml", "docx", "xlsx", "text", "system"]

ValueType = Literal["text", "money", "number", "integer", "date", "code", "boolean"]

Cardinality = Literal["single", "repeating"]

# business: extracted business data. transform: the same records shaped
# for a target system (e.g. Oracle Output) — reviewed, never counted as
# extracted records again. source/qa: always-derivable inspection datasets
# that never count as "found something".
DatasetRole = Literal["business", "transform", "source", "qa"]


class SourceLocator(BaseModel):
    """Structural address of a value inside a non-paginated or structured
    source. Unused for PDF today; reserved so HTML (Phase C) and future
    DOCX/XLSX sources plug in without a schema redesign."""

    dom_path: str | None = None  # e.g. "html>body>main>table[2]>tbody>tr[4]>td[3]"
    element_id: str | None = None
    section_path: list[str] = Field(default_factory=list)  # heading trail
    table_index: int | None = None
    row_index: int | None = None
    column_index: int | None = None
    sheet_name: str | None = None
    cell_ref: str | None = None  # e.g. "B7" for spreadsheets
    # The element's position in the document (a web page has no page or
    # coordinates): what reads it in order puts headings, fields and tables
    # where they were printed.
    document_order: int | None = None


class CellProvenance(BaseModel):
    """Where a staging value came from. Every field is optional because not
    every source can supply every coordinate — but whatever the extraction
    source DID provide (page, bbox, evidence, locator) is preserved."""

    source_document_id: str
    source_filename: str
    source_type: SourceType
    source_page: int | None = None
    # PDF points, (x0, y0, x1, y1), top-left origin — PyMuPDF's space.
    source_bbox: tuple[float, float, float, float] | None = None
    evidence_text: str | None = None
    extraction_method: str | None = None
    source_locator: SourceLocator | None = None
    # Stable id of the region/record this value was read from, e.g.
    # "clin:3" — lets the UI group cells that share one source region.
    source_region_id: str | None = None
    # Source-verification hints: text that locates the region on the page
    # (a form label, a CLIN number) and the exact text of this cell within
    # it. Used to highlight the cell rather than the whole record.
    anchor_text: str | None = None
    highlight_text: str | None = None
    # OCR-derived structure values (set by structure_provenance only): the
    # lowest confidence of the words the value was read from. With the gate
    # on, a value can be Verified only when this is known and high — OCR
    # confidence is necessary for Verified, never sufficient.
    ocr_confidence: float | None = None
    ocr_gate: bool = False
    # The two OCR passes read this value differently (unresolved): never
    # Verified while set.
    ocr_contested: bool = False

    @model_serializer(mode="wrap")
    def _omit_unused_ocr_keys(self, handler):
        # OCR trust keys appear only on OCR-read values, so native/HTML
        # provenance (e.g. every contract_v3 value) serializes exactly as
        # before these keys existed.
        data = handler(self)
        if isinstance(data, dict):
            if data.get("ocr_confidence") is None:
                data.pop("ocr_confidence", None)
            for key in ("ocr_gate", "ocr_contested"):
                if data.get(key) is False:
                    data.pop(key, None)
        return data


class ValidationCheck(BaseModel):
    check: str
    passed: bool
    message: str | None = None


class CellValidation(BaseModel):
    status: Literal["passed", "failed", "not_checked"]
    checks: list[ValidationCheck] = Field(default_factory=list)


class SourceColumn(BaseModel):
    """The original column a staged table value came from — kept so a later
    profile/version can map it (e.g. "Part Number" → invoice.line.part_number)
    without reparsing the source."""

    raw_header: str | None = None
    column_index: int
    # First neutral structural role, if any (e.g. "numeric_amount_column").
    structural_role: str | None = None
    structural_roles: list[str] = Field(default_factory=list)


class SourceColumnValue(SourceColumn):
    raw_value: str
    provenance: CellProvenance | None = None


class StagingCell(BaseModel):
    canonical_field: str
    display_label: str
    value: str | float | int | bool | None = None
    raw_value: str | None = None
    value_type: ValueType = "text"
    provenance: CellProvenance | None = None
    validation: CellValidation = Field(
        default_factory=lambda: CellValidation(status="not_checked")
    )
    # None for an optional, legitimately-empty column of a repeating
    # record (e.g. a CLIN with no FOB) — that is not "Missing".
    review_status: ReviewStatus | None = None
    review_reasons: list[str] = Field(default_factory=list)
    # Set when the value came from a table column.
    source_column: SourceColumn | None = None


class StagingRecord(BaseModel):
    record_id: str
    cells: dict[str, StagingCell]
    record_status: ReviewStatus | None = None
    # Optional cross-link, e.g. a QA Review row pointing at the dataset it
    # summarizes. Profile-provided, so the UI needs no per-profile mapping.
    links_to_dataset: str | None = None
    # Every original column of a table-derived record, mapped or not.
    source_columns: list[SourceColumnValue] = Field(default_factory=list)
    # Grid payload only: fields whose long text is a preview; the full
    # value loads with the record (get_staging_record).
    truncated_fields: list[str] = Field(default_factory=list)

    @model_serializer(mode="wrap")
    def _omit_empty_truncation(self, handler):
        # Only grid records with a text preview carry the key.
        data = handler(self)
        if isinstance(data, dict) and not data.get("truncated_fields"):
            data.pop("truncated_fields", None)
        return data


class StagingColumn(BaseModel):
    canonical_field: str
    key: str
    display_label: str
    value_type: ValueType = "text"
    expected: bool = False


class StagingDataset(BaseModel):
    dataset_id: str
    display_name: str
    cardinality: Cardinality
    role: DatasetRole = "business"
    description: str | None = None
    columns: list[StagingColumn]
    records: list[StagingRecord]
    # Canonical fields that best identify a record (used for row labels).
    identity_fields: list[str] = Field(default_factory=list)
    # Canonical fields a compact grid shows (the rest in the record detail
    # view). Empty = every column.
    grid_fields: list[str] = Field(default_factory=list)
    # True when records carry only their grid (and identity) cells; the
    # full record is served by the dataset record endpoint.
    compact: bool = False
    # Grid rows carry complete values; the grid shows long text in full.
    full_text: bool = False
    # Canonical fields whose column the source itself prints (only for
    # datasets declaring source-adaptive columns).
    source_columns: list[str] = Field(default_factory=list)

    @model_serializer(mode="wrap")
    def _omit_default_grid_keys(self, handler):
        # Only datasets that declare a compact grid carry these keys, so
        # every other profile's datasets serialize exactly as before.
        data = handler(self)
        if isinstance(data, dict):
            if not data.get("grid_fields"):
                data.pop("grid_fields", None)
            if data.get("compact") is False:
                data.pop("compact", None)
            if not data.get("source_columns"):
                data.pop("source_columns", None)
        return data


class ExportCapability(BaseModel):
    capability_id: str  # "professional_excel" | "dataset_csv" | later "oracle_*"
    label: str
    format: Literal["xlsx", "csv", "json", "xml"]
    # API path. Profiles declare it with a "{document_id}" placeholder; the
    # workbook served to the client has it substituted.
    href: str
    # Set for exports of a single dataset.
    dataset_id: str | None = None


class ProfileView(BaseModel):
    """One tab of a profile's presentation: its datasets, in order.
    kind "source" also shows the document's own transcription."""

    view_id: str
    label: str
    dataset_ids: list[str]
    kind: Literal["records", "source"] = "records"


class ProfileDescriptor(BaseModel):
    profile_id: str
    profile_version: int
    display_name: str
    description: str
    document_families: list[str]
    export_capabilities: list[ExportCapability]
    # Destinations this profile's canonical fields can later be mapped to.
    # Declared now, implemented in Phase E.
    oracle_mapping_capability: Literal["planned", "available", "none"] = "none"
    # The tabs a document of this profile is presented in, in order. Empty
    # = the generic workspace tabs.
    views: list[ProfileView] = Field(default_factory=list)


class ExtractionOutcomeModel(BaseModel):
    status: str
    title: str
    message: str
    details: list[str] = Field(default_factory=list)
    record_count: int = 0
    needs_review_count: int = 0


class QaSummary(BaseModel):
    verified: int = 0
    needs_review: int = 0
    missing: int = 0
    record_count: int = 0


class ProcessingMetadata(BaseModel):
    document_family: str | None = None
    document_family_label: str | None = None
    resolution_reasons: list[str] = Field(default_factory=list)
    resolved_at: str | None = None
    page_count: int | None = None
    source_type: SourceType | None = None
    transcription_available: bool = False
    # The last processing run's optional AI enrichment outcome
    # (app/services/ai_enrichment.py). Informational only: it never changes
    # a cell's review state.
    ai_enrichment_status: str | None = None
    ai_enrichment_notice: dict | None = None


class StagingWorkbook(BaseModel):
    document_id: str
    document_filename: str
    profile: ProfileDescriptor
    outcome: ExtractionOutcomeModel
    datasets: list[StagingDataset]
    qa_summary: QaSummary
    processing_metadata: ProcessingMetadata
