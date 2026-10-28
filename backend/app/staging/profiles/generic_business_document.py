"""generic_business_document@2 — fallback profile for any document no
specific profile is registered for.

It INTERPRETS the schema-neutral structure (app/source_structure/): it
never looks for particular business fields. Accepted label/value
candidates become Key Fields (or Contacts when the value is a contact
channel), accepted tables with repeating, amount-bearing rows become Line
Items, other accepted tables become Other Tables. Rejected/ambiguous
structure is summarized in QA Review; narrative never becomes a field.

@2 replaced @1's V3-only inputs with structural candidates (@1 remains
registered for documents pinned to it).
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import replace

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.document import Document
from app.models.document_page import DocumentPage
from app.models.document_staging_workbook import DocumentStagingWorkbook
from app.services.v3_reader import get_normalized_v3_document
from app.source_structure.models import FieldCandidate, TableCandidate, TableCell
from app.source_structure.ocr_geometry import PageGeometry
from app.source_structure.service import get_or_build_source_structure
from app.source_structure.text_shapes import normalize_space
from app.staging.models import (
    CellProvenance,
    ExportCapability,
    SourceColumn,
    SourceColumnValue,
)
from app.staging.profile import (
    SOURCE_SHEET,
    ExportSheet,
    AdapterResult,
    DatasetDefinition,
    FieldDefinition,
    RawRecord,
    StagingProfile,
)
from app.staging.provenance import make_provenance, source_type_of, system_provenance
from app.staging.structure_provenance import (
    field_provenance,
    region_provenance,
    source_column,
    table_cell_provenance,
)

F = FieldDefinition

_CONTACT_TYPES = {"email", "phone"}
_CONTACT_LABEL = re.compile(
    r"\b(e-?mail|phone|telephone|tel|fax|mobile|cell|contact|attn|attention)\b", re.I
)

DOCUMENT_SUMMARY = DatasetDefinition(
    dataset_id="document_summary",
    display_name="Document Summary",
    cardinality="single",
    description="What this document is and how it was processed.",
    fields=(
        F("document.document_type", "document_type", "Document Type", grounding="system", expected=True),
        F("document.source_filename", "source_filename", "Source File", grounding="system", expected=True),
        F("document.source_type", "source_type", "File Type", grounding="system", expected=True),
        F("document.page_count", "page_count", "Pages", "integer", grounding="system"),
        F("document.processing_status", "processing_status", "Processing Status", grounding="system"),
        F("document.structure_summary", "structure_summary", "Structure Found", grounding="system"),
    ),
)

_FIELD_COLUMNS = (
    F("document.field.name", "name", "Field", grounding="derived"),
    F("document.field.value", "value", "Value", expected=True),
    F("document.field.value_type", "value_type", "Type", grounding="none"),
    F("document.field.extraction_method", "extraction_method", "Found By", grounding="none"),
)

KEY_FIELDS = DatasetDefinition(
    dataset_id="key_fields",
    display_name="Key Fields",
    cardinality="repeating",
    description="Label/value pairs found in the document's structure.",
    identity_fields=("document.field.name", "document.field.value"),
    fields=_FIELD_COLUMNS,
)

CONTACTS = DatasetDefinition(
    dataset_id="contacts",
    display_name="Contacts",
    cardinality="repeating",
    description="Contact channels and contact/address blocks.",
    identity_fields=("document.contact.label", "document.contact.value"),
    fields=(
        F("document.contact.label", "name", "Contact Field", grounding="derived"),
        F("document.contact.value", "value", "Value", expected=True),
        F("document.contact.value_type", "value_type", "Type", grounding="none"),
    ),
)

SECTIONS = DatasetDefinition(
    dataset_id="document_sections",
    display_name="Sections",
    cardinality="repeating",
    description=(
        "The document's own text, section by section: each heading with the "
        "paragraphs, bullets and lines printed under it, in reading order."
    ),
    identity_fields=("document.section.heading",),
    fields=(
        F("document.section.heading", "heading", "Section", grounding="derived", expected=True),
        F("document.section.content", "content", "Content", expected=True),
        F("document.section.page", "page", "Page", "integer", grounding="none"),
    ),
)

LINE_ITEMS = DatasetDefinition(
    dataset_id="line_items",
    display_name="Line Items",
    cardinality="repeating",
    description=(
        "Rows of accepted tables whose structure is repeating records with "
        "amount columns. Columns are mapped from structural roles, not header names."
    ),
    identity_fields=("document.line_item.item_number", "document.line_item.description"),
    fields=(
        F("document.line_item.item_number", "item_number", "Item"),
        F("document.line_item.description", "description", "Description"),
        F("document.line_item.quantity", "quantity", "Quantity", "number"),
        F("document.line_item.unit", "unit", "Unit"),
        F("document.line_item.unit_price", "unit_price", "Unit Price", "money"),
        F("document.line_item.amount", "amount", "Amount", "money"),
        F("document.line_item.other_values", "other_values", "Other Columns", grounding="derived"),
        F("document.line_item.source_table", "source_table", "Table", grounding="none"),
    ),
)

OTHER_TABLES = DatasetDefinition(
    dataset_id="other_tables",
    display_name="Other Tables",
    cardinality="repeating",
    description="Accepted tables that are not repeating amount-bearing records.",
    identity_fields=("document.table.columns",),
    fields=(
        F("document.table.columns", "columns", "Columns", grounding="derived", expected=True),
        F("document.table.column_count", "column_count", "Column Count", "integer", grounding="system"),
        F("document.table.row_count", "row_count", "Row Count", "integer", grounding="system"),
        F("document.table.first_row", "first_row", "First Row", grounding="derived"),
        F("document.table.detection", "detection", "Detected By", grounding="none"),
    ),
)

ALL_FIELDS = DatasetDefinition(
    dataset_id="all_fields",
    display_name="All Fields",
    cardinality="repeating",
    description=(
        "Everything found in structured form: key fields, contacts, each "
        "accepted table row, typed values (dates, amounts, emails, URLs) "
        "from running text, and headings. Never individual OCR words."
    ),
    identity_fields=("document.field.name", "document.field.value"),
    fields=(F("document.field.category", "category", "Category", grounding="none"), *_FIELD_COLUMNS),
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








def _is_line_item_table(table: TableCandidate) -> bool:
    hints = {h for hs in table.column_hints.values() for h in hs}
    return (
        table.acceptance == "accepted"
        and "repeating_records" in table.table_hints
        and "numeric_amount_column" in hints
        and bool(hints & {"description_column", "identifier_column"})
    )


def _columns_with(table: TableCandidate, hint: str) -> list[int]:
    return sorted(c for c, hs in table.column_hints.items() if hint in hs)


def _line_item_records(
    document: Document, table: TableCandidate, table_label: str
) -> tuple[list[RawRecord], list[RawRecord]]:
    """(line records, total-row key-field records)."""

    identifier = next(iter(_columns_with(table, "identifier_column")), None)
    description = next(iter(_columns_with(table, "description_column")), None)
    quantity = next(iter(_columns_with(table, "quantity_column")), None)
    unit = next(iter(_columns_with(table, "unit_column")), None)
    amounts = _columns_with(table, "numeric_amount_column")
    amount = amounts[-1] if amounts else None
    unit_price = amounts[-2] if len(amounts) >= 2 else None
    mapped = {c for c in (identifier, description, quantity, unit, amount, unit_price) if c is not None}

    lines: list[RawRecord] = []
    totals: list[RawRecord] = []
    for r, row in enumerate(table.rows):
        by_column = {cell.column_index: cell for cell in row}
        anchor_cell = by_column.get(identifier) if identifier is not None else None
        anchor = (anchor_cell.text if anchor_cell and anchor_cell.text else None) or next(
            (c.text for c in row if c.text), None
        )

        if r in table.total_row_indices:
            filled = [c for c in row if c.text]
            if len(filled) >= 2:
                label_cell, value_cell = filled[0], filled[-1]
                provenance = table_cell_provenance(document, table, row, value_cell, label_cell.text)
                totals.append(
                    RawRecord(
                        record_id=f"{table.candidate_id}:total:{r}",
                        values={
                            "name": label_cell.text,
                            "value": value_cell.text,
                            "value_type": "currency",
                            "extraction_method": "table total row",
                            "category": "Key Field",
                        },
                        provenance=provenance,
                    )
                )
            continue

        values: dict[str, object] = {"source_table": table_label}
        cell_provenance: dict[str, CellProvenance] = {}
        cell_columns: dict[str, SourceColumn] = {}
        for key, column in (
            ("item_number", identifier),
            ("description", description),
            ("quantity", quantity),
            ("unit", unit),
            ("unit_price", unit_price),
            ("amount", amount),
        ):
            cell = by_column.get(column) if column is not None else None
            if cell is None or not cell.text:
                continue
            values[key] = cell.text
            cell_provenance[key] = table_cell_provenance(document, table, row, cell, anchor)
            cell_columns[key] = source_column(table, cell.column_index)
        other = [
            f"{table.headers[c] if c < len(table.headers) else f'Column {c + 1}'}: {cell.text}"
            for c, cell in sorted(by_column.items())
            if c not in mapped and cell.text
        ]
        if other:
            values["other_values"] = "; ".join(other)
        if len(values) <= 1:
            continue
        lines.append(
            RawRecord(
                record_id=f"{table.candidate_id}:row:{r}",
                values=values,
                provenance=table_cell_provenance(document, table, row, row[0], anchor),
                cell_provenance=cell_provenance,
                cell_source_columns=cell_columns,
                source_columns=[
                    SourceColumnValue(
                        **source_column(table, cell.column_index).model_dump(),
                        raw_value=cell.text,
                        provenance=table_cell_provenance(document, table, row, cell, anchor),
                    )
                    for cell in row
                    if cell.text
                ],
            )
        )
    return lines, totals


def _table_label(table: TableCandidate, index: int) -> str:
    where = f"page {table.page}" if table.page else (
        f"HTML table {table.source_locator.table_index + 1}"
        if table.source_locator and table.source_locator.table_index is not None
        else "table"
    )
    return f"Table {index} ({where})"


# Typed values worth surfacing from running text (never bare words): dates,
# currency amounts, emails and URLs.
_MONTH = r"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
_TYPED_VALUES: tuple[tuple[str, str, re.Pattern[str]], ...] = (
    ("Date", "date", re.compile(rf"\b{_MONTH}\.? \d{{1,2}}, \d{{4}}\b|\b\d{{1,2}} {_MONTH}\.? \d{{4}}\b", re.I)),
    ("Date", "date", re.compile(r"\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/.-]\d{1,2}[/.-]\d{4}\b")),
    ("Amount", "currency", re.compile(r"(?<![\w.])-?[$€£¥]\s?\d[\d,]*(?:\.\d{2})?\b")),
    ("Email", "email", re.compile(r"\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b")),
    ("URL", "url", re.compile(r"\bhttps?://\S+|\bwww\.[\w-]+(?:\.[\w-]+)+\S*", re.I)),
)
_MAX_HEADINGS = 20


def _row_label(row: list[TableCell]) -> str | None:
    """The cell that names a table row: its most wordy non-numeric cell
    ("ENGLISH (COMPULSORY)", "TOTAL")."""

    textual = [
        c for c in row
        if c.text and sum(ch.isalpha() for ch in c.text) >= 2 and sum(ch.isdigit() for ch in c.text) <= 1
    ]
    if not textual:
        return None
    return max(textual, key=lambda c: sum(ch.isalpha() for ch in c.text)).text


def _table_title(structure, table: TableCandidate) -> str | None:
    """The heading printed just above a table on its page, if any."""

    if not table.bbox or table.page is None:
        return None
    x0, top, x1, _ = table.bbox
    above = [
        r for r in structure.regions
        if r.region_type == "HEADING" and r.page == table.page and r.bbox
        and 0 <= top - r.bbox[3] <= 80 and min(x1, r.bbox[2]) > max(x0, r.bbox[0])
    ]
    return normalize_space(max(above, key=lambda r: r.bbox[3]).text) if above else None


def _all_fields(
    document: Document,
    structure,
    scalar_records: list[RawRecord],
    accepted_tables: list[TableCandidate],
) -> list[RawRecord]:
    """Everything the document says in structured form: label/value fields
    and contacts, then each accepted table row, then typed values (dates,
    amounts, emails, URLs) from running text, then headings. Each entry is
    source-supported and deduplicated by value; bare OCR words never are."""

    records: list[RawRecord] = []
    seen_values: set[str] = set()

    def key(value: object) -> str:
        return normalize_space(str(value)).lower()

    for record in scalar_records:
        category = record.values.get("category") or (
            "Contact" if record.values.get("name") in (None, "Contact block") else "Key Field"
        )
        records.append(replace(record, values={**record.values, "category": category}))
        seen_values.add(key(record.values.get("value")))

    for index, table in enumerate(accepted_tables, start=1):
        category = _table_title(structure, table) or _table_label(table, index)
        has_header = bool(table.header_cells)
        for r, row in enumerate(table.rows):
            filled = [c for c in row if c.text]
            if not filled:
                continue
            row_label = _row_label(row) or f"Row {r + 1}"
            for cell in filled:
                if cell.text == row_label:
                    continue
                column = (
                    table.headers[cell.column_index]
                    if has_header and cell.column_index < len(table.headers) and table.headers[cell.column_index]
                    else f"Column {cell.column_index + 1}"
                )
                records.append(
                    RawRecord(
                        record_id=f"{table.candidate_id}:all:{r}:{cell.column_index}",
                        values={
                            "category": category,
                            "name": f"{row_label} / {column}",
                            "value": cell.text,
                            "value_type": "table cell",
                            "extraction_method": table.detection_method.replace("_", " "),
                        },
                        provenance=table_cell_provenance(document, table, row, cell, row_label),
                    )
                )
            seen_values.update(key(c.text) for c in filled)

    headings: list[RawRecord] = []
    for region in structure.regions:
        if region.region_type not in ("HEADING", "PARAGRAPH", "NARRATIVE"):
            continue
        for field_name, value_type, pattern in _TYPED_VALUES:
            for match in pattern.finditer(region.text):
                value = match.group(0).strip().rstrip(".,;")
                if key(value) in seen_values:
                    continue
                seen_values.add(key(value))
                records.append(
                    RawRecord(
                        record_id=f"{region.region_id}:typed:{match.start()}",
                        values={
                            "category": "Detected Value",
                            "name": field_name,
                            "value": value,
                            "value_type": value_type,
                            "extraction_method": "typed value in text",
                        },
                        provenance=region_provenance(document, region, highlight=value, kind="typed_value"),
                    )
                )
        text = normalize_space(region.text)
        if region.region_type == "HEADING" and len(headings) < _MAX_HEADINGS and key(text) not in seen_values:
            seen_values.add(key(text))
            headings.append(
                RawRecord(
                    record_id=f"{region.region_id}:heading",
                    values={
                        "category": "Heading",
                        "name": "Heading",
                        "value": text,
                        "value_type": "heading",
                        "extraction_method": "document heading",
                    },
                    provenance=region_provenance(document, region, highlight=text, kind="heading"),
                )
            )
    return records + headings


# Text a reader reads; containers (key/value groups, tables) and their parts
# are covered by their own records.
_SECTION_TEXT_REGIONS = {"HEADING", "PARAGRAPH", "NARRATIVE", "LIST_ITEM", "LABEL_VALUE", "CONTACT_BLOCK"}
# "Education______" — a heading ruled to the margin.
_RULED_HEADING = re.compile(r"^(?P<title>[^\n_]{2,80}?)\s*_{4,}\s*$")
_BULLET_ONLY = re.compile(r"^[\s•●▪■◦·∙‣*\-–]+$")
_LEADING_BULLET = re.compile(r"^[•●▪■◦·∙‣]\s*")
_MAX_SECTIONS = 80


def _reading_order(structure) -> list[tuple]:
    """(region, line, line number) for every line of the top-level text regions, in
    reading order: page, then top to bottom, then left to right. A line's
    height is estimated within its region, so a right-aligned date printed
    beside a block's second line reads with that line, not after the block.
    Sources without geometry keep document order."""

    by_id = {region.region_id: region for region in structure.regions}
    chosen = {r.region_id for r in structure.regions if r.region_type in _SECTION_TEXT_REGIONS}

    def nested(region) -> bool:
        parent = region.parent_region_id
        while parent:
            if parent in chosen:
                return True
            parent = by_id[parent].parent_region_id if parent in by_id else None
        return False

    # A page read in columns (source structure marks them): its main column
    # (more words) first, then the other (a résumé's sidebar).
    words_by_column: dict[tuple, int] = {}
    for region in structure.regions:
        column = region.structural_metadata.get("column")
        if column:
            key = (region.page, column)
            words_by_column[key] = words_by_column.get(key, 0) + len(region.text.split())

    def column_rank(region) -> int:
        column = region.structural_metadata.get("column")
        if not column:
            return 0
        other = "left" if column == "right" else "right"
        mine, theirs = words_by_column.get((region.page, column), 0), words_by_column.get((region.page, other), 0)
        return 0 if (mine, column == "left") >= (theirs, other == "left") else 1

    lines: list[tuple] = []
    for index, region in enumerate(structure.regions):
        if region.region_id not in chosen or nested(region) or not normalize_space(region.text):
            continue
        texts = region.text.splitlines()
        for number, text in enumerate(texts):
            if region.bbox:
                top, bottom = region.bbox[1], region.bbox[3]
                y = top + (number + 0.5) * max(bottom - top, 0) / len(texts)
                key = (region.page or 0, column_rank(region), round(y), region.bbox[0], index, number)
            else:
                key = (region.page or 0, 0, 0, 0, index, number)
            lines.append((key, region, text, number))
    if any(item[1].bbox for item in lines):
        lines.sort(key=lambda item: item[0])
    return [(region, text, number) for _, region, text, number in lines]


# A heading in larger type than the body text: this much larger.
_HEADING_SIZE_RATIO = 1.4


def _font_size(region, line: int | None = None) -> float | None:
    """A line's font size when recorded, else its region's."""

    sizes = region.structural_metadata.get("line_sizes")
    if line is not None and isinstance(sizes, list) and line < len(sizes):
        return float(sizes[line])
    size = region.structural_metadata.get("font_size")
    return float(size) if isinstance(size, (int, float)) else None


def _body_font_size(structure) -> float | None:
    """The size most of the document's running text is set in (by words)."""

    weights: dict[float, int] = {}
    for region in structure.regions:
        size = _font_size(region)
        if size and region.region_type in ("PARAGRAPH", "NARRATIVE"):
            weights[size] = weights.get(size, 0) + len(region.text.split())
    return max(weights, key=weights.get) if weights else None


