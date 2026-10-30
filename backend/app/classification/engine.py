"""Document classification with candidates, scores and evidence.

The selected type is exactly what the staging resolver picks
(``app/staging/resolver.predict_profile``), so automatic results — and
everything built on them — are unchanged. What this adds is the account
behind it: every type the document's own content points to, how strongly,
and why, so a person can review, confirm or change it.

Signals (all read from the document, never from its file name):

* structural recognizers a profile declares (passport MRZ, FAR Part
  headings, XML records, licence layout …) — their own score and reasons;
* keyword families (``structure_detection``): the keywords actually found;
* letter structure (subject line, salutation, closing) → correspondence;
* the document's stored AI classification, when one was recorded;
* contract structure: an incorporated-clause listing plus a contract number;
* contract subtypes from form identifiers (SF 1442, SF 33, SF 30 …).

Scores are evidence strength between 0 and 1. They are **not** calibrated
probabilities; thresholds (settings) decide what needs review.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.document import Document
from app.services.structure_detection import DOCUMENT_FAMILIES, family_for_document_type, family_keyword_hits
from app.staging import registry
from app.staging.document_categories import CATEGORY_LABELS, category_for_family
from app.staging.resolver import (
    CORRESPONDENCE_FAMILY,
    CORRESPONDENCE_LABEL,
    _INCONCLUSIVE,
    _LETTER_OVERRIDABLE,
    _has_contract_structure,
    _letter_signals,
    _page_text,
    predict_profile,
)

ENGINE_VERSION = "cls-1"
_TOP_N = 5
# Keyword evidence alone never reaches certainty. Strength saturates with
# the keyword score (a two-word phrase scores 2): 4 → 0.65, 6 → 0.78, 10 → 0.90.
_KEYWORD_CAP = 0.95
_KEYWORD_SCALE = 3.5
# A competing family's keywords pull a score down by this share of theirs.
_RUNNER_UP_WEIGHT = 0.75
# A printed Standard Form number on the first pages is distinctive.
_FORM_IDENTIFIER_SCORE = 0.9
_FORM_PAGES = 2

# Subtypes by family: (label, pattern found in the document's opening pages).
CONTRACT_SUBTYPES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("SF 1442 Contract Award", re.compile(r"\b(SF|STANDARD FORM)\s*1442\b|\b1442\s*\(", re.I)),
    ("Contract Modification (SF 30)", re.compile(
        r"\b(SF|STANDARD FORM)\s*30\b|AMENDMENT OF SOLICITATION\s*/\s*MODIFICATION OF CONTRACT", re.I)),
    ("SF 33 Solicitation / Award", re.compile(r"\b(SF|STANDARD FORM)\s*33\b|SOLICITATION,\s*OFFER\s*(AND|&)\s*AWARD", re.I)),
    ("OASIS+ IDIQ", re.compile(r"\bOASIS\+?\b")),
    ("SF 26 Award / Contract", re.compile(r"\b(SF|STANDARD FORM)\s*26\b|AWARD/CONTRACT", re.I)),
)
CONTRACT_DEFAULT_SUBTYPE = "DoD / UCF Contract"
SUBTYPES: dict[str, tuple[str, ...]] = {
    "government_contract": tuple(label for label, _ in CONTRACT_SUBTYPES) + (CONTRACT_DEFAULT_SUBTYPE,),
    "invoice": ("Standard Invoice", "PO-Referenced Invoice"),
    "purchase_order": ("Purchase Order", "Purchase Order Amendment"),
    "academic_transcript": ("University Transcript", "School Transcript"),
    "bank_statement": ("Checking Account Statement", "Savings Account Statement", "Credit Card Statement"),
    "financial_statement": ("Balance Sheet", "Income Statement", "Cash Flow Statement"),
    "passport": ("Passport Book", "Passport Card"),
    "identity_card": ("National Identity Card", "Residence Permit"),
}
# (subtype, pattern) checked in order; the first that the text states wins.
_STATED_SUBTYPES: dict[str, tuple[tuple[str, re.Pattern[str]], ...]] = {
    "bank_statement": (
        ("Credit Card Statement", re.compile(r"\bcredit\s+card\b.{0,40}\bstatement\b|\bminimum\s+payment\s+due\b", re.I)),
        ("Savings Account Statement", re.compile(r"\bsavings\s+account\b", re.I)),
        ("Checking Account Statement", re.compile(r"\bchecking\s+account\b|\bchecks\s+paid\b", re.I)),
    ),
    "financial_statement": (
        ("Balance Sheet", re.compile(r"\bbalance\s+sheet\b|\bstatement\s+of\s+financial\s+position\b", re.I)),
        ("Income Statement", re.compile(r"\bincome\s+statement\b|\bstatement\s+of\s+operations\b|\bprofit\s+and\s+loss\b", re.I)),
        ("Cash Flow Statement", re.compile(r"\bstatement\s+of\s+cash\s+flows?\b|\bcash\s+flow\s+statement\b", re.I)),
    ),
    "passport": (
        ("Passport Card", re.compile(r"\bpassport\s+card\b", re.I)),
        ("Passport Book", re.compile(r"\bpassport\b", re.I)),
    ),
    "identity_card": (
        ("Residence Permit", re.compile(r"\bresidence\s+permit\b|\bpermanent\s+resident\b", re.I)),
        ("National Identity Card", re.compile(r"\bidentity\s+card\b|\bnational\s+id\b", re.I)),
    ),
}
_PO_REFERENCE = re.compile(r"\b(purchase\s+order|p\.?\s?o\.?)\s*(no\.?|number|#|:)", re.I)
_PO_AMENDMENT = re.compile(r"\b(change\s+order|purchase\s+order\s+(amendment|change)|po\s+amendment)\b", re.I)


@dataclass
class Candidate:
    family: str
    label: str
    score: float
    evidence: list[str] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)
    subtype: str | None = None

    @property
    def category(self) -> str:
        return category_for_family(self.family)

    @property
    def profile_id(self) -> str:
        profile = registry.profile_for_family(self.family) or registry.generic_profile()
        return profile.profile_id

    def as_dict(self) -> dict:
        return {
            "family": self.family,
            "label": self.label,
            "category": self.category,
            "category_label": CATEGORY_LABELS[self.category],
            "profile_id": self.profile_id,
            "subtype": self.subtype,
            "score": round(self.score, 3),
            "evidence": self.evidence,
            "sources": self.sources,
        }


@dataclass
class Prediction:
    selected: Candidate
    candidates: list[Candidate]
    status: str  # classified | review_recommended | review_required
    method: str
    reasons: list[str]
    thresholds: dict[str, float]


def family_label(family: str) -> str:
    if family == CORRESPONDENCE_FAMILY:
        return CORRESPONDENCE_LABEL
    if family in DOCUMENT_FAMILIES:
        return DOCUMENT_FAMILIES[family][0]
    profile = registry.profile_for_family(family)
    return profile.display_name if profile else family.replace("_", " ").title()


def detect_subtype(family: str, text: str) -> tuple[str | None, str | None]:
    """(subtype label, evidence) from the document's own text."""

    if family in ("government_contract", "contract"):
        for label, pattern in CONTRACT_SUBTYPES:
            match = pattern.search(text)
            if match:
                return label, f'Form identifier "{match.group(0).strip()}" found'
        return (CONTRACT_DEFAULT_SUBTYPE, None) if family == "government_contract" else (None, None)
    if family == "invoice":
        match = _PO_REFERENCE.search(text)
        return ("PO-Referenced Invoice", f'Purchase order reference "{match.group(0).strip()}" found') if match else (
            "Standard Invoice", None)
    if family == "purchase_order":
        match = _PO_AMENDMENT.search(text)
        return ("Purchase Order Amendment", f'"{match.group(0).strip()}" found') if match else ("Purchase Order", None)
    # Only a subtype the document states; never a guess.
    for label, pattern in _STATED_SUBTYPES.get(family, ()):
        match = pattern.search(text)
        if match:
            return label, f'"{match.group(0).strip()}" found'
    return None, None


