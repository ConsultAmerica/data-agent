"""Batch validation rules: a workspace's own regex and threshold checks run
against every document's extracted values.

Built-in templates live here in code and ship disabled, so nothing is
flagged until someone turns a rule on; a workspace stores only its own rules
and overrides of a template (same rule_id) in validation_rules. Values come
from the persisted staging workbook (the document page's values) through
app.services.document_actions, never from a re-extraction.

Rule types:
  regex           field_label's value must fully match `pattern`
  required_field  field_label must have a value
  funding_gap     |priced (or not-to-exceed) total - funded total| <= threshold
  max_amount      field_label's dollar amount <= threshold
  field_match     field_label and the label(s) in `pattern` must agree
A field_label may list alternative labels separated by "|"
("UEI|Unique Entity ID").
"""

from __future__ import annotations

import logging
import re
from dataclasses import asdict, dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.validation_rule import ValidationRule

logger = logging.getLogger(__name__)

RULE_TYPES = ("regex", "required_field", "funding_gap", "max_amount", "field_match")
SEVERITIES = ("high", "medium", "low")
SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2}
STATUS_ORDER = {"fail": 0, "missing": 1, "not_applicable": 2, "pass": 3}
MAX_PATTERN = 300
_PLAIN_NUMBER = re.compile(r"^\s*\$?\s*(-?[\d,]+(?:\.\d+)?)\s*$")
_NORMALIZE = re.compile(r"[^A-Z0-9]+")


@dataclass(frozen=True)
class RuleTemplate:
    rule_id: str
    name: str
    rule_type: str
    severity: str
    description: str
    field_label: str | None = None
    pattern: str | None = None
    threshold: float | None = None
    enabled: bool = False


TEMPLATES: tuple[RuleTemplate, ...] = (
    RuleTemplate(
        "template:uei-format", "UEI is 12 characters", "regex", "medium",
        "SAM Unique Entity IDs are 12 alphanumeric characters.",
        field_label="Unique Entity ID (UEI)|Unique Entity ID|UEI", pattern="[A-Z0-9]{12}",
    ),
    RuleTemplate(
        "template:cage-format", "CAGE code is 5 characters", "regex", "low",
        "CAGE codes are 5 alphanumeric characters.",
        field_label="CAGE Code|CAGE", pattern="[A-Z0-9]{5}",
    ),
    RuleTemplate(
        "template:piid-format", "Contract number looks like a PIID", "regex", "medium",
        "A PIID is 13-17 letters and digits (agency code, fiscal year, instrument type, serial).",
        field_label="Contract Number", pattern="[A-Z0-9]{6}[0-9]{2}[A-Z][A-Z0-9]{4,8}",
    ),
    RuleTemplate(
        "template:funding-gap", "Funding gap over $10,000", "funding_gap", "high",
        "Flags a contract whose funded total differs from the priced (or not-to-exceed) total by more than the threshold.",
        threshold=10_000.0,
    ),
    RuleTemplate(
        "template:contracting-officer", "Contracting Officer is named", "required_field", "low",
        "Every award should name its contracting officer.",
        field_label="Contracting Officer",
    ),
)


class RuleError(ValueError):
    """A rule payload that can't be saved; the message is user-facing."""


def _labels(value: str | None) -> list[str]:
    return [label.strip() for label in (value or "").split("|") if label.strip()]


def _row_to_dict(row: ValidationRule) -> dict:
    return {
        "rule_id": row.rule_id,
        "name": row.name,
        "rule_type": row.rule_type,
        "field_label": row.field_label,
        "pattern": row.pattern,
        "threshold": row.threshold,
        "severity": row.severity,
        "enabled": row.enabled,
        "description": row.description,
    }


def stored_rules(database: Session, workspace: str | None) -> list[ValidationRule]:
    owner = (
        ValidationRule.owner_workspace.is_(None)
        if workspace is None
        else ValidationRule.owner_workspace == workspace
    )
    return list(database.scalars(select(ValidationRule).where(owner).order_by(ValidationRule.id)))


def find_stored_rule(database: Session, workspace: str | None, rule_id: str) -> ValidationRule | None:
    return next((row for row in stored_rules(database, workspace) if row.rule_id == rule_id), None)


def template(rule_id: str) -> RuleTemplate | None:
    return next((item for item in TEMPLATES if item.rule_id == rule_id), None)


def effective_rules(database: Session, workspace: str | None) -> list[dict]:
    """Templates (overridden by the workspace's stored copy of the same
    rule_id), then the workspace's own rules. Each says where it came from:
    "template", "override" or "custom". Disabled rules are included."""

    stored = stored_rules(database, workspace)
    by_id = {row.rule_id: row for row in stored}
    rules = []
    for item in TEMPLATES:
        override = by_id.get(item.rule_id)
        rules.append(
            {**_row_to_dict(override), "source": "override"} if override is not None
            else {**asdict(item), "source": "template"}
        )
    for row in stored:
        if template(row.rule_id) is None:
            rules.append({**_row_to_dict(row), "source": "custom"})
    return rules


