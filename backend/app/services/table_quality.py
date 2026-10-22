"""Post-detection table acceptance gate for Dataomatix.

Scores candidate tables and rejects prose / segmentation artifacts that were
incorrectly split into columns, while preserving legitimate one-row form tables.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from typing import Any, Literal

PROSE_MARKERS: tuple[str, ...] = (
    "pursuant to",
    "far ",
    "section ",
    "shall ",
    "hereby",
    "oasis+",
    "task order",
    "in accordance with",
    "subject to",
    "provided that",
    "notwithstanding",
    "contractor shall",
    "the government",
    "as set forth",
    "including but not limited",
)

_WORD_RE = re.compile(r"[A-Za-z0-9]+")
_SENTENCE_END_RE = re.compile(r"[.!?]\s+[A-Z]")
_TRAILING_PUNCT_RE = re.compile(r"[,:;]$")
_LEADING_LOWER_RE = re.compile(r"^[a-z]")
_TITLE_LIKE_RE = re.compile(
    r"^[A-Z0-9][A-Za-z0-9 /#.\-']{0,48}:?$"
)

_FORM_HEADER_MAX_LEN = 48
_FORM_VALUE_MAX_LEN = 80
_LONG_CELL_LEN = 60
_FRAGMENT_WORD_MIN = 8

AcceptanceStatus = Literal["accepted", "rejected"]


@dataclass(frozen=True)
class TableQualityAssessment:
    table_structure_score: float
    header_quality_score: float
    row_consistency_score: float
    prose_probability: float
    table_acceptance_status: AcceptanceStatus
    rejection_reason: str | None


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def _normalize_cell(value: Any) -> str:
    if value is None:
        return ""
    return " ".join(str(value).strip().split())


def _normalize_rows(
    headers: list[str],
    rows: list[dict] | list[list],
) -> list[list[str]]:
    normalized_headers = [_normalize_cell(h) for h in headers]
    out: list[list[str]] = []
    for row in rows:
        if isinstance(row, dict):
            if normalized_headers and any(h in row for h in normalized_headers):
                cells = [_normalize_cell(row.get(h, "")) for h in normalized_headers]
            else:
                cells = [_normalize_cell(v) for v in row.values()]
        else:
            cells = [_normalize_cell(v) for v in row]
        out.append(cells)
    return out


def _word_count(text: str) -> int:
    return len(_WORD_RE.findall(text))


def _looks_like_form_header(header: str) -> bool:
    text = _normalize_cell(header)
    if not text or len(text) > _FORM_HEADER_MAX_LEN:
        return False
    # Multi-clause sentence punctuation — not a form label.
    if text.count(",") >= 2:
        return False
    # Full sentence endings only when there is enough surrounding text.
    if _SENTENCE_END_RE.search(text) and _word_count(text) >= 5:
        return False
    lower = text.lower()
    if any(marker in lower for marker in PROSE_MARKERS):
        return False
    words = _WORD_RE.findall(text.rstrip(":"))
    if not words or len(words) > 8:
        return False
    # Short title-like labels, optionally ending with a colon.
    stripped = text.rstrip(":")
    if _TITLE_LIKE_RE.match(stripped) or text.endswith(":"):
        return True
    # Compact Title Case / UPPER labels without sentence punctuation.
    if not any(ch in text for ch in "!?"):
        return len(stripped) <= 32 and len(words) <= 6
    return False


def _header_is_sentence_fragment(header: str) -> bool:
    text = _normalize_cell(header)
    if not text:
        return False
    # Short form labels like "A. NAME" use abbreviation periods — not prose.
    if _looks_like_form_header(text) and _word_count(text) <= 6 and len(text) <= 40:
        return False
    lower = text.lower()
    if any(marker in lower for marker in PROSE_MARKERS):
        return True
    if _LEADING_LOWER_RE.match(text):
        return True
    if _TRAILING_PUNCT_RE.search(text.rstrip()) and _word_count(text) >= 4:
        return True
    if _SENTENCE_END_RE.search(text) and _word_count(text) >= 5:
        return True
    if len(text) > 70 and _word_count(text) >= 10:
        return True
    if text.count(",") >= 2 and _word_count(text) >= 6:
        return True
    return False


def _cell_is_sentence_fragment(text: str) -> bool:
    if not text:
        return False
    lower = text.lower()
    if any(marker in lower for marker in PROSE_MARKERS):
        return True
    words = _word_count(text)
    if len(text) >= _LONG_CELL_LEN and words >= _FRAGMENT_WORD_MIN:
        return True
    if text.count(",") >= 2 and words >= 6:
        return True
    if _SENTENCE_END_RE.search(text) and words >= 5:
        return True
    if _LEADING_LOWER_RE.match(text) and words >= 4:
        return True
    if _TRAILING_PUNCT_RE.search(text) and words >= 5:
        return True
    return False


def _join_row_text(cells: list[str]) -> str:
    return " ".join(c for c in cells if c)


def _reads_as_prose(joined: str) -> bool:
    if not joined or _word_count(joined) < 10:
        return False
    lower = joined.lower()
    marker_hits = sum(1 for m in PROSE_MARKERS if m in lower)
    if marker_hits >= 1 and _word_count(joined) >= 12:
        return True
    if _SENTENCE_END_RE.search(joined) and _word_count(joined) >= 14:
        return True
    # Continuous prose: many words, few numeric/code tokens, flowing punctuation.
    words = _WORD_RE.findall(joined)
    alpha_words = [w for w in words if w.isalpha()]
    if len(alpha_words) >= 16 and joined.count(",") >= 2:
        return True
    if len(alpha_words) >= 12 and any(
        joined.endswith(p) for p in (".", ";", ",")
    ):
        return True
    return False


def _cells_reconstruct_as_prose(
    headers: list[str],
    rows: list[dict] | list[list],
) -> bool:
    header_texts = [_normalize_cell(h) for h in headers]
    header_joined = _join_row_text(header_texts)
    if _reads_as_prose(header_joined) or (
        len(header_texts) >= 3
        and _word_count(header_joined) >= 10
        and sum(1 for h in header_texts if _header_is_sentence_fragment(h))
        >= max(2, len(header_texts) // 2)
    ):
        return True

    normalized = _normalize_rows(header_texts, rows)
    if not normalized:
        return False

    prose_rows = 0
    for cells in normalized:
        joined = _join_row_text(cells)
        if _reads_as_prose(joined):
            prose_rows += 1
            continue
        # Adjacent cells that stitch into a grammatical continuation.
        if len(cells) >= 2:
            stitched = " ".join(cells)
            if _reads_as_prose(stitched):
                prose_rows += 1
                continue
            continuations = 0
            for left, right in zip(cells, cells[1:]):
                if not left or not right:
                    continue
                if (
                    _TRAILING_PUNCT_RE.search(left)
                    or _LEADING_LOWER_RE.match(right)
                    or left.lower().endswith((" the", " of", " to", " and", " for"))
                ):
                    continuations += 1
            if continuations >= max(1, len(cells) - 1) and _word_count(stitched) >= 10:
                prose_rows += 1

    return prose_rows >= max(1, (len(normalized) + 1) // 2)


def _values_look_compact(cells: list[str]) -> bool:
    nonempty = [c for c in cells if c]
    if not nonempty:
        return False
    compact = [
        c
        for c in nonempty
        if len(c) <= _FORM_VALUE_MAX_LEN
        and _word_count(c) <= 10
        and not _cell_is_sentence_fragment(c)
    ]
    return len(compact) / len(nonempty) >= 0.75


def _has_strong_form_kv_evidence(
    headers: list[str],
    rows: list[list[str]],
) -> bool:
    if len(rows) != 1:
        return False
    if not headers or not all(_looks_like_form_header(h) for h in headers if h):
        return False
    nonempty_headers = [h for h in headers if h]
    if len(nonempty_headers) < 1:
        return False
    return _values_look_compact(rows[0])


def _score_headers(headers: list[str]) -> tuple[float, float]:
    """Return (header_quality_score, header_prose_signal)."""
    if not headers:
        return 0.15, 0.4

    cleaned = [_normalize_cell(h) for h in headers]
    nonempty = [h for h in cleaned if h]
    if not nonempty:
        return 0.2, 0.35

    fragment_n = sum(1 for h in nonempty if _header_is_sentence_fragment(h))
    form_n = sum(1 for h in nonempty if _looks_like_form_header(h))
    unique_ratio = len({h.lower() for h in nonempty}) / len(nonempty)
    avg_len = sum(len(h) for h in nonempty) / len(nonempty)

    quality = 0.55
    quality += 0.25 * (form_n / len(nonempty))
    quality += 0.15 * unique_ratio
    if avg_len <= 28:
        quality += 0.1
    elif avg_len > 55:
        quality -= 0.25
    quality -= 0.55 * (fragment_n / len(nonempty))

    prose_signal = fragment_n / len(nonempty)
    if _reads_as_prose(_join_row_text(nonempty)):
        prose_signal = max(prose_signal, 0.85)
        quality = min(quality, 0.25)

    return _clamp01(quality), _clamp01(prose_signal)


def _score_rows(rows: list[list[str]], col_count: int) -> tuple[float, float]:
    """Return (row_consistency_score, cell_prose_signal)."""
    if not rows:
        return 0.2, 0.3

    widths = [len(r) for r in rows]
    target = col_count or max(widths)
    width_ok = sum(1 for w in widths if w == target) / len(widths)

    nonempty_counts = [sum(1 for c in r if c) for r in rows]
    avg_fill = (
        sum(nonempty_counts) / (len(rows) * max(target, 1)) if rows else 0.0
    )
    fill_spread = 0.0
    if nonempty_counts:
        mean = sum(nonempty_counts) / len(nonempty_counts)
        if mean > 0:
            fill_spread = sum(abs(c - mean) for c in nonempty_counts) / (
                len(nonempty_counts) * mean
            )

    all_cells = [c for r in rows for c in r if c]
    fragment_ratio = (
        sum(1 for c in all_cells if _cell_is_sentence_fragment(c)) / len(all_cells)
        if all_cells
        else 0.0
    )

    consistency = 0.35 + 0.35 * width_ok + 0.25 * min(1.0, avg_fill * 1.2)
    consistency -= 0.2 * min(1.0, fill_spread)
    consistency -= 0.45 * fragment_ratio

    return _clamp01(consistency), _clamp01(fragment_ratio)


def _score_structure(
    headers: list[str],
    rows: list[list[str]],
    *,
    form_kv: bool,
) -> float:
    cols = len(headers)
    n_rows = len(rows)
    if cols <= 0:
        return 0.1

    score = 0.4
    if cols >= 2:
        score += 0.2
    if n_rows >= 2:
        score += 0.25
    elif n_rows == 1 and form_kv:
        score += 0.3
    elif n_rows == 1:
        score -= 0.25
    elif n_rows == 0:
        score -= 0.3

    # Reward distinct short headers vs long overlapping prose chunks.
    if headers and all(_looks_like_form_header(h) for h in headers if h):
        score += 0.15

    nonempty = sum(1 for r in rows for c in r if c)
    if nonempty == 0:
        score -= 0.3

    return _clamp01(score)


def assess_table_candidate(
    *,
    headers: list[str],
    rows: list[dict] | list[list],
    page_text: str | None = None,
) -> TableQualityAssessment:
    header_list = [_normalize_cell(h) for h in headers]
    normalized_rows = _normalize_rows(header_list, rows)
    form_kv = _has_strong_form_kv_evidence(header_list, normalized_rows)

    header_quality, header_prose = _score_headers(header_list)
    row_consistency, cell_prose = _score_rows(normalized_rows, len(header_list))
    structure = _score_structure(header_list, normalized_rows, form_kv=form_kv)

    reconstructs = _cells_reconstruct_as_prose(header_list, normalized_rows)
    all_cells = [c for r in normalized_rows for c in r if c]
    fragment_ratio = (
        sum(1 for c in all_cells if _cell_is_sentence_fragment(c)) / len(all_cells)
        if all_cells
        else 0.0
    )

    prose_probability = _clamp01(
        0.45 * header_prose
        + 0.35 * cell_prose
        + (0.35 if reconstructs else 0.0)
        + 0.25 * fragment_ratio
    )
    if page_text:
        page_lower = page_text.lower()
        page_hits = sum(1 for m in PROSE_MARKERS if m in page_lower)
        if page_hits >= 3 and reconstructs:
            prose_probability = _clamp01(prose_probability + 0.1)

    rejection_reason: str | None = None

    if reconstructs:
        rejection_reason = "cells reconstruct as continuous prose"
    elif fragment_ratio >= 0.55 and not form_kv:
        rejection_reason = "most cells look like sentence fragments"
    elif any(_header_is_sentence_fragment(h) for h in header_list if h) and (
        header_prose >= 0.5 or prose_probability >= 0.55
    ):
        rejection_reason = "headers look like sentence fragments"
    elif len(normalized_rows) == 1 and not form_kv:
        rejection_reason = "one-row segmentation artifact without form key/value evidence"
    elif (
        structure < 0.35
        and header_quality < 0.4
        and row_consistency < 0.4
        and not form_kv
    ):
        rejection_reason = "lack of meaningful structured relationships"
    elif prose_probability >= 0.72 and not form_kv:
        rejection_reason = "high prose probability for candidate table"

    # Soften scores when rejecting for prose / fragments.
    if rejection_reason:
        structure = _clamp01(structure * 0.55)
        header_quality = _clamp01(header_quality * 0.6)
        row_consistency = _clamp01(row_consistency * 0.6)
        status: AcceptanceStatus = "rejected"
    else:
        status = "accepted"

    return TableQualityAssessment(
        table_structure_score=structure,
        header_quality_score=header_quality,
        row_consistency_score=row_consistency,
        prose_probability=prose_probability,
        table_acceptance_status=status,
        rejection_reason=rejection_reason,
    )


def is_accepted_table(
    *,
    headers: list[str],
    rows: list[dict] | list[list],
    page_text: str | None = None,
) -> bool:
    return (
        assess_table_candidate(
            headers=headers,
            rows=rows,
            page_text=page_text,
        ).table_acceptance_status
        == "accepted"
    )


def filter_accepted_tables(tables: list[dict]) -> list[dict]:
    """Keep accepted tables and attach assessment under ``_quality``."""
    accepted: list[dict] = []
    for table in tables:
        headers = list(table.get("headers") or [])
        rows = list(table.get("rows") or [])
        page = table.get("page")
        page_text = table.get("page_text")
        if page_text is None and isinstance(page, str):
            page_text = page
        assessment = assess_table_candidate(
            headers=headers,
            rows=rows,
            page_text=page_text if isinstance(page_text, str) else None,
        )
        if assessment.table_acceptance_status != "accepted":
            continue
        enriched = dict(table)
        enriched["_quality"] = asdict(assessment)
        accepted.append(enriched)
    return accepted
