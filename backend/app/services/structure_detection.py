import re
from dataclasses import dataclass

from app.models.document import Document
from app.models.document_page import DocumentPage
from app.schemas.structure_detection import (
    ContentStats,
    DetectedField,
    DetectedTable,
    DetectedTarget,
    DetectionCounts,
    ExtractionType,
    StructureDetectionResponse,
)
from app.services.ai_provider import AIProvider, AIProviderError
from app.services.contract_classifier import classify_contract
from app.services.generic_entity_extractor import (
    extract_generic_entities,
)
from app.services.generic_kv_scanner import (
    ScannedPair,
    is_internal_form_name,
    is_plausible_kv_label,
    scan_page_for_labeled_pairs,
)
from app.services.generic_label_extractor import (
    extract_labeled_value,
)
from app.services.field_classification import _looks_like_section_heading
from app.services.label_rejection import (
    looks_like_clause_citation_value,
    looks_like_narrative_fragment,
    looks_like_toc_entry,
)
from app.services.table_quality import assess_table_candidate

DETECTION_PAGE_LIMIT = 40

PRIMARY_CONFIDENCE_MIN = 0.75
HIGH_CONFIDENCE_MIN = 0.90

FAMILY_SCORE_MARGIN = 1
FAMILY_MIN_SCORE = 2
TABLE_MATCH_MIN_SCORE = 2

# Preferred sort order only — never injects missing targets into the schema.
FAMILY_DEFAULT_KEYS: dict[str, list[str]] = {
    "financial_report": [
        "operating_expenses",
        "revenue_analysis",
        "financial_summary",
        "accounts_payable",
    ],
    "budget": [
        "operating_expenses",
        "budget_vs_actual",
        "financial_summary",
    ],
    "government_contract": ["clins", "supplies_services", "wawf_routing_data"],
    # The fields a reviewer checks first on each document type.
    "pay_stub": [
        "kv_employee", "kv_employee_name", "kv_pay_period", "kv_pay_date",
        "kv_gross_pay", "kv_net_pay", "kv_total_deductions",
    ],
    "receipt": [
        "kv_receipt_no", "kv_receipt_number", "kv_date", "kv_total",
        "kv_subtotal", "kv_tax", "kv_payment_method",
    ],
    "bank_check": [
        "kv_pay_to_the_order_of", "kv_date", "kv_amount", "kv_check_no",
        "kv_check_number", "kv_memo",
    ],
    "passport": [
        "kv_surname", "kv_given_names", "kv_passport_no", "kv_nationality",
        "kv_date_of_birth", "kv_date_of_expiry",
    ],
    "statement": [
        "kv_account_number", "kv_statement_period", "kv_beginning_balance",
        "kv_ending_balance", "kv_total_deposits", "kv_total_withdrawals",
    ],
    "utility_bill": [
        "kv_account_number", "kv_service_address", "kv_billing_period",
        "kv_amount_due", "kv_due_date",
    ],
    "tax_form": [
        "kv_employer_identification_number", "kv_wages_tips_other_compensation",
        "kv_federal_income_tax_withheld",
    ],
    "rate_card": ["rate_card", "labor_categories", "hourly_rates"],
}


@dataclass(frozen=True)
class HeadingFamily:
    key: str
    label: str
    pattern: re.Pattern[str]
    extraction_type: ExtractionType
    suggested_prompt: str