def validate_rule_payload(payload: dict) -> dict:
    """Normalized, validated rule fields; raises RuleError with a readable message."""

    name = (payload.get("name") or "").strip()
    if not name:
        raise RuleError("Give the rule a name.")
    rule_type = (payload.get("rule_type") or "").strip().lower()
    if rule_type not in RULE_TYPES:
        raise RuleError(f"rule_type must be one of {', '.join(RULE_TYPES)}.")
    severity = (payload.get("severity") or "medium").strip().lower()
    if severity not in SEVERITIES:
        raise RuleError(f"severity must be one of {', '.join(SEVERITIES)}.")
    field_label = (payload.get("field_label") or "").strip() or None
    pattern = (payload.get("pattern") or "").strip() or None
    threshold = payload.get("threshold")

    if rule_type in ("regex", "required_field", "max_amount", "field_match") and not _labels(field_label):
        raise RuleError("This rule type needs a field label.")
    if rule_type == "regex":
        if not pattern:
            raise RuleError("A regex rule needs a pattern.")
        if len(pattern) > MAX_PATTERN:
            raise RuleError(f"Keep the pattern under {MAX_PATTERN} characters.")
        try:
            re.compile(pattern, re.IGNORECASE)
        except re.error as error:
            raise RuleError(f"The pattern is not a valid regular expression: {error}.") from error
    elif rule_type == "field_match":
        if not _labels(pattern):
            raise RuleError("A field-match rule needs the second field label.")
        if len(pattern) > MAX_PATTERN:
            raise RuleError(f"Keep the second label under {MAX_PATTERN} characters.")
    else:
        pattern = None
    if rule_type in ("funding_gap", "max_amount"):
        try:
            threshold = float(threshold)
        except (TypeError, ValueError) as error:
            raise RuleError("This rule type needs a dollar threshold.") from error
        if threshold < 0:
            raise RuleError("The threshold can't be negative.")
    else:
        threshold = None
    if rule_type == "funding_gap":
        field_label = None

    return {
        "name": name[:200],
        "rule_type": rule_type,
        "field_label": field_label[:300] if field_label else None,
        "pattern": pattern,
        "threshold": threshold,
        "severity": severity,
        "enabled": bool(payload.get("enabled", True)),
        "description": (payload.get("description") or "").strip(),
    }


# --- evaluation ----------------------------------------------------------------


def _money(value: float | None) -> str:
    return "—" if value is None else f"${value:,.2f}"


def _amount(text: str | None) -> float | None:
    from app.services.document_actions import parse_money

    amount = parse_money(text)
    if amount is not None:
        return amount
    plain = _PLAIN_NUMBER.match(text or "")
    if plain:
        try:
            return float(plain.group(1).replace(",", ""))
        except ValueError:
            return None
    return None


def _first_line(value: str) -> str:
    return " ".join(value.strip().splitlines()[0].split()) if value and value.strip() else value


def _result(rule: dict, status: str, detail: str, value: str | None = None, page: int | None = None) -> dict:
    return {
        "rule_id": rule["rule_id"],
        "name": rule["name"],
        "rule_type": rule["rule_type"],
        "severity": rule["severity"],
        "status": status,
        "detail": detail,
        "value": value,
        "page": page,
    }


