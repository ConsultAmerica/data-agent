from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.document import Document
from app.models.document_page import DocumentPage
from app.models.document_signature import DocumentSignature
from app.schemas.contract_signatures import SignatureResult
from app.schemas.universal_extraction import SourceEvidence
from app.services.ai_context import build_page_context
from app.services.ai_provider import AIProvider, AIProviderError
from app.services.source_validator import validate_source_value


async def extract_contract_signatures(
    *,
    database: Session,
    document: Document,
    pages: list[DocumentPage],
    ai_provider: AIProvider,
) -> tuple[list[SignatureResult], list[str]]:
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
        ai_result = await ai_provider.extract_signatures(
            page_context=context,
        )
    except AIProviderError as exc:
        return [], [f"Signature extraction unavailable: {exc}"]

    page_lookup = {page.page_number: page for page in pages}

    results: list[SignatureResult] = []

    for raw_signature in ai_result.get("signatures", []):
        party_name = str(raw_signature.get("party_name", "")).strip()

        if not party_name:
            continue

        page_number = raw_signature.get("page_number")
        page = page_lookup.get(page_number)

        if page is None:
            continue

        source_text = str(raw_signature.get("source_text", ""))

        if not validate_source_value(
            strict=True,  # AI-produced value: the quote alone is not evidence
            value=source_text,
            source_text=source_text,
            page_text=page.final_text or "",
        ):
            warnings.append(
                f"Signature for {party_name} failed source "
                "validation and was dropped."
            )
            continue

        results.append(
            SignatureResult(
                party_name=party_name,
                signatory_name=str(
                    raw_signature.get("signatory_name", "")
                ),
                signatory_title=str(
                    raw_signature.get("signatory_title", "")
                ),
                signed=bool(raw_signature.get("signed", False)),
                signature_date=raw_signature.get(
                    "signature_date"
                ),
                confidence=float(
                    raw_signature.get("confidence", 0.7)
                ),
                evidence=SourceEvidence(
                    page_number=page_number,
                    source_text=source_text[:800],
                    source_reference=(
                        f"{document.original_filename}, "
                        f"page {page_number}"
                    ),
                ),
            )
        )

    database.execute(
        delete(DocumentSignature).where(
            DocumentSignature.document_id == document.id
        )
    )

    for signature in results:
        database.add(
            DocumentSignature(
                document_id=document.id,
                party_name=signature.party_name,
                signatory_name=signature.signatory_name,
                signatory_title=signature.signatory_title,
                signed=signature.signed,
                signature_date=signature.signature_date,
                confidence=signature.confidence,
                evidence_json=signature.evidence.model_dump(),
            )
        )

    database.commit()

    return results, warnings


def signature_to_result(
    signature: DocumentSignature,
) -> SignatureResult:
    return SignatureResult(
        party_name=signature.party_name,
        signatory_name=signature.signatory_name,
        signatory_title=signature.signatory_title,
        signed=signature.signed,
        signature_date=signature.signature_date,
        confidence=signature.confidence,
        evidence=SourceEvidence(**signature.evidence_json),
    )


def get_document_signatures(
    database: Session, document_id: str
) -> list[DocumentSignature]:
    return list(
        database.scalars(
            select(DocumentSignature).where(
                DocumentSignature.document_id == document_id
            )
        )
    )
