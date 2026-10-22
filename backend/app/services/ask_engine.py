"""DataoAI: grounded question answering over the caller's documents.

No model writes the answer. A question is routed to what extraction already
stored and verified, and every sentence in the answer cites a page:

* field questions ("who is the contractor?") read the persisted staging
  workbook, the same values the document page shows;
* clause questions ("which contracts include DFARS 252.204-7012?") read the
  extracted clause references, with FAR/DFARS shorthand expanded
  ("cybersecurity" -> 252.204-7012);
* obligation questions read the obligations tracker;
* everything is backed by passages retrieved from the page text, which is
  split on clause and section boundaries (never mid-clause) and ranked with
  BM25 plus an exact clause-number boost.
"""

from __future__ import annotations

import logging
import math
import re
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from urllib.parse import quote

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models.document import Document
from app.models.document_clause_reference import DocumentClauseReference
from app.models.document_page import DocumentPage

logger = logging.getLogger(__name__)

ENGINE = "grounded-retrieval"
MAX_PASSAGES = 5
MAX_CITATIONS = 24
SNIPPET_CHARS = 280
CHUNK_TARGET = 900
CHUNK_MAX = 1400
CACHE_SECONDS = 300

# --- question understanding --------------------------------------------------

CLAUSE_RE = re.compile(r"\b(2?52\.\d{3}-\d{1,4})\b")
_DFARS_RE = re.compile(r"^252\.")

# Shorthand people use for clauses they don't cite by number.
CLAUSE_SYNONYMS: list[tuple[tuple[str, ...], tuple[str, ...]]] = [
    (("cybersecurity", "cyber security", "cyber incident", "covered defense information", "cdi", "nist 800-171", "800-171"),
     ("252.204-7012", "252.204-7019", "252.204-7020")),
    (("cmmc",), ("252.204-7021", "252.204-7012")),
    (("safeguarding", "federal contract information", "fci"), ("52.204-21",)),
    (("kaspersky",), ("52.204-23",)),
    (("section 889", "huawei", "zte", "telecommunications equipment", "video surveillance"),
     ("52.204-24", "52.204-25", "52.204-26")),
    (("bytedance", "tiktok"), ("52.204-27",)),
    (("e-verify", "everify"), ("52.222-54",)),
    (("option to extend", "extend the term", "option period", "options"), ("52.217-8", "52.217-9")),
    (("termination for convenience",), ("52.249-1", "52.249-2", "52.249-4", "52.249-6")),
    (("termination for default", "default termination"), ("52.249-8", "52.249-9", "52.249-10")),
    (("termination",), ("52.249-1", "52.249-2", "52.249-6", "52.249-8", "52.249-9", "52.249-10")),
    (("wawf", "wide area workflow", "invoicing", "invoice", "payment request"), ("252.232-7006", "52.232-25")),
    (("prompt payment",), ("52.232-25",)),
    (("electronic funds transfer", "eft", "sam registration"), ("52.232-33",)),
    (("limitation of funds", "limitation of cost"), ("52.232-22", "52.232-20")),
    (("service contract labor", "service contract act", "sca"), ("52.222-41",)),
    (("subcontracting plan", "small business subcontracting"), ("52.219-9",)),
    (("limitations on subcontracting",), ("52.219-14",)),
    (("disputes",), ("52.233-1",)),
    (("changes clause", "changes"), ("52.243-1", "52.243-4")),
    (("inspection",), ("52.246-2", "52.246-4", "52.246-12")),
    (("iuid", "unique identification"), ("252.211-7003",)),
    (("stop work", "stop-work"), ("52.242-15",)),
    (("vets-4212", "veterans"), ("52.222-37",)),
    (("whistleblower",), ("52.203-17",)),
    (("trafficking",), ("52.222-50",)),
]