def _caps_heading(line: str) -> bool:
    """"EXPERIENCE", "AWARDS & ACHIEVEMENTS": a short line set in capitals,
    the way documents without ruled headings mark their sections."""

    words = line.split()
    letters = [ch for ch in line if ch.isalpha()]
    return (
        1 <= len(words) <= 6
        and len(letters) >= 3
        and all(ch.isupper() for ch in letters)
        and not any(ch.isdigit() for ch in line)
        and not line.endswith((".", ",", ";", ":"))
    )


def _title_like(line: str) -> bool:
    """A name or title opening a document ("Anila Masood")."""

    return (
        1 <= len(line.split()) <= 6
        and not line.endswith((".", ",", ";", ":"))
        and not any(ch.isdigit() or ch == "@" for ch in line)
    )


# A line that stops mid-sentence: its sentence continues on the next line.
_MID_SENTENCE = re.compile(
    r"(?:[-–]|\b(?:and|or|nor|but|the|a|an|of|to|with|for|in|on|at|by|from|into|onto|my|your|our|their|"
    r"its|this|that|these|which|who|as|is|are|was|were|be|been|while|including|such|using|via|than|both))$",
    re.I,
)
_SENTENCE_END = (".", "!", "?", ":", ";")
# Characters in a block's widest line for it to read as running prose.
_PROSE_WIDTH = 60


