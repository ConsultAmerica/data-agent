"""far_regulatory_change@1 — a Federal Register FAR rule (FAR_REGULATORY_CHANGE).

    Federal Register PDF ─► app/far/final_rule.py (reading order, FR documents,
                            dot-leader tables, amendatory instructions)
                         ─► Rule Summary (one record: the rule's facts)
                         ─► FAR Rule Data (one table: the rule itself, its
                            preamble sections, trade-agreement thresholds and
                            every amendatory change)

A Federal Register rule is change history (what was removed and what was
added, effective when) — not current regulatory content, which a FAR Part
file holds (far_part_52). Resolution needs the rule's own structure: the
Federal Register running header, 48 CFR, "ACTION: Final rule" and a FAC /
FAR Case reference. Never the filename. Deterministic — no OCR, no AI.
"""

from __future__ import annotations

import re
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.far.final_rule import Change, FinalRule, LeaderTable, far_number, parse_final_rule
from app.models.document import Document
from app.models.document_page import DocumentPage
from app.services.document_storage import ensure_local_copy
from app.staging.models import CellProvenance, ExportCapability, ProfileView
from app.staging.profile import (
    AdapterResult,
    DatasetDefinition,
    ExportSheet,
    FieldDefinition,
    RawRecord,
    Recognition,
    StagingProfile,
)
from app.staging.provenance import make_provenance

F = FieldDefinition
FAMILY = "far_regulatory_change"
DOCUMENT_LABEL = "FAR Final Rule"
_METHOD = "federal_register_text"

RULE_SUMMARY = DatasetDefinition(
    dataset_id="rule_summary",
    display_name="Rule Summary",
    cardinality="single",
    description="The rule's identity, publication and effect, as printed in its Federal Register heading.",
    fields=(
        F("rule.document_label", "document_label", "Document Label", grounding="system"),
        F("rule.heading", "heading", "Heading", expected=True, grounding="derived"),
        F("rule.reference", "reference", "Reference", expected=True, grounding="derived"),
        F("rule.fac_number", "fac_number", "FAC Number", grounding="derived"),
        F("rule.far_case", "far_case", "FAR Case", grounding="derived"),
        F("rule.action", "action", "Action"),
        F("rule.effective_date", "effective_date", "Effective Date", "date", expected=True),
        F("rule.cfr_parts", "cfr_parts", "CFR Parts Amended"),
        F("rule.agency", "agency", "Agency"),
        F("rule.summary", "summary", "Summary"),
        F("rule.publication", "publication", "Publication", grounding="derived"),
        F("rule.fr_citation", "fr_citation", "Federal Register Citation", grounding="derived"),
        F("rule.fr_doc", "fr_doc", "FR Document Number", grounding="derived"),
        F("rule.docket", "docket", "Docket Number", grounding="derived"),
        F("rule.rin", "rin", "RIN", grounding="derived"),
        F("rule.contact", "contact", "For Further Information"),
        F("rule.signed_by", "signed_by", "Signed By"),
        F("rule.companions", "companions", "Companion Documents", grounding="derived"),
        F("rule.change_count", "change_count", "Amendatory Changes", "integer", grounding="system"),
        F("rule.threshold_count", "threshold_count", "Threshold Records", "integer", grounding="system"),
    ),
)

_DATA_FIELDS = (
    ("section", "Section", "text", "derived"),
    ("record_type", "Record Type", "text", "none"),
    ("far_reference", "FAR Reference", "text", "derived"),
    ("title", "Title / Subject", "text", "derived"),
    ("action", "Action / Change", "text", "derived"),
    ("previous_value", "Previous Value", "text", "evidence"),
    ("new_value", "New Value", "text", "evidence"),
    ("effective_date", "Effective Date", "date", "derived"),
    ("fac_number", "FAC Number", "code", "derived"),
    ("far_case", "FAR Case", "code", "derived"),
    ("regulation_part", "Regulation Part", "text", "derived"),
    ("clause_number", "Provision / Clause Number", "code", "derived"),
    ("clause_title", "Provision / Clause Title", "text", "derived"),
    ("revision_date", "Revision Date", "text", "derived"),
    ("trade_agreement", "Trade Agreement", "text", "derived"),
    ("supply_threshold", "Supply Threshold", "text", "evidence"),
    ("service_threshold", "Service Threshold", "text", "evidence"),
    ("construction_threshold", "Construction Threshold", "text", "evidence"),
    ("text", "Description / Text", "text", "evidence"),
    ("source_page", "Source Page", "integer", "system"),
    ("source_reference", "Source Reference", "text", "system"),
)