def _quote(words: list[str], limit: int = 5) -> str:
    shown = ", ".join(f'"{w}"' for w in words[:limit])
    return shown + (f" (+{len(words) - limit} more)" if len(words) > limit else "")


def _candidates(database: Session, document: Document, text: str) -> dict[str, Candidate]:
    found: dict[str, Candidate] = {}

    def add(family: str, score: float, evidence: list[str], source: str) -> None:
        if not family or family in _INCONCLUSIVE:
            return
        candidate = found.setdefault(family, Candidate(family=family, label=family_label(family), score=0.0))
        candidate.score = max(candidate.score, max(0.0, min(1.0, score)))
        candidate.evidence.extend(e for e in evidence if e and e not in candidate.evidence)
        if source not in candidate.sources:
            candidate.sources.append(source)

    for profile in registry.latest_profiles():
        if profile.document_recognizer is None:
            continue
        recognition = profile.document_recognizer(database, document)
        if recognition.score > 0:
            add(profile.document_families[0], recognition.score, list(recognition.reasons),
                f"structural recognizer ({profile.display_name})")

    from app.source_structure.service import load_source_structure

    structure = load_source_structure(database, document.id)
    if structure is not None:
        for profile in registry.latest_profiles():
            if profile.recognizer is None:
                continue
            recognition = profile.recognizer(structure)
            if recognition.score > 0:
                add(profile.document_families[0], recognition.score, list(recognition.reasons),
                    f"layout recognizer ({profile.display_name})")

    opening = _opening_pages(database, document.id)
    for label, pattern in CONTRACT_SUBTYPES:
        match = pattern.search(opening)
        if match and (label.startswith("SF ") or label.startswith("Contract Modification")):
            add("government_contract", _FORM_IDENTIFIER_SCORE,
                [f'Standard Form identifier "{match.group(0).strip()}" on the first pages'], "form identifier")
            break

    hits = family_keyword_hits(text)
    for family, (score, words) in hits.items():
        rival = max((other for f, (other, _w) in hits.items() if f != family), default=0)
        strength = 1 - math.exp(-score / _KEYWORD_SCALE)
        share = score / (score + _RUNNER_UP_WEIGHT * rival)
        add(family, _KEYWORD_CAP * strength * share, [f"Keywords found: {_quote(words)}"], "keywords")

    keyword_top = max(hits, key=lambda f: hits[f][0]) if hits else None

    if keyword_top is None or keyword_top in _LETTER_OVERRIDABLE:
        signals = _letter_signals(database, document, text)
        if signals:
            add(CORRESPONDENCE_FAMILY, 0.85, [f"Letter structure: {', '.join(signals)}; no contract structure"],
                "letter structure")

    if document.document_type:
        mapped, _label = family_for_document_type(document.document_type, document.classification_confidence or 0.0)
        confidence = document.classification_confidence or 0.0
        add(mapped, min(0.9, 0.9 * confidence),
            [f'Earlier AI classification "{document.document_type}" (confidence {confidence:.2f})'],
            "stored AI classification")

    if _has_contract_structure(database, document.id):
        add("government_contract", 0.8, ["Incorporated-clause listing and a contract number"], "document structure")

    for candidate in found.values():
        subtype, evidence = detect_subtype(candidate.family, text)
        candidate.subtype = subtype
        if evidence and evidence not in candidate.evidence:
            candidate.evidence.insert(0, evidence)
    return found


