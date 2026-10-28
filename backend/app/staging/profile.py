"""Staging profile definitions.

A profile declares WHAT its workbook contains (datasets, fields, stable
canonical ids, validation rules, exports) plus one adapter that reads the
profile's persisted domain tables into `RawRecord`s. Everything else —
cell validation, review status, provenance defaults, outcome, QA summary,
generic exports — is shared engine code, so adding a profile (invoice@1,
purchase_order@1, …) is a registration, not a change to the engine or UI.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Literal

from sqlalchemy.orm import Session

from app.models.document import Document
from app.source_structure.models import StructuredSourceDocument
from app.staging.models import (
    Cardinality,
    CellProvenance,
    DatasetRole,
    ExportCapability,
    ProfileView,
    SourceColumn,
    SourceColumnValue,
    ValidationCheck,
    ValueType,
)

# Sensitivity of a profile's documents (docs/di-01-document-taxonomy.md
# §4). Restricted documents are never sent to an external provider without
# an explicit approval (app/recognition/policy.py).
DataClass = Literal["public", "internal", "confidential", "restricted"]
DATA_CLASSES: tuple[str, ...] = ("public", "internal", "confidential", "restricted")

# Whether a profile's adapter consumes the schema-neutral source structure
# (app/source_structure/). The extraction job builds that structure only
# when the resolved profile needs it (see app/staging/preparation.py):
#   required  the adapter reads it — always built
#   optional  the adapter works without it — built only if resolution
#             wasn't confident (the document may really be generic)
#   none      never used by this profile
SourceStructureRequirement = Literal["required", "optional", "none"]

# How a populated value must relate to its evidence to be Verified:
#   evidence  the value itself must appear in the evidence text
#   derived   the value is classified/normalized from the evidence (e.g.
#             "Basic IDIQ", "5 years"); evidence must exist, not contain it
#   system    a fact about the file itself (page count, filename)
#   none      not a business value (QA/source inspection columns) — no
#             review status at all
Grounding = Literal["evidence", "derived", "system", "none"]


@dataclass(frozen=True)
class FieldRule:
    """A field-specific business validation. `rule` is one of:
    positive_amount     money/number must be > 0
    evidence_mentions   evidence must contain one of `terms` (case-insensitive)
    pattern             value must fully match regex `pattern`
    """

    rule: str
    terms: tuple[str, ...] = ()
    pattern: str | None = None
    message: str | None = None


@dataclass(frozen=True)
class FieldDefinition:
    # Stable integration key, e.g. "contract.minimum_guarantee" or
    # "contract.clin.max_amount". Later the LEFT side of Oracle mappings.
    # Never derived from display_label.
    canonical_field: str
    # Attribute/column key in the adapter's raw record.
    key: str
    display_label: str
    value_type: ValueType = "text"
    # Expected fields that are empty are shown as Missing. Optional
    # columns of repeating records are simply blank.
    expected: bool = False
    grounding: Grounding = "evidence"
    rules: tuple[FieldRule, ...] = ()


@dataclass(frozen=True)
class DatasetDefinition:
    dataset_id: str
    display_name: str
    cardinality: Cardinality
    fields: tuple[FieldDefinition, ...]
    role: DatasetRole = "business"
    description: str | None = None
    identity_fields: tuple[str, ...] = ()
    # Canonical fields a compact grid shows; the rest open in a record
    # detail view. Empty = every column in the grid.
    grid_fields: tuple[str, ...] = ()
    # Columns captioned by the document's own headings (AdapterResult.
    # column_labels) are listed in the served dataset, so a view can keep
    # every column the source prints even when it is empty.
    source_adaptive_columns: bool = False
    # Only the columns a document names (AdapterResult.column_labels) are
    # served — for sources whose columns are entirely the file's own (XML
    # element names), declared as generic slots.
    labelled_columns_only: bool = False
    # Grid rows carry complete values (no long-text preview) and the grid
    # shows them in full — for a dataset that IS the reading view of a
    # document (FAR Clauses & Provisions).
    full_text_grid: bool = False
    # False for a presentation over records other datasets already hold
    # (e.g. Contract Data): its rows are reviewed but not counted again.
    counts_records: bool = True


@dataclass
class RawRecord:
    """What an adapter produces for one record, before validation."""

    record_id: str
    values: dict[str, Any]
    # Row-level provenance — used for every cell that has no own entry in
    # `cell_provenance`.
    provenance: CellProvenance | None = None
    cell_provenance: dict[str, CellProvenance] = field(default_factory=dict)
    # The domain builder's own record-level QA verdict ("Verified" /
    # "Needs Review"), when it has one. A flagged record can never have
    # Verified cells.
    builder_status: str | None = None
    links_to_dataset: str | None = None
    # Table-derived records: the original column per mapped cell, and every
    # original column value (mapped or not).
    cell_source_columns: dict[str, SourceColumn] = field(default_factory=dict)
    source_columns: list[SourceColumnValue] = field(default_factory=list)
    # Profile-run checks per value key (semantic mapping, arithmetic…); a
    # failed check makes that cell Needs Review with its message.
    cell_checks: dict[str, list[ValidationCheck]] = field(default_factory=dict)


@dataclass
class AdapterResult:
    records: dict[str, list[RawRecord]]
    # Extraction outcome inputs the adapter knows about (e.g. contract_v3's
    # v3_extraction provenance record).
    outcome_provenance: dict | None = None
    # Per-document column captions: dataset id → canonical field → label.
    # For tables whose columns a document names itself ("Unit Code" where
    # the field is course.code). Canonical ids never change.
    column_labels: dict[str, dict[str, str]] = field(default_factory=dict)
    # Per-document dataset captions and descriptions (dataset id → text),
    # e.g. "Clauses" for the records of an XML file's <Clause> elements.
    dataset_names: dict[str, str] = field(default_factory=dict)
    dataset_descriptions: dict[str, str] = field(default_factory=dict)
    # Datasets this document has no use for (unused record slots).
    omit_datasets: set[str] = field(default_factory=set)


AdapterFn = Callable[[Session, Document], AdapterResult]


@dataclass(frozen=True)
class Recognition:
    score: float  # 0..1
    reasons: list[str]


# Optional: scores how well a document's schema-neutral structure fits the
# profile. Consulted only when document-family resolution wasn't confident
# (app/staging/resolver.refine_with_structure).
RecognizerFn = Callable[[StructuredSourceDocument], Recognition]

# Optional: scores the document itself (e.g. its DOM) BEFORE keyword family
# classification — for sources whose structure is decisive and whose words
# would mislead the keyword classifier (FAR Part 52 regulation text reads
# like a contract). Must return 0 cheaply for documents it doesn't handle.
DocumentRecognizerFn = Callable[[Session, Document], Recognition]

# Optional: builds and persists the profile's own domain records when the
# extraction job prepares staging (the adapter then only reads them).
# Returns a JSON-safe run summary.
MaterializerFn = Callable[[Session, Document], dict]


@dataclass(frozen=True)
class ExportArtifact:
    content: bytes | str
    media_type: str
    filename: str


# Optional: profile-specific exports addressed by id
# (/staging-workbook/exports/{export_id}); None = unknown id.
ExporterFn = Callable[[Session, Document, str], "ExportArtifact | None"]


@dataclass(frozen=True)
class ExportSheet:
    """One sheet of a profile's Excel workbook: the datasets it combines,
    in order. `title` None = the (first populated) dataset's own name.
    `first_populated` takes only the first dataset that has records (e.g.
    the schedule's line items, else the V3 CLINs). Empty sheets are never
    written."""

    title: str | None
    dataset_ids: tuple[str, ...]
    first_populated: bool = False


SOURCE_SHEET = "Source"


@dataclass(frozen=True)
class StagingProfile:
    profile_id: str
    profile_version: int
    display_name: str
    description: str
    # Document families (app/services/structure_detection.py
    # DOCUMENT_FAMILIES keys) this profile is the staging schema for.
    document_families: tuple[str, ...]
    datasets: tuple[DatasetDefinition, ...]
    adapter: AdapterFn
    export_capabilities: tuple[ExportCapability, ...]
    oracle_mapping_capability: Literal["planned", "available", "none"] = "none"
    # When set, the engine fills this dataset (which must use the standard
    # qa.* fields) from the validated business datasets, instead of the
    # adapter supplying QA rows.
    auto_qa_dataset: str | None = None
    source_structure: SourceStructureRequirement = "none"
    recognizer: RecognizerFn | None = None
    document_recognizer: DocumentRecognizerFn | None = None
    # Whether the V3 contract pipeline (clauses, CLINs, funding…) applies to
    # this profile's documents. False lets the extraction job skip it when
    # the document recognizer has already identified the profile.
    contract_pipeline: bool = True
    materializer: MaterializerFn | None = None
    exporter: ExporterFn | None = None
    # Document-specific presentation: the tabs and the datasets in each.
    views: tuple[ProfileView, ...] = ()
    # The Excel workbook's sheets (export.xlsx); empty = one sheet per
    # dataset. A sheet titled SOURCE_SHEET lists the document and its
    # source datasets.
    export_sheets: tuple[ExportSheet, ...] = ()
    data_class: DataClass = "confidential"

    @property
    def key(self) -> str:
        return f"{self.profile_id}@{self.profile_version}"

    def dataset(self, dataset_id: str) -> DatasetDefinition:
        for dataset in self.datasets:
            if dataset.dataset_id == dataset_id:
                return dataset
        raise KeyError(f"{self.key} has no dataset {dataset_id!r}")
