"""Contract Insights Search: full-text search across every visible document.

The question is read the same way Ask Dataomatix reads it (terms, FAR/DFARS
shorthand, clause numbers), the page text is searched passage by passage
(clause-bounded chunks, BM25 with an exact clause-number boost), and each
matching document comes back with its best passages highlighted, the clauses
it cites that match, and the headline contract facts the document page shows.

Facets are counted over the query's matching set before pagination; each
facet ignores its own filter, so picking "DFARS" still shows how many
documents a "FAR" pick would add.
"""

from __future__ import annotations

import logging
import re
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime
from urllib.parse import quote

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.document import Document
from app.models.document_clause_reference import DocumentClauseReference
from app.models.document_staging_workbook import DocumentStagingWorkbook
from app.services import ask_engine
from app.services.dashboard_stats import compute_document_status
from app.staging.document_labels import profile_label, type_label

logger = logging.getLogger(__name__)

MAX_LIMIT = 50
PASSAGES_PER_DOCUMENT = 3
MATCHED_CLAUSES_PER_DOCUMENT = 8
CLAUSE_NUMBER_BOOST = 6.0
CLAUSE_TOPIC_BOOST = 1.0
METADATA_BOOST = 0.5
NOT_STAGED = "Not staged"

FACT_FIELDS: list[tuple[str, tuple[str, ...]]] = [
    ("Contract Number", ("Contract Number",)),
    ("Contractor", ("Contractor", "Contractor Name", "Offeror")),
    ("Award Date", ("Award Date", "Date Issued")),
    ("Award Amount", ("Award Amount", "Total Award Amount")),
]

FACETS = ("document_types", "families", "statuses", "clause_families", "years")

# Connective words a search box collects that say nothing about the content.
SEARCH_NOISE = frozenset("""
through using within between across among during via per upon onto into
also only just more most other such same very
""".split())

# Words too common in clause titles to pick clauses by on their own.
TOPIC_GENERIC = frozenset("""
notice notices information certification certifications certificate report reports
system systems service services contract contracts contractor government federal
general requirement requirements representation representations
""".split())

_BASE_NUMBER = re.compile(r"2?52\.\d{3}-\d{1,4}")


def base_clause_number(number: str | None) -> str:
    """"52.249-2 Alt I" -> "52.249-2"; other text is returned trimmed."""

    match = _BASE_NUMBER.search(number or "")
    return match.group(0) if match else (number or "").strip()


@dataclass
class SearchFilters:
    document_types: list[str] = field(default_factory=list)
    families: list[str] = field(default_factory=list)
    statuses: list[str] = field(default_factory=list)
    clause_families: list[str] = field(default_factory=list)
    has_clauses: list[str] = field(default_factory=list)
    years: list[str] = field(default_factory=list)
    uploaded_from: date | None = None
    uploaded_to: date | None = None


@dataclass
class _Candidate:
    document: Document
    type_label: str
    family_label: str
    profile_id: str | None
    status: str
    year: str
    clause_families: set[str]
    clause_numbers: set[str]
    raw_score: float = 0.0
    passages: list = field(default_factory=list)
    matched_clauses: list[dict] = field(default_factory=list)


def _uploaded_date(document: Document) -> date | None:
    value = document.uploaded_at
    if isinstance(value, datetime):
        return value.date()
    return value


def _candidates(database: Session, visible_ids) -> list[_Candidate]:
    documents = list(database.scalars(select(Document).where(Document.id.in_(visible_ids))))
    if not documents:
        return []
    ids = [document.id for document in documents]
    pins = {
        pin.document_id: pin
        for pin in database.scalars(
            select(DocumentStagingWorkbook).where(DocumentStagingWorkbook.document_id.in_(ids))
        )
    }
    families: dict[str, set[str]] = defaultdict(set)
    numbers: dict[str, set[str]] = defaultdict(set)
    for document_id, family, number in database.execute(
        select(
            DocumentClauseReference.document_id,
            DocumentClauseReference.clause_family,
            DocumentClauseReference.clause_number,
        ).where(DocumentClauseReference.document_id.in_(ids))
    ):
        if number:
            numbers[document_id].add(base_clause_number(number))
            families[document_id].add(
                "DFARS" if number.startswith("252.") else (family or "FAR").upper()
            )
    candidates = []
    for document in documents:
        pin = pins.get(document.id)
        try:
            labelled_type = type_label(database, document, pin) if pin else NOT_STAGED
        except Exception:  # noqa: BLE001 - a label must never fail the search
            logger.exception("type label unavailable for %s", document.id)
            labelled_type = profile_label(pin.profile_id) if pin else NOT_STAGED
        uploaded = _uploaded_date(document)
        candidates.append(_Candidate(
            document=document,
            type_label=labelled_type,
            family_label=profile_label(pin.profile_id) if pin else NOT_STAGED,
            profile_id=pin.profile_id if pin else None,
            status=compute_document_status(database, document),
            year=str(uploaded.year) if uploaded else "Unknown",
            clause_families=families.get(document.id, set()),
            clause_numbers=numbers.get(document.id, set()),
        ))
    return candidates


