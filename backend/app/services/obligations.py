"""Contract obligations: who owes what, and by when.

Read-only and derived from what extraction already stored — schedules
(award date, base and option periods, CLIN periods, delivery dates) from
the persisted Professional Staging Workbook first and the V3 tables as
fallback, incorporated clauses (a
curated FAR/DFARS clause → duty map) and contractor duty sentences mined
from page text. Nothing here is persisted; every obligation carries the
source reference, page and snippet it came from. What a team adds on top
(workflow status, owner, sub-tasks) lives in ObligationTracking, keyed by
the obligation's stable id, and is merged in on read.
"""

from __future__ import annotations

import hashlib
import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone

from dateutil import parser as date_parser
from dateutil.relativedelta import relativedelta
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.document import Document
from app.models.document_clause_reference import DocumentClauseReference
from app.models.document_contract_summary import DocumentContractSummary
from app.models.document_delivery_schedule import DocumentDeliverySchedule
from app.models.document_line_item import DocumentLineItem
from app.models.document_page import DocumentPage
from app.models.document_performance_period import DocumentPerformancePeriod
from app.models.document_staging_workbook import DocumentStagingWorkbook
from app.models.obligation_tracking import ObligationTracking

DUE_SOON_DAYS = 30
# Milestones (period ends, option windows) that passed this long ago are
# history, not obligations.
LAPSED_MILESTONE_DAYS = 30
MAX_TEXT_OBLIGATIONS = 40
EVIDENCE_CHARS = 280

STATUS_ORDER = {"overdue": 0, "due_soon": 1, "upcoming": 2, "ongoing": 3, "undated": 4}
# Team workflow, set by people — never inferred from dates.
WORKFLOW_STATUSES = ("upcoming", "in_review", "pending_co", "completed")
MAX_SUBTASKS = 50

