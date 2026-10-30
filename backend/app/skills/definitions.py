"""Document skills: what a kind of document is expected to contain and how
its data is checked and reviewed — its canonical business sections, fields
(with the printed labels they go by), tables, validation rules, review
requirements and the export mappings it feeds.

A skill describes; it never invents a value. Fields are filled only from
what the document prints or extraction read, with the source page and
evidence. Any change to a definition must bump its version (a test pins
each version's content hash).
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
import hashlib
import json
from typing import Any, Literal

ValueType = Literal["text", "date", "currency", "number", "identifier", "percentage"]


@dataclass(frozen=True)
class FieldSpec:
    key: str
    label: str
    # Printed labels this field goes by, lower case ("cage", "cage code").
    aliases: tuple[str, ...]
    type: ValueType = "text"
    required: bool = False
    # A regular expression the value must match (identifiers).
    pattern: str | None = None
    # A date's meaning, for date intelligence (issue, award, effective,
    # start, end, expiration, renewal, due).
    date_role: str | None = None


@dataclass(frozen=True)
class TableSpec:
    key: str
    label: str
    # Column captions the printed table goes by; it matches when enough of
    # them appear in its header.
    columns: tuple[str, ...]
    min_matches: int = 2


@dataclass(frozen=True)
class SectionSpec:
    key: str
    label: str
    fields: tuple[FieldSpec, ...] = ()
    tables: tuple[TableSpec, ...] = ()


@dataclass(frozen=True)
class Skill:
    skill_id: str
    version: str
    name: str
    document_class: str
    families: tuple[str, ...]
    subtypes: tuple[str, ...]
    sections: tuple[SectionSpec, ...]
    # Cross-field checks: see app/skills/validation.py for the rule kinds.
    rules: tuple[dict[str, Any], ...] = ()
    # Which values a person must review regardless of confidence.
    review: dict[str, Any] = field(default_factory=dict)
    # Where the data is exported: the staging profile whose exports and
    # configured Oracle import templates apply. No Oracle column names are
    # defined here — they come from the configured templates only.
    export: dict[str, Any] = field(default_factory=dict)
    # How values are found: the staging profile, and the targets a person
    # can ask for by name.
    extraction: dict[str, Any] = field(default_factory=dict)

    def fields(self) -> list[tuple[SectionSpec, FieldSpec]]:
        return [(section, spec) for section in self.sections for spec in section.fields]

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)

    def content_hash(self) -> str:
        return hashlib.sha256(json.dumps(self.as_dict(), sort_keys=True, default=list).encode()).hexdigest()[:16]


def F(key: str, label: str, *aliases: str, type: ValueType = "text", required: bool = False,
      pattern: str | None = None, date_role: str | None = None) -> FieldSpec:
    return FieldSpec(key, label, tuple(a.lower() for a in (label, *aliases)), type, required, pattern, date_role)


_REVIEW_DEFAULT = {"min_confidence": 0.8, "evidence_required": True, "always_review_required_fields": True}

CONTRACT = Skill(
    skill_id="contract_recognition",
    version="1.0",
    name="Contract Recognition",
    document_class="contract",
    families=("government_contract", "contract", "master_services_agreement", "supplier_agreement", "sow", "amendment"),
    subtypes=("SF 1442 Contract Award", "Contract Modification (SF 30)", "SF 33 Solicitation / Award", "OASIS+ IDIQ",
              "SF 26 Award / Contract", "DoD / UCF Contract", "Contract Brief"),
    sections=(
        SectionSpec("contractor_information", "Contractor Information", fields=(
            F("contractor_name", "Contractor Name", "legal entity", "contractor", "name of offeror", "offeror",
              "vendor name", "name and address of offeror", required=True),
            F("cage_code", "CAGE Code", "cage", type="identifier", pattern=r"^[A-Z0-9]{5}$"),
            F("uei", "UEI", "unique entity id", "unique entity identifier", "sam uei", type="identifier",
              pattern=r"^[A-Z0-9]{12}$"),
            F("business_size", "Business Size", "size status", "business type"),
            F("contractor_address", "Contractor Address", "address of offeror"),
        )),
        SectionSpec("contract_information", "Contract Information", fields=(
            F("contract_number", "Contract Number", "contract no", "contract no.", "award number", "contract id",
              "piid", "enter the contract number", "prime contract no", type="identifier", required=True),
            F("contract_name", "Contract Name", "contract title", "project title"),
            F("solicitation_number", "Solicitation Number", "solicitation no", "enter the solicitation number",
              type="identifier"),
            F("contract_type", "Contract Type", "type of contract"),
            F("oracle_project_number", "Oracle Project Number", "project number", type="identifier"),
            F("security_classification", "Security Classification Level", "security classification"),
            F("dpas_rating", "DPAS Rating"),
            F("issuing_office", "Issuing Office", "issued by", "acquisition agency", "agency"),
            F("company_role", "Company Role", "role"),
        )),
        SectionSpec("contract_values", "Contract Values", fields=(
            F("exercised_value", "Contract Exercised Value", "exercised value", type="currency"),
            F("potential_value", "Contract Potential Value", "potential value", "total contract value",
              "ceiling value", type="currency"),
            F("total_award_amount", "Total Award Amount", "total amount of award", "award amount", type="currency"),
            F("funded_amount", "Funded Amount", "total funding", "funding", type="currency"),
        )),
        SectionSpec("contract_dates", "Contract Dates", fields=(
            F("award_date", "Award Date", "date of award", "date signed", "award effective date", type="date",
              date_role="award"),
            F("issue_date", "Issue Date", "date issued", type="date", date_role="issue"),
            F("effective_date", "Effective Date", type="date", date_role="effective"),
            F("expiration_date", "Expiration Date", "contract expiration date", "completion date", type="date",
              date_role="expiration"),
            F("briefed_through", "Briefed Through"),
        )),
        SectionSpec("period_of_performance", "Period of Performance", fields=(
            F("period_of_performance", "Period of Performance", "pop"),
            F("pop_start", "Period of Performance Start", "pop start", "performance start date", type="date",
              date_role="start"),
            F("pop_end", "Period of Performance End", "pop end", "performance end date", type="date", date_role="end"),
        )),
        SectionSpec("contacts", "Contacts", fields=(
            F("contracting_officer", "Contracting Officer", "point of contact", "administrative contracting officer"),
            F("contact_email", "Email", "e-mail"),
            F("contact_phone", "Phone", "telephone", "telephone number"),
        )),
        SectionSpec("contract_lines", "Contract Lines", tables=(
            TableSpec("contract_lines", "Contract Lines",
                      ("item", "item no", "clin", "supplies/services", "supplies/service", "quantity", "qty", "unit",
                       "unit price", "amount")),
        )),
        SectionSpec("clauses", "Clauses", tables=(
            TableSpec("clauses", "Clauses", ("clause", "clause number", "number", "title", "date", "clause title")),
        )),
        SectionSpec("deliveries", "Deliveries", tables=(
            TableSpec("deliveries", "Deliveries",
                      ("deliverable", "delivery date", "place of delivery", "ship to", "date", "quantity")),
        )),
        SectionSpec("modifications", "Modifications", tables=(
            TableSpec("modifications", "Modifications",
                      ("mod number", "modification number", "mod description", "effective date", "funding change")),
        )),
    ),
    rules=(
        {"rule": "date_order", "first": "pop_start", "then": "pop_end",
         "message": "The period of performance ends before it starts"},
        {"rule": "date_order", "first": "award_date", "then": "expiration_date",
         "message": "The contract expires before it was awarded"},
        {"rule": "not_greater", "value": "exercised_value", "limit": "potential_value",
         "message": "The exercised value is larger than the potential value"},
    ),
    review=_REVIEW_DEFAULT,
    export={"staging_profile": "contract_v3", "oracle_templates": "configured for the staging profile"},
    extraction={"staging_profile": "contract_v3", "targets": ("contract_number", "contractor_name", "expiration_date",
                                                               "far_clauses")},
)

INVOICE = Skill(
    skill_id="invoice_recognition",
    version="1.0",
    name="Invoice Recognition",
    document_class="invoice",
    families=("invoice", "credit_note"),
    subtypes=("Standard Invoice", "PO-Referenced Invoice"),
    sections=(
        SectionSpec("invoice_summary", "Invoice Summary", fields=(
            F("invoice_number", "Invoice Number", "invoice no", "invoice #", "invoice id", type="identifier",
              required=True),
            F("invoice_date", "Invoice Date", "date of invoice", "date", type="date", required=True, date_role="issue"),
            F("due_date", "Due Date", "payment due", "payment due date", type="date", date_role="due"),
            F("currency", "Currency"),
        )),
        SectionSpec("supplier", "Supplier", fields=(
            F("supplier_name", "Supplier Name", "supplier", "vendor", "vendor name", "remit to", "from", required=True),
            F("supplier_tax_id", "Supplier Tax Identifier", "tax id", "vat number", "vat no", "ein",
              "tax identification number", "gst number", type="identifier"),
            F("supplier_address", "Supplier Address", "vendor address"),
        )),
        SectionSpec("customer", "Customer", fields=(
            F("customer_name", "Customer Name", "bill to", "sold to", "customer", "billed to"),
            F("customer_address", "Customer Address", "billing address", "ship to"),
        )),
        SectionSpec("po_reference", "Purchase Order Reference", fields=(
            F("po_number", "Purchase Order Number", "po number", "po no", "purchase order", "po #", type="identifier"),
        )),
        SectionSpec("invoice_lines", "Invoice Lines", tables=(
            TableSpec("invoice_lines", "Invoice Lines",
                      ("description", "item", "quantity", "qty", "unit price", "rate", "amount", "line total")),
        )),
        SectionSpec("taxes", "Taxes", fields=(
            F("tax_amount", "Tax Amount", "tax", "sales tax", "vat", "gst", type="currency"),
            F("tax_rate", "Tax Rate", type="percentage"),
        )),
        SectionSpec("totals", "Totals", fields=(
            F("subtotal", "Subtotal", "sub total", "net amount", type="currency"),
            F("total_amount", "Invoice Total", "total", "amount due", "total due", "balance due", "invoice total",
              "grand total", type="currency", required=True),
        )),
        SectionSpec("payment_terms", "Payment Terms", fields=(
            F("payment_terms", "Payment Terms", "terms"),
        )),
    ),
    rules=(
        {"rule": "sum_equals", "parts": ("subtotal", "tax_amount"), "total": "total_amount",
         "message": "Subtotal plus tax doesn't equal the invoice total"},
        {"rule": "date_order", "first": "invoice_date", "then": "due_date",
         "message": "The invoice is due before it was issued"},
    ),
    review=_REVIEW_DEFAULT,
    export={"staging_profile": "invoice", "oracle_templates": "configured for the staging profile"},
    extraction={"staging_profile": "invoice", "targets": ("invoice_number", "total_amount", "supplier_tax_id")},
)

PURCHASE_ORDER = Skill(
    skill_id="purchase_order_recognition",
    version="1.0",
    name="Purchase Order Recognition",
    document_class="purchase_order",
    families=("purchase_order",),
    subtypes=("Purchase Order", "Purchase Order Amendment"),
    sections=(
        SectionSpec("po_summary", "Purchase Order Summary", fields=(
            F("po_number", "Purchase Order Number", "po number", "po no", "purchase order", "order number",
              type="identifier", required=True),
            F("po_date", "Order Date", "po date", "date", type="date", required=True, date_role="issue"),
            F("delivery_date", "Delivery Date", "required by", "deliver by", type="date", date_role="due"),
        )),
        SectionSpec("supplier", "Supplier", fields=(
            F("supplier_name", "Supplier Name", "supplier", "vendor", "to", required=True),
            F("supplier_address", "Supplier Address", "vendor address"),
        )),
        SectionSpec("buyer", "Buyer", fields=(
            F("buyer_name", "Buyer", "bill to", "buyer name", "purchaser"),
            F("ship_to", "Ship To", "deliver to", "shipping address"),
        )),
        SectionSpec("order_lines", "Order Lines", tables=(
            TableSpec("order_lines", "Order Lines", ("item", "description", "quantity", "qty", "unit price", "amount")),
        )),
        SectionSpec("totals", "Totals", fields=(
            F("subtotal", "Subtotal", type="currency"),
            F("tax_amount", "Tax Amount", "tax", type="currency"),
            F("total_amount", "Order Total", "total", "grand total", type="currency", required=True),
        )),
        SectionSpec("terms", "Terms", fields=(
            F("payment_terms", "Payment Terms", "terms"),
            F("shipping_terms", "Shipping Terms", "incoterms", "ship via"),
        )),
    ),
    rules=(
        {"rule": "sum_equals", "parts": ("subtotal", "tax_amount"), "total": "total_amount",
         "message": "Subtotal plus tax doesn't equal the order total"},
        {"rule": "date_order", "first": "po_date", "then": "delivery_date",
         "message": "Delivery is due before the order date"},
    ),
    review=_REVIEW_DEFAULT,
    export={"staging_profile": None, "oracle_templates": "configured for the staging profile"},
    extraction={"staging_profile": None, "targets": ("po_number", "total_amount")},
)

BANK_STATEMENT = Skill(
    skill_id="bank_statement_recognition",
    version="1.0",
    name="Bank Statement Recognition",
    document_class="bank_statement",
    families=("bank_statement", "statement"),
    subtypes=("Checking Account Statement", "Savings Account Statement", "Credit Card Statement"),
    sections=(
        SectionSpec("account", "Account", fields=(
            F("bank_name", "Bank Name", "bank"),
            F("account_holder", "Account Holder", "account name", "customer name"),
            F("account_number", "Account Number", "account no", "account #", type="identifier", required=True),
            F("statement_period", "Statement Period", "period"),
            F("period_start", "Period Start", "from", "opening date", type="date", date_role="start"),
            F("period_end", "Period End", "to", "closing date", "statement date", type="date", date_role="end"),
        )),
        SectionSpec("balances", "Balances", fields=(
            F("opening_balance", "Opening Balance", "beginning balance", "previous balance", type="currency"),
            F("total_credits", "Total Deposits", "deposits and other credits", "total credits", type="currency"),
            F("total_debits", "Total Withdrawals", "withdrawals and other debits", "total debits", type="currency"),
            F("closing_balance", "Closing Balance", "ending balance", "new balance", type="currency", required=True),
        )),
        SectionSpec("transactions", "Transactions", tables=(
            TableSpec("transactions", "Transactions",
                      ("date", "description", "amount", "balance", "debit", "credit", "withdrawals", "deposits")),
        )),
    ),
    rules=(
        {"rule": "balance", "opening": "opening_balance", "credits": "total_credits", "debits": "total_debits",
         "closing": "closing_balance", "message": "Opening balance plus credits minus debits doesn't equal the closing balance"},
        {"rule": "date_order", "first": "period_start", "then": "period_end",
         "message": "The statement period ends before it starts"},
    ),
    review=_REVIEW_DEFAULT,
    export={"staging_profile": None, "oracle_templates": "configured for the staging profile"},
    extraction={"staging_profile": None, "targets": ("account_number", "closing_balance")},
)

PASSPORT = Skill(
    skill_id="passport_recognition",
    version="1.0",
    name="Passport Recognition",
    document_class="identity",
    families=("passport", "identity_card", "driving_licence"),
    subtypes=("Passport Book", "Passport Card", "National Identity Card", "Residence Permit"),
    sections=(
        SectionSpec("holder", "Holder", fields=(
            F("surname", "Surname", "last name", "family name", required=True),
            F("given_names", "Given Names", "given name", "first name", "first names", required=True),
            F("nationality", "Nationality"),
            F("date_of_birth", "Date of Birth", "birth date", "dob", type="date"),
            F("sex", "Sex", "gender"),
            F("place_of_birth", "Place of Birth"),
        )),
        SectionSpec("document", "Document", fields=(
            F("document_number", "Passport Number", "passport no", "passport number", "document number",
              "document no", type="identifier", required=True),
            F("issuing_country", "Issuing Country", "country code", "issuing state", "country"),
            F("date_of_issue", "Date of Issue", "issue date", "date issued", type="date", date_role="issue"),
            F("date_of_expiry", "Date of Expiry", "expiry date", "expiration date", "valid until", type="date",
              required=True, date_role="expiration"),
            F("authority", "Authority", "issuing authority"),
        )),
    ),
    rules=(
        {"rule": "date_order", "first": "date_of_issue", "then": "date_of_expiry",
         "message": "The document expires before it was issued"},
        {"rule": "date_order", "first": "date_of_birth", "then": "date_of_issue",
         "message": "The document was issued before the holder's date of birth"},
    ),
    review={**_REVIEW_DEFAULT, "always_review": ("document_number", "date_of_expiry")},
    export={"staging_profile": "passport", "oracle_templates": "configured for the staging profile"},
    extraction={"staging_profile": "passport", "targets": ("document_number", "date_of_expiry")},
)

SKILLS: tuple[Skill, ...] = (CONTRACT, INVOICE, PURCHASE_ORDER, BANK_STATEMENT, PASSPORT)
