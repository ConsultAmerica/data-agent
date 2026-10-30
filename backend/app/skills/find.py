"""Targeted extraction: "Extract Contract Number", "Find Supplier Tax
Identifier", "Identify FAR Clauses". The answer comes from what the
document prints or extraction read — with its page, evidence, confidence
and validation status — or the reply says it wasn't found. Nothing is
generated: an absent value is reported as absent.
"""

from __future__ import annotations

import re
from typing import Any

from app.skills.business_data import _best_spec, _plain_label, _type_check
from app.skills.registry import skill_for_family
from app.skills.values import normalized

_VERBS = re.compile(
    r"^\s*(?:please\s+)?(?:extract|find|get|identify|show|list|locate|what\s+is|what\s+are|where\s+is)\s+(?:me\s+)?(?:the\s+)?",
    re.IGNORECASE,
)
_CLAUSES = re.compile(r"\b(far|dfars|gsar)?\s*clauses?\b", re.IGNORECASE)


def request_label(query: str) -> str:
    text = _VERBS.sub("", query.strip()).strip(" ?.!")
    return re.sub(r"\s+", " ", text)


def _word_overlap(a: str, b: str) -> float:
    ta, tb = set(normalized(a).split()), set(normalized(b).split())
    return len(ta & tb) / len(ta | tb) if ta and tb else 0.0


def find_in_document(
    query: str,
    *,
    business: dict[str, Any],
    family: str | None,
    clause_citations: list[Any] | None = None,
    dates: dict[str, Any] | None = None,
) -> dict[str, Any]:
    label = request_label(query)
    if not label:
        return {"query": query, "label": label, "found": False, "message": "Say which value to find."}

    clause = _CLAUSES.search(label)
    if clause and clause_citations is not None:
        family_name = (clause.group(1) or "").upper() or None
        rows = [c for c in clause_citations if family_name is None or c.clause_family.upper() == family_name]
        seen: dict[str, Any] = {}
        for c in rows:
            seen.setdefault(c.clause_number, c)
        answers = [
            {"value": f"{c.clause_number} {c.title}".strip(), "page": c.page_number, "evidence": c.source_text,
             "confidence": None, "validation_status": "passed" if c.title else "not_checked"}
            for c in seen.values()
        ]
        return {
            "query": query, "label": label, "kind": "clauses", "found": bool(answers),
            "answers": answers,
            "message": f"{len(answers)} {family_name or 'FAR/DFARS'} clauses cited in the document."
            if answers else "No clause citations were found in the document text.",
        }

    skill = skill_for_family(family)
    fields = {f["key"]: f for s in business["sections"] for f in s.get("fields", [])}
    spec = _best_spec(label, skill) if skill else None
    if spec is not None and fields.get(spec.key, {}).get("value"):
        field = fields[spec.key]
        return {
            "query": query, "label": label, "kind": "field", "found": True, "field": spec.key,
            "answers": [_answer(c, spec) for c in field["candidates"] if c["value"]],
            "message": f"{spec.label} found on page {field['page']}." if field["page"] else f"{spec.label} found.",
        }

    # Any printed or extracted value whose label names what was asked.
    if spec is not None and spec.date_role == "expiration" and dates and dates.get("expiration"):
        expiry = dates["expiration"]
        inferred = expiry["basis"] == "inferred"
        return {
            "query": query, "label": label, "kind": "date", "found": True, "field": spec.key,
            "answers": [{
                "value": expiry["text"], "source_label": expiry["label"], "page": expiry["page"],
                "evidence": expiry["evidence"], "record_key": expiry.get("record_key"), "confidence": None,
                "validation_status": "passed" if expiry["valid"] else "failed", "review_status": None,
                "basis": expiry["basis"],
            }],
            "message": (
                f"No expiration date is printed; inferred from {expiry['inferred_from']}."
                if inferred else f"{expiry['label']} found."
            ),
        }

    candidates = [c for s in business["sections"] for f in s.get("fields", []) for c in f["candidates"]]
    candidates += [c for s in business["sections"] for c in s.get("values", [])]
    candidates += business["other"]["values"]
    wanted = normalized(label)
    scored = []
    for c in candidates:
        if not c["value"]:
            continue
        plain = _plain_label(c["label"])
        score = 1.0 if plain == wanted else _word_overlap(plain, wanted)
        if score >= 0.6:
            scored.append((score, c))
    scored.sort(key=lambda item: -item[0])
    if scored:
        best = scored[0][0]
        answers = [_answer(c, spec) for score, c in scored if score == best]
        return {"query": query, "label": label, "kind": "field", "found": True, "field": spec.key if spec else None,
                "answers": answers, "message": f"Found under “{answers[0]['source_label']}”."}
    return {
        "query": query, "label": label, "kind": "field", "found": False, "field": spec.key if spec else None,
        "answers": [],
        "message": f"“{label}” wasn't found in this document's printed or extracted values.",
    }


def _answer(candidate: dict[str, Any], spec) -> dict[str, Any]:
    issue = _type_check(spec, candidate["value"]) if spec else None
    return {
        "value": candidate["value"],
        "source_label": candidate["label"],
        "page": candidate["page"],
        "evidence": candidate["evidence"],
        "record_key": candidate["record_key"],
        "confidence": candidate["confidence"],
        "validation_status": "failed" if issue else (candidate.get("validation_status") or "passed"),
        "review_status": candidate["review_status"],
    }