HEADING_FAMILIES: list[HeadingFamily] = [
    HeadingFamily(
        "financial_summary",
        "Financial Summary",
        re.compile(r"financial\s+summary", re.I),
        "table",
        "Extract the financial summary table.",
    ),
    HeadingFamily(
        "revenue_analysis",
        "Revenue Analysis",
        re.compile(r"revenue\s+analysis", re.I),
        "table",
        "Extract the revenue analysis table with budget, actual, and variance.",
    ),
    HeadingFamily(
        "operating_expenses",
        "Operating Expenses",
        re.compile(r"operating\s+expenses?", re.I),
        "table",
        "Extract operating expenses with budget, actual, variance, and variance percentage.",
    ),
    HeadingFamily(
        "accounts_payable",
        "Accounts Payable Summary",
        re.compile(r"accounts\s+payable", re.I),
        "table",
        "Extract vendor invoice counts and open balances.",
    ),
    HeadingFamily(
        "budget_vs_actual",
        "Budget vs Actual",
        re.compile(r"budget\s+vs\.?\s+actual", re.I),
        "table",
        "Extract the budget vs actual table with variance columns.",
    ),
    HeadingFamily(
        "vendor_balances",
        "Vendor Balances",
        re.compile(r"vendor\s+balances?", re.I),
        "table",
        "Extract vendor balances and open amounts.",
    ),
    HeadingFamily(
        "rate_card",
        "Rate Card",
        re.compile(r"rate\s+card", re.I),
        "table",
        "Extract the rate card with labor categories and hourly rates.",
    ),
    HeadingFamily(
        "labor_categories",
        "Labor Categories",
        re.compile(r"labor\s+categor", re.I),
        "table",
        "Extract labor categories and associated rates.",
    ),
    HeadingFamily(
        "hourly_rates",
        "Hourly Rates",
        re.compile(r"hourly\s+rates?", re.I),
        "table",
        "Extract hourly rates by labor category.",
    ),
    HeadingFamily(
        "clins",
        "CLINs",
        re.compile(r"\bclins?\b|contract\s+line\s+item", re.I),
        "table",
        "Extract all CLINs with quantities, unit prices, total prices, and descriptions.",
    ),
    HeadingFamily(
        "pricing_table",
        "Pricing Table",
        # "unit price" alone is too generic — it also appears in ordinary
        # supplies/services and line-item tables. Only match the literal
        # heading phrase.
        re.compile(r"pricing\s+table", re.I),
        "table",
        "Extract the full pricing table with all line items and amounts.",
    ),
    HeadingFamily(
        "payment_schedule",
        "Payment Schedule",
        re.compile(r"payment\s+schedule", re.I),
        "table",
        "Extract the payment schedule with due dates and amounts.",
    ),
    HeadingFamily(
        "delivery_schedule",
        "Delivery Schedule",
        re.compile(r"delivery\s+schedule", re.I),
        "table",
        "Extract the delivery schedule with milestones and dates.",
    ),
    HeadingFamily(
        "far_clauses",
        "FAR Clauses",
        re.compile(r"\bfar\s+52\.|federal\s+acquisition\s+regulation", re.I),
        "clause",
        "Extract FAR clauses cited in this document.",
    ),
    HeadingFamily(
        "dfars_clauses",
        "DFARS Clauses",
        re.compile(r"\bdfars\s+252\.", re.I),
        "clause",
        "Extract DFARS clauses cited in this document.",
    ),
    HeadingFamily(
        "payment_obligations",
        "Payment Obligations",
        re.compile(r"payment\s+obligations?", re.I),
        "obligation",
        "Extract all payment obligations and terms.",
    ),
    HeadingFamily(
        "reporting_requirements",
        "Reporting Requirements",
        re.compile(r"reporting\s+requirements?", re.I),
        "obligation",
        "Extract all reporting requirements and their frequency.",
    ),
    HeadingFamily(
        "signatures",
        "Signatures",
        re.compile(
            r"in\s+witness\s+whereof|\bsignature\s+block\b|\bsigned\s+by\b",
            re.I,
        ),
        "signature",
        "Extract signatory names, titles, and signature dates.",
    ),
    HeadingFamily(
        "supplies_services",
        "Supplies / Services",
        re.compile(r"supplies\s*(?:/|or)\s*services", re.I),
        "table",
        "Extract the supplies/services table with item numbers, quantities, "
        "units, unit prices, and amounts.",
    ),
    HeadingFamily(
        "clin_delivery_schedule",
        "CLIN Delivery Schedule",
        re.compile(
            r"clin.{0,40}delivery\s+schedule|delivery\s+schedule.{0,40}clin",
            re.I,
        ),
        "table",
        "Extract the CLIN delivery schedule with delivery dates, quantities, "
        "and ship-to addresses.",
    ),
    HeadingFamily(
        "wawf_routing_data",
        "WAWF Routing Data",
        re.compile(r"wawf\s+routing\s+data|wide\s+area\s+workflow", re.I),
        "table",
        "Extract the complete WAWF Routing Data table, preserving all "
        "detected columns and rows.",
    ),
    HeadingFamily(
        "clauses_incorporated_by_reference",
        "Clauses Incorporated by Reference",
        re.compile(r"clauses\s+incorporated\s+by\s+reference", re.I),
        "clause",
        "Extract all clauses listed under \"CLAUSES INCORPORATED BY "
        "REFERENCE\", including clause number, title, date/version, and "
        "source page where available.",
    ),
    HeadingFamily(
        "clauses_incorporated_full_text",
        "Clauses Incorporated by Full Text",
        re.compile(r"clauses\s+incorporated\s+by\s+full\s+text", re.I),
        "clause",
        "Extract all clauses listed under \"CLAUSES INCORPORATED BY FULL "
        "TEXT\", including clause number, title, and full clause text.",
    ),
]


# Headers / surrounding text only — no single-word keywords that would
# label every financial table as "Revenue" or every budget column as
# "Operating Expenses".
TABLE_FAMILIES: dict[str, tuple[str, list[str]]] = {
    "financial_summary": (
        "Financial Summary",
        ["financial summary", "total revenue", "net income",
         "summary of operations"],
    ),
    "revenue_analysis": (
        "Revenue Analysis",
        ["revenue analysis", "revenue by", "sales by"],
    ),
    "operating_expenses": (
        "Operating Expenses",
        ["operating expense", "expense category"],
    ),
    "accounts_payable": (
        "Accounts Payable Summary",
        ["accounts payable", "open balance"],
    ),
    "budget_vs_actual": (
        "Budget vs Actual",
        ["budget vs actual", "budget versus actual"],
    ),
    "vendor_balances": (
        "Vendor Balances",
        ["vendor balance", "vendor balances"],
    ),
    "rate_card": (
        "Rate Card",
        # Require the literal heading. "labor category" / "hourly rate"
        # alone are common in government CLINs and must not invent a Rate Card.
        ["rate card"],
    ),
    "labor_categories": (
        "Labor Categories",
        ["labor category", "labor categories"],
    ),
    "hourly_rates": (
        "Hourly Rates",
        ["hourly rate", "hourly rates"],
    ),
    "clins": (
        "CLINs",
        ["clin", "contract line item"],
    ),
    "pricing_table": (
        "Pricing Table",
        # Literal phrase only — "unit price"/"total price" appear on most
        # supplies/services schedules that are not Pricing Tables.
        ["pricing table"],
    ),
    "payment_schedule": (
        "Payment Schedule",
        ["payment schedule"],
    ),
    "delivery_schedule": (
        "Delivery Schedule",
        ["delivery schedule"],
    ),
    "funding_table": (
        "Funding Table",
        ["funding table", "obligated amount"],
    ),
    "line_items": (
        "Line Items",
        ["line item"],
    ),
    "supplies_services": (
        "Supplies / Services",
        ["supplies or services", "supplies/services",
         "schedule of supplies"],
    ),
    "clin_delivery_schedule": (
        "CLIN Delivery Schedule",
        ["clin", "delivery schedule", "delivery date"],
    ),
    "wawf_routing_data": (
        "WAWF Routing Data",
        # Need at least two of these for TABLE_MATCH_MIN_SCORE=2
        ["wawf", "routing", "dodaac"],
    ),
    "clauses_incorporated_by_reference": (
        "Clauses Incorporated by Reference",
        ["incorporated by reference", "clauses incorporated"],
    ),
    "clauses_incorporated_full_text": (
        "Clauses Incorporated by Full Text",
        ["incorporated by full text", "full text clauses"],
    ),
}


