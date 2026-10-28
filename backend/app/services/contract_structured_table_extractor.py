from dataclasses import dataclass
from typing import Any, Callable

from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.database.base import Base
from app.models.document import Document
from app.models.document_address import DocumentAddress
from app.models.document_amendment_history import DocumentAmendmentHistory
from app.models.document_clause_reference import DocumentClauseReference
from app.models.document_contact import DocumentContact
from app.models.document_delivery_schedule import DocumentDeliverySchedule
from app.models.document_funding_line import DocumentFundingLine
from app.models.document_insurance_requirement import DocumentInsuranceRequirement
from app.models.document_key_position import DocumentKeyPosition
from app.models.document_line_item import DocumentLineItem
from app.models.document_order_range import DocumentOrderRange
from app.models.document_page import DocumentPage
from app.models.document_performance_period import DocumentPerformancePeriod
from app.models.document_wawf_instruction import DocumentWawfInstruction
from app.schemas.structured_tables import (
    AddressResult,
    AmendmentHistoryResult,
    ClauseReferenceResult,
    ContactResult,
    DeliveryScheduleResult,
    FundingLineResult,
    InsuranceRequirementResult,
    KeyPositionResult,
    LineItemResult,
    OrderRangeResult,
    PerformancePeriodResult,
    WawfInstructionResult,
)
from app.schemas.universal_extraction import SourceEvidence
from app.services.ai_context import build_page_context
from app.services.ai_provider import AIProvider, AIProviderError
from app.services.contract_structured_table_schema import STRUCTURED_TABLE_SPECS
from app.services.source_validator import validate_source_value


def _to_float(raw: str | None) -> float | None:
    if raw is None:
        return None

    cleaned = raw.replace("$", "").replace(",", "").strip()

    if not cleaned:
        return None

    try:
        return float(cleaned)
    except ValueError:
        return None


def _to_bool(raw: str | None) -> bool:
    if raw is None:
        return False

    return raw.strip().lower() in {"true", "yes", "1"}


def _to_str(raw: str | None) -> str | None:
    if raw is None:
        return None

    value = raw.strip()

    return value or None


def _build_line_item_fields(row: dict[str, str]) -> dict[str, Any]:
    return {
        "clin": _to_str(row.get("clin")),
        "description": row.get("description", "") or "",
        "quantity": _to_float(row.get("quantity")),
        "unit": _to_str(row.get("unit")),
        "unit_price": _to_float(row.get("unit_price")),
        "amount": _to_float(row.get("amount")),
        "is_maximum": _to_bool(row.get("is_maximum")),
        "period_label": _to_str(row.get("period_label")),
    }


def _build_performance_period_fields(row: dict[str, str]) -> dict[str, Any]:
    return {
        "period_label": row.get("period_label", "") or "",
        "start_date": _to_str(row.get("start_date")),
        "end_date": _to_str(row.get("end_date")),
        "amount": _to_float(row.get("amount")),
    }


def _build_delivery_schedule_fields(row: dict[str, str]) -> dict[str, Any]:
    return {
        "clin": _to_str(row.get("clin")),
        "delivery_date": _to_str(row.get("delivery_date")),
        "quantity": _to_float(row.get("quantity")),
        "ship_to_address": _to_str(row.get("ship_to_address")),
        "dodaac": _to_str(row.get("dodaac")),
        "cage_code": _to_str(row.get("cage_code")),
    }


def _build_key_position_fields(row: dict[str, str]) -> dict[str, Any]:
    return {
        "position_title": row.get("position_title", "") or "",
        "pir": _to_str(row.get("pir")),
        "code": _to_str(row.get("code")),
        "monthly_amount": _to_float(row.get("monthly_amount")),
        "pws_section": _to_str(row.get("pws_section")),
        "wawf_field": _to_str(row.get("wawf_field")),
        "wawf_value": _to_str(row.get("wawf_value")),
    }


def _build_funding_line_fields(row: dict[str, str]) -> dict[str, Any]:
    return {
        "acrn": _to_str(row.get("acrn")),
        "line_of_accounting": _to_str(row.get("line_of_accounting")),
        "amount": _to_float(row.get("amount")),
    }


def _build_clause_reference_fields(row: dict[str, str]) -> dict[str, Any]:
    family = (row.get("clause_family") or "").strip().upper()

    if family not in {"FAR", "DFARS"}:
        family = "FAR"

    return {
        "clause_family": family,
        "clause_number": row.get("clause_number", "") or "",
        "title": row.get("title", "") or "",
        "effective_date": _to_str(row.get("effective_date")),
        "alternate": _to_str(row.get("alternate")),
        "deviation": _to_str(row.get("deviation")),
        "variation_effective_date": _to_str(row.get("variation_effective_date")),
        "full_text": _to_str(row.get("full_text")),
    }