def _opening_pages(database: Session, document_id: str) -> str:
    from sqlalchemy import select

    from app.models.document_page import DocumentPage

    texts = database.scalars(
        select(DocumentPage.final_text)
        .where(DocumentPage.document_id == document_id, DocumentPage.page_number <= _FORM_PAGES)
        .order_by(DocumentPage.page_number)
    )
    return "\n".join(text or "" for text in texts)


def _status(selected: Candidate, others: list[Candidate], inconclusive: bool) -> str:
    settings = get_settings()
    high, low = settings.classification_high_confidence, settings.classification_low_confidence
    if inconclusive or selected.score < low:
        return "review_required"
    contested = any(other.score >= selected.score for other in others)
    if selected.score >= high and not contested:
        return "classified"
    return "review_recommended"


def _method(reasons: list[str]) -> str:
    first = (reasons or [""])[0].lower()
    if first.startswith("structural recognition"):
        return "structural recognizer"
    if any(r.lower().startswith("structural recognition") for r in reasons):
        return "layout recognizer"
    if "letter structure" in " ".join(reasons).lower():
        return "letter structure"
    if any(r.lower().startswith("ai document classification") for r in reasons):
        return "stored AI classification"
    if any(r.lower().startswith("structural evidence") for r in reasons):
        return "document structure"
    return "keyword classifier"


def predict(database: Session, document: Document) -> Prediction:
    settings = get_settings()
    text = _page_text(database, document.id)
    found = _candidates(database, document, text)
    resolution = predict_profile(database, document)
    if not resolution.confident:
        # As staging does: a stored layout can settle what text couldn't.
        from app.source_structure.service import load_source_structure
        from app.staging.resolver import refine_with_structure

        structure = load_source_structure(database, document.id)
        if structure is not None:
            resolution = refine_with_structure(resolution, structure)
    inconclusive = resolution.family in _INCONCLUSIVE

    if inconclusive:
        selected = Candidate(family=resolution.family, label=resolution.family_label, score=0.0,
                             evidence=["No document type was recognized with enough evidence"],
                             sources=["fallback"])
    else:
        selected = found.get(resolution.family) or Candidate(
            family=resolution.family, label=resolution.family_label, score=0.5,
            evidence=list(resolution.reasons), sources=["resolver"],
        )
        if selected.subtype is None:
            selected.subtype, _ = detect_subtype(selected.family, text)
    others = sorted((c for f, c in found.items() if f != selected.family), key=lambda c: -c.score)
    ranked = [selected, *others][:_TOP_N]
    return Prediction(
        selected=selected,
        candidates=ranked,
        status=_status(selected, others, inconclusive),
        method=_method(resolution.reasons),
        reasons=list(resolution.reasons),
        thresholds={"high": settings.classification_high_confidence, "low": settings.classification_low_confidence},
    )
