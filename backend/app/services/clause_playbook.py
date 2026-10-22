"""Clause playbook: expected / prohibited / review-worthy clauses checked
against the clauses a document actually cites.

Built-in defaults live here in code; a workspace stores only its own rules
and overrides of a default (same rule_id) in clause_playbook_rules. A
document is evaluated against the clause numbers already extracted
(document_clause_references, plus the layout-built contract structure when
present) — nothing is re-extracted. A document that cites no clauses at
all is "not applicable" rather than "missing everything".

A rule's extraction patterns (phrases / regexes) are a second, weaker
signal: when a clause is not cited but a pattern matches a page, the
finding is "present_text_match" — reported, never counted as satisfied.
Verbatim clause text only ever comes from ingested FAR / DFARS records.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.clause_playbook_rule import ClausePlaybookRule
from app.models.document import Document
from app.models.document_clause_reference import DocumentClauseReference
from app.models.document_contract_structure import DocumentContractStructure
from app.models.document_far_record import DocumentFarRecord
from app.models.document_page import DocumentPage

EXPECTATIONS = ("required", "prohibited", "review")
SEVERITIES = ("high", "medium", "low")
APPLIES_TO = ("all", "dod")
SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2}

_NUMBER = re.compile(r"(?<![\d.])(\d{2,3}\.\d{3}-\d{1,4})(?![\d])")


# Clause-library categories for the built-in rules.
CAT_CYBER = "Cybersecurity & supply chain"
CAT_ETHICS = "Ethics & integrity"
CAT_LABOR = "Labor & socioeconomic programs"
CAT_PAYMENT = "Payments & funding"
CAT_DISPUTES = "Disputes & termination"
CAT_OPTIONS = "Options & contract term"

PATTERN_KINDS = ("regex", "phrase")
MAX_PATTERNS = 10
MAX_PATTERN_LENGTH = 200
MAX_NOTE_LENGTH = 300
MAX_RATIONALE_LENGTH = 4000
MAX_STANDARD_TEXT_LENGTH = 100_000
MAX_FALLBACK_TEXT_LENGTH = 20_000
MAX_CATEGORY_LENGTH = 120
MAX_AGENCY_LENGTH = 80
# A quantified group that is itself quantified — "(a+)+", "(\w*)*" — can
# backtrack catastrophically on page-length text, so it is refused.
_NESTED_QUANTIFIER = re.compile(r"\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)[+*{]")


@dataclass(frozen=True)
class PlaybookRule:
    rule_id: str
    clause_number: str
    title: str
    expectation: str
    severity: str
    rationale: str
    applies_to: str = "all"
    enabled: bool = True
    category: str = ""
    agency: str = ""
    standard_text: str = ""
    fallback_text: str = ""
    extraction_patterns: tuple = ()


def _rule(
    clause: str,
    title: str,
    expectation: str,
    severity: str,
    rationale: str,
    applies_to: str = "all",
    *,
    category: str,
    phrases: tuple[str, ...] = (),
) -> PlaybookRule:
    return PlaybookRule(
        rule_id=f"default:{clause}",
        clause_number=clause,
        title=title,
        expectation=expectation,
        severity=severity,
        rationale=rationale,
        applies_to=applies_to,
        category=category,
        # DFARS rules are DoD-specific by construction.
        agency="DoD" if clause.startswith("252.") else "",
        extraction_patterns=tuple(
            {"kind": "phrase", "pattern": phrase, "note": "Official clause title"} for phrase in phrases
        ),
    )


# Conservative starting playbook. Prescriptions have thresholds and
# exceptions, so "missing" means "confirm why", never "non-compliant".
# Title phrases are given only where the official title is distinctive
# enough that finding it in the text is worth a look.
DEFAULT_RULES: tuple[PlaybookRule, ...] = (
    _rule("52.204-21", "Basic Safeguarding of Covered Contractor Information Systems", "required", "medium",
          "Prescribed when the contractor may have Federal contract information on its systems.",
          category=CAT_CYBER, phrases=("Basic Safeguarding of Covered Contractor Information Systems",)),
    _rule("52.204-23", "Prohibition on Contracting for Hardware, Software, and Services Developed or Provided by Kaspersky Lab and Other Covered Entities",
          "required", "high", "Prescribed for solicitations and contracts generally (Section 1634, FY2018 NDAA).",
          category=CAT_CYBER, phrases=("Kaspersky Lab and Other Covered Entities",)),
    _rule("52.204-25", "Prohibition on Contracting for Certain Telecommunications and Video Surveillance Services or Equipment",
          "required", "high", "Section 889 prohibition; prescribed for solicitations and contracts generally.",
          category=CAT_CYBER,
          phrases=("Prohibition on Contracting for Certain Telecommunications and Video Surveillance Services or Equipment",)),
    _rule("52.204-27", "Prohibition on a ByteDance Covered Application", "required", "medium",
          "Prescribed for solicitations and contracts generally.",
          category=CAT_CYBER, phrases=("Prohibition on a ByteDance Covered Application",)),
    _rule("52.203-13", "Contractor Code of Business Ethics and Conduct", "required", "medium",
          "Prescribed when the value is expected to exceed the threshold (currently $6 million) and performance is 120 days or more.",
          category=CAT_ETHICS, phrases=("Contractor Code of Business Ethics and Conduct",)),
    _rule("52.222-26", "Equal Opportunity", "required", "medium",
          "Prescribed for most contracts; confirm an exemption applies if absent.", category=CAT_LABOR),
    _rule("52.222-50", "Combating Trafficking in Persons", "required", "high",
          "Prescribed for solicitations and contracts generally.",
          category=CAT_LABOR, phrases=("Combating Trafficking in Persons",)),
    _rule("52.232-33", "Payment by Electronic Funds Transfer—System for Award Management", "required", "medium",
          "Standard EFT payment clause when payment is made by EFT through SAM.", category=CAT_PAYMENT),
    _rule("52.233-1", "Disputes", "required", "medium",
          "Prescribed for solicitations and contracts subject to the Contract Disputes Act.", category=CAT_DISPUTES),
    _rule("252.204-7012", "Safeguarding Covered Defense Information and Cyber Incident Reporting", "required", "high",
          "DoD contracts generally; 72-hour cyber incident reporting obligation.", applies_to="dod",
          category=CAT_CYBER, phrases=("Safeguarding Covered Defense Information and Cyber Incident Reporting",)),
    _rule("252.204-7019", "Notice of NIST SP 800-171 DoD Assessment Requirements", "required", "medium",
          "DoD solicitations and contracts that include 252.204-7012.", applies_to="dod",
          category=CAT_CYBER, phrases=("Notice of NIST SP 800-171 DoD Assessment Requirements",)),
    _rule("252.204-7020", "NIST SP 800-171 DoD Assessment Requirements", "required", "medium",
          "DoD solicitations and contracts that include 252.204-7012.", applies_to="dod", category=CAT_CYBER),
    _rule("252.232-7006", "Wide Area WorkFlow Payment Instructions", "required", "medium",
          "DoD contracts paid through WAWF; payment instructions should be present.", applies_to="dod",
          category=CAT_PAYMENT, phrases=("Wide Area WorkFlow Payment Instructions",)),
    _rule("252.203-7002", "Requirement to Inform Employees of Whistleblower Rights", "required", "low",
          "Prescribed for DoD solicitations and contracts.", applies_to="dod",
          category=CAT_ETHICS, phrases=("Requirement to Inform Employees of Whistleblower Rights",)),
    _rule("52.217-8", "Option to Extend Services", "review", "medium",
          "Present: track the notice window so the up-to-six-month extension can be exercised in time.",
          category=CAT_OPTIONS),
    _rule("52.217-9", "Option to Extend the Term of the Contract", "review", "medium",
          "Present: preliminary notice and exercise deadlines must be tracked.", category=CAT_OPTIONS),
    _rule("52.232-22", "Limitation of Funds", "review", "high",
          "Present: the contract is incrementally funded; monitor the 75% notification and the funded ceiling.",
          category=CAT_PAYMENT),
    _rule("52.249-8", "Default (Fixed-Price Supply and Service)", "review", "medium",
          "Present: termination-for-default rights; confirm cure-notice handling.", category=CAT_DISPUTES),
    _rule("52.249-2", "Termination for Convenience of the Government (Fixed-Price)", "review", "low",
          "Present: termination-for-convenience settlement terms apply.", category=CAT_DISPUTES),
)


def normalize_clause_number(value: str | None) -> str | None:
    """'FAR 52.204-30 Alternate 1' → '52.204-30'; anything without a clause
    number → None."""

    if not value:
        return None
    match = _NUMBER.search(value.replace("‑", "-").replace("–", "-"))
    return match.group(1) if match else None


def _rule_dict(rule: PlaybookRule) -> dict:
    data = asdict(rule)
    data["extraction_patterns"] = [dict(item) for item in rule.extraction_patterns]
    return data


def _row_to_dict(row: ClausePlaybookRule, base: PlaybookRule | None = None) -> dict:
    """A stored rule as the API shape. A legacy override stored before the
    clause-library columns existed inherits its default's category/agency
    and patterns (None there means "never set", unlike "")."""

    patterns = row.extraction_patterns
    if patterns is None and base is not None:
        patterns = [dict(item) for item in base.extraction_patterns]
    return {
        "rule_id": row.rule_id,
        "clause_number": row.clause_number,
        "title": row.title,
        "expectation": row.expectation,
        "severity": row.severity,
        "rationale": row.rationale,
        "applies_to": row.applies_to,
        "enabled": row.enabled,
        "category": row.category if row.category is not None else (base.category if base else ""),
        "agency": row.agency if row.agency is not None else (base.agency if base else ""),
        "standard_text": row.standard_text or "",
        "fallback_text": row.fallback_text or "",
        "extraction_patterns": list(patterns or []),
    }


def rule_fields(rule: ClausePlaybookRule | PlaybookRule) -> dict:
    """The editable fields of a stored or built-in rule (what a PUT merges
    its changes onto)."""

    data = _row_to_dict(rule, default_rule(rule.rule_id)) if isinstance(rule, ClausePlaybookRule) else _rule_dict(rule)
    data.pop("rule_id", None)
    return data


def stored_rules(database: Session, workspace: str | None) -> list[ClausePlaybookRule]:
    owner = (
        ClausePlaybookRule.owner_workspace.is_(None)
        if workspace is None
        else ClausePlaybookRule.owner_workspace == workspace
    )
    return list(database.scalars(select(ClausePlaybookRule).where(owner).order_by(ClausePlaybookRule.id)))


def find_stored_rule(database: Session, workspace: str | None, rule_id: str) -> ClausePlaybookRule | None:
    return next((row for row in stored_rules(database, workspace) if row.rule_id == rule_id), None)


def effective_rules(database: Session, workspace: str | None) -> list[dict]:
    """Defaults overridden by the workspace's stored rules (same rule_id, or
    a custom rule for the same clause number), then the workspace's own
    custom rules. Each rule says where it came from: "default",
    "override" or "custom". Disabled rules are included (enabled=False)."""

    stored = stored_rules(database, workspace)
    by_id = {row.rule_id: row for row in stored}
    custom_numbers = {
        normalize_clause_number(row.clause_number): row
        for row in stored
        if not row.rule_id.startswith("default:")
    }
    rules: list[dict] = []
    consumed: set[str] = set()
    for default in DEFAULT_RULES:
        override = by_id.get(default.rule_id)
        if override is not None:
            rules.append({**_row_to_dict(override, default), "source": "override"})
            consumed.add(override.rule_id)
            continue
        replacement = custom_numbers.get(default.clause_number)
        if replacement is not None:
            # A custom rule for the same clause supersedes the default.
            continue
        rules.append({**_rule_dict(default), "source": "default"})
    for row in stored:
        if row.rule_id in consumed or row.rule_id.startswith("default:"):
            continue
        rules.append({**_row_to_dict(row), "source": "custom"})
    return rules


def _document_clauses(database: Session, document_id: str) -> dict[str, dict]:
    """Normalized clause number → first sighting {page, evidence}. Listing
    citations win over incidental (narrative) mentions."""

    found: dict[str, dict] = {}
    rows = database.scalars(
        select(DocumentClauseReference)
        .where(DocumentClauseReference.document_id == document_id)
        .order_by(DocumentClauseReference.row_index)
    )
    for row in rows:
        number = normalize_clause_number(row.clause_number)
        if not number:
            continue
        evidence = row.evidence_json or {}
        page = evidence.get("page_number") if isinstance(evidence.get("page_number"), int) else None
        sighting = {
            "page": page,
            "evidence": (evidence.get("source_text") or row.title or "").strip()[:300] or None,
            "listing": row.citation_context == "listing",
        }
        current = found.get(number)
        if current is None or (sighting["listing"] and not current["listing"]):
            found[number] = sighting

    structure = database.scalar(
        select(DocumentContractStructure).where(DocumentContractStructure.document_id == document_id)
    )
    for clause in ((structure.payload or {}).get("clauses") or []) if structure else []:
        number = normalize_clause_number(clause.get("clause_number"))
        if not number:
            continue
        sighting = {
            "page": clause.get("page") if isinstance(clause.get("page"), int) else None,
            "evidence": (clause.get("evidence") or clause.get("title") or "").strip()[:300] or None,
            "listing": True,
        }
        current = found.get(number)
        if current is None or not current["listing"]:
            found[number] = sighting
    return found


def _fold(text: str) -> str:
    """Lowercase, one space between words, plain dashes and quotes — so a
    phrase matches across line breaks and typographic punctuation."""

    text = text.replace("‑", "-").replace("–", "-").replace("—", "-")
    text = text.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    return " ".join(text.lower().split())


def _snippet(text: str, start: int, end: int, margin: int = 80) -> str:
    left = max(0, start - margin)
    right = min(len(text), end + margin)
    return ("…" if left else "") + text[left:right].strip() + ("…" if right < len(text) else "")


def match_patterns(patterns: list[dict], pages: list[tuple[int, str]]) -> dict | None:
    """The first page where one of the rule's patterns matches: {page,
    snippet, kind, pattern, note}, or None. Phrases match whole words,
    case- and whitespace-insensitively; regexes match case-insensitively.
    A pattern that no longer compiles is skipped, never raised."""

    compiled: list[tuple[dict, re.Pattern]] = []
    for item in patterns or []:
        pattern = str(item.get("pattern") or "").strip()
        if not pattern:
            continue
        try:
            if item.get("kind") == "regex":
                compiled.append((item, re.compile(pattern, re.IGNORECASE)))
            else:
                compiled.append((item, re.compile(r"(?<!\w)" + re.escape(_fold(pattern)) + r"(?!\w)")))
        except re.error:
            continue
    if not compiled:
        return None
    for page_number, raw in pages:
        if not raw:
            continue
        folded = _fold(raw)
        for item, regex in compiled:
            text = raw if item.get("kind") == "regex" else folded
            hit = regex.search(text)
            if hit:
                return {
                    "page": page_number,
                    "snippet": _snippet(text, hit.start(), hit.end())[:300],
                    "kind": item.get("kind") or "phrase",
                    "pattern": str(item.get("pattern") or ""),
                    "note": str(item.get("note") or ""),
                }
    return None


def _page_texts(database: Session, document_id: str) -> list[tuple[int, str]]:
    rows = database.execute(
        select(DocumentPage.page_number, DocumentPage.final_text, DocumentPage.native_text)
        .where(DocumentPage.document_id == document_id)
        .order_by(DocumentPage.page_number)
    )
    return [(row.page_number, row.final_text or row.native_text or "") for row in rows]


# Findings that are neither satisfied nor a deviation: the clause was not
# cited, but its text (a rule pattern) appears — confirm by reading the page.
TEXT_MATCH = "present_text_match"
_STATUS_RANK = {TEXT_MATCH: 1, "satisfied": 2}


def evaluate_document(database: Session, document_id: str, workspace: str | None) -> dict:
    clauses = _document_clauses(database, document_id)
    summary = {"high": 0, "medium": 0, "low": 0, "satisfied": 0, "deviations": 0, "text_matches": 0}
    if not clauses:
        return {"document_id": document_id, "applicable": False, "is_dod": False, "findings": [], "summary": summary}

    # A DFARS clause in a clause listing makes it a DoD document; a narrative
    # mention of one (e.g. a GSA vehicle citing 252.216-7002) does not.
    is_dod = any(number.startswith("252.") and sighting["listing"] for number, sighting in clauses.items())
    pages: list[tuple[int, str]] | None = None  # loaded only if a pattern needs it
    findings: list[dict] = []
    for rule in effective_rules(database, workspace):
        if not rule["enabled"]:
            continue
        if rule["applies_to"] == "dod" and not is_dod:
            continue
        number = normalize_clause_number(rule["clause_number"]) or rule["clause_number"]
        sighting = clauses.get(number)
        expectation = rule["expectation"]
        text_match = None
        if not sighting and rule.get("extraction_patterns"):
            if pages is None:
                pages = _page_texts(database, document_id)
            text_match = match_patterns(rule["extraction_patterns"], pages)
        if text_match:
            # Not cited as a clause, but its text is on a page: never counted
            # as satisfied or as a deviation until someone confirms it.
            status = TEXT_MATCH
        elif expectation == "required":
            status = "satisfied" if sighting else "missing"
        elif expectation == "prohibited":
            status = "present_prohibited" if sighting else "satisfied"
        else:  # review
            if not sighting:
                continue  # nothing to review
            status = "present_review"
        findings.append(
            {
                "rule_id": rule["rule_id"],
                "clause_number": rule["clause_number"],
                "title": rule["title"],
                "expectation": expectation,
                "severity": rule["severity"],
                "status": status,
                "rationale": rule["rationale"],
                "page": text_match["page"] if text_match else (sighting["page"] if sighting else None),
                "evidence": text_match["snippet"] if text_match else (sighting["evidence"] if sighting else None),
                "pattern_match": (
                    {key: text_match[key] for key in ("kind", "pattern", "note")} if text_match else None
                ),
            }
        )
        if status == "satisfied":
            summary["satisfied"] += 1
        elif status == TEXT_MATCH:
            summary["text_matches"] += 1
        else:
            summary["deviations"] += 1
            summary[rule["severity"]] = summary.get(rule["severity"], 0) + 1

    findings.sort(
        key=lambda item: (
            _STATUS_RANK.get(item["status"], 0),
            SEVERITY_ORDER.get(item["severity"], 3),
            item["clause_number"],
        )
    )
    return {"document_id": document_id, "applicable": True, "is_dod": is_dod, "findings": findings, "summary": summary}


def validate_patterns(value) -> list[dict]:
    """Normalized extraction patterns; raises ValueError naming the first bad
    pattern (1-based) and why."""

    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError("extraction_patterns must be a list of {kind, pattern, note}.")
    if len(value) > MAX_PATTERNS:
        raise ValueError(f"A rule can have at most {MAX_PATTERNS} extraction patterns.")
    patterns: list[dict] = []
    for index, item in enumerate(value, start=1):
        if not isinstance(item, dict):
            raise ValueError(f"Extraction pattern {index} must be an object with kind and pattern.")
        kind = str(item.get("kind") or "phrase").strip().lower()
        if kind not in PATTERN_KINDS:
            raise ValueError(f"Extraction pattern {index}: kind must be one of {', '.join(PATTERN_KINDS)}.")
        pattern = str(item.get("pattern") or "").strip()
        if not pattern:
            raise ValueError(f"Extraction pattern {index} is empty.")
        if len(pattern) > MAX_PATTERN_LENGTH:
            raise ValueError(f"Extraction pattern {index} is longer than {MAX_PATTERN_LENGTH} characters.")
        if kind == "phrase" and len(pattern) < 4:
            raise ValueError(f"Extraction pattern {index}: a phrase needs at least 4 characters.")
        if kind == "regex":
            try:
                re.compile(pattern)
            except re.error as error:
                raise ValueError(f"Extraction pattern {index} is not a valid regular expression: {error}.") from error
            if _NESTED_QUANTIFIER.search(pattern):
                raise ValueError(
                    f"Extraction pattern {index} nests a repeated group inside another repeat (e.g. (a+)+), "
                    "which can stall on long pages; simplify it."
                )
        note = str(item.get("note") or "").strip()
        if len(note) > MAX_NOTE_LENGTH:
            raise ValueError(f"Extraction pattern {index}: the note is limited to {MAX_NOTE_LENGTH} characters.")
        patterns.append({"kind": kind, "pattern": pattern, "note": note})
    return patterns


def _bounded_text(payload: dict, key: str, limit: int, label: str) -> str:
    value = str(payload.get(key) or "").strip()
    if len(value) > limit:
        raise ValueError(f"{label} is limited to {limit:,} characters.")
    return value


def validate_rule_payload(payload: dict) -> dict:
    """Normalized, validated rule fields; raises ValueError with a readable
    message."""

    clause = (payload.get("clause_number") or "").strip()
    if not normalize_clause_number(clause):
        raise ValueError("clause_number must be a clause number such as 52.204-21 or 252.204-7012.")
    expectation = (payload.get("expectation") or "").strip().lower()
    if expectation not in EXPECTATIONS:
        raise ValueError(f"expectation must be one of {', '.join(EXPECTATIONS)}.")
    severity = (payload.get("severity") or "medium").strip().lower()
    if severity not in SEVERITIES:
        raise ValueError(f"severity must be one of {', '.join(SEVERITIES)}.")
    applies_to = (payload.get("applies_to") or "all").strip().lower()
    if applies_to not in APPLIES_TO:
        raise ValueError(f"applies_to must be one of {', '.join(APPLIES_TO)}.")
    return {
        "clause_number": normalize_clause_number(clause),
        "title": (payload.get("title") or "").strip()[:300],
        "expectation": expectation,
        "severity": severity,
        "rationale": _bounded_text(payload, "rationale", MAX_RATIONALE_LENGTH, "The rationale"),
        "applies_to": applies_to,
        "enabled": bool(payload.get("enabled", True)),
        "category": " ".join(_bounded_text(payload, "category", MAX_CATEGORY_LENGTH, "The category").split()),
        "agency": " ".join(_bounded_text(payload, "agency", MAX_AGENCY_LENGTH, "The agency").split()),
        "standard_text": _bounded_text(payload, "standard_text", MAX_STANDARD_TEXT_LENGTH, "The standard text"),
        "fallback_text": _bounded_text(payload, "fallback_text", MAX_FALLBACK_TEXT_LENGTH, "The fallback text"),
        "extraction_patterns": validate_patterns(payload.get("extraction_patterns")),
    }


def default_rule(rule_id: str) -> PlaybookRule | None:
    return next((rule for rule in DEFAULT_RULES if rule.rule_id == rule_id), None)


# --- Verbatim clause text from ingested FAR / DFARS regulation records -------

_MONTHS = {name: index for index, name in enumerate(
    ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"), start=1)}
_VERSION = re.compile(r"([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{4})")


def version_sort_key(version_date: str | None) -> tuple[int, int]:
    """'(NOV 2021)' → (2021, 11); unparseable → (0, 0) so it sorts last
    when newest-first."""

    match = _VERSION.search(version_date or "")
    if not match or match.group(1).lower() not in _MONTHS:
        return (0, 0)
    return (int(match.group(2)), _MONTHS[match.group(1).lower()])


def _record_dict(record: DocumentFarRecord, filename: str | None, include_text: bool = True) -> dict:
    data = {
        "clause_number": record.far_number,
        "clause_key": record.clause_key,
        "title": record.title or record.official_heading or record.display_name or "",
        "clause_type": record.clause_type,
        "version_date": record.version_date,
        "prescription": record.prescription,
        "document_id": record.document_id,
        "filename": filename,
    }
    if include_text:
        data["source_text"] = record.source_text
    return data


def ingested_clause_texts(database: Session, clause_number: str, visible_documents) -> list[dict]:
    """Every ingested basic-clause record for one clause number in documents
    the caller can see, newest version first. Text is exactly as ingested."""

    number = normalize_clause_number(clause_number)
    if not number:
        return []
    rows = database.execute(
        select(DocumentFarRecord, Document.original_filename, Document.uploaded_at)
        .join(Document, Document.id == DocumentFarRecord.document_id)
        .where(
            DocumentFarRecord.far_number == number,
            DocumentFarRecord.content_type == "CLAUSE_OR_PROVISION",
            DocumentFarRecord.source_text.is_not(None),
            DocumentFarRecord.document_id.in_(visible_documents),
        )
    ).all()
    rows.sort(
        key=lambda row: (version_sort_key(row[0].version_date), row[2].timestamp() if row[2] else 0),
        reverse=True,
    )
    return [_record_dict(record, filename) for record, filename, _ in rows]


def ingested_clause_index(database: Session, visible_documents, limit: int = 5000) -> list[dict]:
    """Ingested clause numbers the caller can see: number, title, family
    (FAR / DFARS) and the distinct version dates on file."""

    rows = database.execute(
        select(DocumentFarRecord.far_number, DocumentFarRecord.title, DocumentFarRecord.version_date)
        .where(
            DocumentFarRecord.content_type == "CLAUSE_OR_PROVISION",
            DocumentFarRecord.source_text.is_not(None),
            DocumentFarRecord.document_id.in_(visible_documents),
        )
        .limit(limit)
    )
    index: dict[str, dict] = {}
    for number, title, version in rows:
        entry = index.setdefault(
            number,
            {
                "clause_number": number,
                "title": title or "",
                "family": "DFARS" if number.startswith("252.") else "FAR",
                "versions": [],
            },
        )
        if not entry["title"] and title:
            entry["title"] = title
        if version and version not in entry["versions"]:
            entry["versions"].append(version)
    for entry in index.values():
        entry["versions"].sort(key=version_sort_key, reverse=True)
    return sorted(index.values(), key=lambda entry: _clause_sort_key(entry["clause_number"]))


def _clause_sort_key(number: str) -> tuple:
    return tuple((0, int(part), "") if part.isdigit() else (1, 0, part) for part in re.split(r"[.-]", number))