def _document_sections(document: Document, structure) -> list[RawRecord]:
    """The document's narrative as Heading | Content records, in reading
    order. A section starts at a heading: headings ruled to the margin
    ("Education____") when the document uses them, else headings set in
    capitals ("EXPERIENCE"), else its HEADING regions. With ruled or capital
    headings, other HEADING regions (a degree, a job title) are text of
    their section. Text before the first heading is a lead section named by
    its title (a résumé's name); contact lines join that title block rather
    than the text printed beside them. Bullet-only lines are dropped and a
    wrapped line rejoins the line it continues."""

    ordered = [(region, raw.strip(), number) for region, raw, number in _reading_order(structure) if raw.strip()]
    ruled = sum(1 for _, line, _ in ordered if _RULED_HEADING.match(line))
    # Documents that set their headings in larger type ("EDUCATION" at 23pt)
    # may capitalise entries too ("BEST EVENT ORGANIZER AWARD" at 12pt):
    # then only capital lines in heading-sized type are headings.
    body = _body_font_size(structure)
    sizes = [_font_size(region, number) for region, line, number in ordered if _caps_heading(line)]
    heading_size = (
        _HEADING_SIZE_RATIO * body
        if body and any(size and size >= _HEADING_SIZE_RATIO * body for size in sizes)
        else None
    )

    def capital_heading(region, line: str, number: int) -> bool:
        if not _caps_heading(line):
            return False
        size = _font_size(region, number)
        if heading_size is None or (size is not None and size >= heading_size):
            return True
        # Smaller capitals are still a heading when set apart: a block of
        # their own, or a heading line a contact block absorbed. Capitalised
        # entries inside running text or label/value lines are not.
        standalone = region.region_type in ("HEADING", "PARAGRAPH", "NARRATIVE") and len(region.text.splitlines()) == 1
        return standalone or region.region_type == "CONTACT_BLOCK"

    capitals = sum(1 for region, line, number in ordered if capital_heading(region, line, number))
    mode = "ruled" if ruled >= 2 else "capitals" if capitals >= 2 else "regions"
    # Pages with bullet glyphs: there a full-width line may end a bullet,
    # so wrapped lines rejoin only on clear evidence.
    bulleted = {region.page for region, line, _ in ordered if _BULLET_ONLY.match(line)}
    widest: dict[str, int] = {}
    for region, line, _ in ordered:
        widest[region.region_id] = max(widest.get(region.region_id, 0), len(line))

    sections: list[dict] = []
    current: dict | None = None
    previous_region = None

    def stacked(previous, region) -> bool:
        """Two heading lines set directly one under the other in the same
        type: one heading broken over two lines ("ADDITIONAL" / "SKILLS")."""

        if not (previous.bbox and region.bbox) or previous.page != region.page:
            return False
        if previous.structural_metadata.get("column") != region.structural_metadata.get("column"):
            return False
        size, other = _font_size(previous), _font_size(region)
        if not size or not other or abs(size - other) > 0.5:
            return False
        gap = region.bbox[1] - previous.bbox[3]
        return -1 <= gap <= 0.6 * size

    def start(title: str, region, *, lead: bool = False) -> dict:
        if (
            sections
            and current is sections[-1]
            and not current["lines"]
            and not current["lead"]
            and stacked(current["region"], region)
        ):
            current["heading"] = f"{current['heading']} {title}"
            return current
        section = {"heading": title, "lines": [], "evidence": [], "region": region, "lead": lead}
        sections.append(section)
        return section

    def heading_of(region, line: str, number: int) -> str | None:
        ruled_match = _RULED_HEADING.match(line)
        if mode == "ruled":
            return normalize_space(ruled_match.group("title")) if ruled_match else None
        if mode == "capitals":
            if ruled_match:
                return normalize_space(ruled_match.group("title"))
            return normalize_space(line) if capital_heading(region, line, number) else None
        return normalize_space(line) if region.region_type == "HEADING" else None

    def continues(previous: str, line: str, region) -> bool:
        if previous.endswith(_SENTENCE_END):
            return False
        if line[:1].islower() or line.startswith("&"):
            return True
        if region is not previous_region:
            return False
        if _MID_SENTENCE.search(previous) or (previous.endswith(",") and len(previous) >= 40):
            return True
        # Running text (prose-width lines, no bullets on the page): a line
        # reaching the block's width wrapped at the margin. Lists and narrow
        # columns (skills, dates) never join this way.
        width = widest.get(region.region_id, 0)
        return region.page not in bulleted and width >= _PROSE_WIDTH and len(previous) >= 0.85 * width

    for region, line, number in ordered:
        if _BULLET_ONLY.match(line):
            continue
        title = heading_of(region, line, number)
        # A smaller capital line right under a heading with no text yet is
        # its subtitle ("AMMARA FAZAL" / "EVENT ORGANIZER"), not a section.
        if (
            title
            and mode == "capitals"
            and current is not None
            and not current["lines"]
            and heading_size is not None
            and (_font_size(region, number) or 0) < heading_size
        ):
            title = None
        if title:
            current = start(title, region)
            previous_region = None
            continue
        if current is None and mode != "regions" and (region.region_type == "HEADING" or _title_like(line)):
            # The title block that opens the document (a name, a form title).
            current = start(normalize_space(line), region, lead=True)
            previous_region = None
            continue
        if current is None and region.region_type == "HEADING":
            current = start(normalize_space(line), region, lead=True)
            previous_region = None
            continue
        line = _LEADING_BULLET.sub("", line)
        target = current
        if region.region_type == "CONTACT_BLOCK" and sections and sections[0]["lead"]:
            target = sections[0]
        if target is None:
            current = target = start("Introduction", region)
        target["evidence"].append(line)
        lines = target["lines"]
        if target is current and lines and continues(lines[-1], line, region):
            lines[-1] = f"{lines[-1]} {line}"
        else:
            lines.append(line)
        if target is current:
            previous_region = region

    # A document with no headings at all is one block of text.
    if len(sections) == 1 and sections[0]["heading"] == "Introduction":
        sections[0]["heading"] = "Text"

    records: list[RawRecord] = []
    for index, section in enumerate(sections[:_MAX_SECTIONS]):
        if not section["lines"]:
            continue
        region = section["region"]
        provenance = make_provenance(
            document,
            page=region.page,
            evidence="\n".join([section["heading"], *section["evidence"]]),
            bbox=region.bbox,
            extraction_method=f"{region.extraction_method}:section",
            region_id=region.region_id,
            anchor=section["heading"],
            locator=region.source_locator,
            source_type="html" if region.extraction_method == "dom" else None,
        )
        provenance.highlight_text = section["heading"]
        records.append(
            RawRecord(
                record_id=f"section:{index}",
                values={"heading": section["heading"], "content": "\n".join(section["lines"]), "page": region.page},
                provenance=provenance,
            )
        )
    return records


