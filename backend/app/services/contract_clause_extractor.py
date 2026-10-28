from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.document import Document
from app.models.document_clause import DocumentClause
from app.models.document_page import DocumentPage
from app.schemas.contract_clauses import ClauseResult
from app.schemas.universal_extraction import SourceEvidence
from app.services.ai_context import build_page_context
from app.services.ai_provider import AIProvider, AIProviderError
from app.services.contract_clause_schema import CLAUSE_TYPES
from app.services.source_validator import validate_source_value


async def extract_contract_clauses(
    *,
    database: Session,
    document: Document,
    pages: list[DocumentPage],
    ai_provider: AIProvider,
) -> tuple[list[ClauseResult], list[str]]:
    warnings: list[str] = []

    if not pages:
        return [], [
            "No extracted pages were found for this document."
        ]

    settings = get_settings()

    context = build_page_context(
        pages,
        maximum_characters=settings.ai_max_context_chars,
    )

    try:
        ai_result = await ai_provider.extract_clauses(
            page_context=context,
        )
    except AIProviderError as exc:
        return [], [f"Clause extraction unavailable: {exc}"]

    page_lookup = {page.page_number: page for page in pages}

    clause_type_lookup = {
        clause_type.lower(): clause_type
        for clause_type in CLAUSE_TYPES
    }

    results: list[ClauseResult] = []

    for raw_clause in ai_result.get("clauses", []):
        clause_type = clause_type_lookup.get(
            str(raw_clause.get("clause_type", "")).lower()
        )

        if clause_type is None:
            continue

        page_number = raw_clause.get("page_number")
        page = page_lookup.get(page_number)

        if page is None:
            continue

        extracted_text = str(raw_clause.get("extracted_text", ""))

        if not validate_source_value(
            strict=True,  # AI-produced value: the quote alone is not evidence
            value=extracted_text,
            source_text=extracted_text,
            page_text=page.final_text or "",
        ):
            warnings.append(
                f"{clause_type} clause failed source validation "
                "and was dropped."
            )
            continue

        results.append(
            ClauseResult(
                clause_type=clause_type,
                classification=str(
                    raw_clause.get("classification", clause_type)
                ),
                extracted_text=extracted_text,
                value_summary=str(
                    raw_clause.get("value_summary", "")
                ),
                confidence=float(
                    raw_clause.get("confidence", 0.7)
                ),
                evidence=SourceEvidence(
                    page_number=page_number,
                    source_text=extracted_text[:800],
                    source_reference=(
                        f"{document.original_filename}, "
                        f"page {page_number}"
                    ),
                ),
            )
        )

    database.execute(
        delete(DocumentClause).where(
            DocumentClause.document_id == document.id
        )
    )

    for clause in results:
        database.add(
            DocumentClause(
                document_id=document.id,
                clause_type=clause.clause_type,
                classification=clause.classification,
                extracted_text=clause.extracted_text,
                value_summary=clause.value_summary,
                confidence=clause.confidence,
                evidence_json=clause.evidence.model_dump(),
            )
        )

    database.commit()

    return results, warnings


def clause_to_result(clause: DocumentClause) -> ClauseResult:
    return ClauseResult(
        clause_type=clause.clause_type,
        classification=clause.classification,
        extracted_text=clause.extracted_text,
        value_summary=clause.value_summary,
        confidence=clause.confidence,
        evidence=SourceEvidence(**clause.evidence_json),
    )


def get_document_clauses(
    database: Session, document_id: str
) -> list[DocumentClause]:
    return list(
        database.scalars(
            select(DocumentClause).where(
                DocumentClause.document_id == document_id
            )
        )
    )