# Curated FAR/DFARS clause duties. Facts only — the clause's own duty, the
# party that owes it and the timing the clause itself states. `annual` is
# a fixed (month, day) due date that recurs every year.
CLAUSE_OBLIGATIONS: dict[str, list[dict]] = {
    "52.204-7": [{
        "title": "Maintain active SAM registration",
        "description": "Keep the System for Award Management registration current, accurate and complete through final payment; renew at least annually.",
        "category": "compliance", "party": "contractor", "recurrence": "annually",
    }],
    "52.204-10": [{
        "title": "Report first-tier subcontract awards",
        "description": "Report each first-tier subcontract award of $30,000 or more, and executive compensation where required, in SAM/FSRS.",
        "category": "reporting", "party": "contractor", "recurrence": "per occurrence",
        "trigger": "by the end of the month following the month of subcontract award",
    }],
    "52.204-21": [{
        "title": "Apply basic safeguarding controls",
        "description": "Apply the clause's basic safeguarding requirements to covered contractor information systems that process Federal contract information.",
        "category": "compliance", "party": "contractor",
    }],
    "52.204-25": [{
        "title": "Report covered telecommunications equipment",
        "description": "Report any covered telecommunications equipment or services identified during contract performance to the Contracting Officer.",
        "category": "notification", "party": "contractor", "recurrence": "per occurrence",
        "trigger": "within 1 business day of identification; mitigation details within 10 business days",
    }],
    "52.217-8": [{
        "title": "Option to extend services (up to 6 months)",
        "description": "The Government may require continued performance of services within the limits and rates of the contract, exercised within the period specified in the Schedule.",
        "category": "option", "party": "government",
        "trigger": "within the period specified in the Schedule",
    }],
    "52.217-9": [{
        "title": "Notice of intent to extend the term",
        "description": "The Government may extend the term by written notice and gives a preliminary written notice of its intent to extend before the contract expires.",
        "category": "option", "party": "government",
        "trigger": "within the period specified in the Schedule, before the contract expires",
    }],
    "52.219-9": [
        {
            "title": "Submit Individual Subcontract Report (ISR)",
            "description": "Submit the ISR in eSRS for the subcontracting plan, for periods ending March 31 and September 30.",
            "category": "reporting", "party": "contractor",
            "trigger": "semiannually, within 30 days after each period ends (April 30 and October 30)",
            "next_of": [(4, 30), (10, 30)],
        },
        {
            "title": "Submit Summary Subcontract Report (SSR)",
            "description": "Submit the SSR in eSRS for the fiscal year ending September 30.",
            "category": "reporting", "party": "contractor", "recurrence": "annually",
            "annual": (10, 30),
        },
    ],
    "52.219-14": [{
        "title": "Observe limitations on subcontracting",
        "description": "Do not pay more than the clause's percentage of the amount paid by the Government to subcontractors that are not similarly situated entities.",
        "category": "compliance", "party": "contractor",
    }],
    "52.222-37": [{
        "title": "File VETS-4212 report",
        "description": "Report veteran employment and hiring data to the Department of Labor on the VETS-4212 form.",
        "category": "reporting", "party": "contractor", "recurrence": "annually",
        "annual": (9, 30),
    }],
    "52.222-41": [{
        "title": "Pay Service Contract Labor Standards wages",
        "description": "Pay service employees no less than the wage rates and fringe benefits in the applicable wage determination and post the required notice.",
        "category": "compliance", "party": "contractor",
    }],
    "52.222-54": [{
        "title": "Enroll in E-Verify",
        "description": "Enroll in E-Verify and verify employment eligibility of new hires and of employees assigned to the contract.",
        "category": "compliance", "party": "contractor",
        "trigger": "enroll within 30 calendar days of contract award",
    }],
    "52.232-7": [{
        "title": "Submit T&M / labor-hour vouchers",
        "description": "Submit vouchers for time-and-materials or labor-hour payments, and a completion voucher at the end of performance.",
        "category": "financial", "party": "contractor", "recurrence": "per occurrence",
        "trigger": "no more often than every two weeks, unless otherwise authorized",
    }],
    "52.232-25": [{
        "title": "Prompt payment of proper invoices",
        "description": "The Government pays proper invoices by the due date set by the clause, otherwise interest penalties apply.",
        "category": "financial", "party": "government", "recurrence": "per occurrence",
        "trigger": "generally the 30th day after receipt of a proper invoice",
    }],
    "52.232-33": [{
        "title": "Keep EFT information current in SAM",
        "description": "Maintain accurate electronic funds transfer information in the System for Award Management.",
        "category": "financial", "party": "contractor",
    }],
    "52.242-15": [{
        "title": "Comply with stop-work orders",
        "description": "Stop work when ordered for up to 90 days; assert any equitable adjustment after the order ends.",
        "category": "notification", "party": "contractor", "recurrence": "per occurrence",
        "trigger": "assert adjustment within 30 days after the stop-work period ends",
    }],
    "52.243-1": [{
        "title": "Assert change-order adjustments",
        "description": "Assert any right to an adjustment under a change order.",
        "category": "notification", "party": "contractor", "recurrence": "per occurrence",
        "trigger": "within 30 days of receipt of a written change order",
    }],
    "52.246-4": [{
        "title": "Maintain inspection system for services",
        "description": "Provide and maintain an inspection system acceptable to the Government; reperform nonconforming services when required.",
        "category": "compliance", "party": "contractor",
    }],
    "52.247-34": [{
        "title": "Deliver F.o.b. destination",
        "description": "Deliver supplies to the destination at the contractor's risk and expense.",
        "category": "deliverable", "party": "contractor", "recurrence": "per occurrence",
    }],
    "252.204-7012": [{
        "title": "Report cyber incidents to DoD",
        "description": "Rapidly report cyber incidents affecting covered defense information to DoD at https://dibnet.dod.mil and preserve images of affected systems.",
        "category": "notification", "party": "contractor", "recurrence": "per occurrence",
        "trigger": "within 72 hours of discovery",
    }],
    "252.211-7003": [{
        "title": "Mark and register items with IUID",
        "description": "Mark items requiring unique item identification and register them in the IUID Registry at delivery.",
        "category": "deliverable", "party": "contractor", "recurrence": "per occurrence",
    }],
    "252.232-7006": [{
        "title": "Submit payment requests in WAWF",
        "description": "Submit payment requests and receiving reports electronically through Wide Area WorkFlow (PIEE).",
        "category": "financial", "party": "contractor", "recurrence": "per occurrence",
    }],
}

