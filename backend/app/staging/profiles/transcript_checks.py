"""Credit and GPA arithmetic for academic transcripts (validation rules
ED-03..ED-05, docs/di-01-validation-rules.md).

Recomputes total credits and the cumulative GPA from the course rows and
compares them with what the transcript states. The GPA is recalculated
only on a known grading scale: the scale the transcript prints, else the
common US 4.0 letter scale when every grade is a letter on it (reported
as an assumption). A disagreement makes the stated value Needs Review; the
stated value is never replaced.
"""

from __future__ import annotations

import re

from app.staging.models import ValidationCheck
from app.staging.profile import RawRecord

US_4_SCALE = {
    "A+": 4.0, "A": 4.0, "A-": 3.7, "B+": 3.3, "B": 3.0, "B-": 2.7,
    "C+": 2.3, "C": 2.0, "C-": 1.7, "D+": 1.3, "D": 1.0, "D-": 0.7, "F": 0.0,
}
# Grades that carry no grade points; the first set still earns credit.
PASS_NO_POINTS = {"P", "S", "CR", "TR"}
NO_CREDIT = {"W", "WD", "I", "IP", "AU", "NC", "U", "NR", "Z", "F"}

_SCALE_PAIR = re.compile(r"\b([A-F][+-]?)\s*[=:]\s*(\d(?:\.\d{1,2})?)\b")
_NUMBER = re.compile(r"\d+(?:\.\d+)?")


def printed_scale(text: str) -> dict[str, float] | None:
    pairs = {grade: float(points) for grade, points in _SCALE_PAIR.findall(text or "")}
    return pairs if len(pairs) >= 4 else None


def _first_number(value) -> float | None:
    match = _NUMBER.search(str(value or ""))
    return float(match.group(0)) if match else None


def _credits(course: RawRecord) -> float | None:
    for key in ("credits_earned", "credits", "credits_attempted"):
        number = _first_number(course.values.get(key))
        if number is not None:
            return number
    return None


def _summary(summary: list[RawRecord], *field_ids: str) -> RawRecord | None:
    for field_id in field_ids:
        for record in summary:
            if record.values.get("field_id") == field_id and record.values.get("scope") in (None, "", "cumulative", "overall"):
                return record
    return None


def _row(check: str, computed, stated, result: str, details: str) -> RawRecord:
    return RawRecord(
        record_id=f"academic_check:{check}",
        values={"check": check, "computed": computed, "stated": stated, "result": result, "details": details},
    )


def academic_checks(courses: list[RawRecord], summary: list[RawRecord], page_text: str) -> list[RawRecord]:
    """Check rows; failed comparisons are also added to the stated summary
    record's cell checks (so that cell is Needs Review)."""

    rows: list[RawRecord] = []
    graded = [
        (str(c.values.get("grade") or "").strip().upper(), _credits(c))
        for c in courses
        if c.values.get("grade") not in (None, "") and _credits(c) is not None
    ]
    rows.append(_row("Courses read", len(courses), None, "INFO",
                     f"{len(graded)} of {len(courses)} course row(s) have both credits and a grade."))
    if not graded:
        return rows

    attempted = sum(credits for _, credits in graded)
    earned = sum(credits for grade, credits in graded if grade not in NO_CREDIT)
    stated_total = _summary(summary, "transcript.summary.total_credits", "transcript.summary.credits_earned")
    if stated_total is not None:
        stated = _first_number(stated_total.values.get("value"))
        matches = [label for label, total in (("earned", earned), ("attempted", attempted)) if stated is not None and abs(total - stated) < 0.01]
        if matches:
            rows.append(_row("Total credits", _fmt(earned if "earned" in matches else attempted), stated_total.values.get("value"),
                             "PASS", f"Sum of course credits ({matches[0]}) equals the stated total."))
        else:
            message = f"Course credits sum to {_fmt(earned)} earned / {_fmt(attempted)} attempted; the transcript states {stated_total.values.get('value')}."
            rows.append(_row("Total credits", _fmt(earned), stated_total.values.get("value"), "REVIEW", message))
            stated_total.cell_checks.setdefault("value", []).append(
                ValidationCheck(check="credit_arithmetic", passed=False, message=message)
            )
    else:
        rows.append(_row("Total credits", _fmt(earned), None, "NOT STATED", "The transcript states no credit total to compare."))

    scale = printed_scale(page_text)
    scale_source = "the grading scale printed on the transcript"
    if scale is None:
        letters = {grade for grade, _ in graded if grade not in PASS_NO_POINTS}
        if letters and letters <= set(US_4_SCALE):
            scale, scale_source = US_4_SCALE, "the standard US 4.0 letter scale (assumed — no scale is printed)"
    if scale is None:
        rows.append(_row("Cumulative GPA", None, None, "NOT CHECKED",
                         "The grading scale is unknown, so the GPA is not recalculated."))
        return rows

    points = gpa_credits = 0.0
    unscaled = []
    for grade, credits in graded:
        if grade in PASS_NO_POINTS or grade in NO_CREDIT - {"F"}:
            continue
        if grade not in scale:
            unscaled.append(grade)
            continue
        points += scale[grade] * credits
        gpa_credits += credits
    if not gpa_credits:
        rows.append(_row("Cumulative GPA", None, None, "NOT CHECKED", "No graded course carries grade points."))
        return rows
    gpa = points / gpa_credits
    computed = f"{gpa:.3f}"
    detail = f"{points:g} grade points / {gpa_credits:g} GPA credits on {scale_source}."
    if unscaled:
        detail += f" Grades not on the scale were left out: {', '.join(sorted(set(unscaled)))}."
    stated_gpa = _summary(summary, "transcript.summary.cumulative_gpa")
    if stated_gpa is None:
        rows.append(_row("Cumulative GPA", computed, None, "NOT STATED", detail))
        return rows
    stated = _first_number(stated_gpa.values.get("value"))
    rounded, truncated = round(gpa + 1e-9, 2), int(gpa * 100) / 100
    if stated is not None and (abs(stated - rounded) < 0.005 or abs(stated - truncated) < 0.005):
        rows.append(_row("Cumulative GPA", computed, stated_gpa.values.get("value"), "PASS", detail))
    else:
        message = f"Recalculated GPA is {gpa:.2f}; the transcript states {stated_gpa.values.get('value')}. {detail}"
        rows.append(_row("Cumulative GPA", computed, stated_gpa.values.get("value"), "REVIEW", message))
        stated_gpa.cell_checks.setdefault("value", []).append(
            ValidationCheck(check="gpa_recalculation", passed=False, message=message)
        )
    return rows


def _fmt(number: float) -> str:
    return f"{number:g}"