DOCUMENT_FAMILIES: dict[str, tuple[str, list[str]]] = {
    "financial_report": (
        "Financial Report",
        ["revenue", "operating expenses", "net income", "gross profit",
         "ebitda", "financial summary", "financial report"],
    ),
    "financial_statement": (
        "Financial Statement",
        ["balance sheet", "income statement", "statement of cash",
         "statement of operations"],
    ),
    "invoice": (
        "Invoice",
        ["invoice number", "bill to", "remit to", "amount due",
         "invoice date"],
    ),
    "budget": (
        "Budget",
        ["budget vs actual", "fiscal year budget", "budgeted amount"],
    ),
    "statement": (
        "Statement",
        ["statement of account", "account statement",
         "beginning balance", "ending balance", "statement period",
         "total deposits", "total withdrawals"],
    ),
    "purchase_order": (
        "Purchase Order",
        ["purchase order", "po number", "ship to"],
    ),
    "government_contract": (
        "Government Contract",
        ["clin", "far ", "dfars", "contracting officer",
         "cor/cotr", "solicitation"],
    ),
    "master_services_agreement": (
        "Master Services Agreement",
        ["master services agreement", "this msa"],
    ),
    "supplier_agreement": (
        "Supplier Agreement",
        ["supplier agreement", "vendor agreement"],
    ),
    "sow": (
        "Statement of Work",
        ["statement of work", "scope of work", "deliverables"],
    ),
    "amendment": (
        "Amendment",
        ["this amendment", "hereby amends", "amendment no"],
    ),
    "rate_card": (
        "Rate Card",
        # Document-family classification only — do not treat ordinary
        # labor-category/hourly-rate language as a Rate Card document.
        ["rate card", "labor rate card"],
    ),
    "procurement": (
        "Procurement Document",
        ["request for proposal", "request for quote",
         "invitation for bid", "solicitation number"],
    ),
    "technical_specification": (
        "Technical Specification",
        ["technical specification", "performance specification",
         "shall comply with"],
    ),
    "contract": (
        "Contract",
        ["this agreement", "the parties", "effective date",
         "governing law", "whereas"],
    ),
    "laboratory_report": (
        "Laboratory Report",
        ["complete blood count", "cbc", "iron studies", "reference range",
         "patient information", "specimen", "hematology",
         "laboratory report"],
    ),
    # Personal, payment and records documents. Keywords are phrases a
    # document of that type prints on its face; generic words shared with
    # invoices or contracts ("total", "date of birth") are left out so
    # the score margin stays meaningful.
    "passport": (
        "Passport",
        ["passport no", "passport number", "type/type", "date of expiry",
         "place of birth", "given names", "nationality", "passport",
         "country code", "date of issue", "issuing authority"],
    ),
    "driving_licence": (
        "Driving Licence",
        ["driver license", "driver's license", "drivers license",
         "driving licence", "driving license", "license class",
         "permis de conduire", "endorsements", "restrictions", "dln"],
    ),
    "identity_card": (
        "Identity Card",
        ["identity card", "national id", "id card", "national identity",
         "card number", "carte d'identite"],
    ),
    "academic_transcript": (
        "Academic Transcript",
        ["official transcript", "academic transcript", "academic record",
         "cumulative gpa", "grade point average", "credits attempted",
         "credits earned", "credit hours", "term gpa", "registrar"],
    ),
    "pay_stub": (
        "Pay Stub / Paycheck",
        ["pay stub", "paystub", "earnings statement", "pay period",
         "pay date", "gross pay", "net pay", "ytd", "year to date",
         "federal income tax", "social security", "medicare"],
    ),
    "bank_check": (
        "Bank Cheque",
        ["pay to the order of", "pay to the order", "void after",
         "not valid after", "authorized signature", "⑆", "⑈"],
    ),
    "receipt": (
        "Receipt",
        ["receipt", "receipt number", "receipt no", "payment receipt",
         "sales receipt", "thank you for your purchase", "change due",
         "cash tendered", "amount tendered", "card ending", "auth code"],
    ),
    "tax_form": (
        "Tax Form",
        ["form w-2", "wage and tax statement", "form 1099", "form w-9",
         "form 1040", "employer identification number",
         "taxpayer identification number", "internal revenue service"],
    ),
    "utility_bill": (
        "Utility Bill",
        ["service address", "meter number", "meter reading",
         "previous reading", "current reading", "kwh", "billing period",
         "usage history"],
    ),
    "insurance_policy": (
        "Insurance Policy",
        ["policy number", "policyholder", "declarations page",
         "named insured", "deductible", "coverage limit"],
    ),
    "quotation": (
        "Quotation",
        ["quotation", "quote number", "quote no", "price quote",
         "valid until", "estimate number", "quote date"],
    ),
    "credit_note": (
        "Credit Note",
        ["credit note", "credit memo", "credit memorandum"],
    ),
    "shipping_document": (
        "Shipping Document",
        ["bill of lading", "packing slip", "packing list", "delivery note",
         "consignee", "shipper", "waybill"],
    ),
    "resume": (
        "Resume / CV",
        ["curriculum vitae", "work experience", "professional experience",
         "professional summary", "technical skills", "employment history",
         "references available"],
    ),
    "business_requirements": (
        "Business Requirements Document",
        ["business requirements", "functional requirements",
         "non-functional requirements", "business objectives",
         "project scope", "requirements document"],
    ),
    "research_idea": (
        "Research / Idea Document",
        ["market opportunity", "target audience", "competitors",
         "feasibility", "monetization", "go-to-market",
         "value proposition"],
    ),
}