RULE_DATA = DatasetDefinition(
    dataset_id="far_rule_data",
    display_name="FAR Rule Data",
    cardinality="repeating",
    description=(
        "The whole rule in one table, in document order: the rule, its preamble sections, the trade-agreement "
        "thresholds and every amendatory change (previous → new value, affected FAR section, provision or clause)."
    ),
    identity_fields=("rule.data.far_reference", "rule.data.section", "rule.data.title"),
    grid_fields=tuple(f"rule.data.{key}" for key, *_ in _DATA_FIELDS),
    full_text_grid=True,
    fields=tuple(F(f"rule.data.{key}", key, label, value_type, grounding=grounding) for key, label, value_type, grounding in _DATA_FIELDS),
)


# --- recognition -----------------------------------------------------------------------------

_FR_RUNNING_HEAD = re.compile(r"Federal Register\s*/\s*Vol\.\s*\d+,\s*No\.\s*\d+.*Rules and Regulations", re.I)
_FINAL_RULE = re.compile(r"ACTION:\s*(?:Interim\s+)?final rule", re.I)
_FAC = re.compile(r"\bFAC\s+\d{4}[–-]\d{2}|\bFAR Case\s+\d{4}[–-]\d{3}", re.I)


def recognize_regulatory_change(database: Session, document: Document) -> Recognition:
    if Path(document.stored_filename or document.original_filename or "").suffix.lower() != ".pdf":
        return Recognition(0.0, ["not a PDF"])
    text = "\n".join(
        page.final_text or ""
        for page in database.scalars(
            select(DocumentPage).where(DocumentPage.document_id == document.id).order_by(DocumentPage.page_number).limit(6)
        )
    )
    reasons: list[str] = []
    score = 0.0
    if _FR_RUNNING_HEAD.search(text):
        score += 0.3
        reasons.append("Federal Register 'Rules and Regulations' running header")
    if "Federal Acquisition Regulation" in text:
        score += 0.2
        reasons.append("Federal Acquisition Regulation")
    if re.search(r"\b48 CFR\b", text):
        score += 0.15
        reasons.append("48 CFR")
    if _FINAL_RULE.search(text):
        score += 0.25
        reasons.append("ACTION: Final rule")
    if _FAC.search(text):
        score += 0.1
        reasons.append("FAC / FAR Case reference")
    return Recognition(round(score, 2), reasons or ["no Federal Register FAR rule structure"])


# --- adapter ---------------------------------------------------------------------------------


def _hyphen(text: str | None) -> str | None:
    return text.replace("–", "-").replace("—", "-") if text else text


def _prov(document: Document, page: int | None, bbox, evidence: str | None) -> CellProvenance | None:
    if not evidence:
        return None
    return make_provenance(
        document,
        page=page,
        evidence=evidence,
        bbox=list(bbox) if bbox else None,
        extraction_method=_METHOD,
        source_type="pdf",
    )


def _source_reference(rule: FinalRule, fr_page: str | None) -> str | None:
    parts = []
    if rule.volume and fr_page:
        parts.append(f"{rule.volume} FR {fr_page}")
    if rule.fr_doc:
        parts.append(f"FR Doc. {rule.fr_doc}")
    return " · ".join(parts) or None


def _common(rule: FinalRule) -> dict:
    return {"fac_number": _hyphen(rule.fac), "far_case": _hyphen(rule.far_case)}


def _threshold_records(
    document: Document, rule: FinalRule, table: LeaderTable, context: str | None, change: Change | None, start: int
) -> list[RawRecord]:
    def column(word: str) -> int | None:
        return next((i - 1 for i, header in enumerate(table.headers) if i and word in header.lower()), None)

    supply, service, construction = column("supply"), column("service"), column("construction")
    records = []
    for index, row in enumerate(table.rows):
        values = {
            **_common(rule),
            "section": f"Amendment {change.instruction}" if change else context,
            "record_type": "Trade Agreement Threshold",
            "far_reference": f"{far_number(change.section)}{change.paragraphs or ''}" if change and change.section else None,
            "title": (table.caption or None),
            "trade_agreement": f"{row.group} — {row.label}" if row.group else row.label,
            "supply_threshold": row.values[supply] if supply is not None else None,
            "service_threshold": row.values[service] if service is not None else None,
            "construction_threshold": row.values[construction] if construction is not None else None,
            "effective_date": rule.effective_date if change else None,
            "regulation_part": change.part if change else None,
            "text": row.text,
            "source_page": table.page,
            "source_reference": _source_reference(rule, table.fr_page),
        }
        provenance = _prov(document, table.page, row.bbox, row.text)
        records.append(
            RawRecord(
                record_id=f"rule_data:{start + index}:threshold:{table.page}:{index}",
                values=values,
                provenance=provenance,
                cell_provenance={"title": _prov(document, table.page, table.bbox, table.caption)} if table.caption else {},
            )
        )
    return records