_SHALL_DUTY = re.compile(
    r"\b(?:the\s+)?(?P<party>contractor|offeror|vendor|government|contracting officer)\s+shall\s+"
    r"(?:\w+\s+){0,3}?(?P<verb>submit|deliver|provide|notify|report|furnish|file|send|invoice|maintain)\b",
    re.IGNORECASE,
)
_TIMING = re.compile(
    r"\b(?:within\s+(?:\w+\s+)?\(?\d+\)?\s*(?:calendar\s+|business\s+|working\s+)?(?:days?|hours?|weeks?|months?)"
    r"(?:\s+(?:of|after|following|before|prior to|from)\s+[^,.;]{1,60})?"
    r"|no\s+later\s+than\s+[^,.;]{1,60}"
    r"|prior\s+to\s+[^,.;]{1,50}"
    r"|timely)\b",
    re.IGNORECASE,
)
_RECURRENCE = [
    ("daily", re.compile(r"\bdaily\b|\beach day\b", re.I)),
    ("weekly", re.compile(r"\bweekly\b|\beach week\b", re.I)),
    ("monthly", re.compile(r"\bmonthly\b|\beach month\b|\bevery month\b", re.I)),
    ("quarterly", re.compile(r"\bquarterly\b|\beach quarter\b", re.I)),
    ("annually", re.compile(r"\bannual(?:ly)?\b|\beach year\b|\byearly\b", re.I)),
]
_NO_LATER_DATE = re.compile(r"no\s+later\s+than\s+([A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}/\d{1,2}/\d{2,4})", re.I)
_DURATION = re.compile(r"(\d+)\s*(year|month|day)s?", re.I)
_CLAUSE_BASE = re.compile(r"^(?:FAR\s+|DFARS\s+)?((?:52|252)\.\d{3}-\d{1,4})", re.I)
_SENTENCE_SPLIT = re.compile(r"(?<=[.;])\s+(?=[A-Z(])")


def _parse_date(value: str | None) -> date | None:
    if not value or not str(value).strip():
        return None
    try:
        parsed = date_parser.parse(str(value).strip(), fuzzy=False, default=datetime(1900, 1, 1))
    except (ValueError, OverflowError, TypeError):
        return None
    return parsed.date() if parsed.year > 1900 else None


def _clean(text: str | None) -> str:
    return " ".join((text or "").replace("�", "'").split())


def _snippet(text: str | None) -> str:
    cleaned = _clean(text)
    return cleaned if len(cleaned) <= EVIDENCE_CHARS else cleaned[: EVIDENCE_CHARS - 1].rstrip() + "…"


def _page_of(evidence: dict | None) -> int | None:
    if not isinstance(evidence, dict):
        return None
    for key in ("page_number", "page", "source_page"):
        value = evidence.get(key)
        if isinstance(value, int) and value > 0:
            return value
    return None


def _status(due: date | None, recurrence: str | None, today: date, category: str = "") -> str:
    if due is None:
        # Recurring duties and standing compliance run for the whole contract.
        return "ongoing" if recurrence or category == "compliance" else "undated"
    if due < today:
        return "overdue"
    if due <= today + timedelta(days=DUE_SOON_DAYS):
        return "due_soon"
    return "upcoming"


def _next_annual(month: int, day: int, today: date) -> date:
    candidate = date(today.year, month, day)
    return candidate if candidate >= today else date(today.year + 1, month, day)


def _add_duration(start: date, text: str | None) -> date | None:
    match = _DURATION.search(text or "")
    if not match:
        return None
    amount, unit = int(match.group(1)), match.group(2).lower()
    delta = {"year": relativedelta(years=amount), "month": relativedelta(months=amount), "day": relativedelta(days=amount)}[unit]
    return start + delta - timedelta(days=1)


def _obligation(
    *,
    document_id: str,
    document_name: str,
    title: str,
    description: str,
    category: str,
    party: str,
    source_type: str,
    source_reference: str,
    today: date,
    due: date | None = None,
    recurrence: str | None = None,
    trigger: str | None = None,
    page: int | None = None,
    evidence: str | None = None,
    confidence: float = 0.6,
) -> dict:
    key = "|".join([document_id, source_type, source_reference, title.lower()])
    return {
        "obligation_id": hashlib.sha1(key.encode("utf-8")).hexdigest()[:16],
        "document_id": document_id,
        "document_name": document_name,
        "title": title,
        "description": description,
        "category": category,
        "responsible_party": party,
        "due_date": due.isoformat() if due else None,
        "recurrence": recurrence,
        "trigger": trigger,
        "status": _status(due, recurrence, today, category),
        "source_type": source_type,
        "source_reference": source_reference,
        "page": page,
        "evidence": _snippet(evidence),
        "confidence": round(max(0.0, min(1.0, float(confidence or 0.0))), 2),
    }


def _lapsed(item: dict, today: date) -> bool:
    if item["category"] not in {"performance", "option"} or not item["due_date"]:
        return False
    return date.fromisoformat(item["due_date"]) < today - timedelta(days=LAPSED_MILESTONE_DAYS)


# --- sources -----------------------------------------------------------------


