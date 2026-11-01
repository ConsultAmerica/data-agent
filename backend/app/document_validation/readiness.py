"""Oracle Fusion mapping readiness of the source data.

One of:
- ready: Ready for Mapping
- ready_with_warnings: Ready with Warnings
- review_required: Review Required

It says whether the extracted data can be mapped as it is. It doesn't say
that an Oracle target is configured or that an import will succeed. It
never blocks the mapping workspace.
"""

from __future__ import annotations

from typing import Any

from app.document_validation import business_fields

READINESS_LABELS = {
    "ready": "Ready for Mapping",
    "ready_with_warnings": "Ready with Warnings",
    "review_required": "Review Required",
}
NOTE = ("Source-data readiness only: it doesn't confirm that an Oracle target is configured "
        "or that an import will succeed.")
# Validation kinds that leave a mapped value uncertain.
_CRITICAL_KINDS = {"missing_required", "conflicting_values", "incorrect_total", "cross_field"}
_PARTY_WORDS = ("contractor", "supplier", "vendor", "merchant", "customer", "buyer", "account_holder", "holder", "name")


def _check(key: str, label: str, status: str, detail: str, **extra: Any) -> dict[str, Any]:
    # status: passed | warning | blocker | info
    return {"key": key, "label": label, "status": status, "detail": detail, **extra}


def mapping_readiness(
    *,
    file: dict[str, Any],
    classification: dict[str, Any],
    business: dict[str, Any],
    validation: dict[str, Any],
    labels: dict[str, Any],
    completeness: dict[str, Any],
    entities: dict[str, Any],
    layout_stats: dict[str, Any],
) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []

    if file["status"] == "failed":
        checks.append(_check("file", "File verified", "blocker", "The file failed verification"))
    else:
        checks.append(_check("file", "File verified", "passed", "The file verified"))

    status = classification.get("status")
    family_label = classification.get("family_label") or "Unknown"
    if classification.get("decided") or status == "classified":
        checks.append(_check("classification", "Document type", "passed", family_label))
    elif status == "review_required":
        checks.append(_check("classification", "Document type", "blocker",
                             f"{family_label} — confidence too low: confirm or change the type"))
    else:
        checks.append(_check("classification", "Document type", "warning",
                             f"{family_label} — confirming the type is recommended"))

    fields = business_fields(business)
    skill = business.get("skill")
    if skill is None:
        checks.append(_check("identifiers", "Source identifiers", "warning",
                             "No business fields are defined for this type: mapping uses the document's own labels"))
    else:
        required = [f for f in fields if f.get("required")]
        missing = [f["label"] for f in required if not f.get("value")]
        uncertain = [f["label"] for f in required if f.get("value") and f.get("association") == "needs_review"]
        if missing:
            checks.append(_check("identifiers", "Source identifiers", "blocker", f"Not found: {', '.join(missing)}",
                                 fields=missing))
        elif uncertain:
            checks.append(_check("identifiers", "Source identifiers", "blocker",
                                 f"Uncertain which value belongs to: {', '.join(uncertain)}", fields=uncertain))
        else:
            found = ", ".join(f"{f['label']} {f['value']}" for f in required[:3])
            checks.append(_check("identifiers", "Source identifiers", "passed", found or "None required"))
        parties = [f for f in fields if any(w in f["key"] for w in _PARTY_WORDS)]
        if parties:
            named = [f for f in parties if f.get("value")]
            checks.append(_check(
                "relationships", "Contract and party relationships", "passed" if named else "warning",
                f"{named[0]['label']}: {named[0]['value']}" if named else f"No {parties[0]['label'].lower()} found",
            ))

    unresolved = len(labels.get("unresolved") or [])
    uncertain_fields = [f["label"] for f in fields if f.get("association") == "needs_review" and not f.get("required")]
    if unresolved or uncertain_fields:
        parts = []
        if unresolved:
            parts.append(f"{unresolved} value(s) without a readable label")
        if uncertain_fields:
            parts.append(f"uncertain association: {', '.join(uncertain_fields[:4])}")
        checks.append(_check("labels", "Field-label confidence", "warning", "; ".join(parts)))
    else:
        checks.append(_check("labels", "Field-label confidence", "passed",
                             f"{labels.get('resolved', 0)} of {labels.get('total', 0)} labels resolved"))

    critical = [i for g in validation.get("groups") or [] if g["kind"] in _CRITICAL_KINDS for i in g["issues"]]
    if critical:
        checks.append(_check("conflicts", "Critical extraction conflicts", "blocker",
                             f"{len(critical)} unresolved: {critical[0]['message']}", count=len(critical)))
    else:
        checks.append(_check("conflicts", "Critical extraction conflicts", "passed", "None unresolved"))

    table_gaps = [m for m in completeness.get("measures") or [] if m["key"] in ("tables", "table_rows") and m["status"] == "gaps"]
    cell_groups = [g for g in validation.get("groups") or [] if g["kind"] == "invalid_cell"]
    if table_gaps or cell_groups:
        detail = "; ".join([m["detail"] for m in table_gaps] + [f"{len(g['issues'])} cell(s) don't fit their column" for g in cell_groups])
        checks.append(_check("tables", "Table structure", "warning", detail))
    elif layout_stats.get("tables"):
        checks.append(_check("tables", "Table structure", "passed", f"{layout_stats['tables']} table(s), {layout_stats.get('table_rows', 0)} rows"))

    contracts = entities.get("contracts") or []
    if len(contracts) > 1:
        checks.append(_check("isolation", "Multiple-contract isolation", "warning",
                             f"{len(contracts)} contracts in one document ({', '.join(contracts[:4])}): "
                             "each table keeps its own contract number; map each contract separately",
                             contracts=contracts))

    location = layout_stats.get("source_location") or {}
    none = location.get("none", 0)
    total = sum(location.values()) if location else 0
    if total and none:
        checks.append(_check("evidence", "Source evidence", "info",
                             f"{none} of {total} value(s) have no recorded location (the values stay valid)"))
    elif total:
        checks.append(_check("evidence", "Source evidence", "passed", f"{total} value(s) traced to their page"))

    omitted = next((m for m in completeness.get("measures") or [] if m["key"] == "form_fields" and m["status"] == "gaps"), None)
    if omitted:
        checks.append(_check("form_fields", "Filled form fields represented", "warning", f"{omitted['missing_count']} filled form field(s) not represented"))

    statuses = {c["status"] for c in checks}
    state = "review_required" if "blocker" in statuses else "ready_with_warnings" if "warning" in statuses else "ready"
    return {"state": state, "label": READINESS_LABELS[state], "checks": checks, "note": NOTE}
