from app.schemas.universal_extraction import ExtractedValue, SourceEvidence
from app.services.source_validator import validate_source_value

ALLOWED_VALUE_TYPES = {
    "text",
    "number",
    "money",
    "date",
    "email",
    "phone",
    "address",
    "identifier",
    "boolean",
    "list",
    "object",
}


def map_ai_value(
    *,
    ai_value: dict,
    page_lookup: dict[int, object],
    document_name: str,
) -> tuple[ExtractedValue | None, str | None]:
    """Maps one raw AI-provider value dict into an `ExtractedValue`,
    validating it against its claimed source page. Returns
    (value, None) on success or (None, warning) on failure — mirrors the
    per-value mapping in universal_extraction_service.universal_extract.
    """

    page_number = ai_value.get("page_number")
    source_text = ai_value.get("source_text", "")

    page = page_lookup.get(page_number)

    if page is None:
        return None, f"AI returned invalid page {page_number}."

    verified = validate_source_value(
        strict=True,  # AI-produced value: the quote alone is not evidence
        value=ai_value.get("value"),
        source_text=source_text,
        page_text=getattr(page, "final_text", "") or "",
    )

    if not verified:
        label = ai_value.get("label")
        return None, f"AI result failed source validation: {label}"

    raw_value_type = str(ai_value.get("value_type", "text"))
    value_type = (
        raw_value_type if raw_value_type in ALLOWED_VALUE_TYPES else "text"
    )

    value = ExtractedValue(
        label=ai_value.get("label", "Extracted value"),
        value=ai_value.get("value"),
        value_type=value_type,
        confidence=float(ai_value.get("confidence", 0.8)),
        extraction_method="ai",
        evidence=SourceEvidence(
            page_number=page_number,
            source_text=source_text,
            source_reference=f"{document_name}, page {page_number}",
        ),
        verified=True,
    )

    return value, None