@dataclass
class _Fact:
    """One staged value with the page and source text it was read from."""

    value: str
    page: int | None = None
    evidence: str | None = None


@dataclass
class _Clin:
    clin: str
    title: str = ""
    is_option: bool = False
    pop_start: date | None = None
    pop_end: date | None = None
    delivery: date | None = None
    quantity: str | None = None
    ship_to: str | None = None
    page: int | None = None
    evidence: str | None = None


@dataclass
class _ScheduleFacts:
    """Schedule facts for one document: the persisted Professional Staging
    Workbook first (what the document page shows), V3 tables as fallback."""

    fields: dict[str, _Fact] = field(default_factory=dict)
    clins: dict[str, _Clin] = field(default_factory=dict)
    from_workbook: bool = False


_EMPTY_VALUES = {"", "n/a", "na", "none", "null", "-", "—", "not applicable", "see schedule"}
_DATE_TOKEN = r"(\d{1,2}[-/ ][A-Za-z]{3,9}[-/ ]\d{2,4}|[A-Za-z]{3,9}\.? \d{1,2},? \d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}/\d{1,2}/\d{2,4})"
_DATE_RANGE = re.compile(_DATE_TOKEN + r"\s*(?:to|through|thru|until|-|–)\s*" + _DATE_TOKEN, re.I)
_SINGLE_DATE = re.compile(_DATE_TOKEN)


def _meaningful(value) -> str | None:
    text = _clean(str(value)) if value is not None else ""
    return None if text.lower() in _EMPTY_VALUES else text


def _cell_fact(cell) -> _Fact | None:
    if cell is None:
        return None
    value = _meaningful(cell.value)
    if value is None:
        return None
    provenance = cell.provenance
    return _Fact(
        value=value,
        page=getattr(provenance, "source_page", None) if provenance else None,
        evidence=getattr(provenance, "evidence_text", None) if provenance else None,
    )


def _date_span(text: str | None) -> tuple[date | None, date | None]:
    """'POP 29-SEP-2023 TO 28-SEP-2028' → (start, end); one date → (None, date)."""

    if not text:
        return None, None
    span = _DATE_RANGE.search(text)
    if span:
        return _parse_date(span.group(1)), _parse_date(span.group(2))
    single = _SINGLE_DATE.search(text)
    return None, _parse_date(single.group(1)) if single else None


def _workbook_facts(database: Session, document_id: str) -> _ScheduleFacts | None:
    """Read the persisted workbook — only for documents already pinned to a
    contract profile, so reading never pins or re-stages anything."""

    profile_id = database.scalar(
        select(DocumentStagingWorkbook.profile_id).where(DocumentStagingWorkbook.document_id == document_id)
    )
    if not profile_id or "contract" not in profile_id:
        return None
    try:
        from app.staging.service import get_staging_workbook

        workbook = get_staging_workbook(database, document_id)
    except Exception:  # noqa: BLE001 — V3 tables remain the fallback
        return None

    facts = _ScheduleFacts(from_workbook=True)
    datasets = {dataset.dataset_id: dataset for dataset in workbook.datasets}

    summary = datasets.get("contract_summary")
    for record in summary.records if summary else []:
        for key, cell in record.cells.items():
            fact = _cell_fact(cell)
            if fact:
                facts.fields.setdefault(key.rsplit(".", 1)[-1], fact)

    def clin_entry(number: str) -> _Clin:
        return facts.clins.setdefault(number, _Clin(clin=number))

    data = datasets.get("contract_data")
    for record in data.records if data else []:
        cells = record.cells
        kind = _meaningful(getattr(cells.get("contract.data.record_type"), "value", None))
        record_id = _meaningful(getattr(cells.get("contract.data.record_id"), "value", None))
        if kind == "Field" and record_id:
            fact = _cell_fact(cells.get("contract.data.value"))
            if fact:
                facts.fields.setdefault(record_id, fact)
        elif kind == "CLIN":
            number = _meaningful(getattr(cells.get("contract.data.clin"), "value", None)) or record_id
            if not number:
                continue
            entry = clin_entry(number)
            title = _cell_fact(cells.get("contract.data.title"))
            entry.title = entry.title or (title.value if title else "")
            entry.is_option = entry.is_option or "option" in entry.title.lower()
            source = title or _cell_fact(cells.get("contract.data.record_id"))
            if source and entry.page is None:
                entry.page, entry.evidence = source.page, source.evidence

    clins = datasets.get("clins")
    for record in clins.records if clins else []:
        cells = record.cells
        number = _meaningful(getattr(cells.get("contract.clin.clin"), "value", None))
        if not number:
            continue
        entry = clin_entry(number)
        description = _cell_fact(cells.get("contract.clin.description"))
        option = _meaningful(getattr(cells.get("contract.clin.option_base"), "value", None)) or ""
        entry.title = entry.title or (description.value[:120] if description else "")
        entry.is_option = entry.is_option or "option" in option.lower()
        entry.pop_start = entry.pop_start or _parse_date(_meaningful(getattr(cells.get("contract.clin.pop_start"), "value", None)))
        entry.pop_end = entry.pop_end or _parse_date(_meaningful(getattr(cells.get("contract.clin.pop_end"), "value", None)))
        if description and entry.page is None:
            entry.page, entry.evidence = description.page, description.evidence

    delivery = datasets.get("delivery_information")
    for record in delivery.records if delivery else []:
        cells = record.cells
        number = _meaningful(getattr(cells.get("contract.delivery.clin"), "value", None))
        when = _cell_fact(cells.get("contract.delivery.delivery_date"))
        if not number:
            continue
        entry = clin_entry(number)
        if when:
            start, end = _date_span(when.value)
            if start:  # a period of performance, not a single delivery
                entry.pop_start, entry.pop_end = entry.pop_start or start, entry.pop_end or end
            elif end:
                entry.delivery = end
            entry.page, entry.evidence = when.page or entry.page, when.evidence or when.value
        quantity = _cell_fact(cells.get("contract.delivery.quantity"))
        ship_to = _cell_fact(cells.get("contract.delivery.ship_to"))
        entry.quantity = entry.quantity or (quantity.value if quantity else None)
        entry.ship_to = entry.ship_to or (ship_to.value if ship_to else None)
    return facts


