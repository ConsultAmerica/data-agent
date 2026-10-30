"""A page's plain text in reading order — exactly what PyMuPDF's
``page.get_text("text", sort=True)`` returns, computed faster.

PyMuPDF's ``get_sorted_text`` builds a ``Rect`` object for every word and
every running union (about 1,000 per page on a dense contract), which made
it most of the page-loading time on long PDFs (14.9 of 26 s for a 288-page
contract). This is the same algorithm — same words, flags, tolerance,
spacing and line-break rules — on plain float tuples. MuPDF computes in
float32 and every coordinate here already is one, so min/max unions are
exact and the output is byte-identical (tests/test_sorted_page_text.py
compares it on real documents).
"""

from __future__ import annotations

import fitz

_EMPTY = (fitz.FZ_MAX_INF_RECT, fitz.FZ_MAX_INF_RECT, fitz.FZ_MIN_INF_RECT, fitz.FZ_MIN_INF_RECT)

Box = tuple[float, float, float, float]


def _is_empty(r: Box) -> bool:
    return r[0] >= r[2] or r[1] >= r[3]


def _union(a: Box, b: Box) -> Box:
    # Rect.include_rect: an empty operand leaves the other unchanged.
    if _is_empty(b):
        return a
    if _is_empty(a):
        return b
    return (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))


def _sort_words(words: list, tolerance: float) -> list:
    """pymupdf.utils.get_text_words(sort=True): line-wise, forgiving small
    vertical deviations, each line left to right."""

    words.sort(key=lambda w: (w[3], w[0]))
    ordered: list = []
    line = [words[0]]
    lrect: Box = tuple(words[0][:4])
    for w in words[1:]:
        if abs(w[1] - lrect[1]) <= tolerance or abs(w[3] - lrect[3]) <= tolerance:
            line.append(w)
            lrect = _union(lrect, tuple(w[:4]))
        else:
            line.sort(key=lambda item: item[0])
            ordered.extend(line)
            line = [w]
            lrect = tuple(w[:4])
    line.sort(key=lambda item: item[0])
    ordered.extend(line)
    return ordered


def _line_text(clip: Box, line: list[tuple[Box, str]]) -> str:
    line.sort(key=lambda w: w[0][0])
    text = ""
    x1 = clip[0]
    for r, t in line:
        width = max(0, r[2] - r[0])
        spaces = max(int(round((r[0] - x1) / width * len(t))), 0 if (x1 == clip[0] or r[0] <= x1) else 1)
        text += " " * spaces + t
        x1 = r[2]
    return text


def sorted_page_text(page: fitz.Page, tolerance: float = 3) -> str:
    textpage = page.get_textpage(flags=fitz.TEXTFLAGS_TEXT)
    raw = textpage.extractWORDS(None)
    del textpage
    if not raw:
        return ""
    words = [(tuple(w[:4]), w[4]) for w in _sort_words(raw, tolerance)]

    totalbox: Box = _EMPTY
    for box, _ in words:
        totalbox = _union(totalbox, box)

    lines: list[tuple[Box, str]] = []
    line = [words[0]]
    lrect = words[0][0]
    for box, text in words[1:]:
        if abs(lrect[1] - box[1]) <= tolerance or abs(lrect[3] - box[3]) <= tolerance:
            line.append((box, text))
            lrect = _union(lrect, box)
        else:
            lines.append((lrect, _line_text(totalbox, line)))
            line = [(box, text)]
            lrect = box
    lines.append((lrect, _line_text(totalbox, line)))

    lines.sort(key=lambda item: item[0][3])
    text = lines[0][1]
    y1 = lines[0][0][3]
    for rect, line_text in lines[1:]:
        height = max(0, rect[3] - rect[1])
        distance = min(int(round((rect[1] - y1) / height)), 5)
        text += "\n" * (distance + 1) + line_text
        y1 = rect[3]
    return text