# Field questions -> staging-workbook labels (first found wins), shown as `label`.
FIELD_INTENTS: list[tuple[tuple[str, ...], list[tuple[str, tuple[str, ...]]]]] = [
    (("contractor", "vendor", "awardee", "supplier", "offeror", "who won", "who is the company"),
     [("Contractor", ("Contractor", "Contractor Name", "Offeror"))]),
    (("contracting officer", "who signed"),
     [("Contracting Officer", ("Contracting Officer",))]),
    (("agency", "issuing office", "issued by", "customer", "contracting office"),
     [("Issuing Office / Agency", ("Agency / Office", "Issued By", "Contracting Office"))]),
    (("award date", "when was it awarded", "when was the contract awarded", "awarded on", "date awarded"),
     [("Award Date", ("Award Date", "Date Issued"))]),
    (("contract number", "piid", "contract no"),
     [("Contract Number", ("Contract Number",))]),
    (("solicitation",), [("Solicitation Number", ("Solicitation Number", "Solicitation / RFP"))]),
    (("vehicle",), [("Contract Vehicle", ("Contract Vehicle",))]),
    (("contract type", "pricing arrangement", "firm fixed", "type of contract"),
     [("Contract Type", ("Contract Type",))]),
    (("award amount", "how much", "value", "worth", "ceiling", "total amount", "dollar", "minimum guarantee", "price"),
     [("Award Amount", ("Award Amount", "Total Award Amount")),
      ("Ceiling / Max Aggregate", ("Ceiling / Max Aggregate", "Ceiling Amount", "Ceiling")),
      ("Minimum Guarantee", ("Minimum Guarantee",)),
      ("Task Order Range", ("Task Order Range",))]),
    (("naics", "size standard", "small business size"),
     [("NAICS", ("NAICS",)), ("Size Standard", ("Size Standard",))]),
    (("period of performance", "pop", "start date", "end date", "duration", "expire", "expiring", "expiration", "when does", "term of the contract"),
     [("Performance Start", ("Performance Start",)), ("Base Period", ("Base Period",)),
      ("Options", ("Options",)), ("Max Duration", ("Max Duration",))]),
]

OBLIGATION_WORDS = ("obligation", "deadline", "due", "deliverable", "milestone", "report", "notify",
                    "notification", "must the contractor", "required to submit", "reporting")
LIST_CLAUSES_RE = re.compile(r"\b(list|show|which|what)\b.*\b(dfars|far)\b.*\bclauses?\b|\b(dfars|far) clauses\b", re.I)
WITHIN_DAYS_RE = re.compile(r"(?:next|within|in)\s+(\d{1,4})\s+days", re.I)

STOPWORDS = set("""
a an the and or of to in on for by with at from as is are was were be been being this that these those
it its into about which what who whom whose when where why how does do did has have had any all each
contract contracts document documents clause clauses please show list me tell find give us our their
there than then can could would should shall will may might must not no yes if per under over
""".split())

# Question words that say what to do, not what the clause is about.
TOPIC_NOISE = set("""
summarize summary extract explain describe include includes included contain contains key main
requirement requirements provision provisions clause clauses contractor government agency
which where there these those about regarding related relevant applicable
""".split())

TOKEN_RE = re.compile(r"2?52\.\d{3}-\d{1,4}|[a-z0-9]+(?:[-'][a-z0-9]+)*")


def _tokens(text: str) -> list[str]:
    return [token for token in TOKEN_RE.findall(text.lower()) if token not in STOPWORDS and len(token) > 1]


@dataclass
class Intent:
    clause_numbers: list[str] = field(default_factory=list)
    clause_numbers_explicit: bool = False
    clause_family: str | None = None  # "FAR" / "DFARS" listing
    field_groups: list[list[tuple[str, tuple[str, ...]]]] = field(default_factory=list)
    obligations: bool = False
    within_days: int | None = None
    terms: list[str] = field(default_factory=list)
    # Topic words matched against clause titles ("termination", "payment").
    topic_terms: list[str] = field(default_factory=list)
    wants_clauses: bool = False