def _v3_facts(database: Session, document_id: str, facts: _ScheduleFacts) -> _ScheduleFacts:
    """Fill what the workbook didn't have from the V3 tables."""

    summary = database.scalar(
        select(DocumentContractSummary).where(DocumentContractSummary.document_id == document_id)
    )
    if summary is not None:
        for key in ("award_date", "base_period", "options"):
            value = _meaningful(getattr(summary, key))
            if value:
                facts.fields.setdefault(key, _Fact(value=value, page=summary.source_page, evidence=summary.evidence))

    for line in database.scalars(
        select(DocumentLineItem).where(DocumentLineItem.document_id == document_id).order_by(DocumentLineItem.row_index)
    ):
        number = line.clin or line.slin
        if not number or (number in facts.clins and facts.from_workbook):
            continue
        entry = facts.clins.setdefault(number, _Clin(clin=number))
        entry.title = entry.title or _clean(line.description)[:120]
        entry.is_option = entry.is_option or "option" in f"{line.option_base or ''} {line.period_label or ''}".lower()
        entry.pop_start = entry.pop_start or _parse_date(line.pop_start)
        entry.pop_end = entry.pop_end or _parse_date(line.pop_end)
        if entry.page is None:
            entry.page = _page_of(line.evidence_json)
            entry.evidence = (line.evidence_json or {}).get("source_text") or line.description

    for row in database.scalars(
        select(DocumentDeliverySchedule).where(DocumentDeliverySchedule.document_id == document_id)
    ):
        if not row.clin or (facts.from_workbook and row.clin in facts.clins and facts.clins[row.clin].delivery):
            continue
        entry = facts.clins.setdefault(row.clin, _Clin(clin=row.clin))
        entry.delivery = entry.delivery or _parse_date(row.delivery_date)
        entry.quantity = entry.quantity or (f"{row.quantity:g}" if row.quantity else None)
        entry.ship_to = entry.ship_to or _clean(row.ship_to_address) or None
        if entry.page is None:
            entry.page = _page_of(row.evidence_json)
            entry.evidence = (row.evidence_json or {}).get("source_text")
    return facts


def _schedule_facts(database: Session, document_id: str) -> _ScheduleFacts:
    return _v3_facts(database, document_id, _workbook_facts(database, document_id) or _ScheduleFacts())


