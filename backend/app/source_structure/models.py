"""Source-neutral structural representation of a document.

PDF (native or OCR) and HTML differ only at ingestion; both produce this
model, and staging profiles consume it. Nothing here knows what an invoice,
contract or purchase order is — it describes STRUCTURE (label/value
relationships, tables, headings, contact blocks) and neutral hints about
it (value-type, column roles), never business meaning.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from app.staging.models import SourceLocator

RegionType = Literal[
    "LABEL_VALUE",
    "TABLE",
    "TABLE_ROW",
    "TABLE_CELL",
    "HEADING",
    "SECTION",
    "LIST_ITEM",
    "PARAGRAPH",
    "FORM_FIELD",
    "CONTACT_BLOCK",
    "KEY_VALUE_GROUP",
    "NARRATIVE",
    "IMAGE_REGION",
]

ValueTypeHint = Literal[
    "text",
    "identifier",
    "date",
    "datetime",
    "currency",
    "number",
    "percentage",
    "email",
    "phone",
    "address",
    "boolean",
]

# How a label was tied to its value. Recorded so profiles (and reviewers)
# can weigh relations differently.
StructuralRelation = Literal[
    "same_line_separator",  # "Label: value" inside one text run
    "left_right_separator",  # "Label:" then the value to its right
    "left_right_typography",  # bold label, regular value, same line
    "left_right_whitespace",  # "Roll No.   516522" — no separator, shape-gated
    "same_line_filler",  # "Group ____ HUMANITIES" — underline/leader fill
    "form_fill_in",  # printed wording + value written into its blank
    "ruled_form_row",  # captions on the left, the value on a drawn underline at the right
    "table_key_value_grid",  # ruled grid of caption | value cells
    "label_above_value",  # "Label:" with the value directly below
    "form_widget",  # PDF AcroForm field
    "html_label_for",  # <label for=…> → control
    "html_definition_list",  # <dt> → <dd>
    "html_table_header_cell",  # <th> → <td> in a two-column table
    "html_adjacent_elements",  # container with exactly [label, value]
    "html_inline_separator",  # <p><b>Label:</b> value</p>
]

Acceptance = Literal["accepted", "ambiguous", "rejected"]

BBox = tuple[float, float, float, float]


class StructuredRegion(BaseModel):
    region_id: str
    region_type: RegionType
    text: str
    normalized_text: str
    # PDF/image page (1-based). None for sources without pages (HTML).
    page: int | None = None
    # PDF points, top-left origin — the renderer's space, for native AND
    # OCR regions (OCR pixels are transformed on ingestion).
    bbox: BBox | None = None
    source_locator: SourceLocator | None = None
    parent_region_id: str | None = None
    children: list[str] = Field(default_factory=list)
    extraction_method: str = "native"  # native | ocr | dom | form_widget
    structural_metadata: dict = Field(default_factory=dict)


class FieldCandidate(BaseModel):
    candidate_id: str
    raw_label: str
    raw_value: str
    # Label with separators/whitespace normalized — still the document's
    # own wording, never mapped to a canonical field.
    label_text: str
    value_type_hint: ValueTypeHint
    structural_relation: StructuralRelation
    source_region_ids: list[str] = Field(default_factory=list)
    page: int | None = None
    label_bbox: BBox | None = None
    value_bbox: BBox | None = None
    source_locator: SourceLocator | None = None
    # What was literally read: "Label: value" as it appears in the source.
    evidence_text: str
    extraction_method: str = "native"
    acceptance: Acceptance = "accepted"
    reasons: list[str] = Field(default_factory=list)
    validation_hints: list[str] = Field(default_factory=list)
    group_id: str | None = None  # KEY_VALUE_GROUP membership
    # The caption a form row sits under ("2. Contract Information" for
    # "Contract Number"); None when the row has no parent caption.
    section_label: str | None = None
    # Non-blocking trust signals for accepted candidates (text_shapes.
    # candidate_quality); profiles may require a minimum score.
    quality_score: float = 1.0
    quality_flags: list[str] = Field(default_factory=list)
    # Lowest OCR word confidence under the VALUE (OCR pages only).
    ocr_confidence: float | None = None
    # The OCR passes disagreed on a word of the VALUE.
    ocr_contested: bool = False


class TableCell(BaseModel):
    row_index: int  # -1 for the header row
    column_index: int
    text: str
    bbox: BBox | None = None
    source_locator: SourceLocator | None = None
    region_id: str | None = None
    # Lowest OCR word confidence under this cell (OCR pages only; None when
    # unknown or not OCR).
    ocr_confidence: float | None = None
    ocr_contested: bool = False


# Neutral structural roles — never "invoice lines" or "CLINs".
ColumnHint = Literal[
    "identifier_column",
    "description_column",
    "quantity_column",
    "numeric_amount_column",
    "unit_column",
    "date_column",
]


class TableContinuation(BaseModel):
    """Metadata for merging a table that continues across pages. Recorded
    now; tables are NOT merged here — a profile decides (e.g. multi-page
    invoice lines). Header equality alone is never enough to merge."""

    normalized_headers: list[str]
    # Normalized headers joined, or "columns:N" when no header row exists.
    header_signature: str
    column_count: int
    # Table extent as a fraction of page height (0 = top, 1 = bottom).
    page_top_ratio: float | None = None
    page_bottom_ratio: float | None = None
    starts_near_page_top: bool = False
    ends_near_page_bottom: bool = False
    continuation_candidate: bool = False
    previous_candidate_id: str | None = None
    next_candidate_id: str | None = None
    hint_reasons: list[str] = Field(default_factory=list)


class TableCandidate(BaseModel):
    candidate_id: str
    region_id: str
    page: int | None = None
    bbox: BBox | None = None
    source_locator: SourceLocator | None = None
    detection_method: str  # pdf_ruling_lines | pdf_column_alignment | html_dom
    extraction_method: str = "native"
    headers: list[str]
    header_cells: list[TableCell] = Field(default_factory=list)
    rows: list[list[TableCell]]
    column_hints: dict[int, list[ColumnHint]] = Field(default_factory=dict)
    total_row_indices: list[int] = Field(default_factory=list)
    table_hints: list[str] = Field(default_factory=list)  # e.g. repeating_records
    structure_score: float = 0.0
    acceptance: Acceptance = "accepted"
    reasons: list[str] = Field(default_factory=list)
    continuation: TableContinuation | None = None

    @property
    def table_id(self) -> str:
        return self.candidate_id


class StructureStats(BaseModel):
    pages: int = 0
    regions_by_type: dict[str, int] = Field(default_factory=dict)
    field_candidates: dict[str, int] = Field(default_factory=dict)  # by acceptance
    table_candidates: dict[str, int] = Field(default_factory=dict)
    duration_ms: int = 0


class StructuredSourceDocument(BaseModel):
    document_id: str
    source_type: str  # pdf | image | html
    extractor_version: int
    regions: list[StructuredRegion] = Field(default_factory=list)
    field_candidates: list[FieldCandidate] = Field(default_factory=list)
    table_candidates: list[TableCandidate] = Field(default_factory=list)
    stats: StructureStats = Field(default_factory=StructureStats)
    warnings: list[str] = Field(default_factory=list)