def _scanned_label_pairs(
    database: Session,
    document: Document,
    seen: set[tuple[str, str]],
    table_row_labels: set[str],
    ocr_pages: set[int],
) -> list[RawRecord]:
    """Label/value lines the structural passes leave out — "Gross Pay
    2,000.00", "Subtotal 8.48  Tax 0.68  Total 9.16" on pay stubs and
    receipts — from the page-text scanner schema discovery already uses,
    under the same reliability gates. Labels already listed (or held in an
    accepted table) are skipped."""

    from app.services.field_classification import is_narrative_or_section_field
    from app.services.generic_kv_scanner import is_plausible_kv_label, scan_page_for_labeled_pairs
    from app.services.structure_detection import _looks_like_reliable_kv_label

    listed = {label for label, _ in seen}
    records: list[RawRecord] = []
    pages = database.scalars(
        select(DocumentPage).where(DocumentPage.document_id == document.id).order_by(DocumentPage.page_number)
    )
    for page in pages:
        for pair in scan_page_for_labeled_pairs(page=page):
            label = normalize_space(pair.raw_label)
            if label.lower() in listed or label.lower() in table_row_labels:
                continue
            if not is_plausible_kv_label(pair.raw_label) or not _looks_like_reliable_kv_label(pair):
                continue
            if is_narrative_or_section_field(key=f"kv_{label.lower()}", label=label, value=pair.value, field_group="field"):
                continue
            listed.add(label.lower())
            seen.add((label.lower(), normalize_space(pair.value).lower()))
            evidence = next(
                (line for line in (page.final_text or "").splitlines() if pair.value in line), pair.value
            )
            record = RawRecord(
                record_id=f"scan:{page.page_number}:{label.lower()}",
                values={
                    "name": label,
                    "value": pair.value,
                    "value_type": None,
                    "extraction_method": pair.method.replace("_", " "),
                    "category": "Key Field",
                },
                provenance=make_provenance(
                    document, page=page.page_number, evidence=evidence, extraction_method=f"page_text:{pair.method}",
                ),
            )
            if page.page_number in ocr_pages:
                record.provenance.ocr_gate = True
            records.append(record)
    return records