def _from_schedules(database: Session, document_id: str, name: str, today: date) -> list[dict]:
    items: list[dict] = []
    base = {"document_id": document_id, "document_name": name, "today": today}
    facts = _schedule_facts(database, document_id)
    confidence = 0.85 if facts.from_workbook else 0.7

    # Award and base period.
    award_fact = facts.fields.get("award_date")
    award = _parse_date(award_fact.value) if award_fact else None
    clins = sorted(facts.clins.values(), key=lambda entry: entry.clin)
    base_clins = [entry for entry in clins if not entry.is_option]
    options = [entry for entry in clins if entry.is_option]
    base_clin_end = max((entry.pop_end for entry in base_clins if entry.pop_end), default=None)

    start_fact = facts.fields.get("performance_start")
    if start_fact:
        starts = award if start_fact.value.lower().startswith("award") else _parse_date(start_fact.value)
        if starts and starts >= today:
            items.append(_obligation(**base, title="Performance begins", description=f"Performance starts ({start_fact.value}).",
                                     category="performance", party="contractor", source_type="schedule", source_reference="Performance start",
                                     due=starts, page=start_fact.page, evidence=start_fact.evidence or start_fact.value, confidence=confidence))

    base_period = facts.fields.get("base_period")
    computed_base_end = _add_duration(award, base_period.value) if award and base_period else None
    base_end = base_clin_end or computed_base_end
    if computed_base_end and not base_clin_end:
        evidence = f"Award date {award_fact.value}; base period {base_period.value}"
        items.append(_obligation(**base, title="Base period ends", description="End of the base period, computed from the award date and base period length.",
                                 category="performance", party="contractor", source_type="schedule", source_reference="Contract summary",
                                 due=computed_base_end, page=base_period.page or award_fact.page, evidence=evidence, confidence=min(confidence, 0.8)))

    # CLIN periods and deliveries.
    for entry in clins:
        reference = f"CLIN {entry.clin}"
        label = entry.title or reference
        if entry.pop_end:
            title = f"Base period ends ({reference})" if not entry.is_option else f"{reference} performance ends"
            items.append(_obligation(**base, title=title, description=f"Period of performance for {label} ends.",
                                     category="performance", party="contractor", source_type="schedule", source_reference=reference,
                                     due=entry.pop_end, page=entry.page, evidence=entry.evidence, confidence=confidence))
        if entry.pop_start and entry.pop_start >= today and not entry.is_option:
            items.append(_obligation(**base, title=f"{reference} performance begins", description=f"Period of performance for {label} starts.",
                                     category="performance", party="contractor", source_type="schedule", source_reference=reference,
                                     due=entry.pop_start, page=entry.page, evidence=entry.evidence, confidence=confidence))
        if entry.delivery:
            numeric = bool(entry.quantity) and re.fullmatch(r"[\d,.]+", entry.quantity) is not None
            quantity = f" ({entry.quantity}{' units' if numeric else ''})" if entry.quantity else ""
            destination = f" to {_clean(entry.ship_to)[:80]}" if entry.ship_to else ""
            items.append(_obligation(**base, title=f"Deliver {reference}{quantity}", description=f"Delivery of {label}{destination}.",
                                     category="deliverable", party="contractor", source_type="schedule", source_reference=reference,
                                     due=entry.delivery, page=entry.page, evidence=entry.evidence, confidence=confidence))

    # Option exercise decisions: each option is decided before the period
    # it would follow ends — its own start, else the preceding period's end.
    previous_end = base_end
    for entry in options:
        reference = f"CLIN {entry.clin}"
        due = entry.pop_start - timedelta(days=1) if entry.pop_start else previous_end
        items.append(_obligation(**base, title=f"Option decision for {reference}",
                                 description=f"{entry.title or 'Option'}: the Government decides whether to exercise this option.",
                                 category="option", party="government", source_type="schedule", source_reference=reference,
                                 due=due, trigger=None if due else "before the preceding period of performance ends",
                                 page=entry.page, evidence=entry.evidence, confidence=confidence))
        previous_end = entry.pop_end

    options_fact = facts.fields.get("options")
    if not options and base_end and options_fact and not re.match(r"^\s*(none|no|0)\b", options_fact.value, re.I):
        items.append(_obligation(**base, title="Option exercise decision", description=f"Options: {options_fact.value}. The Government decides before the base period ends.",
                                 category="option", party="government", source_type="schedule", source_reference="Contract summary",
                                 due=base_end, page=options_fact.page, evidence=options_fact.evidence or options_fact.value, confidence=min(confidence, 0.75)))

    # Narrative performance periods (V3) — dated ones only.
    for period in database.scalars(
        select(DocumentPerformancePeriod).where(DocumentPerformancePeriod.document_id == document_id)
    ):
        label = _clean(period.period_label) or "Period of performance"
        reference = f"CLIN {period.clin}" if period.clin else label
        page = _page_of(period.evidence_json)
        evidence = (period.evidence_json or {}).get("source_text") or period.requirement
        start, end = _parse_date(period.start_date), _parse_date(period.end_date)
        if end:
            items.append(_obligation(**base, title=f"{label} ends", description=f"Performance for {label.lower()} must be complete by this date.",
                                     category="performance", party="contractor", source_type="schedule", source_reference=reference,
                                     due=end, page=page, evidence=evidence, confidence=period.confidence))
        if start and start >= today:
            items.append(_obligation(**base, title=f"{label} begins", description=f"Performance for {label.lower()} starts.",
                                     category="performance", party="contractor", source_type="schedule", source_reference=reference,
                                     due=start, page=page, evidence=evidence, confidence=period.confidence))
    return items


