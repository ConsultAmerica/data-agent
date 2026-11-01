"""Ruled tables on raster (OCR) pages, found from the printed grid itself.

Native PDFs get table rules as vector lines (pdf_structure._ruled_tables);
a scanned page only has pixels, and inferring its columns from word
alignment alone is fragile when OCR adds debris or misses a cell. Printed
column rules are a far stronger signal:

    page image → local-contrast binarization (faint thin rules survive,
    light background texture does not form long lines)
    → long vertical runs = column rules; rules spanning the same height
      form one table (≥ 3 rules → ≥ 2 columns)
    → rows = the skew-aware OCR lines inside the table; a line with a
      number or first-column text starts a row, others continue it
      (wrapped cell text); leading number-free lines are the header

Coordinates come back in PDF points, the same space as the OCR words.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from io import BytesIO

_DPI = 150
_MIN_RULES = 3
# A horizontal rule whose band is taller than this (pixels at _DPI) is too
# tilted or not a rule; it is not used as row evidence.
_MAX_RULE_THICKNESS_PX = 30
# Rules closer than this (PDF points) are one rule; bands thinner than it
# are not a row.
_MIN_BAND_PT = 6.0


@dataclass
class RasterGrid:
    columns: list[float]  # x of each column rule, PDF points, ascending
    top: float
    bottom: float
    # Printed row rules inside the grid as sloped segments (x0, y0, x1, y1)
    # in PDF points — fitted from the rule's pixels, so a gently tilted scan
    # still places them exactly. Empty means "no row evidence", never
    # "no rows".
    row_rules: list[tuple[float, float, float, float]] = field(default_factory=list)
    # Every vertical rule as (x, top, bottom), PDF points: where each one
    # starts and stops tells a table (rules run the full height) from a
    # form of boxes (dividers that change from row to row).
    rule_spans: list[tuple[float, float, float]] = field(default_factory=list)
    # A ruled form's boxes read one by one (form_box_ocr), by box index, and
    # the page's text: filled in by the structure service, not detected here.
    box_words: dict = field(default_factory=dict)
    page_text: str = ""
    # A ruled table's cells, when box_words holds them (by cell index).
    cell_boxes: list = field(default_factory=list)

    def rule_ys_at(self, x: float) -> list[float]:
        """y of every row rule at horizontal position x."""

        ys = []
        for rx0, ry0, rx1, ry1 in self.row_rules:
            if rx1 > rx0:
                t = min(1.0, max(0.0, (x - rx0) / (rx1 - rx0)))
                ys.append(ry0 + (ry1 - ry0) * t)
        return ys

    @property
    def bbox(self) -> tuple[float, float, float, float]:
        return (self.columns[0], self.top, self.columns[-1], self.bottom)

    def _frame(self) -> tuple[float, float, list[float]] | None:
        """(left, right, row rule ys) of the ruled frame: the largest set of
        row rules sharing a left and right end. On a photo or screenshot the
        grid also holds the page's edges, a viewer's toolbar or scrollbar;
        they don't share the frame's ends."""

        rules = sorted((min(x0, x1), max(x0, x1), (y0 + y1) / 2) for x0, y0, x1, y1 in self.row_rules)
        frames: list[list[tuple[float, float, float]]] = []
        for rule in rules:
            frame = next(
                (f for f in frames if abs(f[0][0] - rule[0]) <= _MIN_BAND_PT and abs(f[0][1] - rule[1]) <= _MIN_BAND_PT),
                None,
            )
            if frame is None:
                frames.append([rule])
            else:
                frame.append(rule)
        frame = max(frames, key=len, default=[])
        if len(frame) < 3:
            return None
        left = sorted(r[0] for r in frame)[len(frame) // 2]
        right = sorted(r[1] for r in frame)[len(frame) // 2]
        edges: list[float] = []
        for y in sorted(r[2] for r in frame):
            if not edges or y - edges[-1] > _MIN_BAND_PT:
                edges.append(y)
        return left, right, edges

    def framed(self) -> "RasterGrid":
        """The grid cut to its ruled frame — the table itself, without a
        screenshot's page edges, toolbar icons or scrollbar — or the grid as
        it is when it has no frame of row rules."""

        found = self._frame()
        if found is None:
            return self
        left, right, edges = found
        spans = [
            (x, y0, y1) for x, y0, y1 in self.rule_spans
            if left - _MIN_BAND_PT <= x <= right + _MIN_BAND_PT and min(y1, edges[-1]) - max(y0, edges[0]) > _MIN_BAND_PT
        ]
        # The column rules can reach past the first or last row rule (a
        # header printed above the first rule stays in the table).
        top = min([edges[0]] + [y0 for _, y0, _ in spans])
        bottom = max([edges[-1]] + [y1 for _, _, y1 in spans])
        columns: list[float] = []
        for x in sorted([left, right] + [x for x, _, _ in spans]):
            if not columns or x - columns[-1] > _MIN_BAND_PT:
                columns.append(x)
        if len(columns) < _MIN_RULES:
            return self
        rows = [r for r in self.row_rules if top - 1 <= (r[1] + r[3]) / 2 <= bottom + 1]
        return RasterGrid(columns=columns, top=top, bottom=bottom, row_rules=rows, rule_spans=spans)

    def cells(self) -> list[tuple[float, float, float, float]]:
        """Every cell of a ruled table, row by row: the bands between its row
        rules across its columns. Empty when it has no row rules (its rows
        are then read from the text alone)."""

        found = self._frame()
        if found is None:
            return []
        _, _, edges = found
        ys = [self.top] if self.top < edges[0] - _MIN_BAND_PT else []
        ys += edges
        if self.bottom > edges[-1] + _MIN_BAND_PT:
            ys.append(self.bottom)
        return [
            (x0, top, x1, bottom)
            for top, bottom in zip(ys, ys[1:])
            for x0, x1 in zip(self.columns, self.columns[1:])
        ]

    def form_boxes(self) -> list[tuple[float, float, float, float]] | None:
        """The boxes of a ruled form — a W-2, a tax or customs form —
        read row by row, or None for a table.

        The form's frame is the largest set of row rules sharing a left and
        right end (on a photo or screenshot the grid also holds the page's
        edges, a viewer's toolbar or scrollbar). Each band between two of
        those rules is split by the dividers crossing it. A table's column
        rules run through every band, so every band splits the same way; a
        form's dividers start and stop at row rules, so its bands split
        differently ("a SSN | d Control number", one wide box, three boxes)."""

        framed = self._frame()
        if framed is None:
            return None
        left, right, edges = framed
        dividers = [span for span in self.rule_spans if left - _MIN_BAND_PT <= span[0] <= right + _MIN_BAND_PT]
        layouts: list[list[float]] = []
        boxes: list[tuple[float, float, float, float]] = []
        for top, bottom in zip(edges, edges[1:]):
            middle = (top + bottom) / 2
            xs = [left]
            for x in sorted(x for x, y0, y1 in dividers if y0 - 2 <= middle <= y1 + 2):
                if x - xs[-1] > _MIN_BAND_PT and right - x > _MIN_BAND_PT:
                    xs.append(x)
            xs.append(right)
            layouts.append(xs)
            boxes.extend((x0, top, x1, bottom) for x0, x1 in zip(xs, xs[1:]))

        def same(a: list[float], b: list[float]) -> bool:
            return len(a) == len(b) and all(abs(p - q) <= _MIN_BAND_PT for p, q in zip(a, b))

        if len(layouts) < 2 or all(same(layout, layouts[0]) for layout in layouts[1:]):
            return None
        return boxes


def detect_raster_grids(fitz_page) -> list[RasterGrid]:
    try:
        import cv2
        import numpy as np
        from PIL import Image
    except ImportError:
        return []
    try:
        pixmap = fitz_page.get_pixmap(dpi=int(_DPI))
        gray = np.asarray(Image.open(BytesIO(pixmap.tobytes("png"))).convert("L"))
    except Exception:  # noqa: BLE001 — a page we can't rasterize has no raster grid
        return []
    height, width = gray.shape
    binary = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 15, 10)
    vertical = cv2.morphologyEx(binary, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(20, height // 50))))
    # Re-join rule pieces broken by crossing text or background texture.
    vertical = cv2.dilate(vertical, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 15)))
    count, _, stats, _ = cv2.connectedComponentsWithStats(vertical)
    rules = [
        (float(x + w / 2), float(y), float(y + h))
        for x, y, w, h, _ in (stats[i] for i in range(1, count))
        if h > height * 0.04 and w < width * 0.02
    ]
    # Flat horizontal rules (row separators): long, thin, level runs.
    horizontal = cv2.morphologyEx(binary, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (max(40, width // 30), 1)))
    horizontal = cv2.dilate(horizontal, cv2.getStructuringElement(cv2.MORPH_RECT, (15, 1)))
    h_count, h_labels, h_stats, _ = cv2.connectedComponentsWithStats(horizontal)
    h_rules: list[tuple[float, float, float, float]] = []
    for i in range(1, h_count):
        x, y, w, h, _ = h_stats[i]
        if h > _MAX_RULE_THICKNESS_PX or w < 4 * h:
            continue
        # Fit the rule's centre line from its two ends (tilt-aware).
        band = h_labels[y : y + h, x : x + w] == i
        edge = max(1, w // 10)
        ys_left = np.nonzero(band[:, :edge])[0]
        ys_right = np.nonzero(band[:, w - edge :])[0]
        if not len(ys_left) or not len(ys_right):
            continue
        h_rules.append((float(x), float(y + ys_left.mean()), float(x + w), float(y + ys_right.mean())))
    scale = 72.0 / _DPI
    grids: list[RasterGrid] = []
    used: set[int] = set()
    for i, (x, y0, y1) in enumerate(sorted(rules, key=lambda r: -(r[2] - r[1]))):
        if i in used:
            continue
        group = [(x, y0, y1)]
        for j, (x2, a0, a1) in enumerate(sorted(rules, key=lambda r: -(r[2] - r[1]))):
            if j == i or j in used:
                continue
            overlap = min(y1, a1) - max(y0, a0)
            if overlap >= 0.5 * min(y1 - y0, a1 - a0):
                group.append((x2, a0, a1))
                used.add(j)
        used.add(i)
        xs: list[float] = []
        for gx in sorted(g[0] for g in group):
            if not xs or gx - xs[-1] > 10:
                xs.append(gx)
        if len(xs) < _MIN_RULES:
            continue
        top = min(g[1] for g in group)
        bottom = max(g[2] for g in group)
        span = xs[-1] - xs[0]
        row_rules = sorted(
            (hx0 * scale, hy0 * scale, hx1 * scale, hy1 * scale)
            for hx0, hy0, hx1, hy1 in h_rules
            if top + 2 < (hy0 + hy1) / 2 < bottom - 2 and min(hx1, xs[-1]) - max(hx0, xs[0]) >= 0.6 * span
        )
        grids.append(
            RasterGrid(
                columns=[v * scale for v in xs],
                top=top * scale,
                bottom=bottom * scale,
                row_rules=row_rules,
                rule_spans=sorted((gx * scale, g0 * scale, g1 * scale) for gx, g0, g1 in group),
            )
        )
    return grids