def _facet_values(candidate: _Candidate, facet: str) -> set[str]:
    if facet == "document_types":
        return {candidate.type_label}
    if facet == "families":
        return {candidate.family_label}
    if facet == "statuses":
        return {candidate.status}
    if facet == "clause_families":
        return candidate.clause_families
    if facet == "years":
        return {candidate.year}
    return set()


def _passes(candidate: _Candidate, filters: SearchFilters, skip: str | None = None) -> bool:
    for facet in FACETS:
        if facet == skip:
            continue
        wanted = set(getattr(filters, facet))
        if wanted and not (_facet_values(candidate, facet) & wanted):
            return False
    if filters.has_clauses:
        wanted_numbers = {base_clause_number(number) for number in filters.has_clauses if number.strip()}
        if wanted_numbers and not wanted_numbers <= candidate.clause_numbers:
            return False
    uploaded = _uploaded_date(candidate.document)
    if filters.uploaded_from and (uploaded is None or uploaded < filters.uploaded_from):
        return False
    if filters.uploaded_to and (uploaded is None or uploaded > filters.uploaded_to):
        return False
    return True


def highlight_spans(snippet: str, terms: list[str], clause_numbers: list[str]) -> list[list[int]]:
    """[start, end) offsets of every query term and clause number in the
    snippet, merged where they overlap."""

    lowered = snippet.lower()
    spans: list[tuple[int, int]] = []
    for needle in {*clause_numbers, *terms}:
        if not needle:
            continue
        for match in re.finditer(rf"(?<![a-z0-9]){re.escape(needle.lower())}(?![a-z0-9])", lowered):
            spans.append((match.start(), match.end()))
    spans.sort()
    merged: list[list[int]] = []
    for start, end in spans:
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return merged


def _passage_href(document_id: str, page: int, snippet: str) -> str:
    highlight = " ".join(snippet.lstrip("… ").split())[:60]
    return f"/documents/{document_id}?view=source&page={page}&hl={quote(highlight)}"


def _score_query(database: Session, candidates: list[_Candidate], intent: ask_engine.Intent) -> None:
    terms = scoring_terms(intent)
    clause_numbers = intent.clause_numbers
    by_id = {candidate.document.id: candidate for candidate in candidates}

    # Passages: BM25 across the whole visible corpus, so IDF is shared.
    chunks = []
    for candidate in candidates:
        chunks.extend(ask_engine.document_chunks(database, candidate.document.id))
    for score, chunk in ask_engine.rank_passages(chunks, terms, clause_numbers, limit=len(chunks) or 1):
        candidate = by_id[chunk.document_id]
        if len(candidate.passages) >= PASSAGES_PER_DOCUMENT:
            continue
        candidate.passages.append((score, chunk))
        candidate.raw_score += score

    # Clauses the document cites: by number (the question named it or its
    # shorthand did), or by a topic word in the clause title.
    wanted = set(clause_numbers)
    topics = [
        topic for topic in intent.topic_terms
        if topic not in TOPIC_GENERIC and topic not in SEARCH_NOISE
    ] if intent.wants_clauses or not wanted else []
    if (wanted or topics) and candidates:
        references = database.scalars(
            select(DocumentClauseReference)
            .where(DocumentClauseReference.document_id.in_(list(by_id)))
            .order_by(DocumentClauseReference.row_index)
        )
        seen: set[tuple[str, str]] = set()
        for reference in references:
            number = reference.clause_number or ""
            key = (reference.document_id, number)
            if key in seen:
                continue
            title = ask_engine.clause_title(reference)
            by_number = base_clause_number(number) in wanted
            by_topic = bool(title) and any(topic in title.lower() for topic in topics)
            if not (by_number or by_topic):
                continue
            seen.add(key)
            candidate = by_id[reference.document_id]
            candidate.raw_score += CLAUSE_NUMBER_BOOST if by_number else CLAUSE_TOPIC_BOOST
            if len(candidate.matched_clauses) < MATCHED_CLAUSES_PER_DOCUMENT:
                candidate.matched_clauses.append({
                    "clause_number": number,
                    "title": title,
                    "page": ask_engine.clause_page(reference),
                })

    # Metadata: a document with no text can still match on its name or labels.
    for candidate in candidates:
        haystack = " ".join([
            candidate.document.original_filename or "",
            candidate.type_label,
            candidate.family_label,
        ]).lower()
        hits = sum(1 for term in terms if term in haystack)
        candidate.raw_score += METADATA_BOOST * hits