def adapt_generic(database: Session, document: Document) -> AdapterResult:
    structure = get_or_build_source_structure(database, document)
    staging_record = database.scalars(
        select(DocumentStagingWorkbook).where(DocumentStagingWorkbook.document_id == document.id)
    ).first()

    key_fields: list[RawRecord] = []
    contacts: list[RawRecord] = []
    seen: set[tuple[str, str]] = set()

    for candidate in structure.field_candidates:
        if candidate.acceptance != "accepted":
            continue
        signature = (candidate.label_text.lower(), normalize_space(candidate.raw_value).lower())
        if signature in seen:
            continue
        seen.add(signature)
        is_contact = candidate.value_type_hint in _CONTACT_TYPES or bool(
            _CONTACT_LABEL.search(candidate.label_text)
        )
        record = RawRecord(
            record_id=candidate.candidate_id,
            values={
                "name": candidate.label_text,
                "value": candidate.raw_value.strip(),
                "value_type": candidate.value_type_hint,
                "extraction_method": candidate.structural_relation.replace("_", " "),
                "category": "Contact" if is_contact else "Key Field",
            },
            provenance=field_provenance(document, candidate),
        )
        (contacts if is_contact else key_fields).append(record)

    # Fields the canonical V3 classifier accepted (e.g. numbered government
    # form labels) that the structural pass didn't already produce.
    try:
        v3 = get_normalized_v3_document(database, document.id)
    except ValueError:
        v3 = None
    geometry = PageGeometry(database, document.id)
    ocr_pages = {
        page.page_number
        for page in database.scalars(select(DocumentPage).where(DocumentPage.document_id == document.id))
        if page.extraction_method == "ocr"
    }
    table_row_labels = {
        normalize_space(cell.text).lower()
        for table in structure.table_candidates
        if table.acceptance == "accepted"
        for row in table.rows
        for cell in row
        if cell.text
    }
    for index, row in enumerate(v3.all_fields if v3 else []):
        signature = (row.normalized_field.lower(), normalize_space(row.value).lower())
        if signature in seen:
            continue
        # V3's own layout pass also reads table rows and OCR debris as
        # "fields" on scanned pages: drop values with no content, captions
        # carrying rule/underline debris, and rows a table already holds.
        if not re.search(r"[A-Za-z0-9]", row.value or "") or re.search(r"[|_«»]", row.normalized_field or ""):
            continue
        if normalize_space(row.normalized_field).lower() in table_row_labels:
            continue
        seen.add(signature)
        key_fields.append(
            RawRecord(
                record_id=row.row_provenance.row_id if row.row_provenance else f"v3field:{index}",
                values={
                    "name": row.normalized_field,
                    "value": row.value,
                    "value_type": None,
                    "extraction_method": f"v3 {row.extraction_method}",
                    "category": "Key Field",
                },
                provenance=make_provenance(
                    document,
                    page=row.source_page,
                    evidence=row.evidence,
                    bbox=geometry.pdf_bbox(
                        row.source_page, row.row_provenance.bbox, row.row_provenance.bbox_space
                    )
                    if row.row_provenance
                    else None,
                    extraction_method=row.extraction_method,
                    region_id=row.row_provenance.row_id if row.row_provenance else None,
                ),
                builder_status=row.qa_status,
            )
        )
        if "ocr" in (row.extraction_method or "").lower() or row.source_page in ocr_pages:
            # No per-word confidence for these — OCR-read, so never Verified
            # on the strength of the text alone.
            key_fields[-1].provenance.ocr_gate = True

    key_fields.extend(
        _scanned_label_pairs(database, document, seen, table_row_labels, ocr_pages)
    )

    for region in structure.regions:
        if region.region_type != "CONTACT_BLOCK":
            continue
        contacts.append(
            RawRecord(
                record_id=region.region_id,
                values={"name": "Contact block", "value": region.text, "value_type": "address"},
                provenance=region_provenance(document, region, kind="contact_block"),
            )
        )

    line_items: list[RawRecord] = []
    other_tables: list[RawRecord] = []
    accepted_tables = [t for t in structure.table_candidates if t.acceptance == "accepted"]
    for index, table in enumerate(accepted_tables, start=1):
        label = _table_label(table, index)
        if _is_line_item_table(table):
            lines, totals = _line_item_records(document, table, label)
            line_items.extend(lines)
            key_fields.extend(totals)
            continue
        header_text = " | ".join(h for h in table.headers if h)
        first_row = " | ".join(c.text for c in table.rows[0] if c.text) if table.rows else ""
        other_tables.append(
            RawRecord(
                record_id=table.candidate_id,
                values={
                    "columns": header_text,
                    "column_count": len(table.headers),
                    "row_count": len(table.rows),
                    "first_row": first_row or None,
                    "detection": table.detection_method.replace("_", " "),
                },
                provenance=make_provenance(
                    document,
                    page=table.page,
                    evidence=f"{header_text}\n{first_row}".strip(),
                    bbox=table.bbox,
                    extraction_method=f"{table.extraction_method}:{table.detection_method}",
                    region_id=table.region_id,
                    anchor=next((h for h in table.headers if h), None),
                    locator=table.source_locator,
                    source_type="html" if table.extraction_method == "dom" else None,
                ),
            )
        )
        if table.extraction_method == "ocr":
            confidences = [c.ocr_confidence for row in table.rows[:1] for c in row if c.text]
            other_tables[-1].provenance.ocr_gate = True
            other_tables[-1].provenance.ocr_confidence = (
                min(confidences) if confidences and None not in confidences else None
            )

    all_fields = _all_fields(document, structure, key_fields + contacts, accepted_tables)
    sections = _document_sections(document, structure)
    stats = structure.stats
    regions = stats.regions_by_type
    summary_parts = [
        f"{stats.field_candidates.get('accepted', 0)} label/value pairs",
        f"{len(accepted_tables)} tables",
        f"{regions.get('HEADING', 0)} headings",
    ]
    rejected_fields = [f for f in structure.field_candidates if f.acceptance != "accepted"]
    rejected_tables = [t for t in structure.table_candidates if t.acceptance != "accepted"]
    narrative = regions.get("NARRATIVE", 0) + regions.get("PARAGRAPH", 0)
    reason_counts = Counter(r for f in rejected_fields for r in f.reasons)
    qa_rows = [
        RawRecord(
            record_id="qa:structure:fields",
            values={
                "qa_check": "Structure: label/value candidates",
                "result": "PASS" if not rejected_fields else "REVIEW",
                "details": (
                    f"{stats.field_candidates.get('accepted', 0)} accepted, "
                    f"{len(rejected_fields)} not accepted"
                    + (
                        " (" + ", ".join(f"{r.replace('_', ' ')}: {n}" for r, n in reason_counts.most_common(3)) + ")"
                        if reason_counts
                        else ""
                    )
                    + "."
                ),
                "action": "Rejected candidates are excluded; check the source if an expected field is absent."
                if rejected_fields
                else "None.",
            },
        ),
        RawRecord(
            record_id="qa:structure:tables",
            values={
                "qa_check": "Structure: tables",
                "result": "PASS" if not rejected_tables else "REVIEW",
                "details": f"{len(accepted_tables)} accepted, {len(rejected_tables)} rejected by the table-quality gate.",
                "action": "None." if not rejected_tables else "Rejected tables (e.g. prose laid out in columns) are excluded.",
            },
        ),
        RawRecord(
            record_id="qa:structure:narrative",
            values={
                "qa_check": "Structure: narrative",
                "result": "INFO",
                "details": (
                    f"{narrative} paragraph/narrative regions were read; their text is under "
                    f"{len(sections)} section{'s' if len(sections) != 1 else ''}, not turned into fields."
                ),
                "action": "See Sections; the full text is also in Source / Transcription.",
            },
        ),
    ]
    if structure.warnings:
        qa_rows.append(
            RawRecord(
                record_id="qa:structure:warnings",
                values={
                    "qa_check": "Structure: warnings",
                    "result": "REVIEW",
                    "details": "; ".join(structure.warnings),
                    "action": "Re-run extraction if the source file was unavailable.",
                },
            )
        )

    source_type = source_type_of(document)
    summary = RawRecord(
        record_id="document_summary",
        values={
            "document_type": (staging_record.document_family_label if staging_record else None)
            or "Unclassified business document",
            "source_filename": document.original_filename,
            "source_type": source_type.upper(),
            # HTML has no pages; don't present its single ingestion page as one.
            "page_count": None if source_type == "html" else document.page_count,
            "processing_status": document.processing_status,
            "structure_summary": ", ".join(summary_parts),
        },
        provenance=system_provenance(document),
    )

    return AdapterResult(
        records={
            "document_summary": [summary],
            "key_fields": key_fields,
            "contacts": contacts,
            "document_sections": sections,
            "line_items": line_items,
            "other_tables": other_tables,
            "all_fields": all_fields,
            "source_documents": [
                RawRecord(record_id=f"source:{i}", values=row.model_dump())
                for i, row in enumerate(v3.source_documents if v3 else [])
            ],
            "qa_review": qa_rows,
        },
        outcome_provenance=document.ingestion_provenance,
    )


