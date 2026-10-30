"""Document dates by meaning — issue, award, effective, start, end,
expiration, renewal, due, period of performance — and the document's
expiration status: Active, Expiring Soon, Expired, Not Applicable or
Unknown.

Every date carries its page and evidence. A date printed as such is
"explicit"; a date read off another statement (an expiry taken from the end
of the period of performance when no expiration date is printed) is
"inferred" and says what it was inferred from. Status is computed only
from an identified expiration date: no date, no status (Unknown).
"""

from __future__ import annotations

from datetime import date
from typing import Any

from app.skills.values import dates_in, parse_date

# Classes whose documents run out (status needed); others are Not
# Applicable unless they print an expiration date themselves.
_EXPIRING_CLASSES = {"contract", "identity"}

# The key-date detector's kinds (app/key_dates/detector.py) by role.
_KEY_DATE_ROLE = {
    "expiry": "expiration", "valid_until": "expiration", "renewal": "renewal", "termination": "expiration",
    "period_end": "end", "due": "due", "issue": "issue", "award": "award", "effective": "effective", "start": "start",
}

ROLE_LABELS = {
    "issue": "Issue Date", "award": "Award Date", "effective": "Effective Date", "start": "Start Date",
    "end": "End Date", "expiration": "Expiration Date", "renewal": "Renewal Date", "due": "Due Date",
    "period": "Period of Performance",
}


def _entry(role: str, text: str, parsed: date | None, **source: Any) -> dict[str, Any]:
    return {
        "role": role,
        "role_label": ROLE_LABELS.get(role, role.title()),
        "text": text,
        "date": parsed.isoformat() if parsed else None,
        "valid": parsed is not None,
        "basis": source.pop("basis", "explicit"),
        **source,
    }


def document_dates(
    business: dict[str, Any],
    key_dates: list[Any],
    *,
    today: date,
    warning_days: int,
) -> dict[str, Any]:
    dates: list[dict[str, Any]] = []
    for section in business["sections"]:
        for field in section["fields"]:
            value = field.get("value")
            if not value:
                continue
            source = {"label": field["label"], "page": field["page"], "evidence": field["evidence"],
                      "record_key": field["record_key"], "source": "document field"}
            if field.get("date_role"):
                dates.append(_entry(field["date_role"], value, parse_date(value) or (dates_in(value)[0][1] if dates_in(value) else None), **source))
            elif field["key"] == "period_of_performance":
                found = dates_in(value)
                dates.append(_entry("period", value, None, **source))
                if found:
                    dates.append(_entry("start", found[0][0], found[0][1], **{**source, "label": f"{field['label']} (start)"}))
                if len(found) > 1:
                    dates.append(_entry("end", found[-1][0], found[-1][1], **{**source, "label": f"{field['label']} (end)"}))
    starts = {d["date"] for d in dates if d["role"] == "start"}
    for row in key_dates:
        role = _KEY_DATE_ROLE.get(row.kind)
        if not role:
            continue
        iso = row.date.isoformat()
        if any(d["role"] == role and d["date"] == iso for d in dates):
            continue
        # An open period ("07/01/2025 -") read as ending where it starts.
        if role == "end" and iso in starts:
            continue
        dates.append(_entry(role, (row.details or {}).get("original_text") or iso, row.date, label=row.label,
                            page=row.page, evidence=row.evidence_text, record_key=None, source="key date detector"))

    document_class = business.get("document_class")
    expiry = next((d for d in dates if d["role"] == "expiration" and d["valid"]), None)
    if expiry is None and document_class == "contract":
        # The last period end (the final option year), not the first.
        end = max((d for d in dates if d["role"] == "end" and d["valid"]), key=lambda d: d["date"], default=None)
        if end is not None:
            expiry = {**end, "role": "expiration", "role_label": "Expiration Date", "basis": "inferred",
                      "inferred_from": end["label"]}
            dates.append(expiry)

    if expiry is None:
        status = "Unknown" if document_class in _EXPIRING_CLASSES else "Not Applicable"
        days_remaining = None
        reason = (
            "No expiration date was identified in the document."
            if status == "Unknown" else "This kind of document doesn't expire."
        )
    else:
        days_remaining = (date.fromisoformat(expiry["date"]) - today).days
        if days_remaining < 0:
            status, reason = "Expired", f"Expired {-days_remaining} days ago."
        elif days_remaining <= warning_days:
            status, reason = "Expiring Soon", f"Expires in {days_remaining} days."
        else:
            status, reason = "Active", f"Expires in {days_remaining} days."
        if expiry["basis"] == "inferred":
            reason += f" Inferred from {expiry['inferred_from']}."
    return {
        "status": status,
        "reason": reason,
        "days_remaining": days_remaining,
        "warning_days": warning_days,
        "expiration": expiry,
        "dates": dates,
    }