def scoring_terms(intent: ask_engine.Intent) -> list[str]:
    return [term for term in intent.terms if term not in SEARCH_NOISE]


def _facts(database: Session, candidate: _Candidate) -> list[dict]:
    if not (candidate.profile_id or "").startswith("contract"):
        return []
    try:
        data = ask_engine.contract_facts(database, candidate.document.id)
    except Exception:  # noqa: BLE001 - facts are a convenience, never a failure
        logger.exception("contract facts unavailable for %s", candidate.document.id)
        return []
    facts = []
    for label, lookups in FACT_FIELDS:
        fact = data.fact(*lookups)
        if not fact.value:
            continue
        value = " ".join(str(fact.value).strip().splitlines()[0].split())
        facts.append({"label": label, "value": value, "page": fact.page})
    return facts


def search_insights(
    database: Session,
    visible_ids,
    q: str = "",
    filters: SearchFilters | None = None,
    sort: str = "relevance",
    limit: int = 20,
    offset: int = 0,
) -> dict:
    """`visible_ids` is a selectable of the caller's document ids."""

    started = time.perf_counter()
    filters = filters or SearchFilters()
    query = " ".join((q or "").split())
    limit = max(1, min(limit, MAX_LIMIT))
    offset = max(0, offset)

    candidates = _candidates(database, visible_ids)
    intent = ask_engine.parse_question(query) if query else None
    if intent is not None:
        _score_query(database, candidates, intent)
        matching = [candidate for candidate in candidates if candidate.raw_score > 0]
    else:
        matching = candidates

    facets = {}
    for facet in FACETS:
        counts: Counter = Counter()
        for candidate in matching:
            if _passes(candidate, filters, skip=facet):
                counts.update(_facet_values(candidate, facet))
        ordered = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
        if facet == "years":
            ordered = sorted(counts.items(), key=lambda item: item[0], reverse=True)
        facets[facet] = [{"value": value, "count": count} for value, count in ordered]

    filtered = [candidate for candidate in matching if _passes(candidate, filters)]
    newest = lambda candidate: candidate.document.uploaded_at or datetime.min  # noqa: E731
    if intent is not None and sort != "newest":
        filtered.sort(key=newest, reverse=True)
        filtered.sort(key=lambda candidate: candidate.raw_score, reverse=True)
    else:
        filtered.sort(key=newest, reverse=True)
    top = max((candidate.raw_score for candidate in filtered), default=0.0)

    terms = scoring_terms(intent) if intent else []
    clause_numbers = intent.clause_numbers if intent else []
    results = []
    for candidate in filtered[offset:offset + limit]:
        document = candidate.document
        passages = []
        for _, chunk in candidate.passages:
            snippet = ask_engine.best_snippet(chunk.text, terms, clause_numbers)
            passages.append({
                "page": chunk.page,
                "snippet": snippet,
                "highlights": highlight_spans(snippet, terms, clause_numbers),
                "href": _passage_href(document.id, chunk.page, snippet),
            })
        results.append({
            "document_id": document.id,
            "document_name": document.original_filename,
            "document_type": candidate.type_label,
            "family_label": candidate.family_label,
            "status": candidate.status,
            "uploaded_at": document.uploaded_at.isoformat() if document.uploaded_at else None,
            "score": round(candidate.raw_score / top, 3) if intent is not None and top > 0 else None,
            "facts": _facts(database, candidate),
            "passages": passages,
            "matched_clauses": candidate.matched_clauses,
        })

    return {
        "query": query,
        "total": len(filtered),
        "results": results,
        "facets": facets,
        "terms": list(dict.fromkeys([*clause_numbers, *terms])),
        "took_ms": round((time.perf_counter() - started) * 1000),
    }
