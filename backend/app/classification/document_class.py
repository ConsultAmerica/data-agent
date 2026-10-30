"""The eight document classes the workspace is organized by — Contract,
Invoice, Purchase Order, Bank Statement, Financial Statement, Passport /
Identity Document, Academic Document, General Document — read from the
classified document family. The finer families and categories
(staging/document_categories.py) stay as they are; this is the coarse
level a person picks from and the skills (app/skills) are keyed by."""

from __future__ import annotations

GENERAL = "general"

# (class id, label, families), in display order.
DOCUMENT_CLASSES: tuple[tuple[str, str, frozenset[str]], ...] = (
    ("contract", "Contract", frozenset({
        "government_contract", "contract", "master_services_agreement", "supplier_agreement", "sow", "amendment",
    })),
    ("invoice", "Invoice", frozenset({"invoice", "credit_note"})),
    ("purchase_order", "Purchase Order", frozenset({"purchase_order"})),
    ("bank_statement", "Bank Statement", frozenset({"bank_statement", "statement"})),
    ("financial_statement", "Financial Statement", frozenset({"financial_statement", "financial_report"})),
    ("identity", "Passport / Identity Document", frozenset({"passport", "driving_licence", "identity_card"})),
    ("academic", "Academic Document", frozenset({"academic_transcript"})),
    (GENERAL, "General Document", frozenset()),
)

DOCUMENT_CLASS_LABELS: dict[str, str] = {key: label for key, label, _ in DOCUMENT_CLASSES}
_BY_FAMILY: dict[str, str] = {family: key for key, _, families in DOCUMENT_CLASSES for family in families}


def document_class_for_family(family: str | None) -> str:
    """Any family not named above (correspondence, résumé, a custom type)
    is a General Document: its data is still shown, under its own labels."""

    return _BY_FAMILY.get(family or "", GENERAL)