def evaluate_rule(rule: dict, data) -> dict:
    """One rule against one document's contract data (document_actions'
    load_contract_data result)."""

    rule_type = rule["rule_type"]
    labels = _labels(rule.get("field_label"))
    shown = labels[0] if labels else ""

    if rule_type == "funding_gap":
        from app.services.document_actions import funding_totals

        totals = funding_totals(data)
        priced = totals["priced_total"] if totals["priced_total"] is not None else totals["maximum_total"]
        funded = totals["funded_total"]
        if priced is None or funded is None:
            missing = "no priced or not-to-exceed CLIN amounts" if priced is None else "no funding lines"
            return _result(rule, "not_applicable", f"Nothing to compare: {missing} were extracted.")
        gap = abs(priced - funded)
        basis = "priced" if totals["priced_total"] is not None else "not-to-exceed"
        detail = f"{basis.capitalize()} total {_money(priced)} vs funded {_money(funded)}: gap {_money(gap)}"
        threshold = rule.get("threshold") or 0.0
        if gap > threshold:
            return _result(rule, "fail", f"{detail}, over the {_money(threshold)} limit.", _money(gap))
        return _result(rule, "pass", f"{detail}, within {_money(threshold)}.", _money(gap))

    fact = data.fact(*labels)
    value = " ".join(str(fact.value).split()) if fact.value else None

    if rule_type == "required_field":
        if value:
            return _result(rule, "pass", f"{shown} is present.", _first_line(str(fact.value)), fact.page)
        return _result(rule, "fail", f"{shown} was not found in the extracted data.")

    if value is None:
        return _result(rule, "missing", f"{shown} was not found in the extracted data, so it couldn't be checked.")

    if rule_type == "regex":
        # The first line: addresses and titles continue on later lines.
        candidate = _first_line(str(fact.value))
        try:
            matched = re.fullmatch(rule["pattern"], candidate, re.IGNORECASE) is not None
        except re.error:
            return _result(rule, "not_applicable", "The rule's pattern is not a valid regular expression.", candidate, fact.page)
        if matched:
            return _result(rule, "pass", f"{shown} matches {rule['pattern']}.", candidate, fact.page)
        return _result(rule, "fail", f"{shown} “{candidate}” does not match {rule['pattern']}.", candidate, fact.page)

    if rule_type == "max_amount":
        amount = _amount(value)
        threshold = rule.get("threshold") or 0.0
        if amount is None:
            return _result(rule, "not_applicable", f"{shown} “{value}” is not a dollar amount.", value, fact.page)
        if amount > threshold:
            return _result(rule, "fail", f"{shown} {_money(amount)} exceeds {_money(threshold)}.", _money(amount), fact.page)
        return _result(rule, "pass", f"{shown} {_money(amount)} is within {_money(threshold)}.", _money(amount), fact.page)

    if rule_type == "field_match":
        other_labels = _labels(rule.get("pattern"))
        other = data.fact(*other_labels)
        if not other.value:
            return _result(rule, "missing", f"{other_labels[0]} was not found, so it couldn't be compared.", _first_line(str(fact.value)), fact.page)
        left = _NORMALIZE.sub("", _first_line(str(fact.value)).upper())
        right = _NORMALIZE.sub("", _first_line(str(other.value)).upper())
        pair = f"{shown} “{_first_line(str(fact.value))}” and {other_labels[0]} “{_first_line(str(other.value))}”"
        if left == right:
            return _result(rule, "pass", f"{pair} agree.", _first_line(str(fact.value)), fact.page)
        return _result(rule, "fail", f"{pair} differ.", _first_line(str(fact.value)), fact.page or other.page)

    return _result(rule, "not_applicable", f"Unknown rule type {rule_type}.")


def _summary(results: list[dict]) -> dict:
    summary = {"fail": 0, "missing": 0, "pass": 0, "not_applicable": 0, "high": 0, "medium": 0, "low": 0}
    for item in results:
        summary[item["status"]] = summary.get(item["status"], 0) + 1
        if item["status"] == "fail":
            summary[item["severity"]] = summary.get(item["severity"], 0) + 1
    return summary


def _sort(results: list[dict]) -> list[dict]:
    return sorted(results, key=lambda item: (
        STATUS_ORDER.get(item["status"], 9), SEVERITY_ORDER.get(item["severity"], 9), item["name"],
    ))


def evaluate_document(database: Session, document_id: str, workspace: str | None, data=None) -> dict:
    """Every enabled rule against one document. `applicable` is False when
    no rule is enabled (nothing was checked). Pass `data` when the caller
    already loaded the document's contract data."""

    rules = [rule for rule in effective_rules(database, workspace) if rule["enabled"]]
    if not rules:
        return {"document_id": document_id, "applicable": False, "results": [], "summary": _summary([])}
    if data is None:
        from app.services.document_actions import load_contract_data

        data = load_contract_data(database, document_id)
    results = []
    for rule in rules:
        try:
            results.append(evaluate_rule(rule, data))
        except Exception:  # noqa: BLE001 - one broken rule must not hide the others
            logger.exception("validation rule %s failed on %s", rule["rule_id"], document_id)
            results.append(_result(rule, "not_applicable", "This rule could not be evaluated."))
    results = _sort(results)
    return {"document_id": document_id, "applicable": True, "results": results, "summary": _summary(results)}


def preview_rule(database: Session, document_id: str, payload: dict) -> dict:
    """Evaluate an unsaved rule against one document (live preview)."""

    fields = validate_rule_payload(payload)
    from app.services.document_actions import load_contract_data

    rule = {**fields, "rule_id": payload.get("rule_id") or "preview"}
    return evaluate_rule(rule, load_contract_data(database, document_id))


def portfolio(database: Session, documents: list, workspace: str | None) -> dict:
    """Failures and misses across `documents` (rows with id, original_filename,
    document_type)."""

    enabled = [rule for rule in effective_rules(database, workspace) if rule["enabled"]]
    totals = {"documents": 0, "with_failures": 0, "fail": 0, "missing": 0, "rules_enabled": len(enabled)}
    rows = []
    if not enabled:
        return {"totals": totals, "documents": rows}
    for document in documents:
        result = evaluate_document(database, document.id, workspace)
        totals["documents"] += 1
        summary = result["summary"]
        totals["fail"] += summary["fail"]
        totals["missing"] += summary["missing"]
        if summary["fail"]:
            totals["with_failures"] += 1
        flagged = [item for item in result["results"] if item["status"] in ("fail", "missing")]
        if flagged:
            rows.append({
                "document_id": document.id,
                "filename": document.original_filename,
                "document_type": document.document_type,
                "summary": summary,
                "results": flagged,
            })
    rows.sort(key=lambda row: (-row["summary"]["fail"], -row["summary"]["high"], row["filename"] or ""))
    return {"totals": totals, "documents": rows}