def _build_wawf_instruction_fields(row: dict[str, str]) -> dict[str, Any]:
    return {
        "field_name": row.get("field_name", "") or "",
        "instruction_value": row.get("instruction_value", "") or "",
    }


def _build_insurance_requirement_fields(row: dict[str, str]) -> dict[str, Any]:
    return {
        "coverage_type": row.get("coverage_type", "") or "",
        "minimum_amount": _to_float(row.get("minimum_amount")),
    }


def _build_order_range_fields(row: dict[str, str]) -> dict[str, Any]:
    return {
        "naics_code": _to_str(row.get("naics_code")),
        "minimum_amount": _to_float(row.get("minimum_amount")),
        "maximum_amount": _to_float(row.get("maximum_amount")),
        "description": _to_str(row.get("description")),
    }


def _build_amendment_history_fields(row: dict[str, str]) -> dict[str, Any]:
    return {
        "amendment_number": row.get("amendment_number", "") or "",
        "effective_date": _to_str(row.get("effective_date")),
        "description": _to_str(row.get("description")),
    }


def _build_contact_fields(row: dict[str, str]) -> dict[str, Any]:
    return {
        "contact_name": row.get("contact_name", "") or "",
        "role_title": _to_str(row.get("role_title")),
        "phone_area_code": _to_str(row.get("phone_area_code")),
        "phone_number": _to_str(row.get("phone_number")),
        "phone_extension": _to_str(row.get("phone_extension")),
        "email": _to_str(row.get("email")),
    }


_VALID_ADDRESS_TYPES = {
    "offeror",
    "remittance",
    "ship_to",
    "invoice_destination",
    "other",
}


def _build_address_fields(row: dict[str, str]) -> dict[str, Any]:
    address_type = (row.get("address_type") or "other").strip().lower()

    if address_type not in _VALID_ADDRESS_TYPES:
        address_type = "other"

    return {
        "address_type": address_type,
        "organization_name": _to_str(row.get("organization_name")),
        "street": _to_str(row.get("street")),
        "city": _to_str(row.get("city")),
        "state": _to_str(row.get("state")),
        "zip_code": _to_str(row.get("zip_code")),
    }


@dataclass(frozen=True)
class _FamilyConfig:
    orm_class: type[Base]
    result_class: type[BaseModel]
    response_key: str
    fields: tuple[str, ...]
    build_fields: Callable[[dict[str, str]], dict[str, Any]]


_FAMILY_CONFIG: dict[str, _FamilyConfig] = {
    "line_item": _FamilyConfig(
        DocumentLineItem,
        LineItemResult,
        "line_items",
        (
            "clin",
            "description",
            "quantity",
            "unit",
            "unit_price",
            "amount",
            "is_maximum",
            "period_label",
        ),
        _build_line_item_fields,
    ),
    "performance_period": _FamilyConfig(
        DocumentPerformancePeriod,
        PerformancePeriodResult,
        "performance_periods",
        ("period_label", "start_date", "end_date", "amount"),
        _build_performance_period_fields,
    ),
    "delivery_schedule": _FamilyConfig(
        DocumentDeliverySchedule,
        DeliveryScheduleResult,
        "delivery_schedule",
        (
            "clin",
            "delivery_date",
            "quantity",
            "ship_to_address",
            "dodaac",
            "cage_code",
        ),
        _build_delivery_schedule_fields,
    ),
    "key_position": _FamilyConfig(
        DocumentKeyPosition,
        KeyPositionResult,
        "key_positions",
        (
            "position_title",
            "pir",
            "code",
            "monthly_amount",
            "pws_section",
            "wawf_field",
            "wawf_value",
        ),
        _build_key_position_fields,
    ),
    "funding_line": _FamilyConfig(
        DocumentFundingLine,
        FundingLineResult,
        "funding_lines",
        ("acrn", "line_of_accounting", "amount"),
        _build_funding_line_fields,
    ),
    "clause_reference": _FamilyConfig(
        DocumentClauseReference,
        ClauseReferenceResult,
        "clause_references",
        (
            "clause_family",
            "clause_number",
            "title",
            "effective_date",
            "alternate",
            "deviation",
            "variation_effective_date",
            "full_text",
        ),
        _build_clause_reference_fields,
    ),
    "wawf_instruction": _FamilyConfig(
        DocumentWawfInstruction,
        WawfInstructionResult,
        "wawf_instructions",
        ("field_name", "instruction_value"),
        _build_wawf_instruction_fields,
    ),
    "insurance_requirement": _FamilyConfig(
        DocumentInsuranceRequirement,
        InsuranceRequirementResult,
        "insurance_requirements",
        ("coverage_type", "minimum_amount"),
        _build_insurance_requirement_fields,
    ),
    "order_range": _FamilyConfig(
        DocumentOrderRange,
        OrderRangeResult,
        "order_ranges",
        ("naics_code", "minimum_amount", "maximum_amount", "description"),
        _build_order_range_fields,
    ),
    "amendment_history": _FamilyConfig(
        DocumentAmendmentHistory,
        AmendmentHistoryResult,
        "amendment_history",
        ("amendment_number", "effective_date", "description"),
        _build_amendment_history_fields,
    ),
    "contact": _FamilyConfig(
        DocumentContact,
        ContactResult,
        "contacts",
        (
            "contact_name",
            "role_title",
            "phone_area_code",
            "phone_number",
            "phone_extension",
            "email",
        ),
        _build_contact_fields,
    ),
    "address": _FamilyConfig(
        DocumentAddress,
        AddressResult,
        "addresses",
        (
            "address_type",
            "organization_name",
            "street",
            "city",
            "state",
            "zip_code",
        ),
        _build_address_fields,
    ),
}


