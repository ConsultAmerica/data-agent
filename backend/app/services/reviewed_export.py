"""Reviewed-value-aware export and Oracle payload builders.

Distinguishes machine extraction from human-authoritative results:

  extracted_value  → latest / original machine extract
  value            → effective reviewed (or pending machine) value
  review_status    → pending | accepted | edited | rejected | unknown

Business CSV uses ``value``. Rich JSON keeps both. Oracle preview never
treats pending/rejected/unknown as authoritative downstream data.
"""

from __future__ import annotations

import csv
import io
from datetime import datetime, timezone
from typing import Any

from app.models.document import Document
from app.models.document_metadata_field import DocumentMetadataField
from app.services.field_classification import (
    KEY_CONTRACT_FIELD_KEYS,
    is_canonical_business_field,
    is_key_contract_field,
    is_narrative_or_section_field,
)
from app.services.section_detection import find_nearby_section
from app.services.evidence_text import source_text_of

AUTHORITATIVE_REVIEW_STATUSES = frozenset({"accepted", "edited"})
NON_AUTHORITATIVE_REVIEW_STATUSES = frozenset(
    {"pending", "rejected", "unknown"}
)

CSV_HEADERS = [
    "field",
    "value",
    "extracted_value",
    "review_status",
    "confidence",
    "validation_status",
    "source_page",
    "section",
    "field_type",
]


def _evidence(field: DocumentMetadataField) -> dict[str, Any]:
    raw = field.evidence_json
    return dict(raw) if isinstance(raw, dict) else {}


def extracted_value_for(field: DocumentMetadataField) -> str:
    evidence = _evidence(field)
    machine = evidence.get("machine_value")
    if machine is not None and str(machine) != "":
        return str(machine)
    if field.original_value:
        return str(field.original_value)
    return str(field.value or "")


def validation_status_for(field: DocumentMetadataField) -> str:
    evidence = _evidence(field)
    validation = evidence.get("validation")
    if isinstance(validation, dict) and validation.get("status"):
        return str(validation["status"])
    status = evidence.get("validation_status")
    if status:
        return str(status)
    return "passed"


def source_page_for(field: DocumentMetadataField) -> int:
    evidence = _evidence(field)
    page = evidence.get("page_number")
    if isinstance(page, int) and page > 0:
        return page
    try:
        return int(page)
    except (TypeError, ValueError):
        return 1


def is_authoritative(field: DocumentMetadataField) -> bool:
    return (field.review_status or "pending") in AUTHORITATIVE_REVIEW_STATUSES


def _select_fields(
    fields: list[DocumentMetadataField],
    *,
    authoritative_only: bool = False,
    business_only: bool = True,
) -> list[DocumentMetadataField]:
    selected = (
        [field for field in fields if is_authoritative(field)]
        if authoritative_only
        else list(fields)
    )
    if not business_only:
        return selected
    return [
        field
        for field in selected
        if is_canonical_business_field(
            key=field.field_key,
            label=field.label,
            value=field.value,
            field_group=field.field_group,
        )
    ]


def _section_fields(
    fields: list[DocumentMetadataField],
) -> list[DocumentMetadataField]:
    return [
        field
        for field in fields
        if is_narrative_or_section_field(
            key=field.field_key,
            label=field.label,
            value=field.value,
            field_group=field.field_group,
        )
    ]


def _needs_review_fields(
    fields: list[DocumentMetadataField],
) -> list[DocumentMetadataField]:
    rows: list[DocumentMetadataField] = []
    for field in fields:
        status = (field.review_status or "pending").lower()
        validation = validation_status_for(field).lower()
        confidence = field.confidence
        low_conf = isinstance(confidence, (int, float)) and confidence < 0.6
        empty = field.value is None or str(field.value).strip() == ""
        if status in {"rejected", "pending"} and (
            validation == "failed" or low_conf or empty or status == "rejected"
        ):
            rows.append(field)
        elif validation == "failed" or low_conf:
            rows.append(field)
    return rows