def parse_question(question: str) -> Intent:
    lowered = f" {question.lower()} "
    intent = Intent()
    explicit = CLAUSE_RE.findall(lowered)
    intent.clause_numbers = list(dict.fromkeys(explicit))
    intent.clause_numbers_explicit = bool(explicit)
    expansion_terms: list[str] = []
    if not explicit:
        for phrases, numbers in CLAUSE_SYNONYMS:
            if any(_has_phrase(lowered, phrase) for phrase in phrases):
                intent.clause_numbers.extend(n for n in numbers if n not in intent.clause_numbers)
                expansion_terms.extend(numbers)
                # Several shorthand groups can overlap ("termination for
                # convenience" also says "termination"); the first, most
                # specific match wins.
                break
    if LIST_CLAUSES_RE.search(question) and not intent.clause_numbers:
        intent.clause_family = "DFARS" if "dfars" in lowered else "FAR"
    for phrases, fields in FIELD_INTENTS:
        if any(_has_phrase(lowered, phrase) for phrase in phrases):
            intent.field_groups.append(fields)
    intent.obligations = any(_has_phrase(lowered, word) for word in OBLIGATION_WORDS)
    within = WITHIN_DAYS_RE.search(question)
    if within:
        intent.within_days = int(within.group(1))
        if not intent.obligations and any(w in lowered for w in ("expir", "end", "due")):
            intent.obligations = True
    intent.terms = list(dict.fromkeys(_tokens(question) + expansion_terms))
    intent.wants_clauses = bool(expansion_terms) or any(
        _has_phrase(lowered, word) for word in ("clause", "clauses", "provision", "provisions", "requirements")
    )
    intent.topic_terms = [
        term for term in _tokens(question)
        if len(term) >= 5 and not CLAUSE_RE.fullmatch(term) and term not in TOPIC_NOISE
    ]
    return intent


def _has_phrase(lowered: str, phrase: str) -> bool:
    return re.search(rf"(?<![a-z0-9]){re.escape(phrase)}(?![a-z0-9])", lowered) is not None


# --- passages: clause-boundary chunking + BM25 -------------------------------

# A new chunk starts at a clause citation heading, a SECTION heading, or a
# numbered/lettered article heading - never in the middle of a clause.
BOUNDARY_RE = re.compile(
    r"^\s*(?:(?:FAR|DFARS)\s+)?2?52\.\d{3}-\d{1,4}\b"
    r"|^\s*SECTION\s+[A-M]\b"
    r"|^\s*PART\s+[IVX]+\b"
    r"|^\s*[A-M]\.\d+(?:\.\d+)*\s+[A-Z]"
    r"|^\s*ARTICLE\s+\w+",
    re.IGNORECASE | re.MULTILINE,
)


@dataclass
class Chunk:
    document_id: str
    page: int
    text: str
    tokens: Counter
    length: int
    clause_numbers: frozenset


def chunk_page(document_id: str, page: int, text: str) -> list[Chunk]:
    text = (text or "").replace("\r", "")
    if not text.strip():
        return []
    starts = sorted({0, *[match.start() for match in BOUNDARY_RE.finditer(text)]})
    sections = [text[start:end] for start, end in zip(starts, starts[1:] + [len(text)])]
    pieces: list[str] = []
    for section in sections:
        section = section.strip()
        if not section:
            continue
        if len(section) <= CHUNK_MAX:
            pieces.append(section)
            continue
        # A long clause splits on paragraphs, then sentences, keeping its heading in front.
        heading = section.splitlines()[0][:120]
        buffer = ""
        for paragraph in re.split(r"\n\s*\n|(?<=[.;:])\s+(?=\([a-z0-9]{1,4}\)\s)", section):
            paragraph = paragraph.strip()
            if not paragraph:
                continue
            if buffer and len(buffer) + len(paragraph) > CHUNK_TARGET:
                pieces.append(buffer)
                buffer = f"{heading} … {paragraph}" if not paragraph.startswith(heading) else paragraph
            else:
                buffer = f"{buffer}\n{paragraph}" if buffer else paragraph
            while len(buffer) > CHUNK_MAX:
                cut = buffer.rfind(". ", 0, CHUNK_MAX)
                cut = cut + 1 if cut > CHUNK_TARGET // 2 else CHUNK_MAX
                pieces.append(buffer[:cut])
                buffer = f"{heading} … {buffer[cut:].strip()}"
        if buffer:
            pieces.append(buffer)
    # Merge fragments too small to stand alone (page furniture, short headings).
    merged: list[str] = []
    for piece in pieces:
        if merged and len(piece) < 160 and len(merged[-1]) + len(piece) <= CHUNK_MAX:
            merged[-1] = f"{merged[-1]}\n{piece}"
        else:
            merged.append(piece)
    chunks = []
    for piece in merged:
        tokens = Counter(_tokens(piece))
        if not tokens:
            continue
        chunks.append(Chunk(
            document_id=document_id,
            page=page,
            text=piece,
            tokens=tokens,
            length=sum(tokens.values()),
            clause_numbers=frozenset(CLAUSE_RE.findall(piece)),
        ))
    return chunks