FIELD_PROBES: list[tuple[str, str, str]] = [
    ("revenue", "Revenue", "Revenue"),
    ("gross_profit", "Gross Profit", "Gross Profit"),
    ("net_income", "Net Income", "Net Income"),
    ("operating_expenses", "Operating Expenses", "Operating Expenses"),
    ("contract_number", "Contract Number", "Contract Number"),
    ("contract_no", "Contract No.", "CONTRACT NO"),
    ("effective_date", "Effective Date", "Effective Date"),
    ("invoice_number", "Invoice Number", "Invoice Number"),
    ("amount_due", "Amount Due", "Amount Due"),
    ("amount", "Amount", "Amount"),
    ("date", "Date", "Date"),
    ("po_number", "PO Number", "PO Number"),
    ("solicitation_number", "Solicitation No.", "SOLICITATION"),
    ("dodaac", "DODAAC", "DODAAC"),
    ("cage_code", "CAGE Code", "CAGE"),
    ("psc_cd", "PSC CD", "PSC CD"),
    ("naics", "NAICS", "NAICS"),
    ("max_net_amt", "Max Net Amt", "MAX NET AMT"),
    ("wawf", "WAWF", "WAWF"),
    ("wawf_payment_office", "WAWF Payment Office", "PAYMENT OFFICE"),
    ("wawf_admin_office", "WAWF Admin Office", "ADMIN OFFICE"),
    ("issued_by", "Issued By", "ISSUED BY"),
    ("ship_to", "Ship To", "SHIP TO"),
    ("date_issued", "Date Issued", "DATE ISSUED"),
    ("requisition_number", "Requisition Number", "REQUISITION"),
    ("offer_due_date", "Offer Due Date", "OFFER DUE"),
    ("type_of_solicitation", "Type of Solicitation", "TYPE OF SOLICITATION"),
]

SUGGESTED_PROMPTS: dict[str, str] = {
    family.key: family.suggested_prompt for family in HEADING_FAMILIES
}
SUGGESTED_PROMPTS.update(
    {
        "funding_table": (
            "Extract the funding table with allocations and amounts."
        ),
        "line_items": (
            "Extract all line items with descriptions, quantities, and prices."
        ),
    }
)

ORGANIZATION_PATTERN = re.compile(
    r"\b(?:[A-Z][A-Za-z&.,]*\s+){1,4}"
    r"(?:Inc\.?|LLC|L\.L\.C\.|Corp\.?|Corporation|"
    r"Company|Co\.|Ltd\.?|Industries|Group|Partners)\b"
)

KNOWN_TEMPLATE_KEYS = set(TABLE_FAMILIES) | {
    family.key for family in HEADING_FAMILIES
}

# Template table families that must never appear without a literal
# document phrase — not inferred from column headers alone.
LITERAL_PHRASE_TEMPLATE_KEYS: dict[str, str] = {
    "pricing_table": "pricing table",
    "rate_card": "rate card",
}


def _page_contains_literal_phrase(page_text: str, phrase: str) -> bool:
    return phrase in (page_text or "").lower()


def _template_target_allowed(
    key: str,
    *,
    page_text: str,
    evidence: list[str],
) -> bool:
    """Block template presets unless the page literally contains the phrase."""
    required = LITERAL_PHRASE_TEMPLATE_KEYS.get(key)
    if required is None:
        return True

    haystack = (page_text or "").lower()
    if required in haystack:
        return True

    combined_evidence = " ".join(evidence).lower()
    return required in combined_evidence


def _keyword_score(text: str, keywords: list[str]) -> int:
    """Score keyword hits. Multi-word phrases are high-signal on their own."""
    score = 0
    for keyword in keywords:
        if keyword in text:
            score += 2 if " " in keyword.strip() else 1
    return score