def _append_audit_sheet(sheet: Any, fields: list[DocumentMetadataField], *, page_text_by_number: dict[int, str] | None) -> None:
    # Section is intentionally left out of this default audit view —
    # assignment isn't reliable enough yet and a mostly-blank column adds
    # clutter without adding information. The data isn't discarded: it's
    # still read from evidence_json via section_for() and included in the
    # Source Evidence sheet; this can come back here as an optional
    # column once section detection is reliable across document types.
    sheet.append(
        [
            "PDF Page",
            "Field / Label",
            "Extracted Value",
            "Field Type",
            "Confidence",
            "Validation",
            "Review Status",
        ]
    )
    for field in fields:
        sheet.append(
            [
                source_page_for(field),
                field.label or field.field_key or "",
                "" if field.value is None else str(field.value),
                field.field_group or "field",
                field.confidence,
                validation_status_for(field),
                field.review_status or "pending",
            ]
        )


def section_for(
    field: DocumentMetadataField,
    *,
    page_text_by_number: dict[int, str] | None = None,
) -> str:
    """Nearby heading for this field — from evidence if already computed
    at extraction time, otherwise best-effort from the page text."""

    evidence = _evidence(field)
    section = evidence.get("section")
    if section:
        return str(section)

    if not page_text_by_number:
        return ""

    page_text = page_text_by_number.get(source_page_for(field), "")
    if not page_text:
        return ""

    found = find_nearby_section(
        page_text,
        extracted_value_for(field) or str(field.value or ""),
    )
    return found or ""


def field_to_export_record(
    field: DocumentMetadataField,
    *,
    page_text_by_number: dict[int, str] | None = None,
) -> dict[str, Any]:
    """Rich export row matching the reviewed-value contract."""

    status = field.review_status or "pending"
    return {
        "field": field.label,
        "field_key": field.field_key,
        "field_group": field.field_group,
        "section": section_for(field, page_text_by_number=page_text_by_number),
        "extracted_value": extracted_value_for(field),
        "value": field.value,
        "review_status": status,
        "confidence": field.confidence,
        "validation": {"status": validation_status_for(field)},
        "source": {"page": source_page_for(field)},
        "authoritative": status in AUTHORITATIVE_REVIEW_STATUSES,
    }


def build_document_export(
    *,
    document: Document,
    fields: list[DocumentMetadataField],
    authoritative_only: bool = False,
) -> dict[str, Any]:
    selected = (
        [field for field in fields if is_authoritative(field)]
        if authoritative_only
        else list(fields)
    )
    records = [field_to_export_record(field) for field in selected]
    skipped = [
        {
            "field": field.label,
            "field_key": field.field_key,
            "review_status": field.review_status or "pending",
            "reason": "not_authoritative",
        }
        for field in fields
        if authoritative_only and not is_authoritative(field)
    ]
    return {
        "document_id": document.id,
        "document_filename": document.original_filename,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "authoritative_only": authoritative_only,
        "field_count": len(records),
        "fields": records,
        "skipped": skipped,
    }


def build_export_csv(
    fields: list[DocumentMetadataField],
    *,
    authoritative_only: bool = False,
    page_text_by_number: dict[int, str] | None = None,
) -> str:
    """Business CSV: effective reviewed ``value`` is the primary column."""

    selected = (
        [field for field in fields if is_authoritative(field)]
        if authoritative_only
        else list(fields)
    )
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=CSV_HEADERS, extrasaction="ignore")
    writer.writeheader()
    for field in selected:
        record = field_to_export_record(
            field, page_text_by_number=page_text_by_number
        )
        writer.writerow(
            {
                "field": record["field"],
                "section": record["section"],
                "field_type": record["field_group"],
                "value": record["value"],
                "extracted_value": record["extracted_value"],
                "review_status": record["review_status"],
                "confidence": record["confidence"],
                "validation_status": record["validation"]["status"],
                "source_page": record["source"]["page"],
            }
        )
    return buffer.getvalue()


def build_fields_wide_csv(
    fields: list[DocumentMetadataField],
    *,
    authoritative_only: bool = False,
) -> str:
    """Primary business-data CSV: one header row of human field names, one
    data row of values — an integration-ready record, not an audit dump.
    Headers are the display label (never a raw kv_/custom_ candidate key)."""

    selected = _select_fields(
        fields, authoritative_only=authoritative_only, business_only=True
    )
    headers: list[str] = []
    values: list[str] = []
    for field in selected:
        headers.append(field.label or field.field_key or "")
        value = field.value
        values.append("" if value is None else str(value))
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(headers)
    writer.writerow(values)
    return buffer.getvalue()