_chunk_cache: dict[str, tuple[tuple, float, list[Chunk]]] = {}


def _document_chunks(database: Session, document_id: str) -> list[Chunk]:
    stamp = database.execute(
        select(func.count(DocumentPage.id), func.max(DocumentPage.extracted_at))
        .where(DocumentPage.document_id == document_id)
    ).one()
    key = (stamp[0], str(stamp[1]))
    cached = _chunk_cache.get(document_id)
    if cached and cached[0] == key and time.monotonic() - cached[1] < CACHE_SECONDS * 12:
        return cached[2]
    chunks: list[Chunk] = []
    for page_number, text in database.execute(
        select(DocumentPage.page_number, DocumentPage.final_text)
        .where(DocumentPage.document_id == document_id)
        .order_by(DocumentPage.page_number)
    ):
        chunks.extend(chunk_page(document_id, page_number, text))
    _chunk_cache[document_id] = (key, time.monotonic(), chunks)
    return chunks


def rank_passages(chunks: list[Chunk], terms: list[str], clause_numbers: list[str], limit: int) -> list[tuple[float, Chunk]]:
    if not chunks or not terms:
        return []
    k1, b = 1.4, 0.75
    average = sum(chunk.length for chunk in chunks) / len(chunks)
    frequency = Counter()
    for chunk in chunks:
        frequency.update(set(chunk.tokens) & set(terms))
    total = len(chunks)
    wanted = set(clause_numbers)
    scored = []
    for chunk in chunks:
        score = 0.0
        for term in terms:
            tf = chunk.tokens.get(term, 0)
            if not tf:
                continue
            idf = math.log(1 + (total - frequency[term] + 0.5) / (frequency[term] + 0.5))
            score += idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * chunk.length / average))
        # The clause itself outranks a passage that merely mentions its words.
        if wanted and chunk.clause_numbers & wanted:
            score += 6.0
        if score > 0:
            scored.append((score, chunk))
    scored.sort(key=lambda item: (-item[0], item[1].page))
    # One passage per (document, page) keeps the evidence varied.
    seen: set[tuple[str, int]] = set()
    results = []
    for score, chunk in scored:
        key = (chunk.document_id, chunk.page)
        if key in seen:
            continue
        seen.add(key)
        results.append((score, chunk))
        if len(results) == limit:
            break
    return results


def _best_snippet(text: str, terms: list[str], clause_numbers: list[str]) -> str:
    flat = " ".join(text.split())
    if len(flat) <= SNIPPET_CHARS:
        return flat
    lowered = flat.lower()
    anchors = [lowered.find(number) for number in clause_numbers] + [lowered.find(term) for term in terms]
    anchors = [anchor for anchor in anchors if anchor >= 0]
    start = max(0, min(anchors) - 60) if anchors else 0
    if start:
        space = flat.find(" ", start)
        start = space + 1 if 0 <= space < start + 30 else start
    snippet = flat[start:start + SNIPPET_CHARS]
    return ("… " if start else "") + snippet.strip() + ("…" if start + SNIPPET_CHARS < len(flat) else "")


# --- answer assembly ---------------------------------------------------------


class _Citations:
    def __init__(self) -> None:
        self.items: list[dict] = []
        self._index: dict[tuple, int] = {}

    def add(self, document_id: str, document_name: str, page: int | None, snippet: str, highlight: str | None = None) -> int | None:
        key = (document_id, page, snippet[:80])
        if key in self._index:
            return self._index[key]
        if len(self.items) >= MAX_CITATIONS:
            return None
        n = len(self.items) + 1
        href = f"/documents/{document_id}?view=source"
        if page:
            href += f"&page={page}"
            if highlight:
                href += f"&hl={quote(' '.join(highlight.split())[:80])}"
        self.items.append({
            "n": n,
            "document_id": document_id,
            "document_name": document_name,
            "page": page,
            "snippet": snippet,
            "href": href,
        })
        self._index[key] = n
        return n


def _marker(n: int | None) -> str:
    return f"[{n}]" if n else ""


