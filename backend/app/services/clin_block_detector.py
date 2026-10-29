import re
from dataclasses import dataclass, field

from app.models.document_page import DocumentPage
from app.services.table_shapes import page_tables

_CLIN_HEADER_KEYWORDS = (
    "clin",
    "item no",
    "item number",
    "line item",
)

# CLIN/SLIN identifiers are conventionally 4 digits (FAR uniform numbering)
# but 5-6 digit item numbers occur on non-DoD vehicles (e.g. GSA MAC/IDIQ
# domain-coded CLINs like "10300", "10301"); an optional 1-2 letter suffix
# is the FAR SLIN convention (e.g. "0001AA"). Widened from a 4-digit-only
# match - not a contract-specific fix, a real FAR-numbering-shape gap.
_CLIN_NUMBER_PATTERN = re.compile(r"^\d{4,6}[A-Z]{0,2}$")

# A standalone CLIN/SLIN line as it appears in unstructured (non-bordered)
# pricing schedules: "10301   RD-541330-SB                          0.00".
# Deliberately loose on whitespace - fixed-width columns collapse
# differently depending on extraction method (native vs OCR).
_CLIN_LINE_RE = re.compile(
    r"^(?P<clin>\d{4,6}[A-Z]{0,2})\s{2,}(?P<desc>\S.*?)\s{2,}"
    r"(?P<amount>[\d,]+\.\d{2})\s*$"
)


@dataclass(frozen=True)
class RepeatedRecordBlock:
    key: str
    label: str
    headers: list[str]
    row_count: int
    page_number: int


def _row_first_value(row: object) -> str | None:
    if isinstance(row, dict):
        values = list(row.values())
    elif isinstance(row, (list, tuple)):
        values = list(row)
    else:
        return None
    if not values:
        return None
    return str(values[0]).strip()


def detect_repeated_records(
    *,
    page: DocumentPage,
) -> list[RepeatedRecordBlock]:
    blocks: list[RepeatedRecordBlock] = []

    for table in page_tables(page.tables_json):
        headers = [str(h) for h in (table.get("headers") or [])]
        rows = table.get("rows") or []

        if len(rows) < 2:
            continue

        header_haystack = " ".join(headers).lower()
        header_hit = any(
            keyword in header_haystack for keyword in _CLIN_HEADER_KEYWORDS
        )

        clin_shaped_rows = sum(
            1
            for row in rows
            if (first := _row_first_value(row)) is not None
            and _CLIN_NUMBER_PATTERN.match(first)
        )
        value_hit = clin_shaped_rows >= 2

        if not (header_hit or value_hit):
            continue

        blocks.append(
            RepeatedRecordBlock(
                key="clin_schedule",
                label="CLIN Schedule",
                headers=headers,
                row_count=len(rows),
                page_number=page.page_number,
            )
        )

    return blocks


# Column-header keyword -> ParsedClinRow field, used to map a detected
# table's actual header text onto the V3-shaped fields without assuming a
# fixed column order (ground-truth CLINs sheet and the regression
# contract's schedule use different column sets/orders).
_HEADER_FIELD_KEYWORDS: tuple[tuple[str, str], ...] = (
    ("clin", "clin"),
    ("slin", "slin"),
    ("description", "description"),
    ("supplies", "description"),
    ("services", "description"),
    ("qty", "quantity"),
    ("quantity", "quantity"),
    ("unit price", "unit_price"),
    ("unit", "unit"),
    ("amount", "amount"),
    ("psc", "psc"),
    ("pricing", "pricing_arrangement"),
    ("option", "base_option"),
    ("base", "base_option"),
)


@dataclass(frozen=True)
class ParsedClinRow:
    """A single CLIN/SLIN row, parsed but NOT yet persisted to any V3
    dataset - Step 1 stops here. `parent_line_item`/`relationship` are
    internal-only hierarchy hints (see docs/v3-implementation-plan.md,
    decision #1): never exported to the V3 CLINs sheet, kept only so a
    source-established SLIN relationship isn't silently lost.
    """

    clin: str
    description: str | None
    quantity: str | None
    unit: str | None
    unit_price: str | None
    amount: str | None
    psc: str | None
    pricing_arrangement: str | None
    base_option: str | None
    page_number: int
    source_text: str
    confidence: float
    parent_line_item: str | None = None
    relationship: str | None = None
    reason_codes: list[str] = field(default_factory=list)


def _map_row_by_headers(
    headers: list[str],
    row: object,
) -> dict[str, str]:
    if isinstance(row, dict):
        cells = {str(k): str(v) for k, v in row.items() if v is not None}
        return cells if headers else cells

    if isinstance(row, (list, tuple)):
        values = [str(v) if v is not None else "" for v in row]
    else:
        return {}

    mapped: dict[str, str] = {}
    for header, value in zip(headers, values):
        header_lower = header.lower()
        for keyword, field_name in _HEADER_FIELD_KEYWORDS:
            if keyword in header_lower and field_name not in mapped:
                mapped[field_name] = value.strip()
                break
    return mapped