def _slugify(label: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")
    slug = re.sub(r"_+", "_", slug)
    return slug[:60] or "field"


# inline_regex/stacked_line pull "label: value" or "LABEL\nvalue" shapes
# out of free-form page text with no real form/table structure backing
# them — a clause heading or a sentence fragment ("With Contiguous United
# States CONUS", "fringe benefits contribution rates") can pass the
# looser is_plausible_kv_label() thresholds used for the Field Explorer's
# broader KV search. Auto-promoting one of these into a selectable
# kv_<slug> business-field target needs a stricter bar than that: real
# form labels are short, and clause/heading fragments are not.
_LOW_CONFIDENCE_KV_METHODS = frozenset({"inline_regex", "stacked_line"})
_MAX_AUTO_KV_LABEL_WORDS = 4
_MAX_AUTO_KV_LABEL_CHARS = 32
_KV_PROMOTION_CONFIDENCE_FLOOR = 0.72

# A label truncated mid-clause ("construction such", "...fringe benefits
# con") dangles on a connector word a real field label never ends on.
_DANGLING_TRAILING_WORDS = frozenset(
    {
        "such", "as", "for", "with", "of", "the", "and", "or", "to", "in",
        "on", "at", "by", "from", "under", "including", "than", "a", "an",
        "that", "which", "who", "into", "per",
    }
)

# A numbered/lettered clause or SOW subsection heading ("B.1 General",
# "C.1 Scope", "D.1 Background") is shaped just like a short form label —
# 1-3 words, no dangling connector — so the checks above let it through.
# It isn't a business field though: it's a section marker whose "value"
# is really the body text that follows it, not a filled-in answer.
# _looks_like_section_heading (imported at module top) matches common
# SOW/PWS/clause heading vocabulary plus full UCF section titles, kept
# as a single shared copy in field_classification.py so this gate and
# is_narrative_or_section_field() never drift.


def _looks_like_reliable_kv_label(pair: ScannedPair) -> bool:
    label = pair.raw_label.strip()

    if looks_like_narrative_fragment(label):
        return False

    if _looks_like_section_heading(label):
        return False

    # TOC/navigation lines ("ATTACHMENT J-1 ........ 69") and bare FAR/
    # DFARS clause citations ("505(b)(6), Post-award Notices...") are
    # real text on the page, but they are references, not business-field
    # values — reject them here so they never become a kv_* candidate
    # in the first place, rather than relying on the UI to hide them.
    if looks_like_toc_entry(pair.value):
        return False
    if looks_like_clause_citation_value(pair.value):
        return False

    if pair.method in _LOW_CONFIDENCE_KV_METHODS:
        if pair.confidence < _KV_PROMOTION_CONFIDENCE_FLOOR:
            return False
        words = label.split()
        if (
            len(words) > _MAX_AUTO_KV_LABEL_WORDS
            or len(label) > _MAX_AUTO_KV_LABEL_CHARS
        ):
            return False
        if words and words[-1].strip(".,;:").lower() in _DANGLING_TRAILING_WORDS:
            return False

    return True


def _humanize_table_label(page_number: int, headers: list[str]) -> str:
    if headers:
        first = headers[0].strip()
        if first and not first.lower().startswith("column"):
            return first[:80]
    return f"Table (page {page_number})"


def _is_budget_actual_table(headers: list[str]) -> bool:
    haystack = " ".join(headers).lower()
    return "budget" in haystack and "actual" in haystack


def _heading_matches(text: str) -> list[HeadingFamily]:
    return [family for family in HEADING_FAMILIES if family.pattern.search(text)]


def _label_from_headers(
    headers: list[str],
    surrounding_text: str,
    page_number: int,
    index: int,
) -> tuple[str, str, float, list[str]]:
    haystack = (
        " ".join(headers) + " " + surrounding_text[:400]
    ).lower()

    best_key: str | None = None
    best_label = _humanize_table_label(page_number, headers)
    best_score = 0

    for key, (label, keywords) in TABLE_FAMILIES.items():
        score = _keyword_score(haystack, keywords)
        if score > best_score:
            best_key = key
            best_label = label
            best_score = score

    # Heading overrides only apply when there are no usable headers.
    # With headers present, a page-level phrase like "labor categories"
    # must not rename every table on that page. Heading-only discovery
    # (missed table geometry) still runs separately in detect_document_structures.
    if not headers:
        heading_hits = _heading_matches(haystack)
        table_headings = [
            family for family in heading_hits
            if family.extraction_type == "table"
        ]
        if table_headings:
            family = table_headings[0]
            best_key = family.key
            best_label = family.label
            if best_key in {"pricing_table", "rate_card"}:
                required = {
                    "pricing_table": "pricing table",
                    "rate_card": "rate card",
                }[best_key]
                if required not in haystack:
                    best_key = f"table_p{page_number}_{index}"
                    best_label = _humanize_table_label(page_number, headers)
                    confidence = 0.6
                    evidence = [f"Unlabeled table on page {page_number}"]
                    return best_key, best_label, confidence, evidence
            confidence = 0.98
            evidence = [f"Heading on page {page_number}: {family.label}"]
            return best_key, best_label, confidence, evidence

    if _is_budget_actual_table(headers):
        lowered = surrounding_text.lower()
        if "operating expense" in lowered:
            best_key = "operating_expenses"
            best_label = "Operating Expenses"
        elif "revenue" in lowered:
            best_key = "revenue_analysis"
            best_label = "Revenue Analysis"
        else:
            best_key = "budget_vs_actual"
            best_label = "Budget vs Actual"
        confidence = 0.93
        evidence = [
            f"Budget/actual/variance columns on page {page_number}",
        ]
        return best_key, best_label, confidence, evidence

    if best_score < TABLE_MATCH_MIN_SCORE:
        best_key = f"table_p{page_number}_{index}"
        best_label = _humanize_table_label(page_number, headers)
        confidence = 0.72 if headers else 0.6
        evidence = [f"Unlabeled table on page {page_number}"]
        if headers:
            evidence.append("Columns: " + ", ".join(headers[:8]))
        return best_key, best_label, confidence, evidence

    # Guardrail: never rename a table to a known template family unless
    # the document literally contains that family's primary phrase.
    if best_key in {"pricing_table", "rate_card"}:
        required = {
            "pricing_table": "pricing table",
            "rate_card": "rate card",
        }[best_key]
        if required not in haystack:
            best_key = f"table_p{page_number}_{index}"
            best_label = _humanize_table_label(page_number, headers)
            confidence = 0.72 if headers else 0.6
            evidence = [f"Unlabeled table on page {page_number}"]
            if headers:
                evidence.append("Columns: " + ", ".join(headers[:8]))
            return best_key, best_label, confidence, evidence

    confidence = min(0.99, 0.78 + 0.07 * best_score)
    evidence = [f"Matched {best_label} from table headers on page {page_number}"]
    return best_key or f"table_p{page_number}_{index}", best_label, confidence, evidence


def _merge_targets(targets: list[DetectedTarget]) -> list[DetectedTarget]:
    merged: dict[str, DetectedTarget] = {}

    for target in targets:
        existing = merged.get(target.key)
        if existing is None:
            merged[target.key] = target
            continue

        existing.pages = sorted(set(existing.pages + target.pages))
        existing.confidence = max(existing.confidence, target.confidence)
        existing.evidence = list(
            dict.fromkeys(existing.evidence + target.evidence)
        )
        if not existing.columns and target.columns:
            existing.columns = target.columns
        if not existing.suggested_prompt and target.suggested_prompt:
            existing.suggested_prompt = target.suggested_prompt

    return list(merged.values())


def _sort_targets(
    targets: list[DetectedTarget],
    document_family: str,
) -> list[DetectedTarget]:
    preferred = FAMILY_DEFAULT_KEYS.get(document_family, [])
    rank = {key: index for index, key in enumerate(preferred)}

    return sorted(
        targets,
        key=lambda target: (
            rank.get(target.key, len(preferred)),
            -target.confidence,
            min(target.pages) if target.pages else 999,
        ),
    )


def _classify_document_family(
    text: str,
) -> tuple[str, str, float]:
    lowered = text.lower()

    scores = {
        key: _keyword_score(lowered, keywords)
        for key, (_label, keywords) in DOCUMENT_FAMILIES.items()
    }

    ranked = sorted(
        scores.items(), key=lambda item: item[1], reverse=True
    )

    if not ranked or ranked[0][1] == 0:
        return "unknown", "Unknown / General Document", 0.3

    top_key, top_score = ranked[0]
    runner_up_score = ranked[1][1] if len(ranked) > 1 else 0

    if (
        top_score >= FAMILY_MIN_SCORE
        and top_score - runner_up_score >= FAMILY_SCORE_MARGIN
    ):
        label = DOCUMENT_FAMILIES[top_key][0]
        confidence = min(0.99, 0.72 + 0.06 * top_score)
        return top_key, label, round(confidence, 2)

    if top_score >= 1:
        return (
            "generic_business",
            "Generic Business Document",
            0.55,
        )

    return "unknown", "Unknown / General Document", 0.35


def _target(
    *,
    key: str,
    label: str,
    extraction_type: ExtractionType,
    pages: list[int],
    confidence: float,
    evidence: list[str],
    columns: list[str] | None = None,
    discovery_method: str | None = None,
    source_labels: list[str] | None = None,
) -> DetectedTarget:
    prompt = SUGGESTED_PROMPTS.get(key)
    if prompt is None:
        if extraction_type == "table":
            prompt = f"Extract the {label} table with all rows and columns."
        elif extraction_type == "field":
            prompt = f"Extract the {label}."
        else:
            prompt = f"Extract {label.lower()} from this document."

    return DetectedTarget(
        key=key,
        label=label,
        extraction_type=extraction_type,
        pages=sorted(set(pages)),
        confidence=round(confidence, 2),
        evidence=evidence,
        suggested_prompt=prompt,
        columns=columns or [],
        discovery_method=discovery_method,
        source_labels=source_labels or ([label] if label else []),
    )


async def detect_document_structures(
    *,
    document: Document,
    pages: list[DocumentPage],
    ai_provider: AIProvider,
) -> StructureDetectionResponse:
    scan_pages = pages[:DETECTION_PAGE_LIMIT]
    combined_text = "\n".join(
        page.final_text or "" for page in scan_pages
    )

    detected: list[DetectedTarget] = []

    for page in scan_pages:
        page_text = page.final_text or ""
        raw_tables = page.tables_json or []

        for index, table in enumerate(raw_tables):
            headers = [
                str(header) for header in (table.get("headers") or [])
            ]
            rows = list(table.get("rows") or [])
            quality = assess_table_candidate(
                headers=headers,
                rows=rows,
                page_text=page_text,
            )
            if quality.table_acceptance_status != "accepted":
                # Raw geometry is only a candidate — do not surface prose
                # / one-row segmentation artifacts as selectable tables.
                continue

            key, label, confidence, evidence = _label_from_headers(
                headers=headers,
                surrounding_text=page_text,
                page_number=page.page_number,
                index=index,
            )
            evidence = [
                *evidence,
                (
                    f"table_quality accepted "
                    f"(structure={quality.table_structure_score:.2f}, "
                    f"prose={quality.prose_probability:.2f})"
                ),
            ]
            detected.append(
                _target(
                    key=key,
                    label=label,
                    extraction_type="table",
                    pages=[page.page_number],
                    confidence=min(confidence, 0.95),
                    evidence=evidence,
                    columns=headers,
                )
            )

        # Heading-based discovery even when pdfplumber missed the table.
        for family in _heading_matches(page_text):
            if not _template_target_allowed(
                family.key,
                page_text=page_text,
                evidence=[f"Heading '{family.label}' on page {page.page_number}"],
            ):
                continue

            already = any(
                item.key == family.key and page.page_number in item.pages
                for item in detected
            )
            if already:
                continue

            columns: list[str] = []
            if raw_tables:
                columns = [
                    str(header)
                    for header in (raw_tables[0].get("headers") or [])
                ]

            detected.append(
                _target(
                    key=family.key,
                    label=family.label,
                    extraction_type=family.extraction_type,
                    pages=[page.page_number],
                    confidence=0.96,
                    evidence=[
                        f"Heading '{family.label}' on page {page.page_number}"
                    ],
                    columns=columns,
                )
            )

    detected_fields: list[DetectedField] = []

    # A page carrying a real 3+ column table is a line-item/CLIN schedule,
    # not a document-info block — "Amount"/"Unit Price"/"Quantity" found
    # in that page's flattened text is one row's figure, not a
    # document-level fact, even though it reads exactly like one.
    line_item_pages: set[int] = {
        page.page_number
        for page in scan_pages
        for table in (page.tables_json or [])
        if len(table.get("headers") or []) >= 3
    }
    # Generic, single-word probes/labels that are legitimate document
    # facts on an invoice (one "Amount" due) but are ambiguous — and
    # wrong — once a real line-item table exists on the same page.
    _AMBIGUOUS_ON_LINE_ITEM_PAGE = frozenset(
        {"amount", "unit_price", "quantity", "unit", "price", "total"}
    )

    for key, label, probe_label in FIELD_PROBES:
        probe_hits: list[tuple[int, str]] = []
        for page in scan_pages:
            if (
                key in _AMBIGUOUS_ON_LINE_ITEM_PAGE
                and page.page_number in line_item_pages
            ):
                continue
            value = extract_labeled_value(
                text=page.final_text or "",
                requested_label=probe_label,
            )
            if value:
                probe_hits.append((page.page_number, value))

        if probe_hits:
            matching_pages = [page_num for page_num, _ in probe_hits]
            first_value = probe_hits[0][1]
            first_page = probe_hits[0][0]

            detected_fields.append(
                DetectedField(
                    key=key,
                    label=label,
                    pages=matching_pages,
                )
            )
            detected.append(
                _target(
                    key=key,
                    label=label,
                    extraction_type="field",
                    pages=matching_pages,
                    confidence=0.86,
                    evidence=[
                        f"'{probe_label}: {first_value}' on page "
                        f"{first_page} (field_probe)"
                    ],
                    discovery_method="field_probe",
                    source_labels=[probe_label],
                )
            )

    known_probe_labels = {probe_label.lower() for _, _, probe_label in FIELD_PROBES}

    # Cross-candidate corroboration for stacked_line pairs — these infer a
    # value purely from "next line down" with no same-line separator, so a
    # column/reading-order artifact in the page text can pair one page's
    # heading with another region's unrelated value. A single such
    # mis-pairing is hard to catch in isolation, but the same exact value
    # attaching to several otherwise-unrelated headings is decisive: a
    # real contract fact belongs to one field, not five.
    _REPEATED_VALUE_MIN_OCCURRENCES = 3
    kv_value_occurrences: dict[str, list[str]] = {}

    for page in scan_pages:
        for pair in scan_page_for_labeled_pairs(page=page):
            if pair.normalized_label in known_probe_labels:
                continue
            if is_internal_form_name(pair.raw_label):
                continue
            if not is_plausible_kv_label(pair.raw_label):
                continue
            if not _looks_like_reliable_kv_label(pair):
                continue

            slug = _slugify(pair.raw_label)
            if is_internal_form_name(slug) or is_internal_form_name(f"kv_{slug}"):
                continue
            if (
                slug in _AMBIGUOUS_ON_LINE_ITEM_PAGE
                and page.page_number in line_item_pages
            ):
                # Same reasoning as the FIELD_PROBES guard above: a bare
                # "Unit Price"/"Quantity"/... found on a page that also
                # carries a real line-item table is that table's own
                # column data leaking into free text, not a document fact.
                continue

            from app.services.field_classification import (
                is_narrative_or_section_field,
            )

            kv_key = f"kv_{slug}"
            if is_narrative_or_section_field(
                key=kv_key,
                label=pair.raw_label,
                value=pair.value,
                field_group="field",
            ):
                # Keep as section/narrative signal only — never a business field.
                detected.append(
                    _target(
                        key=f"section_{slug}",
                        label=pair.raw_label,
                        extraction_type="clause",
                        pages=[page.page_number],
                        confidence=pair.confidence,
                        evidence=[
                            f"'{pair.raw_label}' section marker on page "
                            f"{page.page_number}"
                        ],
                        discovery_method=pair.method,
                        source_labels=[pair.raw_label],
                    )
                )
                continue

            method_note = pair.method
            if pair.source_field_path:
                method_note = (
                    f"{pair.method}; raw_path={pair.source_field_path}"
                )

            detected.append(
                _target(
                    key=kv_key,
                    label=pair.raw_label,
                    extraction_type="field",
                    pages=[page.page_number],
                    confidence=pair.confidence,
                    evidence=[
                        f"'{pair.raw_label}: {pair.value}' on page "
                        f"{page.page_number} ({method_note})"
                    ],
                    discovery_method=pair.method,
                    source_labels=[pair.raw_label],
                )
            )
            # Only stacked_line is checked here: it infers a value purely
            # from line adjacency with no same-line separator at all, so
            # it is the one method genuinely vulnerable to a column/
            # reading-order artifact pairing the wrong text. inline_regex
            # still requires an explicit colon/gap/dot-leader on the same
            # line as its label — real structural evidence a repeated
            # value there doesn't undermine.
            if pair.method == "stacked_line":
                normalized_value = " ".join(str(pair.value).strip().lower().split())
                if normalized_value:
                    kv_value_occurrences.setdefault(normalized_value, []).append(
                        kv_key
                    )

    # Demote (not silently drop) any candidate whose value repeated across
    # 3+ otherwise-unrelated low-structure-method labels — evidence of a
    # scan artifact, not 3+ genuine facts sharing one value.
    suspect_keys: set[str] = set()
    for keys in kv_value_occurrences.values():
        if len(set(keys)) >= _REPEATED_VALUE_MIN_OCCURRENCES:
            suspect_keys.update(keys)

    if suspect_keys:
        rewritten: list[DetectedTarget] = []
        for item in detected:
            if item.key not in suspect_keys:
                rewritten.append(item)
                continue
            rewritten.append(
                _target(
                    key=f"section_{item.key[len('kv_'):]}",
                    label=item.label,
                    extraction_type="clause",
                    pages=item.pages,
                    confidence=item.confidence,
                    evidence=item.evidence
                    + [
                        "Excluded from business fields: this value repeated "
                        "across multiple unrelated candidates, indicating a "
                        "text-extraction column/reading-order artifact "
                        "rather than a genuine label/value pairing."
                    ],
                    discovery_method=item.discovery_method,
                    source_labels=item.source_labels,
                )
            )
        detected = rewritten

    entities = extract_generic_entities(combined_text)
    detected_contacts = entities["email"] + entities["phone"]

    if detected_contacts:
        contact_pages = [
            page.page_number
            for page in scan_pages
            if any(
                value in (page.final_text or "")
                for value in detected_contacts
            )
        ] or [scan_pages[0].page_number] if scan_pages else []

        detected.append(
            _target(
                key="contacts",
                label="Contacts",
                extraction_type="contact",
                pages=contact_pages,
                confidence=0.9,
                evidence=[
                    f"{len(detected_contacts)} email/phone values detected"
                ],
            )
        )

    family_key, family_label, family_confidence = _classify_document_family(
        combined_text
    )

    if family_key in {"unknown", "generic_business"} and combined_text.strip():
        try:
            classification = await classify_contract(
                pages=scan_pages,
                ai_provider=ai_provider,
            )
            mapped_key, mapped_label = _map_contract_type_to_family(
                classification.document_type,
                classification.confidence,
            )
            if mapped_key not in {"unknown", "generic_business"}:
                family_key = mapped_key
                family_label = mapped_label
                family_confidence = round(classification.confidence, 2)
        except AIProviderError:
            pass
        except Exception:
            pass

    detected = _merge_targets(detected)
    detected = _sort_targets(detected, family_key)

    primary = [
        target for target in detected
        if target.confidence >= PRIMARY_CONFIDENCE_MIN
    ]
    possible = [
        target for target in detected
        if target.confidence < PRIMARY_CONFIDENCE_MIN
    ]

    detected_tables = [
        DetectedTable(
            key=target.key,
            label=target.label,
            pages=target.pages,
            confidence=target.confidence,
            suggested_prompt=target.suggested_prompt,
            columns=target.columns,
        )
        for target in primary
        if target.extraction_type == "table"
    ]

    obligation_labels = [
        target.label
        for target in primary
        if target.extraction_type == "obligation"
    ]

    organizations = set(ORGANIZATION_PATTERN.findall(combined_text))
    raw_table_count = sum(len(page.tables_json or []) for page in scan_pages)

    content_stats = ContentStats(
        tables=max(raw_table_count, len(detected_tables)),
        dates=len(entities["date"]),
        currency_values=len(entities["money"]),
        organizations=len(organizations),
    )

    counts = DetectionCounts(
        fields=sum(
            1 for target in primary if target.extraction_type == "field"
        ),
        tables=sum(
            1 for target in primary if target.extraction_type == "table"
        ),
        contacts=sum(
            1 for target in primary if target.extraction_type == "contact"
        ),
        obligations=sum(
            1 for target in primary if target.extraction_type == "obligation"
        ),
        clauses=sum(
            1 for target in primary if target.extraction_type == "clause"
        ),
        signatures=sum(
            1 for target in primary if target.extraction_type == "signature"
        ),
    )

    return StructureDetectionResponse(
        document_id=document.id,
        document_family=family_key,
        document_family_label=family_label,
        document_family_confidence=family_confidence,
        detected_fields=detected_fields,
        detected_tables=detected_tables,
        detected_contacts=detected_contacts,
        detected_obligations=obligation_labels,
        detected_targets=primary,
        possible_targets=possible,
        content_stats=content_stats,
        counts=counts,
    )


def _map_contract_type_to_family(
    document_type: str,
    confidence: float,
) -> tuple[str, str]:
    if confidence < 0.4:
        return "unknown", "Unknown / General Document"

    mapping = {
        "Government Contract": "government_contract",
        "Supplier Agreement": "supplier_agreement",
        "Purchase Agreement": "purchase_order",
        "Purchase Order": "purchase_order",
        "Statement of Work": "sow",
        "Amendment": "amendment",
        "Change Order": "amendment",
        "Master Services Agreement": "master_services_agreement",
    }

    contract_types = {
        "NDA",
        "Professional Services Agreement",
        "Software Agreement",
        "SaaS Agreement",
        "Lease",
        "Service Level Agreement",
        "License Agreement",
        "Consulting Agreement",
        "Construction Agreement",
        "Subcontract",
    }

    if document_type in mapping:
        key = mapping[document_type]
        return key, DOCUMENT_FAMILIES.get(key, (document_type, []))[0]

    if document_type in contract_types:
        return "contract", DOCUMENT_FAMILIES["contract"][0]

    return "unknown", "Unknown / General Document"


def family_keyword_hits(text: str) -> dict[str, tuple[int, list[str]]]:
    """Per family: (keyword score, the keywords found) — the evidence
    behind classify_document_family, for families with any hit."""

    lowered = text.lower()
    hits: dict[str, tuple[int, list[str]]] = {}
    for key, (_label, keywords) in DOCUMENT_FAMILIES.items():
        found = [keyword for keyword in keywords if keyword in lowered]
        if found:
            hits[key] = (_keyword_score(lowered, keywords), found)
    return hits


def classify_document_family(text: str) -> tuple[str, str, float]:
    """Public, deterministic (keyword-only, no AI) document-family
    classification — (family_key, family_label, confidence)."""

    return _classify_document_family(text)


def family_for_document_type(document_type: str, confidence: float) -> tuple[str, str]:
    """Maps an AI-classified `Document.document_type` to a family key."""

    return _map_contract_type_to_family(document_type, confidence)