def _empty_results() -> dict[str, list[BaseModel]]:
    return {family: [] for family in _FAMILY_CONFIG}


async def extract_document_structured_tables(
    *,
    database: Session,
    document: Document,
    pages: list[DocumentPage],
    ai_provider: AIProvider,
) -> tuple[dict[str, list[BaseModel]], list[str]]:
    warnings: list[str] = []

    if not pages:
        return _empty_results(), [
            "No extracted pages were found for this document."
        ]

    settings = get_settings()

    context = build_page_context(
        pages,
        maximum_characters=settings.ai_max_context_chars,
    )

    try:
        ai_result = await ai_provider.extract_structured_tables(
            page_context=context,
            table_specs=STRUCTURED_TABLE_SPECS,
        )
    except AIProviderError as exc:
        return _empty_results(), [
            f"Structured table extraction unavailable: {exc}"
        ]

    page_lookup = {page.page_number: page for page in pages}

    results: dict[str, list[BaseModel]] = _empty_results()
    persisted_rows: dict[str, list[tuple[dict[str, Any], float, SourceEvidence]]] = {
        family: [] for family in _FAMILY_CONFIG
    }

    for raw_row in ai_result.get("rows", []):
        family = raw_row.get("family")
        config = _FAMILY_CONFIG.get(family)

        if config is None:
            continue

        page_number = raw_row.get("page_number")
        page = page_lookup.get(page_number)

        if page is None:
            continue

        source_text = str(raw_row.get("source_text", ""))

        if not validate_source_value(
            strict=True,  # AI-produced value: the quote alone is not evidence
            value=source_text,
            source_text=source_text,
            page_text=page.final_text or "",
        ):
            warnings.append(
                f"{config.response_key} row on page {page_number} "
                "failed source validation and was dropped."
            )
            continue

        row = raw_row.get("row") or {}
        fields = config.build_fields(row)

        confidence = float(raw_row.get("confidence", 0.7))

        evidence = SourceEvidence(
            page_number=page_number,
            source_text=source_text[:800],
            source_reference=(
                f"{document.original_filename}, page {page_number}"
            ),
        )

        results[family].append(
            config.result_class(
                **fields,
                confidence=confidence,
                evidence=evidence,
            )
        )

        persisted_rows[family].append((fields, confidence, evidence))

    for family, config in _FAMILY_CONFIG.items():
        database.execute(
            delete(config.orm_class).where(
                config.orm_class.document_id == document.id
            )
        )

        for row_index, (fields, confidence, evidence) in enumerate(
            persisted_rows[family]
        ):
            database.add(
                config.orm_class(
                    document_id=document.id,
                    row_index=row_index,
                    confidence=confidence,
                    evidence_json=evidence.model_dump(),
                    **fields,
                )
            )

    database.commit()

    return results, warnings


def _row_to_result(config: _FamilyConfig, row: Base) -> BaseModel:
    data = {name: getattr(row, name) for name in config.fields}

    return config.result_class(
        **data,
        confidence=row.confidence,
        evidence=SourceEvidence(**row.evidence_json),
    )


def get_document_structured_tables(
    database: Session, document_id: str
) -> dict[str, list[BaseModel]]:
    results: dict[str, list[BaseModel]] = {}

    for family, config in _FAMILY_CONFIG.items():
        rows = list(
            database.scalars(
                select(config.orm_class)
                .where(config.orm_class.document_id == document_id)
                .order_by(config.orm_class.row_index)
            )
        )

        results[family] = [_row_to_result(config, row) for row in rows]

    return results


def structured_table_response_kwargs(
    results: dict[str, list[BaseModel]],
) -> dict[str, list[BaseModel]]:
    """Map internal family keys to StructuredTablesResponse field names."""

    return {
        config.response_key: results[family]
        for family, config in _FAMILY_CONFIG.items()
    }