def build_line_items_csv(
    tables: list[Any],
    *,
    table_key: str | None = None,
) -> str:
    """One line-item table as its own rectangular CSV — real repeating
    rows (one CLIN/line item per row), never flattened into document-level
    columns. Defaults to the table with the most rows when the document
    has more than one and the caller didn't ask for a specific one."""

    if not tables:
        return ""

    if table_key:
        selected = next(
            (
                table
                for table in tables
                if getattr(table, "target_key", None) == table_key
            ),
            None,
        )
        if selected is None:
            return ""
    else:
        selected = max(
            tables, key=lambda table: len(getattr(table, "rows_json", None) or [])
        )

    columns = list(getattr(selected, "columns_json", None) or [])
    rows = list(getattr(selected, "rows_json", None) or [])
    if not columns and rows and isinstance(rows[0], dict):
        columns = list(rows[0].keys())

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow([str(col) for col in columns])
    for row in rows:
        if isinstance(row, dict):
            writer.writerow([row.get(col, "") for col in columns])
        elif isinstance(row, (list, tuple)):
            writer.writerow(list(row))
        else:
            writer.writerow([row])
    return buffer.getvalue()


def build_normalized_document(
    *,
    document: Document,
    fields: list[DocumentMetadataField],
    tables: list[Any] | None = None,
    authoritative_only: bool = False,
) -> dict[str, Any]:
    """The single normalized {fields, tables} record — CSV, XLSX, and the
    UI all read from the same underlying rows this is built from, so this
    endpoint is a thin reshape rather than a separate derivation."""

    selected = _select_fields(
        fields, authoritative_only=authoritative_only, business_only=True
    )
    field_map: dict[str, Any] = {}
    for field in selected:
        # Cosmetic only: the stored field_key keeps its raw kv_ prefix for
        # stable internal lookups, but this record is a public API/export
        # surface, so its keys use the canonical (prefix-stripped) name.
        raw_key = field.field_key or field.label or ""
        key = raw_key[3:] if raw_key.lower().startswith("kv_") else raw_key
        field_map[key] = field.value

    table_map: dict[str, Any] = {}
    for table in tables or []:
        key = getattr(table, "target_key", None) or getattr(
            table, "display_name", None
        ) or "table"
        columns = list(getattr(table, "columns_json", None) or [])
        rows = list(getattr(table, "rows_json", None) or [])
        table_map[key] = {
            "display_name": getattr(table, "display_name", key),
            "columns": columns,
            "rows": rows,
        }

    return {
        "document_id": document.id,
        "document_filename": document.original_filename,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "fields": field_map,
        "tables": table_map,
    }


def _safe_sheet_title(name: str, used: set[str]) -> str:
    cleaned = "".join(
        ch if ch.isalnum() or ch in " -_" else "_" for ch in (name or "Sheet")
    ).strip() or "Sheet"
    cleaned = cleaned[:28]
    candidate = cleaned
    index = 2
    while candidate.lower() in used:
        candidate = f"{cleaned[:24]}_{index}"
        index += 1
    used.add(candidate.lower())
    return candidate