GENERIC_PROFILE = StagingProfile(
    profile_id="generic_business_document",
    profile_version=2,
    display_name="Generic Business Document",
    description=(
        "Fallback for business documents without a dedicated profile: "
        "structural label/value pairs, contacts, repeating line tables and "
        "other accepted tables."
    ),
    document_families=("unknown", "generic_business"),
    datasets=(
        DOCUMENT_SUMMARY,
        KEY_FIELDS,
        CONTACTS,
        SECTIONS,
        LINE_ITEMS,
        OTHER_TABLES,
        ALL_FIELDS,
        SOURCE_DOCUMENTS,
        QA_REVIEW,
    ),
    adapter=adapt_generic,
    export_sheets=(
        ExportSheet("Document Summary", ("document_summary",)),
        ExportSheet("Key Fields", ("key_fields",)),
        ExportSheet("Contacts", ("contacts",)),
        ExportSheet("Sections", ("document_sections",)),
        ExportSheet("Line Items", ("line_items",)),
        ExportSheet("Other Tables", ("other_tables",)),
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
            for definition in (DOCUMENT_SUMMARY, KEY_FIELDS, CONTACTS, SECTIONS, LINE_ITEMS, OTHER_TABLES, ALL_FIELDS)
        ),
    ),
    oracle_mapping_capability="none",
    auto_qa_dataset="qa_review",
    source_structure="required",
)