def _human_list(items: list[str]) -> str:
    if len(items) <= 2:
        return " and ".join(items)
    return ", ".join(items[:-1]) + ", and " + items[-1]


def _clause_page(reference: DocumentClauseReference) -> int | None:
    evidence = reference.evidence_json if isinstance(reference.evidence_json, dict) else {}
    for key in ("page_number", "page", "source_page"):
        value = evidence.get(key)
        if isinstance(value, int) and value > 0:
            return value
    pages = evidence.get("pages")
    if isinstance(pages, list) and pages and isinstance(pages[0], int):
        return pages[0]
    return None


def _clause_snippet(reference: DocumentClauseReference) -> str:
    evidence = reference.evidence_json if isinstance(reference.evidence_json, dict) else {}
    for key in ("source_text", "evidence", "text", "snippet"):
        value = evidence.get(key)
        if isinstance(value, str) and value.strip():
            return " ".join(value.split())[:SNIPPET_CHARS]
    title = f" {reference.title}" if reference.title else ""
    family = (reference.clause_family or "").upper()
    return f"{family} {reference.clause_number}{title}".strip()


_contract_cache: dict[str, tuple[float, object]] = {}


def _contract_data(database: Session, document_id: str):
    cached = _contract_cache.get(document_id)
    if cached and time.monotonic() - cached[0] < CACHE_SECONDS:
        return cached[1]
    from app.services.document_actions import load_contract_data

    data = load_contract_data(database, document_id)
    _contract_cache[document_id] = (time.monotonic(), data)
    return data


