from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.document import Document
from app.schemas.universal_extraction import (
    ExtractedValue,
    SourceEvidence,
    UniversalExtractionResponse,
)
from app.services.ai_context import (
    build_page_context,
)
from app.services.ai_provider import (
    AIProvider,
    AIProviderError,
)
from app.services.deterministic_extractor import (
    extract_from_page,
)
from app.services.request_interpreter import (
    interpret_request,
)
from app.services.requested_table_extractor import (
    extract_requested_tables,
)
from app.services.source_validator import (
    validate_source_value,
)
from app.services.universal_retrieval import (
    retrieve_pages,
)


async def universal_extract(
    *,
    database: Session,
    document: Document,
    instruction: str,
    max_pages: int,
    use_ai_fallback: bool,
    ai_provider: AIProvider,
) -> UniversalExtractionResponse:

    intent = interpret_request(
        instruction
    )

    pages = retrieve_pages(
        database=database,
        document_id=document.id,
        intent=intent,
        maximum_pages=max_pages,
    )

    if not pages:

        return UniversalExtractionResponse(
            document_id=document.id,
            instruction=instruction,
            intent=intent.mode,
            answer=None,
            values=[],
            tables=[],
            pages_used=[],
            unresolved_requests=(
                intent.requested_concepts
            ),
            warnings=[
                (
                    "No relevant document "
                    "pages were found."
                )
            ],
        )

    values = []

    resolved: set[str] = set()

    for page in pages:

        page_values, page_resolved = (
            extract_from_page(
                page=page,
                document_name=(
                    document.original_filename
                ),
                requested_concepts=(
                    intent.requested_concepts
                ),
            )
        )

        values.extend(
            page_values
        )

        resolved.update(
            page_resolved
        )

    tables = []

    if intent.wants_tables:

        tables = extract_requested_tables(
            pages=pages,
            document_name=(
                document.original_filename
            ),
            concepts=(
                intent.requested_concepts
            ),
        )

    unresolved = [
        concept
        for concept
        in intent.requested_concepts
        if concept not in resolved
    ]

    answer = None

    warnings = []

    page_lookup = {
        page.page_number: page
        for page in pages
    }

    needs_ai = (
        use_ai_fallback
        and (
            unresolved
            or intent.mode
            in {
                "question",
                "summary",
            }
        )
    )

    if needs_ai:

        settings = get_settings()

        # Only retrieved pages are sent — never the full PDF.
        context = build_page_context(
            pages,
            maximum_characters=(
                settings.ai_max_context_chars
            ),
        )

        try:
            ai_result = await ai_provider.extract(
                instruction=instruction,
                page_context=context,
            )
        except AIProviderError:
            # Optional enrichment: keep the deterministic answer.
            ai_result = {
                "answer": None,
                "values": [],
                "warnings": ["AI enhancement skipped — deterministic results shown."],
            }

        answer = ai_result.get(
            "answer"
        )

        warnings.extend(
            ai_result.get(
                "warnings",
                [],
            )
        )

        for concept in ai_result.get(
            "unresolved",
            [],
        ):
            if concept not in unresolved:
                unresolved.append(concept)

        for ai_value in ai_result.get(
            "values",
            [],
        ):

            page_number = ai_value.get(
                "page_number"
            )

            source_text = ai_value.get(
                "source_text",
                "",
            )

            page = page_lookup.get(
                page_number
            )

            if page is None:
                warnings.append(
                    (
                        f"AI returned invalid "
                        f"page {page_number}."
                    )
                )

                continue

            verified = validate_source_value(
                strict=True,  # AI-produced value: the quote alone is not evidence
                value=ai_value.get(
                    "value"
                ),
                source_text=source_text,
                page_text=(
                    page.final_text
                    or ""
                ),
            )

            if not verified:

                warnings.append(
                    (
                        "AI result failed "
                        "source validation: "
                        f"{ai_value.get('label')}"
                    )
                )

                continue

            raw_value_type = str(
                ai_value.get(
                    "value_type",
                    "text",
                )
            )

            allowed_types = {
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

            value_type = (
                raw_value_type
                if raw_value_type in allowed_types
                else "text"
            )

            values.append(
                ExtractedValue(
                    label=ai_value.get(
                        "label",
                        "Extracted value",
                    ),

                    value=ai_value.get(
                        "value"
                    ),

                    value_type=value_type,

                    confidence=float(
                        ai_value.get(
                            "confidence",
                            0.8,
                        )
                    ),

                    extraction_method="ai",

                    evidence=SourceEvidence(
                        page_number=(
                            page_number
                        ),

                        source_text=(
                            source_text
                        ),

                        source_reference=(
                            f"{document.original_filename}, "
                            f"page {page_number}"
                        ),
                    ),

                    verified=True,
                )
            )

            label = str(
                ai_value.get("label", "")
            ).lower()

            for concept in list(unresolved):
                if concept.lower() in label or label in concept.lower():
                    unresolved.remove(concept)

    # Verify deterministic values.
    for value in values:

        if value.extraction_method == "ai":
            continue

        page = page_lookup.get(
            value.evidence.page_number
        )

        if page is None:
            continue

        value.verified = (
            validate_source_value(
                value=value.value,
                source_text=(
                    value.evidence
                    .source_text
                ),
                page_text=(
                    page.final_text
                    or ""
                ),
            )
        )

    return UniversalExtractionResponse(
        document_id=document.id,
        instruction=instruction,
        intent=intent.mode,
        answer=answer,
        values=values,
        tables=tables,
        pages_used=[
            page.page_number
            for page in pages
        ],
        unresolved_requests=(
            unresolved
        ),
        warnings=warnings,
    )
