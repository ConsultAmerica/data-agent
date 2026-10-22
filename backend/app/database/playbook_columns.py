"""Local-dev column patch for clause_playbook_rules (create_all does not add
columns to an existing table). Production goes through migration
f3a4b5c6d7e8."""

from sqlalchemy.engine import Engine

from app.database.migrate import _ensure_columns

CLAUSE_PLAYBOOK_RULE_COLUMNS: dict[str, str | dict[str, str]] = {
    "standard_text": "TEXT",
    "fallback_text": "TEXT",
    "extraction_patterns": "JSON",
    "category": "VARCHAR(120)",
    "agency": "VARCHAR(80)",
}


def ensure_clause_playbook_rule_columns(engine: Engine) -> None:
    """Add missing clause_playbook_rules columns for an existing database."""
    _ensure_columns(engine, "clause_playbook_rules", CLAUSE_PLAYBOOK_RULE_COLUMNS)