def build_export_xlsx(
    *,
    document: Document,
    fields: list[DocumentMetadataField],
    tables: list[Any] | None = None,
    authoritative_only: bool = False,
    page_text_by_number: dict[int, str] | None = None,
) -> bytes:
    """Workbook: All Fields, Key Contract Fields, Sections, Line Items,
    Needs Review, Source Evidence, plus one sheet per accepted table.
    """

    from openpyxl import Workbook

    business = _select_fields(
        fields, authoritative_only=authoritative_only, business_only=True
    )
    sections = _section_fields(fields)
    needs_review = _needs_review_fields(fields)
    key_contract = [
        field
        for field in business
        if is_key_contract_field(key=field.field_key, label=field.label)
    ]

    workbook = Workbook()
    used_titles: set[str] = set()

    all_fields_sheet = workbook.active
    all_fields_sheet.title = _safe_sheet_title("All Fields", used_titles)
    _append_audit_sheet(
        all_fields_sheet, business, page_text_by_number=page_text_by_number
    )

    key_sheet = workbook.create_sheet(
        _safe_sheet_title("Key Contract Fields", used_titles)
    )
    # Prefer canonical key order; append any extra key-contract hits after.
    by_key = {
        (field.field_key or field.label or "").lower(): field
        for field in key_contract
    }
    ordered_keys: list[str] = []
    ordered_fields: list[DocumentMetadataField] = []
    for canonical in KEY_CONTRACT_FIELD_KEYS:
        field = by_key.pop(canonical, None)
        if field is None:
            field = by_key.pop(f"kv_{canonical}", None)
        if field is not None:
            ordered_keys.append(field.field_key or field.label)
            ordered_fields.append(field)
    for field in key_contract:
        key = field.field_key or field.label
        if key not in ordered_keys:
            ordered_keys.append(key)
            ordered_fields.append(field)
    key_sheet.append(
        [field.label or field.field_key or "" for field in ordered_fields]
        or ["(no key contract fields)"]
    )
    key_sheet.append(
        [
            "" if field.value is None else str(field.value)
            for field in ordered_fields
        ]
        or [""]
    )

    sections_sheet = workbook.create_sheet(
        _safe_sheet_title("Sections", used_titles)
    )
    _append_audit_sheet(
        sections_sheet, sections, page_text_by_number=page_text_by_number
    )

    line_items_sheet = workbook.create_sheet(
        _safe_sheet_title("Line Items", used_titles)
    )
    line_items_sheet.append(
        ["Note", "Line-item rows are exported as dedicated table sheets below."]
    )

    needs_sheet = workbook.create_sheet(
        _safe_sheet_title("Needs Review", used_titles)
    )
    _append_audit_sheet(
        needs_sheet, needs_review, page_text_by_number=page_text_by_number
    )

    for table in tables or []:
        title = getattr(table, "display_name", None) or getattr(
            table, "target_key", None
        ) or "Table"
        sheet = workbook.create_sheet(_safe_sheet_title(str(title), used_titles))
        columns = list(getattr(table, "columns_json", None) or [])
        rows = list(getattr(table, "rows_json", None) or [])
        if not columns and rows and isinstance(rows[0], dict):
            columns = list(rows[0].keys())
        sheet.append([str(col) for col in columns])
        for row in rows:
            if isinstance(row, dict):
                sheet.append([row.get(col, "") for col in columns])
            elif isinstance(row, (list, tuple)):
                sheet.append(list(row))
            else:
                sheet.append([str(row)])

    evidence_sheet = workbook.create_sheet(
        _safe_sheet_title("Source Evidence", used_titles)
    )
    evidence_sheet.append(
        [
            "document",
            "field",
            "field_key",
            "section",
            "field_type",
            "source_page",
            "raw_ocr",
            "normalized_value",
            "extracted_value",
            "value",
            "confidence",
            "validation_status",
            "review_status",
            "extraction_method",
        ]
    )
    for field in business + sections:
        evidence = _evidence(field)
        evidence_sheet.append(
            [
                document.original_filename,
                field.label,
                field.field_key,
                section_for(field, page_text_by_number=page_text_by_number),
                field.field_group,
                source_page_for(field),
                evidence.get("raw_ocr") or source_text_of(evidence),
                evidence.get("normalized_value") or field.value or "",
                extracted_value_for(field),
                field.value,
                field.confidence,
                validation_status_for(field),
                field.review_status or "pending",
                field.extraction_method,
            ]
        )

    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def build_oracle_payload_preview(
    *,
    document: Document,
    fields: list[DocumentMetadataField],
    dry_run: bool = True,
) -> dict[str, Any]:
    """Preview Oracle-bound payload — never includes pending/rejected.

    Explicit Send to Oracle remains a separate future step; this endpoint
    only builds and validates the preview.
    """

    authoritative = [field for field in fields if is_authoritative(field)]
    skipped = [
        {
            "field": field.label,
            "field_key": field.field_key,
            "review_status": field.review_status or "pending",
            "reason": "pending_or_rejected_not_sent_downstream",
        }
        for field in fields
        if not is_authoritative(field)
    ]

    header: dict[str, Any] = {}
    for field in authoritative:
        header[field.field_key] = field.value

    return {
        "document_id": document.id,
        "source_document": document.original_filename,
        "erp_target": "Oracle Fusion Cloud Procurement",
        "mode": "preview",
        "dry_run": dry_run,
        "send_allowed": False,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "excluded_statuses": sorted(NON_AUTHORITATIVE_REVIEW_STATUSES),
        "contract_header": header,
        "fields": [field_to_export_record(field) for field in authoritative],
        "skipped": skipped,
        "authoritative_count": len(authoritative),
        "skipped_count": len(skipped),
        "ready_to_send": len(authoritative) > 0 and len(skipped) == 0,
    }