def answer_question(
    database: Session,
    visible_ids,
    question: str,
    document_id: str | None = None,
    today: date | None = None,
) -> dict:
    """`visible_ids` is a selectable of the caller's document ids."""

    question = " ".join(question.split())
    today = today or datetime.now(timezone.utc).date()
    intent = parse_question(question)

    statement = select(Document.id, Document.original_filename).where(Document.id.in_(visible_ids))
    if document_id:
        statement = statement.where(Document.id == document_id)
    names = {row.id: row.original_filename for row in database.execute(statement)}
    scope = {
        "document_id": document_id,
        "document_name": names.get(document_id) if document_id else None,
        "document_count": len(names),
    }
    citations = _Citations()
    facts: list[dict] = []
    clause_matches: list[dict] = []
    obligations: list[dict] = []
    sentences: list[str] = []
    hits: Counter = Counter()

    # Clause presence: the extracted clause references, per document.
    references: dict[str, list[DocumentClauseReference]] = defaultdict(list)
    if (intent.clause_numbers or intent.clause_family) and names:
        query = select(DocumentClauseReference).where(DocumentClauseReference.document_id.in_(list(names)))
        if intent.clause_numbers:
            query = query.where(DocumentClauseReference.clause_number.in_(intent.clause_numbers))
        for reference in database.scalars(query.order_by(DocumentClauseReference.row_index)):
            references[reference.document_id].append(reference)

    if intent.clause_numbers and names:
        for number in intent.clause_numbers:
            found_in: list[str] = []
            for doc_id, name in names.items():
                match = next((ref for ref in references.get(doc_id, []) if ref.clause_number == number), None)
                if match is None:
                    if document_id or intent.clause_numbers_explicit:
                        clause_matches.append({
                            "document_id": doc_id, "document_name": name, "clause_number": number,
                            "title": None, "present": False, "page": None, "citation": None,
                        })
                    continue
                page = _clause_page(match)
                n = citations.add(doc_id, name, page, _clause_snippet(match), highlight=number)
                clause_matches.append({
                    "document_id": doc_id, "document_name": name, "clause_number": number,
                    "title": _title(match), "present": True, "page": page, "citation": n,
                })
                hits[doc_id] += 1
                found_in.append(f"{name}{_marker(n)}")
            label = _clause_label(number, references)
            if found_in:
                sentences.append(f"{label} appears in {_human_list(found_in)}.")
            elif intent.clause_numbers_explicit:
                where = scope["document_name"] or (
                    f"any of your {len(names)} documents" if len(names) != 1 else next(iter(names.values()))
                )
                sentences.append(f"{label} was not found among the clauses extracted from {where}.")
        if not intent.clause_numbers_explicit and not any(match["present"] for match in clause_matches):
            # Shorthand that matched no extracted clause: don't list every miss.
            clause_matches = []

    if intent.clause_family and names:
        for doc_id, name in names.items():
            listed = [
                ref for ref in references.get(doc_id, [])
                if (ref.clause_family or "").upper() == intent.clause_family
                or (intent.clause_family == "DFARS" and _DFARS_RE.match(ref.clause_number or ""))
            ]
            unique: dict[str, DocumentClauseReference] = {}
            for ref in listed:
                unique.setdefault(ref.clause_number, ref)
            if not unique:
                continue
            hits[doc_id] += len(unique)
            for number, ref in list(unique.items())[:40]:
                page = _clause_page(ref)
                n = citations.add(doc_id, name, page, _clause_snippet(ref), highlight=number)
                clause_matches.append({
                    "document_id": doc_id, "document_name": name, "clause_number": number,
                    "title": _title(ref), "present": True, "page": page, "citation": n,
                })
            sample = ", ".join(list(unique)[:6])
            more = f", and {len(unique) - 6} more" if len(unique) > 6 else ""
            sentences.append(f"{name} cites {len(unique)} {intent.clause_family} clauses: {sample}{more}.")

    # Topic questions ("summarize termination clauses"): every cited clause
    # whose title carries the topic, beyond the shorthand's fixed numbers.
    if intent.wants_clauses and not intent.clause_numbers_explicit and intent.topic_terms and names:
        already = {(match["document_id"], match["clause_number"]) for match in clause_matches if match["present"]}
        conditions = [DocumentClauseReference.title.ilike(f"%{term}%") for term in intent.topic_terms]
        topical: dict[str, dict[str, DocumentClauseReference]] = defaultdict(dict)
        for ref in database.scalars(
            select(DocumentClauseReference)
            .where(DocumentClauseReference.document_id.in_(list(names)), or_(*conditions))
            .order_by(DocumentClauseReference.row_index)
        ):
            if (ref.document_id, ref.clause_number) not in already:
                topical[ref.document_id].setdefault(ref.clause_number, ref)
        topic = _human_list([f"“{term}”" for term in intent.topic_terms[:3]])
        for doc_id, unique in topical.items():
            name = names[doc_id]
            listed = []
            for number, ref in list(unique.items())[:20]:
                page = _clause_page(ref)
                n = citations.add(doc_id, name, page, _clause_snippet(ref), highlight=number)
                title = _title(ref)
                clause_matches.append({
                    "document_id": doc_id, "document_name": name, "clause_number": number,
                    "title": title, "present": True, "page": page, "citation": n,
                })
                listed.append(f"{number}{f' {title}' if title else ''}{_marker(n)}")
            hits[doc_id] += len(unique)
            more = f", and {len(unique) - 6} more" if len(unique) > 6 else ""
            also = " also" if any(found_doc == doc_id for found_doc, _ in already) else ""
            plural = "s" if len(unique) != 1 else ""
            sentences.append(f"{name}{also} cites {len(unique)} clause{plural} on {topic}: {'; '.join(listed[:6])}{more}.")

    # Field questions: the persisted staging workbook (what the document page shows).
    if intent.field_groups and names:
        for doc_id, name in list(names.items())[:25]:
            try:
                data = _contract_data(database, doc_id)
            except Exception:  # noqa: BLE001 - a broken workbook must not fail the question
                logger.exception("contract data unavailable for %s", doc_id)
                continue
            parts: list[str] = []
            for fields in intent.field_groups:
                for label, lookups in fields:
                    fact = data.fact(*lookups)
                    if not fact.value:
                        continue
                    value = " ".join(str(fact.value).split())
                    # Addresses follow a name on later lines; the sentence names, the fact keeps all.
                    short = " ".join(str(fact.value).strip().splitlines()[0].split()) or value
                    n = citations.add(doc_id, name, fact.page, f"{label}: {value}", highlight=value[:60])
                    facts.append({
                        "document_id": doc_id, "document_name": name, "label": label,
                        "value": value, "page": fact.page, "citation": n,
                    })
                    parts.append(f"{label.lower() if parts else label} {short}{_marker(n)}")
            if parts:
                hits[doc_id] += len(parts)
                if len(names) > 1:
                    sentences.append(f"In {name}: {_fact_sentence(parts)}")
                else:
                    sentences.append(_fact_sentence(parts))

    # Obligations: deadlines, deliverables and reporting duties.
    if intent.obligations and names:
        try:
            from app.services.obligations import build_document_obligations
        except Exception:  # noqa: BLE001 - obligations are optional evidence
            build_document_obligations = None
        if build_document_obligations is not None:
            horizon = today + timedelta(days=intent.within_days) if intent.within_days else None
            gathered: list[dict] = []
            for doc_id in list(names)[:25]:
                try:
                    gathered.extend(build_document_obligations(database, doc_id, today=today))
                except Exception:  # noqa: BLE001
                    logger.exception("obligations unavailable for %s", doc_id)
            if horizon:
                gathered = [
                    item for item in gathered
                    if item.get("due_date") and today.isoformat() <= item["due_date"] <= horizon.isoformat()
                ]
            elif intent.terms:
                wanted = set(intent.terms) - {"obligation", "obligations", "due", "deadline", "deadlines", "report", "reports"}
                if wanted:
                    focused = [
                        item for item in gathered
                        if wanted & set(_tokens(f"{item.get('title', '')} {item.get('description', '')} {item.get('source_reference', '')}"))
                    ]
                    gathered = focused or gathered
            order = {"overdue": 0, "due_soon": 1, "upcoming": 2, "ongoing": 3, "undated": 4}
            gathered.sort(key=lambda item: (order.get(item.get("status"), 9), item.get("due_date") or "9999"))
            for item in gathered[:12]:
                doc_id = item["document_id"]
                name = names.get(doc_id, item.get("document_name") or doc_id)
                snippet = item.get("evidence") or item.get("description") or item["title"]
                n = citations.add(doc_id, name, item.get("page"), " ".join(str(snippet).split())[:SNIPPET_CHARS],
                                  highlight=(item.get("evidence") or "")[:60] or None)
                obligations.append({
                    "document_id": doc_id, "document_name": name, "title": item["title"],
                    "due_date": item.get("due_date"), "status": item.get("status"),
                    "page": item.get("page"), "citation": n,
                })
                hits[doc_id] += 1
            if obligations:
                dated = [o for o in obligations if o["due_date"]]
                window = f" in the next {intent.within_days} days" if intent.within_days else ""
                lead = obligations[0]
                first = f"{lead['title']}{(' (due ' + lead['due_date'] + ')') if lead['due_date'] else ''}{_marker(lead['citation'])}"
                sentences.append(
                    f"Found {len(gathered)} obligation{'s' if len(gathered) != 1 else ''}{window}"
                    f"{f', {len(dated)} with a due date' if dated and not intent.within_days else ''}. "
                    f"First: {first}."
                )
            elif intent.within_days:
                sentences.append(f"No dated obligations fall in the next {intent.within_days} days.")

    # Supporting passages from the page text, always.
    chunks: list[Chunk] = []
    for doc_id in names:
        chunks.extend(_document_chunks(database, doc_id))
    ranked = rank_passages(chunks, intent.terms, intent.clause_numbers, MAX_PASSAGES)
    passages = []
    for score, chunk in ranked:
        name = names[chunk.document_id]
        snippet = _best_snippet(chunk.text, intent.terms, intent.clause_numbers)
        highlight = snippet.lstrip("… ")[:60]
        n = citations.add(chunk.document_id, name, chunk.page, snippet, highlight=highlight)
        passages.append({
            "document_id": chunk.document_id, "document_name": name, "page": chunk.page,
            "text": snippet, "score": round(score, 3), "citation": n,
        })
        hits[chunk.document_id] += 1

    structured = bool(facts or clause_matches or obligations)
    if not sentences and passages:
        top = passages[0]
        others = sorted({p["document_name"] for p in passages})
        sentences.append(
            f"The closest match is on page {top['page']} of {top['document_name']}{_marker(top['citation'])}: "
            f"“{_trim_quote(top['text'])}”"
        )
        if len(passages) > 1:
            more = "".join(_marker(p["citation"]) for p in passages[1:])
            spread = f" across {_human_list(others)}" if len(others) > 1 else ""
            sentences.append(f"{len(passages) - 1} more related passage{'s' if len(passages) > 2 else ''}{spread}{more}.")

    # A document with no page text was never processed: "not found" would mislead.
    unprocessed = bool(document_id and names) and not chunks
    if unprocessed:
        clause_matches = [match for match in clause_matches if match["present"]]
        structured = bool(facts or clause_matches or obligations)
    if not names:
        answer = "There are no processed documents in this workspace yet. Upload a contract to ask about it."
        answer_type = "none"
    elif unprocessed and not structured:
        answer = (
            f"{scope['document_name']} has no extracted text yet, so there is nothing to search. "
            "Process it (Reprocess on its document page), or ask across all documents."
        )
        answer_type = "none"
    elif sentences:
        answer = " ".join(sentences)
        answer_type = (
            "clauses" if clause_matches and not facts and not obligations
            else "fields" if facts
            else "obligations" if obligations
            else "clauses" if clause_matches
            else "passages"
        )
    else:
        answer = (
            "I couldn't find anything in the extracted data or page text that answers that. "
            "Try naming a clause number (e.g. 52.204-21), a field (contractor, award date) or a topic word that appears in the contract."
        )
        answer_type = "none"
    if not structured and not passages:
        answer_type = "none" if names else answer_type

    return {
        "question": question,
        "scope": scope,
        "answer": answer,
        "answer_type": answer_type,
        "facts": facts,
        "clause_matches": clause_matches,
        "obligations": obligations,
        "passages": passages,
        "citations": citations.items,
        "documents": [
            {"document_id": doc_id, "document_name": names[doc_id], "hits": count}
            for doc_id, count in hits.most_common(10)
        ],
        "suggestions": _suggestions(intent, scope),
        "unprocessed": unprocessed,
        "engine": ENGINE,
    }