def _from_clauses(database: Session, document_id: str, name: str, today: date) -> list[dict]:
    items: list[dict] = []
    seen: set[str] = set()
    for clause in database.scalars(
        select(DocumentClauseReference).where(DocumentClauseReference.document_id == document_id).order_by(DocumentClauseReference.row_index)
    ):
        match = _CLAUSE_BASE.match(_clean(clause.clause_number))
        if not match:
            continue
        number = match.group(1)
        if number in seen or number not in CLAUSE_OBLIGATIONS:
            continue
        seen.add(number)
        family = "DFARS" if number.startswith("252.") else "FAR"
        narrative = "narrative" in f"{clause.citation_context} {clause.reference_type or ''}".lower()
        confidence = (clause.confidence or 0.7) * (0.75 if narrative else 0.95)
        for spec in CLAUSE_OBLIGATIONS[number]:
            due = None
            if "annual" in spec:
                due = _next_annual(*spec["annual"], today)
            elif "next_of" in spec:
                due = min(_next_annual(month, day, today) for month, day in spec["next_of"])
            items.append(_obligation(
                document_id=document_id, document_name=name, today=today,
                title=spec["title"], description=spec["description"], category=spec["category"],
                party=spec["party"], source_type="clause", source_reference=f"{family} {number}",
                due=due, recurrence=spec.get("recurrence"), trigger=spec.get("trigger"),
                page=_page_of(clause.evidence_json),
                evidence=(clause.evidence_json or {}).get("source_text") or f"{number} {clause.title or ''}",
                confidence=confidence,
            ))
    return items


def _title_from_sentence(sentence: str, match: re.Match) -> str:
    """The duty itself: verb + object, cut at the first clause boundary
    (comma, timing phrase) and at most 12 words."""

    tail = sentence[match.start("verb"):]
    boundary = re.search(r"[,;:(]|\s(?:within|no later than|prior to|in accordance with|as follows)\b", tail, re.I)
    phrase = tail[: boundary.start()] if boundary else tail
    words = phrase.split()
    title = " ".join(words[:12]).rstrip(",;:.")
    if len(words) > 12:
        title += "…"
    return title[:1].upper() + title[1:]


def _category_for(sentence: str, verb: str) -> str:
    lowered = sentence.lower()
    if re.search(r"\binvoice|voucher|payment|bill", lowered):
        return "financial"
    if verb.lower() == "notify" or re.search(r"\bnotif|\bnotice\b", lowered):
        return "notification"
    if verb.lower() == "report" or re.search(r"\breport", lowered):
        return "reporting"
    if re.search(r"\binsurance|certif|complian|registration|maintain\b", lowered):
        return "compliance"
    return "deliverable"


def _party_for(word: str) -> str:
    return "government" if word.lower() in {"government", "contracting officer"} else "contractor"