def _change_record(document: Document, rule: FinalRule, change: Change, kinds: dict[str, str], position: int) -> RawRecord:
    section = far_number(change.section) if change.section else None
    is_52 = bool(section and section.startswith("52."))
    kind = change.clause_kind or (kinds.get(section) if section else None)
    if change.record_type == "Authority":
        action = "Authority citation (unchanged)"
    else:
        action = change.action
    values = {
        **_common(rule),
        "section": f"Amendment {change.instruction}",
        "record_type": (f"{kind} Date Revision" if change.record_type == "Date Revision" and kind else change.record_type)
        if not (is_52 and change.record_type == "Amendment" and kind)
        else f"{kind} Amendment",
        "far_reference": f"{section}{change.paragraphs or ''}" if section else None,
        "title": change.clause_title,
        "action": action,
        "previous_value": change.previous,
        "new_value": change.new,
        "effective_date": rule.effective_date,
        "regulation_part": change.part,
        "clause_number": section if is_52 else None,
        "clause_title": change.clause_title if is_52 else None,
        "revision_date": change.revision_date,
        "text": change.text,
        "source_page": change.block.page,
        "source_reference": _source_reference(rule, change.block.fr_page),
    }
    if change.record_type == "Authority" and rule.authority:
        values["text"] = f"{change.text}\n{rule.authority[0]}"
    return RawRecord(
        record_id=f"rule_data:{position}:change:{change.instruction}:{change.previous or ''}",
        values=values,
        provenance=_prov(document, change.block.page, change.block.bbox, values["text"]),
    )


def build_rule_records(document: Document, rule: FinalRule) -> tuple[list[RawRecord], list[RawRecord]]:
    """(Rule Summary record, FAR Rule Data records in document order)."""

    first = rule.first_block
    page = first.page if first else 1
    heading = rule.title.replace(": ", " — ", 1) if rule.title else None
    reference = " | ".join(
        p for p in (f"FAC {_hyphen(rule.fac)}" if rule.fac else None, f"FAR Case {_hyphen(rule.far_case)}" if rule.far_case else None) if p
    ) or None

    data: list[RawRecord] = []

    def add(record: RawRecord) -> None:
        data.append(record)

    add(
        RawRecord(
            record_id="rule_data:0:rule",
            values={
                **_common(rule),
                "section": "Final Rule",
                "record_type": "Final Rule",
                "far_reference": rule.cfr_parts,
                "title": heading,
                "action": rule.action,
                "effective_date": rule.effective_date,
                "regulation_part": rule.cfr_parts,
                "text": rule.summary,
                "source_page": page,
                "source_reference": _source_reference(rule, first.fr_page if first else None),
            },
            provenance=_prov(document, page, first.bbox if first else None, rule.summary),
        )
    )
    tables_by_context: dict[str | None, list[tuple[LeaderTable, Change | None]]] = {}
    for table, context, change in rule.tables:
        tables_by_context.setdefault(None if change else context, []).append((table, change))

    for section in rule.sections:
        label = f"{section.number}. {section.title}"
        add(
            RawRecord(
                record_id=f"rule_data:{len(data)}:section:{section.number}",
                values={
                    **_common(rule),
                    "section": label,
                    "record_type": "Preamble Section",
                    "title": section.title,
                    "text": section.text,
                    "source_page": section.block.page,
                    "source_reference": _source_reference(rule, section.block.fr_page),
                },
                provenance=_prov(document, section.block.page, section.block.bbox, section.text),
            )
        )
        for table, _ in tables_by_context.pop(label, []):
            data.extend(_threshold_records(document, rule, table, label, None, len(data)))
    for tables in tables_by_context.values():  # a preamble table outside any section
        for table, change in tables:
            if change is None:
                data.extend(_threshold_records(document, rule, table, None, None, len(data)))

    # A 52.xxx section's kind (provision / clause), from its date revision.
    kinds = {far_number(c.section): c.clause_kind for c in rule.changes if c.section and c.clause_kind}
    amendment_tables = {id(change): table for table, _, change in rule.tables if change is not None}
    for change in rule.changes:
        add(_change_record(document, rule, change, kinds, len(data)))
        if id(change) in amendment_tables:
            data.extend(_threshold_records(document, rule, amendment_tables[id(change)], None, change, len(data)))

    thresholds = sum(1 for r in data if r.values.get("record_type") == "Trade Agreement Threshold")
    changes = sum(
        1
        for r in data
        if (r.values.get("section") or "").startswith("Amendment") and r.values.get("record_type") != "Trade Agreement Threshold"
    )
    summary = RawRecord(
        record_id="rule_summary",
        values={
            "document_label": DOCUMENT_LABEL,
            "heading": heading,
            "reference": reference,
            "fac_number": _hyphen(rule.fac),
            "far_case": _hyphen(rule.far_case),
            "action": rule.action,
            "effective_date": rule.effective_date,
            "cfr_parts": rule.cfr_parts,
            "agency": rule.agency,
            "summary": rule.summary,
            "publication": (
                f"Federal Register Vol. {rule.volume}, No. {rule.issue} · {rule.issue_date}" if rule.volume else None
            ),
            "fr_citation": rule.fr_citation,
            "fr_doc": _hyphen(rule.fr_doc),
            "docket": _hyphen(rule.docket),
            "rin": _hyphen(rule.rin),
            "contact": rule.contact,
            "signed_by": rule.signed_by,
            "companions": "; ".join(f"FR Doc. {_hyphen(doc)} — {title}" for doc, title in rule.companions) or None,
            "change_count": changes,
            "threshold_count": thresholds,
        },
        provenance=_prov(
            document,
            page,
            first.bbox if first else None,
            "\n".join(
                str(v)
                for v in (
                    rule.cfr_parts, rule.reference_line, rule.rin and f"RIN {rule.rin}", rule.title,
                    rule.agency and f"AGENCY: {rule.agency}", rule.action and f"ACTION: {rule.action}",
                    rule.summary and f"SUMMARY: {rule.summary}", rule.dates and f"DATES: {rule.dates}",
                    rule.contact, rule.signed_by,
                )
                if v
            ),
        ),
    )
    return [summary], data