def _slin_parent(clin: str, seen_numeric_clins: set[str]) -> tuple[str | None, str | None]:
    """A CLIN carrying an alphabetic suffix (e.g. "0001AA") is a SLIN of the
    bare numeric CLIN it extends (e.g. "0001"), IF that bare CLIN has
    already been seen on this page - the FAR SLIN numbering convention, not
    a similar-looking-identifier guess."""

    match = re.match(r"^(\d{4,6})([A-Z]{1,2})$", clin)
    if not match:
        return None, None
    numeric_part = match.group(1)
    if numeric_part in seen_numeric_clins:
        return numeric_part, "SLIN"
    return None, None


def _row_has_supporting_content(row: object, first_value: str) -> bool:
    """A real CLIN row always has SOMETHING beyond the bare number - a
    description, quantity, or amount. Guards against generic table
    detection mis-splitting an unrelated narrative paragraph (e.g. an
    address block "1800 F St NW, Washington, D.C. 20405" detected as a
    table whose first cell happens to be the 4-digit-shaped "1800") into a
    spurious CLIN row - confirmed false positive, not a hypothetical one."""

    if isinstance(row, dict):
        values = list(row.values())
    elif isinstance(row, (list, tuple)):
        values = list(row)
    else:
        return False
    remaining = [str(v).strip() for v in values if v is not None and str(v).strip() != first_value]
    return any(remaining)


def parse_clin_rows_from_tables(
    *,
    page: DocumentPage,
) -> list[ParsedClinRow]:
    """Parse CLIN rows out of pdfplumber-detected tables on this page."""

    rows_out: list[ParsedClinRow] = []
    seen_numeric_clins: set[str] = set()

    for table in page_tables(page.tables_json):
        headers = [str(h) for h in (table.get("headers") or [])]
        rows = table.get("rows") or []

        header_haystack = " ".join(headers).lower()
        header_hit = any(keyword in header_haystack for keyword in _CLIN_HEADER_KEYWORDS)
        clin_shaped_row_count = sum(
            1
            for row in rows
            if (first := _row_first_value(row)) is not None
            and _CLIN_NUMBER_PATTERN.match(first)
        )
        # Same eligibility gate as detect_repeated_records: a table is only
        # CLIN-relevant if its headers say so, or at least 2 of its rows
        # are independently CLIN-number-shaped - one coincidental 4-digit
        # match in an otherwise unrelated table is not enough evidence.
        if not (header_hit or clin_shaped_row_count >= 2):
            continue

        for row in rows:
            first_value = _row_first_value(row)
            if not first_value or not _CLIN_NUMBER_PATTERN.match(first_value):
                continue
            if not _row_has_supporting_content(row, first_value):
                continue

            mapped = _map_row_by_headers(headers, row)
            clin = first_value
            parent, relationship = _slin_parent(clin, seen_numeric_clins)

            if re.match(r"^\d{4,6}$", clin):
                seen_numeric_clins.add(clin)

            rows_out.append(
                ParsedClinRow(
                    clin=clin,
                    description=mapped.get("description"),
                    quantity=mapped.get("quantity"),
                    unit=mapped.get("unit"),
                    unit_price=mapped.get("unit_price"),
                    amount=mapped.get("amount"),
                    psc=mapped.get("psc"),
                    pricing_arrangement=mapped.get("pricing_arrangement"),
                    base_option=mapped.get("base_option"),
                    page_number=page.page_number,
                    source_text=" | ".join(
                        str(v) for v in (row.values() if isinstance(row, dict) else row)
                    )[:240],
                    confidence=0.85,
                    parent_line_item=parent,
                    relationship=relationship,
                    reason_codes=["matched_detected_table_row", "clin_number_shape"],
                )
            )

    return rows_out


def parse_clin_rows_from_text(
    *,
    page: DocumentPage,
) -> list[ParsedClinRow]:
    """Fallback for pricing schedules with no ruled table lines (pdfplumber
    finds nothing): scan page text line-by-line for the CLIN-line shape.
    Lower confidence than the table path since there is no header context
    to map columns from - only CLIN/description/amount are populated."""

    rows_out: list[ParsedClinRow] = []
    seen_numeric_clins: set[str] = set()

    for line in (page.final_text or "").splitlines():
        match = _CLIN_LINE_RE.match(line.strip())
        if not match:
            continue

        clin = match.group("clin")
        parent, relationship = _slin_parent(clin, seen_numeric_clins)
        if re.match(r"^\d{4,6}$", clin):
            seen_numeric_clins.add(clin)

        rows_out.append(
            ParsedClinRow(
                clin=clin,
                description=match.group("desc").strip() or None,
                quantity=None,
                unit=None,
                unit_price=None,
                amount=match.group("amount"),
                psc=None,
                pricing_arrangement=None,
                base_option=None,
                page_number=page.page_number,
                source_text=line.strip()[:240],
                confidence=0.6,
                parent_line_item=parent,
                relationship=relationship,
                reason_codes=["clin_line_regex_no_table_structure"],
            )
        )

    return rows_out


def parse_clin_rows(*, page: DocumentPage) -> list[ParsedClinRow]:
    """Best available CLIN row parse for this page: prefer structured
    table rows, fall back to line-shaped text scanning when no table was
    detected. Does not persist anything (Step 1 stops before persistence)."""

    table_rows = parse_clin_rows_from_tables(page=page)
    if table_rows:
        return table_rows
    return parse_clin_rows_from_text(page=page)