def _from_text(database: Session, document_id: str, name: str, today: date) -> list[dict]:
    items: list[dict] = []
    seen: set[str] = set()
    pages = database.execute(
        select(DocumentPage.page_number, DocumentPage.final_text, DocumentPage.native_text, DocumentPage.ocr_text)
        .where(DocumentPage.document_id == document_id)
        .order_by(DocumentPage.page_number)
    )
    for page_number, final_text, native_text, ocr_text in pages:
        text = _clean(final_text or native_text or ocr_text)
        if not text:
            continue
        for sentence in _SENTENCE_SPLIT.split(text):
            if len(sentence) < 30 or len(sentence) > 900:
                continue
            match = _SHALL_DUTY.search(sentence)
            if not match:
                continue
            verb = match.group("verb")
            timing = _TIMING.search(sentence)
            recurrence = next((label for label, pattern in _RECURRENCE if pattern.search(sentence)), None)
            # "provide/maintain all management, labor…" is scope, not a duty
            # with a deadline: keep those verbs only with a timing cue.
            if verb.lower() in {"provide", "maintain", "furnish"} and not (timing or recurrence):
                continue
            fingerprint = re.sub(r"[^a-z0-9]+", " ", sentence[match.start():].lower())[:160]
            if fingerprint in seen:
                continue
            seen.add(fingerprint)
            due = None
            dated = _NO_LATER_DATE.search(sentence)
            if dated:
                due = _parse_date(dated.group(1))
            trigger = _clean(timing.group(0)) if timing and timing.group(0).lower() != "timely" else None
            confidence = 0.55 + (0.15 if timing else 0) + (0.1 if recurrence else 0)
            items.append(_obligation(
                document_id=document_id, document_name=name, today=today,
                title=_title_from_sentence(sentence, match),
                description=_snippet(sentence[match.start():]),
                category=_category_for(sentence, verb), party=_party_for(match.group("party")),
                source_type="text", source_reference=f"Page {page_number}",
                due=due, recurrence=recurrence, trigger=trigger,
                page=page_number, evidence=sentence, confidence=confidence,
            ))
            if len(items) >= MAX_TEXT_OBLIGATIONS:
                return items
    return items


# --- public API ----------------------------------------------------------------


def _sort_key(item: dict):
    return (STATUS_ORDER.get(item["status"], 9), item["due_date"] or "9999-12-31", item["document_name"].lower(), item["title"].lower())


def _collect(database: Session, document_id: str, name: str, today: date) -> list[dict]:
    collected: list[dict] = []
    for source in (_from_schedules, _from_clauses, _from_text):
        collected.extend(source(database, document_id, name, today))
    unique: dict[str, dict] = {}
    for item in collected:
        if _lapsed(item, today):
            continue
        unique.setdefault(item["obligation_id"], item)
    return sorted(unique.values(), key=_sort_key)


def tracking_payload(row: ObligationTracking | None) -> dict:
    if row is None:
        return {"workflow_status": "upcoming", "assignee": None, "subtasks": [], "tracking_updated_at": None, "tracking_updated_by": None}
    return {
        "workflow_status": row.workflow_status if row.workflow_status in WORKFLOW_STATUSES else "upcoming",
        "assignee": row.assignee,
        "subtasks": [dict(task) for task in (row.subtasks or []) if isinstance(task, dict)],
        "tracking_updated_at": row.updated_at.isoformat() if row.updated_at else None,
        "tracking_updated_by": row.updated_by or None,
    }


def apply_tracking(database: Session, obligations: list[dict]) -> list[dict]:
    """Merge each obligation's tracking row (defaults when there is none)."""

    document_ids = sorted({item["document_id"] for item in obligations})
    rows = {
        (row.document_id, row.obligation_key): row
        for row in database.scalars(
            select(ObligationTracking).where(ObligationTracking.document_id.in_(document_ids))
        )
    } if document_ids else {}
    for item in obligations:
        item["obligation_key"] = item["obligation_id"]
        item.update(tracking_payload(rows.get((item["document_id"], item["obligation_id"]))))
    return obligations


def build_document_obligations(database: Session, document_id: str, today: date | None = None) -> list[dict]:
    today = today or datetime.now(timezone.utc).date()
    document = database.get(Document, str(document_id))
    if document is None:
        return []
    return apply_tracking(database, _collect(database, document.id, document.original_filename, today))


def build_portfolio_obligations(database: Session, visible_ids, today: date | None = None) -> dict:
    """`visible_ids` is a selectable of the caller's document ids."""

    today = today or datetime.now(timezone.utc).date()
    documents = database.execute(
        select(Document.id, Document.original_filename).where(Document.id.in_(visible_ids))
    ).all()
    obligations: list[dict] = []
    for document_id, name in documents:
        obligations.extend(_collect(database, document_id, name, today))
    obligations.sort(key=_sort_key)
    apply_tracking(database, obligations)
    return summarize_obligations(obligations)


def summarize_obligations(obligations: list[dict]) -> dict:
    status_counts = Counter(item["status"] for item in obligations)
    counts = {status: status_counts.get(status, 0) for status in STATUS_ORDER}
    counts["total"] = len(obligations)
    categories = Counter(item["category"] for item in obligations)
    workflow = Counter(item.get("workflow_status", "upcoming") for item in obligations)
    return {
        "obligations": obligations,
        "counts": counts,
        "workflow_counts": {value: workflow.get(value, 0) for value in WORKFLOW_STATUSES},
        "by_category": [{"name": name, "count": count} for name, count in categories.most_common()],
    }