def _clause_label(number: str, references: dict[str, list[DocumentClauseReference]]) -> str:
    family = "DFARS" if _DFARS_RE.match(number) else "FAR"
    title = next(
        (_title(ref) for refs in references.values() for ref in refs if ref.clause_number == number and ref.title),
        None,
    )
    return f"{family} {number}" + (f" ({title})" if title else "")


_TITLE_DATE_RE = re.compile(r"\s*\(?\b(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\.?\s+\d{4}\)?\s*$", re.I)


def _title(reference: DocumentClauseReference) -> str | None:
    """The clause title without its trailing date and layout spacing."""

    if not reference.title:
        return None
    title = _TITLE_DATE_RE.sub("", " ".join(reference.title.split())).strip(" .-")
    return title or None


def _fact_sentence(parts: list[str]) -> str:
    text = _human_list(parts)
    return text[0].upper() + text[1:] + "."


def _trim_quote(text: str, limit: int = 220) -> str:
    text = text.lstrip("… ").strip()
    return text if len(text) <= limit else text[:limit].rsplit(" ", 1)[0] + "…"


def _suggestions(intent: Intent, scope: dict) -> list[str]:
    single = bool(scope.get("document_id")) or scope.get("document_count") == 1
    suggestions = []
    if not intent.field_groups:
        suggestions.append("Who is the contractor and what is the award amount?")
    if not intent.obligations:
        suggestions.append("What obligations are due in the next 90 days?")
    if not intent.clause_numbers:
        suggestions.append(
            "Does this contract include DFARS 252.204-7012?" if single
            else "Which contracts include DFARS 252.204-7012?"
        )
    if not intent.clause_family:
        suggestions.append("List DFARS clauses")
    suggestions.append("Summarize termination clauses")
    return suggestions[:4]


# --- public helpers shared with Contract Insights Search ----------------------


def document_chunks(database: Session, document_id: str) -> list[Chunk]:
    """A document's clause-bounded passages (cached per page set)."""

    return _document_chunks(database, document_id)


def best_snippet(text: str, terms: list[str], clause_numbers: list[str]) -> str:
    return _best_snippet(text, terms, clause_numbers)


def contract_facts(database: Session, document_id: str):
    """The cached staging-workbook facts the answers cite (``.fact(*labels)``)."""

    return _contract_data(database, document_id)


def clause_page(reference: DocumentClauseReference) -> int | None:
    return _clause_page(reference)


def clause_title(reference: DocumentClauseReference) -> str | None:
    return _title(reference)
