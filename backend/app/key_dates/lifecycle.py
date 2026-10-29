"""Document lifecycle status: one shared evaluator, document-type rules.

    Active · Not Yet Effective · Expiring Soon · Expires Today · Expired
    No Expiration Date · Needs Review · Not Applicable

Rules by document family:

- Documents that don't expire (invoices, receipts, statements, transcripts,
  reports, tax and pay documents…) are Not Applicable. An invoice's payment
  due date is reported as a payment date, never as the document's expiry.
- Identity documents and policies end at their stated expiry / validity.
- Contracts start at award / effective / performance start and end at their
  base period end (option periods don't extend it until exercised) or a
  stated termination / expiry.
- Anything else is evaluated only from dates it actually states.

A date is used when it is unambiguous; a human-approved metadata value
(Metadata review) wins over the extracted one and is never overwritten by
re-detection. Conflicting end dates of the same kind, or an ambiguous
decisive date, give Needs Review rather than a silent choice. "Today" is the
calendar date in the configured timezone (Settings.lifecycle_timezone).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo

ACTIVE = "active"
NOT_YET_EFFECTIVE = "not_yet_effective"
EXPIRING_SOON = "expiring_soon"
EXPIRES_TODAY = "expires_today"
EXPIRED = "expired"
NO_EXPIRATION = "no_expiration_date"
NEEDS_REVIEW = "needs_review"
NOT_APPLICABLE = "not_applicable"

STATUS_LABELS = {
    ACTIVE: "Active",
    NOT_YET_EFFECTIVE: "Not Yet Effective",
    EXPIRING_SOON: "Expiring Soon",
    EXPIRES_TODAY: "Expires Today",
    EXPIRED: "Expired",
    NO_EXPIRATION: "No Expiration Date",
    NEEDS_REVIEW: "Needs Review",
    NOT_APPLICABLE: "Not Applicable",
}

WARNING_PERIODS = (30, 60, 90)

# Families whose documents don't expire.
NON_EXPIRING = frozenset({
    "invoice", "receipt", "purchase_order", "bank_check", "pay_stub", "tax_form", "utility_bill", "statement",
    "financial_report", "financial_statement", "budget", "academic_transcript", "laboratory_report",
    "technical_specification", "procurement",
})
# Families expected to state an expiry (missing one is worth saying).
EXPECTS_EXPIRY = frozenset({"passport", "driving_licence", "identity_card", "insurance_policy"})
CONTRACTS = frozenset({
    "government_contract", "contract", "master_services_agreement", "supplier_agreement", "sow", "amendment",
})

START_KINDS = ("effective", "start", "award")  # in order of preference
END_KINDS = ("expiry", "valid_until", "termination", "period_end")

# Canonical date concepts (brief) ↔ key-date kinds (storage).
CONCEPTS = {
    "issue": "issue_date",
    "award": "award_date",
    "effective": "effective_date",
    "start": "start_date",
    "period_end": "end_date",
    "expiry": "expiration_date",
    "valid_until": "expiration_date",
    "renewal": "renewal_date",
    "due": "payment_due_date",
    "termination": "termination_date",
}


@dataclass
class DateCandidate:
    """One stated date, whatever its source (extracted or human-approved)."""

    kind: str
    date: date | None
    original_text: str | None
    source: str
    page: int | None
    evidence: str | None
    confidence: float | None
    ambiguous: bool = False
    interpretations: list[str] = field(default_factory=list)
    approved: bool = False
    option: bool = False

    @property
    def concept(self) -> str:
        return CONCEPTS.get(self.kind, self.kind)


@dataclass
class Lifecycle:
    status: str
    reasons: list[str]
    start: DateCandidate | None
    end: DateCandidate | None
    renewal: DateCandidate | None
    payment_due: DateCandidate | None
    days_remaining: int | None
    review_required: list[str]
    evaluated_on: date
    warning_days: int
    timezone: str

    @property
    def label(self) -> str:
        return STATUS_LABELS[self.status]

    def as_dict(self) -> dict[str, Any]:
        return {
            "status": self.status, "label": self.label, "reasons": self.reasons, "days_remaining": self.days_remaining,
            "review_required": self.review_required, "evaluated_on": self.evaluated_on.isoformat(),
            "warning_days": self.warning_days, "timezone": self.timezone,
        }


def today_in(timezone: str) -> date:
    try:
        return datetime.now(ZoneInfo(timezone)).date()
    except Exception:  # noqa: BLE001 - an unknown zone falls back to UTC
        return datetime.now(ZoneInfo("UTC")).date()


def _usable(candidates: list[DateCandidate], kinds: tuple[str, ...]) -> list[DateCandidate]:
    return [c for c in candidates if c.kind in kinds and c.date is not None]


def _pick(candidates: list[DateCandidate], kinds: tuple[str, ...]) -> list[DateCandidate]:
    """Approved values of these kinds if any, else the extracted ones."""

    found = _usable(candidates, kinds)
    approved = [c for c in found if c.approved]
    return approved or found


def evaluate(
    family: str | None,
    candidates: list[DateCandidate],
    *,
    today: date,
    warning_days: int = 30,
    timezone: str = "UTC",
) -> Lifecycle:
    reasons: list[str] = []
    review: list[str] = []
    renewal = next(iter(sorted(_pick(candidates, ("renewal",)), key=lambda c: c.date)), None)
    due = next(iter(sorted(_pick(candidates, ("due",)), key=lambda c: c.date)), None)

    def result(status: str, start=None, end=None, days=None) -> Lifecycle:
        return Lifecycle(status, reasons, start, end, renewal, due, days, review, today, warning_days, timezone)

    if family in NON_EXPIRING:
        reasons.append("This type of document doesn't expire.")
        if due is not None:
            reasons.append(f"Its payment due date ({due.date.isoformat()}) is a payment date, not an expiry.")
        return result(NOT_APPLICABLE)

    # Start: approved first, then by preference of kind.
    start = None
    for kind in START_KINDS:
        found = _pick(candidates, (kind,))
        if found:
            start = min(found, key=lambda c: c.date)
            break

    # End: contracts end at their base period end (options don't count until
    # exercised) unless a termination / expiry is stated.
    ends = _pick(candidates, END_KINDS)
    if family in CONTRACTS:
        stated = [c for c in ends if c.kind in ("termination", "expiry", "valid_until")]
        base = [c for c in ends if c.kind == "period_end" and not c.option]
        ends = stated or base or [c for c in ends if c.kind == "period_end"]
        if not stated and not base and ends:
            reasons.append("Only option-period end dates were found; the base period end wasn't stated.")
            review.append("Confirm the contract's current end date (only option periods were found).")
        end = max(ends, key=lambda c: c.date) if ends else None
    else:
        # Different end dates of the same kind can't both be right
        # (e.g. the passport's MRZ and its printed expiry disagree).
        by_kind: dict[str, set[date]] = {}
        for c in ends:
            if not c.approved:
                by_kind.setdefault(c.kind, set()).add(c.date)
        conflicts = {k: v for k, v in by_kind.items() if len(v) > 1}
        if conflicts and not any(c.approved for c in ends):
            for kind, values in conflicts.items():
                review.append(f"Conflicting {CONCEPTS.get(kind, kind).replace('_', ' ')}s: " + ", ".join(sorted(d.isoformat() for d in values)) + ".")
            return result(NEEDS_REVIEW, start, None)
        end = min(ends, key=lambda c: c.date) if ends else None

    for decisive, name in ((start, "start"), (end, "end")):
        if decisive is not None and decisive.ambiguous and not decisive.approved:
            review.append(
                f"The {name} date “{decisive.original_text}” is ambiguous (could be "
                + " or ".join(decisive.interpretations) + "); confirm it in Metadata review."
            )
    if review:
        return result(NEEDS_REVIEW, start, end)

    if start is not None and start.date > today:
        reasons.append(f"Takes effect on {start.date.isoformat()}.")
        return result(NOT_YET_EFFECTIVE, start, end, (end.date - today).days if end else None)

    if end is None:
        if family in EXPECTS_EXPIRY:
            reasons.append("No expiry date was found, though this type of document normally states one.")
        else:
            reasons.append("The document states no expiration or end date.")
        return result(NO_EXPIRATION, start, None)

    days = (end.date - today).days
    if days < 0:
        reasons.append(f"Ended on {end.date.isoformat()} ({-days} days ago).")
        return result(EXPIRED, start, end, days)
    if days == 0:
        reasons.append("Ends today.")
        return result(EXPIRES_TODAY, start, end, 0)
    if days <= warning_days:
        reasons.append(f"Ends on {end.date.isoformat()}, within {warning_days} days.")
        return result(EXPIRING_SOON, start, end, days)
    reasons.append(f"Ends on {end.date.isoformat()}.")
    return result(ACTIVE, start, end, days)