def adapt_regulatory_change(database: Session, document: Document) -> AdapterResult:
    import fitz

    try:
        path = ensure_local_copy(get_settings(), stored_filename=document.stored_filename)
        with fitz.open(path) as pdf:
            rule = parse_final_rule(pdf)
    except Exception:  # noqa: BLE001 - an unreadable source renders as an empty rule
        rule = None
    if rule is None:
        return AdapterResult(records={"rule_summary": [], "far_rule_data": []}, outcome_provenance=document.ingestion_provenance)
    summary, data = build_rule_records(document, rule)
    return AdapterResult(
        records={"rule_summary": summary, "far_rule_data": data},
        outcome_provenance=document.ingestion_provenance,
    )


def _dataset_csv(definition: DatasetDefinition) -> ExportCapability:
    return ExportCapability(
        capability_id=f"{definition.dataset_id}_csv",
        label=f"{definition.display_name} (CSV)",
        format="csv",
        href=f"/api/documents/{{document_id}}/staging-workbook/datasets/{definition.dataset_id}.csv",
        dataset_id=definition.dataset_id,
    )


FAR_REGULATORY_CHANGE_PROFILE = StagingProfile(
    # Published regulation text.
    data_class="public",
    profile_id="far_regulatory_change",
    profile_version=1,
    display_name=DOCUMENT_LABEL,
    description=(
        "Federal Register FAR rule (FAC amendment): the rule's facts, its preamble sections, trade-agreement "
        "thresholds and every amendatory change — previous and new value, affected FAR section, provision or "
        "clause — with page-level source traceability."
    ),
    document_families=(FAMILY,),
    datasets=(RULE_SUMMARY, RULE_DATA),
    adapter=adapt_regulatory_change,
    export_capabilities=(
        ExportCapability(
            capability_id="professional_excel",
            label="FAR Rule Workbook (Excel)",
            format="xlsx",
            href="/api/documents/{document_id}/staging-workbook/export.xlsx",
        ),
        _dataset_csv(RULE_DATA),
        _dataset_csv(RULE_SUMMARY),
        ExportCapability(
            capability_id="workbook_json",
            label="FAR Rule Data (JSON)",
            format="json",
            href="/api/documents/{document_id}/staging-workbook/export.json",
        ),
    ),
    views=(
        ProfileView(view_id="rule_summary", label="Rule Summary", dataset_ids=["rule_summary"]),
        ProfileView(view_id="far_rule_data", label="FAR Rule Data", dataset_ids=["far_rule_data"]),
    ),
    export_sheets=(
        ExportSheet("Rule Summary", ("rule_summary",)),
        ExportSheet("FAR Rule Data", ("far_rule_data",)),
    ),
    oracle_mapping_capability="none",
    source_structure="none",
    document_recognizer=recognize_regulatory_change,
    contract_pipeline=False,
)

__all__ = ["FAR_REGULATORY_CHANGE_PROFILE"]
