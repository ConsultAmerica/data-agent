"""Provider-neutral page layout: words, lines and tables with geometry.

Every provider maps its own output into these types, in one of the two
coordinate spaces the platform already uses for evidence
(services/evidence_geometry.py):

    pdf_points   PDF user space, 72 per inch, origin top-left
    ocr_pixels   pixels of the page image the engine read, at `dpi`
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

CoordSpace = Literal["pdf_points", "ocr_pixels"]
BBox = tuple[float, float, float, float]  # x0, y0, x1, y1


@dataclass(frozen=True)
class Word:
    text: str
    bbox: BBox
    confidence: float | None = None  # 0..1


@dataclass(frozen=True)
class Line:
    text: str
    bbox: BBox
    words: tuple[Word, ...] = ()
    confidence: float | None = None


@dataclass
class PageLayout:
    page: int  # 1-based
    width: float
    height: float
    coord_space: CoordSpace
    dpi: float | None = None  # for ocr_pixels
    words: list[Word] = field(default_factory=list)
    lines: list[Line] = field(default_factory=list)

    @property
    def text(self) -> str:
        if self.lines:
            return "\n".join(line.text for line in self.lines)
        return " ".join(word.text for word in self.words)

    @property
    def mean_confidence(self) -> float | None:
        values = [w.confidence for w in self.words if w.confidence is not None]
        return sum(values) / len(values) if values else None


@dataclass(frozen=True)
class TableCell:
    row: int
    column: int
    text: str
    bbox: BBox | None = None


@dataclass
class TableResult:
    page: int
    rows: int
    columns: int
    cells: list[TableCell] = field(default_factory=list)
    coord_space: CoordSpace | None = None

    def grid(self) -> list[list[str]]:
        grid = [["" for _ in range(self.columns)] for _ in range(self.rows)]
        for cell in self.cells:
            if 0 <= cell.row < self.rows and 0 <= cell.column < self.columns:
                grid[cell.row][cell.column] = cell.text
        return grid


def polygon_bbox(polygon: list[float] | None, scale: float = 1.0) -> BBox | None:
    """[x1, y1, x2, y2, ...] → axis-aligned box, scaled."""

    if not polygon or len(polygon) < 4:
        return None
    xs, ys = polygon[0::2], polygon[1::2]
    return (min(xs) * scale, min(ys) * scale, max(xs) * scale, max(ys) * scale)
