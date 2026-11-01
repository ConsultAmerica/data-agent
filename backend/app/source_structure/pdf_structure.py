"""PDF (native text or OCR words) → structural regions and candidates.

    words (PDF points, font size, bold)          native: PyMuPDF words+spans
        → visual lines (vertical overlap)         OCR:    word layer, mapped
        → segments (whitespace gaps)                      to PDF points
        → tables       ruling lines (find_tables) / column alignment
        → label/value  separator, left/right, label-above, typography,
                       AcroForm widgets
        → headings, paragraphs/narrative, contact blocks, key/value groups

Nothing here reads page text as one flat string before deciding structure:
every decision is made on positioned segments, and every region keeps its
bbox.
"""

from __future__ import annotations

import re
import statistics
from dataclasses import dataclass, field

from app.services.table_quality import assess_table_candidate
from app.source_structure.models import (
    BBox,
    FieldCandidate,
    StructuredRegion,
    TableCandidate,
    TableCell,
)
from app.source_structure.ocr_geometry import OcrCoordinateSpace
from app.source_structure.table_hints import annotate_table
from app.source_structure.text_shapes import (
    candidate_quality,
    infer_value_type,
    is_numeric_value,
    label_rejection,
    normalize_space,
    strip_label_separator,
    value_rejection,
)

# A narrative block keeps its whole text (read as document sections);
# the cap only bounds a pathological block.
_NARRATIVE_LIMIT = 20_000


@dataclass
class Word:
    text: str
    x0: float
    y0: float
    x1: float
    y1: float
    size: float
    bold: bool = False
    # OCR confidence (0–1) of this word; None for native text or when the
    # OCR engine reported none.
    conf: float | None = None
    # The OCR passes disagreed on this word (ocr_word_layer.fuse_layouts).
    contested: bool = False
    # Vertical offset of this word's row caused by page skew (a scanned
    # page tilted and not deskewed). Lines are grouped on y - row_offset;
    # the reported geometry stays in page space.
    row_offset: float = 0.0

    @property
    def cy(self) -> float:
        return (self.y0 + self.y1) / 2

    @property
    def row_y0(self) -> float:
        return self.y0 - self.row_offset

    @property
    def row_y1(self) -> float:
        return self.y1 - self.row_offset


@dataclass
class Segment:
    words: list[Word]
    line_index: int
    index: int = 0
    used: bool = False

    @property
    def text(self) -> str:
        return " ".join(w.text for w in self.words)

    @property
    def bbox(self) -> BBox:
        return (
            min(w.x0 for w in self.words),
            min(w.y0 for w in self.words),
            max(w.x1 for w in self.words),
            max(w.y1 for w in self.words),
        )

    @property
    def x0(self) -> float:
        return self.bbox[0]

    @property
    def x1(self) -> float:
        return self.bbox[2]

    @property
    def size(self) -> float:
        return statistics.median(w.size for w in self.words)

    @property
    def bold(self) -> bool:
        return all(w.bold for w in self.words)


@dataclass
class Line:
    index: int
    words: list[Word] = field(default_factory=list)
    segments: list[Segment] = field(default_factory=list)

    @property
    def y0(self) -> float:
        return min(w.y0 for w in self.words)

    @property
    def y1(self) -> float:
        return max(w.y1 for w in self.words)

    @property
    def height(self) -> float:
        return max(1.0, self.y1 - self.y0)

    @property
    def row_y0(self) -> float:
        return min(w.row_y0 for w in self.words)

    @property
    def row_y1(self) -> float:
        return max(w.row_y1 for w in self.words)

    @property
    def row_height(self) -> float:
        return max(1.0, self.row_y1 - self.row_y0)

    @property
    def free_segments(self) -> list[Segment]:
        return [s for s in self.segments if not s.used]


def _union(boxes: list[BBox]) -> BBox | None:
    boxes = [b for b in boxes if b]
    if not boxes:
        return None
    return (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))


# --- word acquisition ----------------------------------------------------


def native_words(page) -> list[Word]:
    spans = []
    for block in page.get_text("dict").get("blocks", []):
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                font = str(span.get("font", ""))
                bold = bool(span.get("flags", 0) & 16) or "bold" in font.lower() or font.lower().endswith(("-bd", "bo"))
                spans.append((span["bbox"], float(span.get("size", 10.0)), bold))

    words: list[Word] = []
    for x0, y0, x1, y1, text, *_ in page.get_text("words"):
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        size, bold = y1 - y0, False
        for (sx0, sy0, sx1, sy1), span_size, span_bold in spans:
            if sx0 - 0.5 <= cx <= sx1 + 0.5 and sy0 - 0.5 <= cy <= sy1 + 0.5:
                size, bold = span_size, span_bold
                break
        # Fonts that encode the printed hyphen as U+00AD (soft hyphen) would
        # otherwise yield values browsers render without the hyphen.
        words.append(Word(text.replace("\u00ad", "-"), x0, y0, x1, y1, size, bold))
    return words


def _is_ocr_noise(text: str, conf) -> bool:
    """Debris OCR reads from background texture (watermarks, stamps): a
    short, digit-free token the engine itself is unsure of. Digits are
    always kept (a misread value is flagged downstream, never dropped),
    and so are longer words, which low confidence alone doesn't disprove."""

    if conf is None or float(conf) >= 0.5:
        return False
    alnum = sum(ch.isalnum() for ch in text)
    if alnum == 0:
        return True  # stray rules, underscores, specks
    if any(ch.isdigit() for ch in text):
        return False
    letters = [ch for ch in text if ch.isalpha()]
    # Form captions and filled-in values are often capitals ("MARKS");
    # background debris reads as short lowercase fragments ("oan", "acc").
    all_caps = len(letters) >= 2 and all(ch.isupper() for ch in letters)
    return alnum <= 5 and not all_caps


def ocr_words(ocr_layout_json: dict, space: OcrCoordinateSpace) -> list[Word]:
    words: list[Word] = []
    for item in ocr_layout_json.get("words") or []:
        text = str(item.get("text") or "").strip()
        # Lone punctuation specks are a common OCR artifact ("Bill . To:").
        if not text or re.fullmatch(r"[.,'`|_~‘’]", text):
            continue
        x0, y0, x1, y1 = space.to_pdf_points(
            (float(item["x0"]), float(item["y0"]), float(item["x1"]), float(item["y1"]))
        )
        conf = item.get("conf")
        if _is_ocr_noise(text, conf):
            continue
        words.append(
            Word(
                text, x0, y0, x1, y1,
                size=max(1.0, (y1 - y0) * 0.85),
                conf=float(conf) if conf is not None else None,
                contested=bool(item.get("contested")),
            )
        )
    slope = ocr_skew_slope(ocr_layout_json)
    if slope and words:
        centre = (min(w.x0 for w in words) + max(w.x1 for w in words)) / 2
        for word in words:
            word.row_offset = slope * ((word.x0 + word.x1) / 2 - centre)
    return words


def ocr_skew_slope(ocr_layout_json: dict) -> float:
    """dy/dx of text rows on a page that was OCR'd still tilted (deskew
    skipped or not recorded): the median slope of word centres along the
    engine's own wide text lines. 0.0 when level or not measurable."""

    slopes: list[float] = []
    for line in ocr_layout_json.get("lines") or []:
        words = [w for w in line.get("words") or [] if str(w.get("text") or "").strip()]
        if len(words) < 3:
            continue
        xs = [(float(w["x0"]) + float(w["x1"])) / 2 for w in words]
        ys = [(float(w["y0"]) + float(w["y1"])) / 2 for w in words]
        span = max(xs) - min(xs)
        heights = [float(w["y1"]) - float(w["y0"]) for w in words]
        if span < 10 * statistics.median(heights):
            continue
        mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
        denominator = sum((x - mx) ** 2 for x in xs)
        if denominator:
            slopes.append(sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / denominator)
    if len(slopes) < 3:
        return 0.0
    slope = statistics.median(slopes)
    # Ignore sub-0.1° noise and anything too steep to be a mild scan tilt.
    return slope if 0.0017 <= abs(slope) <= 0.09 else 0.0


# --- lines and segments ----------------------------------------------------


def build_lines(words: list[Word]) -> list[Line]:
    lines: list[Line] = []
    for word in sorted(words, key=lambda w: ((w.row_y0 + w.row_y1) / 2, w.x0)):
        height = max(1.0, word.y1 - word.y0)
        target = None
        for line in reversed(lines[-6:]):
            # Compare against the line's typical band (median centre and
            # height), not its full extent: one oversized word — a large
            # "INVOICE" title level with a letterhead — must not stretch a
            # line until it swallows the small print beneath.
            centres = sorted((w.row_y0 + w.row_y1) / 2 for w in line.words)
            heights = sorted(max(1.0, w.y1 - w.y0) for w in line.words)
            band_centre = centres[len(centres) // 2]
            band_half = heights[len(heights) // 2] / 2
            overlap = min(band_centre + band_half, word.row_y1) - max(band_centre - band_half, word.row_y0)
            # A line not stretched by an outlier word (its tallest word is
            # close to the typical height) may also match on its full
            # extent — residual scan tilt spreads one row over a few points.
            unstretched = heights[-1] <= 1.6 * heights[len(heights) // 2] and height <= 1.6 * heights[len(heights) // 2]
            full = min(line.row_y1, word.row_y1) - max(line.row_y0, word.row_y0)
            if overlap >= 0.5 * min(2 * band_half, height) or (unstretched and full >= 0.5 * min(line.row_height, height)):
                target = line
                break
        if target is None:
            target = Line(index=len(lines))
            lines.append(target)
        target.words.append(word)

    lines.sort(key=lambda l: (l.row_y0, min(w.x0 for w in l.words)))
    for index, line in enumerate(lines):
        line.index = index
        ordered = sorted(line.words, key=lambda w: w.x0)
        current = [ordered[0]]
        segments = []
        # The line's typical glyph size, so one tiny token (an OCR speck, a
        # superscript) doesn't shrink the word-gap threshold.
        line_size = statistics.median(w.size for w in ordered)
        for prev, word in zip(ordered, ordered[1:]):
            gap = word.x0 - prev.x1
            size = max(prev.size, word.size, line_size, 1.0)
            if gap > 0.9 * size or (prev.bold != word.bold and gap > 0.2 * size and prev.text.endswith(":")):
                segments.append(Segment(current, index))
                current = [word]
            else:
                current.append(word)
        segments.append(Segment(current, index))
        for seg_index, seg in enumerate(segments):
            seg.index = seg_index
        line.segments = segments
    return lines


# --- tables: column alignment ----------------------------------------------


@dataclass
class _Band:
    x0: float
    x1: float

    def overlaps(self, seg: Segment, tolerance: float = 3.0) -> bool:
        return seg.x0 <= self.x1 + tolerance and seg.x1 >= self.x0 - tolerance


def _map_to_bands(line: Line, bands: list[_Band]) -> dict[int, list[Segment]] | None:
    mapping: dict[int, list[Segment]] = {}
    for seg in line.free_segments:
        hits = [i for i, band in enumerate(bands) if band.overlaps(seg)]
        if len(hits) != 1:
            return None
        mapping.setdefault(hits[0], []).append(seg)
    return mapping


_ROW_NUMBER = re.compile(r"^\(?\d{1,3}[.)]?$")


def _alignment_tables(lines: list[Line]) -> list[tuple[list[_Band], list[list[list[Segment]]], list[Line]]]:
    """Groups of consecutive lines whose segments line up in ≥3 columns.
    Returns (bands, rows[row][col] -> segments, lines) per table."""

    tables = []
    i = 0
    while i < len(lines):
        start = lines[i]
        if len(start.free_segments) < 3:
            i += 1
            continue
        bands = [_Band(s.x0, s.x1) for s in start.free_segments]
        rows: list[dict[int, list[Segment]]] = [
            {k: [s] for k, s in enumerate(start.free_segments)}
        ]
        members = [start]
        j = i + 1
        line_height = start.height
        while j < len(lines):
            line = lines[j]
            gap = line.y0 - members[-1].y1
            if gap > 2.5 * line_height or not line.free_segments:
                break
            mapping = _map_to_bands(line, bands)
            if mapping is None:
                break
            # A lone row number in the first column ("8." whose other cells
            # OCR lost) starts its own row; it is never wrapped cell text.
            lone_row_number = (
                len(line.free_segments) == 1
                and set(mapping) == {0}
                and bool(_ROW_NUMBER.match(line.free_segments[0].text.strip()))
            )
            if len(line.free_segments) >= 2 or lone_row_number:
                for band_index, segs in mapping.items():
                    bands[band_index].x0 = min(bands[band_index].x0, *(s.x0 for s in segs))
                    bands[band_index].x1 = max(bands[band_index].x1, *(s.x1 for s in segs))
                rows.append(mapping)
            elif gap <= 1.2 * line_height and len(rows) > 1:
                # Wrapped cell text (e.g. a long description) continues the
                # previous row rather than starting a new one.
                for band_index, segs in mapping.items():
                    rows[-1].setdefault(band_index, []).extend(segs)
            else:
                break
            members.append(line)
            j += 1

        full_rows = [r for r in rows if len(r) >= max(2, len(bands) // 2)]
        if len(bands) >= 3 and len(full_rows) >= 3:
            grid = [[row.get(b, []) for b in range(len(bands))] for row in rows]
            header = _header_above(lines, i, bands, line_height)
            if header is not None:
                grid.insert(0, header[1])
                members.insert(0, header[0])
            bands, grid = _split_fused_bands(bands, grid)
            tables.append((bands, grid, members))
            i = j
        else:
            i += 1
    return tables


def _header_above(
    lines: list[Line], start: int, bands: list[_Band], line_height: float
) -> tuple[Line, list[list[Segment]]] | None:
    """The line directly above a column-aligned table whose labels didn't
    band-align with the data (left-aligned headers over right-aligned
    numbers): same column count, label-shaped, and each label sits in its
    own column's slot — between the neighbouring columns — in order."""

    if start == 0:
        return None
    line = lines[start - 1]
    segs = sorted(line.free_segments, key=lambda s: s.x0)
    if len(segs) != len(bands) or lines[start].y0 - line.y1 > 1.5 * line_height:
        return None
    if any(is_numeric_value(s.text) or len(s.words) > 4 for s in segs):
        return None
    for k, seg in enumerate(segs):
        low = bands[k - 1].x1 if k else float("-inf")
        high = bands[k + 1].x0 if k + 1 < len(bands) else float("inf")
        if not (seg.x0 >= low - 2 and seg.x1 <= high + 2):
            return None
    return line, [[seg] for seg in segs]


def _split_fused_bands(
    bands: list[_Band], grid: list[list[list[Segment]]]
) -> tuple[list[_Band], list[list[list[Segment]]]]:
    """Two columns whose HEADERS nearly touch ("UOM" + right-aligned "Unit
    Price") fuse into one band, yet every data row shows two runs with a
    clear vertical gutter between them. Split such a band at that gutter;
    a header run that straddles it is divided word by word."""

    b = 0
    while b < len(bands):
        cells = [row[b] for row in grid]
        filled = [c for c in cells if c]
        pairs = [sorted(c, key=lambda s: s.x0) for c in filled if len(c) == 2]
        if len(pairs) < 3 or len(pairs) < 0.6 * len(filled) or any(len(c) > 2 for c in filled):
            b += 1
            continue
        g0 = max(p[0].x1 for p in pairs)
        g1 = min(p[1].x0 for p in pairs)
        singles = [c[0] for c in filled if len(c) == 1]
        straddling = [s for s in singles if s.x0 < g0 - 1 and s.x1 > g1 + 1]
        if g1 - g0 < 4 or len(straddling) > 1:
            b += 1
            continue
        middle = (g0 + g1) / 2
        new_grid = []
        for row in grid:
            left: list[Segment] = []
            right: list[Segment] = []
            for seg in row[b]:
                if seg.x1 <= middle:
                    left.append(seg)
                elif seg.x0 >= middle:
                    right.append(seg)
                else:
                    # A header run spanning the gutter: assign each word to
                    # the side whose data it sits nearer to.
                    lw = [w for w in seg.words if (w.x0 + w.x1) / 2 < middle]
                    rw = [w for w in seg.words if (w.x0 + w.x1) / 2 >= middle]
                    if lw:
                        left.append(Segment(lw, seg.line_index, seg.index, seg.used))
                    if rw:
                        right.append(Segment(rw, seg.line_index, seg.index, seg.used))
            new_grid.append(row[:b] + [left, right] + row[b + 1:])
        grid = new_grid
        band = bands[b]
        bands = bands[:b] + [_Band(band.x0, g0), _Band(g1, band.x1)] + bands[b + 1:]
        b += 2
    return bands, grid


def _raster_grid_table(
    ids: "_Ids",
    page_number: int,
    lines: list[Line],
    grid,
    extraction_method: str,
    page_text: str,
):
    """A table from a printed column grid (raster_tables.RasterGrid) and the
    OCR lines inside it. Rows follow the skew-aware OCR lines: a line with a
    number, or text in the first column, starts a row; a line without
    either continues the previous row (wrapped cell text). Leading lines
    without numbers form the header, joined per column."""

    x_rules = grid.columns
    x0, top, x1, bottom = grid.bbox
    cell_words = getattr(grid, "box_words", None)
    cell_boxes = getattr(grid, "cell_boxes", None)
    if cell_words and cell_boxes:
        # Each ruled cell was read on its own (form_box_ocr): its words
        # replace the page pass's there; a cell its crop couldn't read (a
        # dark header band) keeps the page's words.
        page_lines = lines
        words: list[Word] = []
        header_bottom = min(cy1 for _, _, _, cy1 in cell_boxes)
        for index, (cx0, cy0, cx1, cy1) in enumerate(cell_boxes):
            own = cell_words.get(index)
            # The first row's printed column names the page pass reads well
            # (often light on a dark band, which a crop reads worse).
            header = cy1 <= header_bottom + 0.5
            page_own = [
                w for line in page_lines for seg in line.free_segments for w in seg.words
                if cx0 <= (w.x0 + w.x1) / 2 <= cx1 and cy0 <= (w.y0 + w.y1) / 2 <= cy1
            ]
            # A cell the page pass found empty, whose crop reads only short
            # scraps without a figure ("ene - in", "i"), holds specks of its
            # rules, not text.
            specks = bool(own) and not page_own and all(
                len(w.text) <= 3 and not any(ch.isdigit() for ch in w.text) for w in own
            )
            if own and not specks and not (header and page_own):
                words.extend(own)
                continue
            words.extend(page_own)
        for line in page_lines:
            for seg in line.segments:
                sx0, sy0, sx1, sy1 = seg.bbox
                if x0 - 2 <= (sx0 + sx1) / 2 <= x1 + 2 and top - 1 <= (sy0 + sy1) / 2 <= bottom + 2:
                    seg.used = True
        lines = build_lines(words)

    def column_of(word: Word) -> int | None:
        centre = (word.x0 + word.x1) / 2
        for index in range(len(x_rules) - 1):
            if x_rules[index] - 2 <= centre <= x_rules[index + 1] + 2:
                return index
        return None

    table_lines: list[tuple[Line, dict[int, list[Word]]]] = []
    for line in lines:
        # Strictly inside the grid: a title printed just above the top rule
        # is not part of the header.
        if not (top + 1 <= (line.row_y0 + line.row_y1) / 2 <= bottom + 2):
            continue
        cells: dict[int, list[Word]] = {}
        for seg in line.free_segments:
            for word in seg.words:
                column = column_of(word)
                if column is not None:
                    cells.setdefault(column, []).append(word)
        if cells:
            table_lines.append((line, cells))
    if not table_lines:
        return None

    columns = len(x_rules) - 1
    header: dict[int, list[Word]] = {}
    rows: list[dict[int, list[Word]]] = []
    row_bottom = 0.0  # lowest word of the current row
    rule_ys_at = getattr(grid, "rule_ys_at", None)
    for _, cells in table_lines:
        texts = {c: " ".join(w.text for w in ws) for c, ws in cells.items()}
        numeric = any(any(ch.isdigit() for ch in t) for t in texts.values())
        line_words = [w for ws in cells.values() for w in ws]
        line_top = min(w.y0 for w in line_words)
        line_bottom = max(w.y1 for w in line_words)
        line_x = sum((w.x0 + w.x1) / 2 for w in line_words) / len(line_words)
        if not rows and not numeric:
            for c, ws in cells.items():
                header.setdefault(c, []).extend(ws)
            continue
        # A printed row rule between this line and the current row makes
        # it a new row, whatever its shape (an empty numbered row "8." is
        # not part of the TOTAL row under it).
        ruled = bool(rows) and rule_ys_at is not None and any(
            row_bottom - 1 <= y <= line_top + 1 for y in rule_ys_at(line_x)
        )
        if ruled:
            rows.append({c: list(ws) for c, ws in cells.items()})
            row_bottom = line_bottom
            continue
        if rows and not numeric and 0 not in cells:
            for c, ws in cells.items():  # wrapped cell text
                rows[-1].setdefault(c, []).extend(ws)
            row_bottom = max(row_bottom, line_bottom)
            continue
        numeric_columns = {c for c, t in texts.items() if any(ch.isdigit() for ch in t)}
        complementary = rows and not (numeric_columns & {c for c in rows[-1] if c != 0})
        if rows and numeric and 0 not in cells and complementary:
            # The row's figures sit on the line under its identifier (a
            # two-line cell, or a tilted scan): they complete that row.
            for c, ws in cells.items():
                rows[-1].setdefault(c, []).extend(ws)
            row_bottom = max(row_bottom, line_bottom)
            continue
        rows.append({c: list(ws) for c, ws in cells.items()})
        row_bottom = line_bottom

    filled_rows = [r for r in rows if len(r) >= 2]
    if len(filled_rows) < 2:
        return None

    def text_of(ws: list[Word]) -> str:
        tokens: list[str] = []
        for w in sorted(ws, key=lambda w: (round(w.y0 / 4), w.x0)):
            if not tokens or tokens[-1] != w.text:  # "MARKS MARKS" from two OCR passes
                tokens.append(w.text)
        return " ".join(tokens)

    def box_of(ws: list[Word]):
        return _union([(w.x0, w.y0, w.x1, w.y1) for w in ws]) if ws else None

    header_texts = [text_of(header.get(c, [])) for c in range(columns)] if header else None
    if header_texts is not None and sum(1 for t in header_texts if t) < max(2, columns // 2):
        header_texts = None
    body_texts = [[text_of(r.get(c, [])) for c in range(columns)] for r in rows]
    body_boxes = [[box_of(r.get(c, [])) for c in range(columns)] for r in rows]
    table, regions = _table_from_grid(
        ids, page_number, "raster_ruling_lines", extraction_method,
        header_texts,
        [box_of(header.get(c, [])) for c in range(columns)] if header_texts else [],
        body_texts, body_boxes, page_text, (x0, top, x1, bottom),
    )
    for line, _ in table_lines:
        for seg in line.segments:
            sx0, sy0, sx1, sy1 = seg.bbox
            if x0 - 2 <= (sx0 + sx1) / 2 <= x1 + 2:
                seg.used = True
    return table, regions


# A form box's printed code before its caption: "a Employee's SSN",
# "1 Wages, tips, other comp.", "15 State", "12a See instructions".
_BOX_CODE = re.compile(r"^(?P<code>[a-z]|[\dlIL]{1,2}[a-z]?)[.)]?\s+(?P<name>\S.*)$")


def _box_code(caption: str) -> str | None:
    """A caption's box code, with OCR's 1-for-l/I/L slips mended inside a
    number ("L7" is box 17); a lone letter stays a letter code ("a")."""

    match = _BOX_CODE.match(caption)
    if not match:
        return None
    code = match.group("code")
    if any(ch.isdigit() for ch in code):
        code = re.sub(r"[lIL]", "1", code)
    elif len(code) > 1 or not code.islower():
        return None
    return code
_VALUE_EDGE = re.compile(r"^[\s—–\-|:]+|[\s—–\-|:]+$")


def _box_rows(lines: list[Line], box: BBox) -> list[list[Segment]]:
    """The segments of `lines` inside `box`, row by row, top to bottom."""

    bx0, by0, bx1, by1 = box
    rows: list[list[Segment]] = []
    for line in lines:
        inside = [
            seg for seg in line.segments
            if bx0 + 1 <= (seg.bbox[0] + seg.bbox[2]) / 2 <= bx1 - 1
            and by0 + 1 <= (seg.bbox[1] + seg.bbox[3]) / 2 <= by1 - 1
        ]
        if inside:
            rows.append(sorted(inside, key=lambda seg: seg.bbox[0]))
    rows.sort(key=lambda row: min(seg.bbox[1] for seg in row))
    return rows


def _read_box(
    rows: list[list[Segment]], box: BBox, columns: list[tuple[float, float]] | None = None
) -> tuple[list[tuple[str, str, list[Word], list[Word]]], list[tuple[float, float]]]:
    """(caption, value, caption words, value words) for each field a box
    holds, and the box's columns: its leading rows set smaller than the rest
    are the caption; two captions printed side by side ("e Employee's name
    f Employee's address") split the box at the second. `columns` imposes a
    split read from another pass."""

    if not rows:
        return [], []
    bx0, _, bx1, _ = box

    def height(row: list[Segment]) -> float:
        sizes = sorted(w.y1 - w.y0 for seg in row for w in seg.words)
        return sizes[len(sizes) // 2] if sizes else 0.0

    tallest = max(height(row) for row in rows)
    caption_rows = 0
    while caption_rows < len(rows) and height(rows[caption_rows]) < 0.8 * tallest:
        caption_rows += 1
    captions, values = rows[: max(1, caption_rows)], rows[max(1, caption_rows):]
    if columns is None:
        first = captions[0]
        starts = [bx0] + [seg.bbox[0] - 2 for seg in first[1:] if _box_code(seg.text.strip())]
        if len(starts) > 1 and _box_code(first[0].text.strip()):
            columns = list(zip(starts, starts[1:] + [bx1]))
        else:
            columns = [(bx0, bx1)]
    out = []
    for cx0, cx1 in columns:
        def within(seg: Segment) -> list[Word]:
            return [w for w in seg.words if cx0 <= (w.x0 + w.x1) / 2 < cx1]

        label_words = [w for row in captions for seg in row for w in within(seg)]
        value_words = [w for row in values for seg in row for w in within(seg)]
        caption = normalize_space(" ".join(w.text for w in label_words))
        value = _VALUE_EDGE.sub("", normalize_space(" ".join(w.text for w in value_words)))
        out.append((caption, value, label_words, value_words))
    return out, columns


def _edits(a: str, b: str) -> int:
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        current = [i]
        for j, cb in enumerate(b, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (ca != cb)))
        previous = current
    return previous[-1]


_MONEY = re.compile(r"^[$€£]\d{1,3}(?:,\d{3})*(?:\.\d{2})?$")
_CLEAN_FIGURE = re.compile(r"^\d{1,3}(?:,\d{3})*(?:\.\d{2})?$|^\d+(?:[-/.]\d+)+$")


def reconcile_box_value(readings: list[str], page_text: str) -> tuple[str, bool]:
    """One value from a box's independent OCR readings (its own crop first,
    then the page pass) and the page's text, and whether they disagree.

    A reading the page text also holds, or holds in a near-identical form
    ("586,420.00" beside "$86,420.00"), gains support; among equals a clean
    amount with its currency sign wins, then the box's own reading.
    Disagreement is reported, never hidden: the value goes to review."""

    readings = [normalize_space(r) for r in readings if r and r.strip()]
    if not readings:
        return "", False
    chunks = {normalize_space(c) for c in re.split(r"\s{2,}|\n", page_text or "") if c.strip()}
    support: dict[str, int] = {}
    for reading in readings:
        support[reading] = support.get(reading, 0) + 1
    for reading in list(dict.fromkeys(readings)):
        limit = max(1, len(reading) // 8)
        for chunk in chunks:
            if abs(len(chunk) - len(reading)) <= limit and _edits(reading, chunk) <= limit:
                support[chunk] = support.get(chunk, 0) + 1

    def rank(candidate: str) -> tuple[int, int, int]:
        shape = 2 if _MONEY.match(candidate) else 1 if _CLEAN_FIGURE.match(candidate) else 0
        order = -readings.index(candidate) if candidate in readings else -len(readings)
        return support[candidate], shape, order

    best = max(support, key=rank)
    return best, len(support) > 1


def _raster_form_fields(
    ids: "_Ids",
    page_number: int,
    lines: list[Line],
    boxes: list[BBox],
    extraction_method: str,
    box_words: dict[int, list[Word]] | None = None,
    page_text: str = "",
) -> list[FieldCandidate]:
    """The boxes of a ruled form on a raster page, each read as its caption
    (the small print at the box's top) and its value (what's written under
    it), in reading order. Each box's own OCR (box_words, form_box_ocr) is
    read first; the page pass's words in the box are a second reading of
    its value. An empty box is kept with a blank value: it was printed."""

    fields: list[FieldCandidate] = []
    for index, box in enumerate(boxes):
        page_rows = _box_rows(lines, box)
        for row in page_rows:
            for seg in row:
                seg.used = True
        own = box_words.get(index) if box_words else None
        primary, columns = _read_box(_box_rows(build_lines(own), box), box) if own else ([], [])
        second, page_columns = _read_box(page_rows, box)
        if len(columns) == 1 and len(page_columns) > 1:
            # The page pass read the box's two captions; its own crop blurred
            # a code ("e" as "@"): split its reading where the page pass did.
            primary, columns = _read_box(_box_rows(build_lines(own), box), box, page_columns)
        if not any(caption for caption, *_ in primary):
            primary, second = second, []
        for position, (caption, value, label_words, value_words) in enumerate(primary):
            if not caption:
                continue
            aligned = second[position] if len(second) == len(primary) else None
            code = _box_code(caption)
            if code is None and aligned is not None and _box_code(aligned[0]):
                # Its crop blurred the code ("'@ Employee's name"); the page
                # pass read it: that code, the crop's caption words.
                # A letter left in the blur ("'=f") is the code; else the
                # page pass's.
                blurred = re.match(r"^\W*([a-z])?\W*\s+(?=\w)", caption)
                code = blurred.group(1) if blurred and blurred.group(1) else _box_code(aligned[0])
                caption = f"{code} {caption[blurred.end():] if blurred else caption}"
            elif code is not None:
                # The mended code in place of its OCR spelling ("L7" → "17").
                caption = f"{code} {_BOX_CODE.match(caption).group('name')}"
            readings = [value]
            if aligned is not None and aligned[1]:
                readings.append(aligned[1])
            disagree = False
            if value:
                value, disagree = reconcile_box_value(readings, page_text)
            field = _field(
                ids, page_number, caption, value, "ruled_form_box",
                _union([(w.x0, w.y0, w.x1, w.y1) for w in label_words]),
                _union([(w.x0, w.y0, w.x1, w.y1) for w in value_words]) if value_words else None,
                f"{caption} {value}".strip(), extraction_method,
            )
            field.box_code = code
            field.box_rect = box
            # Its place makes it a label (small print at the top of a ruled
            # box): only the value's own checks apply.
            field.reasons = [r for r in field.reasons if not r.startswith("label_")]
            if not value and field.reasons == ["empty_value"]:
                field.reasons = []  # a printed box left empty: a blank value
            field.acceptance = "rejected" if field.reasons else "accepted"
            if disagree:
                field.ocr_contested = True
                field.quality_flags.append("ocr_readings_disagree")
            known = [w.conf for w in value_words if w.conf is not None]
            field.ocr_confidence = min(known) if known else None
            fields.append(field)
    return fields


def _key_value_grid_fields(ids: "_Ids", page_number: int, table: TableCandidate, extraction_method: str) -> list[FieldCandidate] | None:
    """A ruled "table" that is really a grid of captions and their values —
    "Invoice Number | NS-2026-1048 | Invoice Date | 2026-09-12" — becomes
    label/value fields instead of a table: an even number of columns where,
    on every row, each even cell is a caption and the next one its value."""

    rows: list[list[TableCell]] = ([table.header_cells] if table.header_cells else []) + table.rows
    columns = max((len(r) for r in rows), default=0)
    if columns < 2 or columns % 2 or len(rows) < 1:
        return None
    pairs: list[tuple[TableCell, TableCell]] = []
    for row in rows:
        by_column = {c.column_index: c for c in row}
        for c in range(0, columns, 2):
            label, value = by_column.get(c), by_column.get(c + 1)
            if label is None or not label.text:
                return None
            if label_rejection(label.text) is not None or is_numeric_value(label.text):
                return None
            if value is not None and value.text:
                pairs.append((label, value))
    if len(pairs) < 2 or len(pairs) < 0.6 * len(rows) * columns / 2:
        return None
    fields = []
    for label, value in pairs:
        field = _field(
            ids, page_number, label.text, value.text, "table_key_value_grid",
            label.bbox, value.bbox, f"{label.text} {value.text}", extraction_method,
        )
        field.ocr_confidence = value.ocr_confidence
        fields.append(field)
    return fields


def _is_header_row(cells: list[list[Segment]], data_rows: list[list[list[Segment]]]) -> bool:
    texts = [" ".join(s.text for s in cell) for cell in cells]
    filled = [t for t in texts if t]
    if len(filled) < 2 or any(is_numeric_value(t) for t in filled):
        return False
    if any(len(t.split()) > 4 for t in filled):
        return False
    data_numeric = any(
        is_numeric_value(" ".join(s.text for s in row[c]))
        for row in data_rows
        for c in range(len(row))
    )
    bold = all(seg.bold for cell in cells for seg in cell)
    return bold or data_numeric


# --- tables: ruling lines (native PDF tables) --------------------------------


def _ruled_tables(page, page_number: int):
    from app.services.generic_table_extractor import page_may_have_ruled_table

    # Without two horizontal and two vertical rules there is no cell to find;
    # skipping the (slow) finder there changes nothing it would return.
    if not page_may_have_ruled_table(page):
        return []
    try:
        # lines_strict: only real vector rules form cell borders — text
        # background rectangles don't invent columns.
        found = page.find_tables(strategy="lines_strict")
        tables = found.tables
        rect_ruled = False
        if not tables and _rules_drawn_as_rectangles(page):
            # Spreadsheet exports draw every rule as a thin filled
            # rectangle, which lines_strict ignores; with no background
            # boxes on the page, rectangles are safe to read as rules.
            tables = page.find_tables(strategy="lines").tables
            rect_ruled = True
    except Exception:  # noqa: BLE001 - table finder is best-effort
        return []
    results = []
    for tab in tables:
        try:
            data = tab.extract()
        except Exception:  # noqa: BLE001
            continue
        if not data or len(data) < 2 or tab.col_count < 2:
            continue
        cell_boxes = [list(row.cells) for row in tab.rows]
        bbox = tab.bbox
        if rect_ruled:
            # Underlined label/value rows above a grid line up with it and
            # get swept in; the table starts at its first well-filled row.
            first = next(
                (i for i, row in enumerate(data) if sum(1 for c in row if str(c or "").strip()) * 2 >= len(row)),
                None,
            )
            if first is None or len(data) - first < 2:
                continue
            if first:
                data, cell_boxes = data[first:], cell_boxes[first:]
                tops = [box[1] for box in cell_boxes[0] if box]
                bbox = (bbox[0], min(tops) if tops else bbox[1], bbox[2], bbox[3])
        results.append((bbox, data, cell_boxes, list(tab.header.names or [])))
    return results


def _rules_drawn_as_rectangles(page) -> bool:
    """True when the page's rectangles are almost all hairline strokes
    (rules), not filled boxes behind text."""

    thin = boxes = 0
    try:
        drawings = page.get_drawings()
    except Exception:  # noqa: BLE001
        return False
    for drawing in drawings:
        for item in drawing.get("items") or []:
            if item[0] != "re":
                continue
            rect = item[1]
            if min(rect.width, rect.height) <= 1.5:
                thin += 1
            else:
                boxes += 1
    return thin >= 8 and boxes <= max(4, thin // 8)


def _horizontal_rules(page, claimed: list[BBox]) -> list[BBox]:
    """Drawn underlines: thin horizontal strokes at least 60pt wide that
    are not part of a table already claimed on the page."""

    rules: list[BBox] = []
    try:
        drawings = page.get_drawings()
    except Exception:  # noqa: BLE001 - vector data is best-effort
        return rules
    horizontals: list[BBox] = []
    verticals: list[BBox] = []
    for drawing in drawings:
        for item in drawing.get("items") or []:
            if item[0] == "l":
                p1, p2 = item[1], item[2]
                box = (min(p1.x, p2.x), min(p1.y, p2.y), max(p1.x, p2.x), max(p1.y, p2.y))
            elif item[0] == "re":
                rect = item[1]
                box = (rect.x0, rect.y0, rect.x1, rect.y1)
            else:
                continue
            if box[3] - box[1] <= 1.5 and box[2] - box[0] >= 60:
                horizontals.append(box)
            elif box[2] - box[0] <= 1.5 and box[3] - box[1] >= 4:
                verticals.append(box)
            elif item[0] == "re" and box[2] - box[0] > 1.5 and box[3] - box[1] > 4:
                # A stroked box: its sides are vertical rules too.
                verticals.extend([(box[0], box[1], box[0], box[3]), (box[2], box[1], box[2], box[3])])
    for box in horizontals:
        if any(cx0 - 1 <= box[0] and box[2] <= cx1 + 1 and cy0 - 1 <= box[1] <= cy1 + 1 for cx0, cy0, cx1, cy1 in claimed):
            continue
        # A box border (an SF 1442 cell) meets vertical rules; a fill-in
        # underline stands alone.
        if any(box[0] - 2 <= vx <= box[2] + 2 and vy0 - 2 <= box[1] <= vy1 + 2 for vx, vy0, _, vy1 in verticals):
            continue
        rules.append(box)
    rules.sort(key=lambda b: (b[1], b[0]))
    return rules


# A lettered or roman section marker: "A.", "B.", "IV.".
_SECTION_MARKER = re.compile(r"(?:[A-Z]|[IVX]{1,4})\.")

# A form page has at least this many captioned underlines.
_MIN_RULED_ROWS = 3
# "18. Brief Statement", "9a. Prime Contractor": a numbered form item.
_NUMBERED_ITEM = re.compile(r"^\d{1,3}[a-z]?\.\s+\S")


def _ruled_form_fields(
    ids: _Ids, page_number: int, fitz_page, lines: list[Line], extraction_method: str, claimed: list[BBox]
) -> list[FieldCandidate]:
    """Form rows printed as captions on the left and the value written on a
    drawn underline at the right ("2. Contract Information | Contract Number
    | ____C0142____"). Pure geometry: the underline marks the value's blank
    (an empty blank is kept as an empty value). The left-most caption of a
    row opens a group; rows below with only an indented caption belong to
    it. Runs before alignment tables, which would read these as columns."""

    rules = _horizontal_rules(fitz_page, claimed)
    rows: list[tuple[Line, list[Segment], list[Segment], BBox]] = []
    for rule in rules:
        rx0, ry, rx1, _ = rule
        # The text written on the rule: its baseline sits just above it.
        line = next(
            (ln for ln in lines if -1.5 <= ry - ln.row_y1 <= 8 and any(s.x1 <= rx1 + 2 for s in ln.free_segments)),
            None,
        )
        if line is None:
            continue
        free = sorted(line.free_segments, key=lambda s: s.x0)
        # Several blanks on one line ("until __12:00 PM__ local time
        # __12 Feb 2024__"): a blank's caption is only the wording after
        # the blank before it.
        before = max((r[2] for r in rules if abs(r[1] - ry) <= 1.5 and r[2] <= rx0), default=float("-inf"))
        captions = [s for s in free if s.x1 <= rx0 + 1 and s.x0 >= before - 1]
        # A value starts on its blank but may run past its end (a long
        # name in a spreadsheet cell); text further right is its own run.
        values = [s for s in free if rx0 - 2 <= s.x0 <= rx1 - 4]
        if not captions:
            continue
        rows.append((line, captions, values, rule))
    if len(rows) < _MIN_RULED_ROWS:
        # A page with one or two such rows (a form continued from the page
        # before) keeps only numbered items that carry a value.
        rows = [row for row in rows if _NUMBERED_ITEM.match(row[1][0].text) and row[2]]
        if not rows:
            return []

    # Two caption columns: items (left) and their sub-labels. Item numbers
    # are often right-aligned ("9a." starts left of "1."), so the column is
    # judged by distance, not by an exact left edge.
    left = min(captions[0].x0 for _, captions, _, _ in rows)
    sub_column = min((captions[-1].x0 for _, captions, _, _ in rows if len(captions) > 1), default=None)
    fields: list[FieldCandidate] = []
    group: Segment | None = None
    for line, captions, values, rule in rows:
        if len(captions) > 1:
            opens_group = True
        elif sub_column is None:
            opens_group = captions[0].x0 <= left + 4
        else:
            opens_group = captions[0].x0 - left < sub_column - captions[0].x0
        if opens_group:
            group = captions[0]
        caption = captions[-1]
        value_text = _clean_value(" ".join(s.text for s in values))
        candidate = _field(
            ids, page_number, caption.text, value_text, "ruled_form_row",
            caption.bbox, _union([s.bbox for s in values]) or rule,
            " ".join(s.text for s in [*captions, *values]), extraction_method,
        )
        if group is not None and group is not caption:
            candidate.section_label = normalize_space(group.text)
        # The underline makes this a field whatever the caption's wording
        # ("16. Is ... required?"); an empty blank stays rejected, so it is
        # shown as blank but never staged as a value.
        if value_text and all(r.startswith("label_") for r in candidate.reasons):
            candidate.acceptance = "accepted"
            candidate.reasons = []
        elif not value_text:
            candidate.acceptance = "rejected"
            candidate.reasons = ["empty_value"]
        fields.append(candidate)
        for seg in [*captions, *values]:
            seg.used = True
    return fields


# --- the extractor --------------------------------------------------------------


@dataclass
class PageStructure:
    regions: list[StructuredRegion] = field(default_factory=list)
    fields: list[FieldCandidate] = field(default_factory=list)
    tables: list[TableCandidate] = field(default_factory=list)


class _Ids:
    def __init__(self, page: int):
        self.page = page
        self.counts: dict[str, int] = {}

    def next(self, kind: str) -> str:
        self.counts[kind] = self.counts.get(kind, 0) + 1
        return f"p{self.page}:{kind}:{self.counts[kind]}"


def _cell_text(segs: list[Segment]) -> str:
    return normalize_space(" ".join(s.text for s in segs))


def _table_from_grid(
    ids: _Ids,
    page_number: int,
    method: str,
    extraction_method: str,
    header_texts: list[str] | None,
    header_boxes: list[BBox | None],
    body_texts: list[list[str]],
    body_boxes: list[list[BBox | None]],
    page_text: str,
    bbox: BBox | None,
) -> tuple[TableCandidate, list[StructuredRegion]]:
    region_id = ids.next("table")
    columns = max(len(r) for r in body_texts) if body_texts else len(header_texts or [])
    headers = header_texts or [f"Column {i + 1}" for i in range(columns)]
    regions: list[StructuredRegion] = []
    header_cells = [
        TableCell(row_index=-1, column_index=c, text=headers[c], bbox=header_boxes[c] if c < len(header_boxes) else None)
        for c in range(len(headers))
    ] if header_texts else []
    rows: list[list[TableCell]] = []
    for r, (texts, boxes) in enumerate(zip(body_texts, body_boxes)):
        row_id = f"{region_id}:r{r}"
        cells = []
        for c, text in enumerate(texts):
            cell_id = f"{row_id}:c{c}"
            cells.append(
                TableCell(row_index=r, column_index=c, text=text, bbox=boxes[c] if c < len(boxes) else None, region_id=cell_id)
            )
            if text:
                regions.append(
                    StructuredRegion(
                        region_id=cell_id,
                        region_type="TABLE_CELL",
                        text=text,
                        normalized_text=text.lower(),
                        page=page_number,
                        bbox=boxes[c] if c < len(boxes) else None,
                        parent_region_id=row_id,
                        extraction_method=extraction_method,
                        structural_metadata={"row_index": r, "column_index": c},
                    )
                )
        rows.append(cells)
        regions.append(
            StructuredRegion(
                region_id=row_id,
                region_type="TABLE_ROW",
                text=" | ".join(texts),
                normalized_text=" | ".join(texts).lower(),
                page=page_number,
                bbox=_union([b for b in boxes if b]),
                parent_region_id=region_id,
                children=[f"{row_id}:c{c}" for c, t in enumerate(texts) if t],
                extraction_method=extraction_method,
                structural_metadata={"row_index": r},
            )
        )

    assessment = assess_table_candidate(
        headers=headers, rows=[[c.text for c in row] for row in rows], page_text=page_text
    )
    table = TableCandidate(
        candidate_id=region_id,
        region_id=region_id,
        page=page_number,
        bbox=bbox,
        detection_method=method,
        extraction_method=extraction_method,
        headers=headers,
        header_cells=header_cells,
        rows=rows,
        structure_score=round(assessment.table_structure_score, 3),
        acceptance="accepted" if assessment.table_acceptance_status == "accepted" else "rejected",
        reasons=[assessment.rejection_reason] if assessment.rejection_reason else [],
    )
    if not header_texts:
        table.reasons.append("no_header_row_detected")
    annotate_table(table)
    regions.insert(
        0,
        StructuredRegion(
            region_id=region_id,
            region_type="TABLE",
            text=" | ".join(headers),
            normalized_text=" | ".join(headers).lower(),
            page=page_number,
            bbox=bbox,
            children=[f"{region_id}:r{r}" for r in range(len(rows))],
            extraction_method=extraction_method,
            structural_metadata={
                "detection_method": method,
                "acceptance": table.acceptance,
                "columns": len(headers),
                "rows": len(rows),
            },
        ),
    )
    return table, regions


def _field(
    ids: _Ids,
    page_number: int,
    label_raw: str,
    value_raw: str,
    relation: str,
    label_bbox: BBox | None,
    value_bbox: BBox | None,
    evidence: str,
    extraction_method: str,
    extra_hints: list[str] | None = None,
) -> FieldCandidate:
    label_text = normalize_space(strip_label_separator(label_raw))
    reasons = [r for r in (label_rejection(label_text), value_rejection(value_raw)) if r]
    hints = list(extra_hints or [])
    if not reasons:
        hints.append("label_noun_phrase_shape")
    quality_score, quality_flags = candidate_quality(label_text, value_raw, relation)
    value_type = infer_value_type(value_raw)
    # "Registration No.  0222420149" is an identifier, not a phone number
    # that happens to have ten digits.
    if value_type in ("phone", "number") and _ID_TAIL.search(label_text) and not re.search(
        r"\b(phone|tel|fax|mobile|cell)\b", label_text, re.I
    ):
        value_type = "identifier"
    return FieldCandidate(
        quality_score=quality_score,
        quality_flags=quality_flags,
        candidate_id=ids.next("field"),
        raw_label=label_raw,
        raw_value=value_raw,
        label_text=label_text,
        value_type_hint=value_type,
        structural_relation=relation,  # type: ignore[arg-type]
        page=page_number,
        label_bbox=label_bbox,
        value_bbox=value_bbox,
        evidence_text=evidence,
        extraction_method=extraction_method,
        acceptance="rejected" if reasons else "accepted",
        reasons=reasons,
        validation_hints=hints,
    )


_LIST_ITEM = re.compile(r"^(\(?[a-z0-9]{1,3}[.)]|[•·▪●\-*])\s+\S", re.I)
_INLINE_SEP = re.compile(r"^(?P<label>[^:]{1,60}?[A-Za-z)#.])\s*:\s+(?P<value>\S.*)$")


def _inline_pairs(words: list[Word], label_words: int) -> list[tuple[list[Word], list[Word]]]:
    """Split one text run holding several "Label: value" pairs
    ("Invoice Number: INV-1001   Invoice Date: 03/14/2025"). A later word
    ending in ':' starts a new pair when the words before it form a
    label-shaped phrase; the phrase starts after the widest gap (pairs are
    usually spaced apart), else at the first capitalized word without digits."""

    pairs: list[tuple[list[Word], list[Word]]] = []
    label_start, value_start = 0, label_words
    k = value_start + 1
    while k < len(words):
        if not words[k].text.endswith(":") or k + 1 >= len(words):
            k += 1
            continue
        starts = [
            j for j in range(max(value_start + 1, k - 4), k + 1)
            if label_rejection(" ".join(w.text for w in words[j:k + 1])) is None
            and words[j].text[:1].isupper()
        ]
        if not starts:
            k += 1
            continue
        widest = max(starts, key=lambda j: words[j].x0 - words[j - 1].x1)
        gap = words[widest].x0 - words[widest - 1].x1
        if all(abs((words[j].x0 - words[j - 1].x1) - gap) < 0.5 for j in starts):
            widest = next((j for j in starts if not any(ch.isdigit() for ch in words[j].text)), widest)
        pairs.append((words[label_start:value_start], words[value_start:widest]))
        label_start, value_start = widest, k + 1
        k = value_start + 1
    pairs.append((words[label_start:value_start], words[value_start:]))
    return pairs


def _is_label_segment(seg: Segment) -> bool:
    return seg.text.rstrip().endswith(":") and label_rejection(seg.text) is None


# OCR renders printed underlines / leader dots between a label and its
# value as runs of '_', dashes or dots: "Group __ HUMANITIES".
_FILLER_PAIR = re.compile(r"^(?P<label>[^_:]{1,40}?)\s*(?:_{2,}|[—–]+|-{2,}|\.{3,}|…+)\s*(?P<value>[^\s_].*)$")
# Identifier-style label endings ("Roll No.", "Invoice #", "Customer ID",
# "Issue Date") — a shape of field captions, not a business vocabulary.
_ID_TAIL = re.compile(r"(?:\bno\.?|#|\bnumber|\bnum\.?|\bid|\bdate|\bcode|\bref\.?)$", re.I)
_VALUE_NOISE = "_|~=—–"


def _clean_label(text: str) -> str:
    # OCR punctuation variation: "Certificate No," / "No;" → "No."
    text = re.sub(r"\b(No|Ref|Acct|Inv)[,;]$", r"\1.", text.strip())
    return text.rstrip(" _—–")


def _clean_value(text: str) -> str:
    return text.strip().strip(_VALUE_NOISE).strip()


def _filled_entry(text: str) -> bool:
    """A value that reads as written into a form blank, whatever its size:
    it carries digits, sits on an underline, or is a single character."""

    stripped = text.strip()
    return (
        stripped.startswith("_")
        or any(ch.isdigit() for ch in stripped)
        or sum(ch.isalnum() for ch in stripped) == 1
    )


def _position_label(text: str) -> bool:
    """A run that can be a caption WITHOUT a separator: short, capitalized,
    not numeric — stricter than label_rejection alone."""

    text = _clean_label(text)
    words = text.split()
    return (
        bool(words)
        and len(words) <= 4
        and len(text) <= 32
        and text[:1].isupper()
        and label_rejection(text) is None
        and not is_numeric_value(text)
        and sum(ch.isdigit() for ch in text) <= 0.2 * len(text)
    )


def _position_value(text: str) -> bool:
    """A run that reads as a VALUE on its own: has digits, or is a short
    all-caps name/code — never a lowercase phrase or another caption."""

    text = _clean_value(text)
    words = text.split()
    letters = [ch for ch in text if ch.isalpha()]
    return (
        bool(words)
        and len(words) <= 8
        and not text.endswith(":")
        and value_rejection(text) is None
        and (any(ch.isdigit() for ch in text) or (letters and all(ch.isupper() for ch in letters) and len(words) <= 6))
    )


def _whitespace_pairs(segments: list[Segment]) -> list[tuple[Segment, Segment]]:
    """Label/value pairs separated only by whitespace ("Roll No.   516522
    Registration No.   0222420149"). Accepted when the label has an
    identifier-style ending, or when the WHOLE line alternates label,
    value, label, value — so a table row ("Bolt | EA | 0.42 | 84.00")
    never pairs up."""

    free = [s for s in segments if not s.used]
    candidates = [
        (a, b)
        for a, b in zip(free, free[1:])
        if _position_label(a.text)
        and _position_value(b.text)
        and 0 < b.x0 - a.x1 <= 200
        # Caption and value share a type size; a letterhead name beside a
        # large "INVOICE" title does not. Filled-in entries are exempt:
        # digits (a stamped serial), an underline, a single character.
        and (_filled_entry(b.text) or abs(a.size - b.size) <= 0.2 * max(a.size, b.size))
    ]
    # Alternation alone is only evidence with at least two pairs; a lone
    # "Brightline Office Supply Co.   INVOICE" is not a caption and value.
    alternating = (
        len(free) >= 4
        and len(free) % 2 == 0
        and all((free[i], free[i + 1]) in candidates for i in range(0, len(free), 2))
    )
    pairs: list[tuple[Segment, Segment]] = []
    taken: set[int] = set()
    for a, b in candidates:
        if id(a) in taken or id(b) in taken:
            continue
        # An identifier caption ("Roll No.", "Issue Date") takes an
        # identifier/date value — digits — never another caption such as
        # a column header ("Sr. No   SUBJECTS").
        id_pair = _ID_TAIL.search(_clean_label(a.text)) and any(ch.isdigit() for ch in b.text)
        if alternating or id_pair:
            pairs.append((a, b))
            taken.update((id(a), id(b)))
    return pairs


def _label_value_candidates(
    ids: _Ids, page_number: int, lines: list[Line], extraction_method: str
) -> list[FieldCandidate]:
    fields: list[FieldCandidate] = []

    for line in lines:
        segments = line.free_segments
        for position, seg in enumerate(segments):
            if seg.used:
                continue
            text = seg.text.strip()

            filler = _FILLER_PAIR.match(text)
            if filler and _position_label(filler.group("label")) and _clean_value(filler.group("value")):
                label = _clean_label(filler.group("label"))
                value = _clean_value(filler.group("value"))
                label_words = len(filler.group("label").split())
                fields.append(
                    _field(
                        ids, page_number, label, value, "same_line_filler",
                        _union([(w.x0, w.y0, w.x1, w.y1) for w in seg.words[:label_words]]) or seg.bbox,
                        _union([(w.x0, w.y0, w.x1, w.y1) for w in seg.words[label_words:]]) or seg.bbox,
                        text, extraction_method,
                    )
                )
                seg.used = True
                continue

            inline = _INLINE_SEP.match(text)
            if inline and not text.endswith(":") and "://" not in text:
                label, value = inline.group("label"), inline.group("value")
                label_words = min(len(label.split()), len(seg.words))
                for label_part, value_part in _inline_pairs(seg.words, label_words):
                    pair_text = " ".join(w.text for w in label_part + value_part)
                    fields.append(
                        _field(
                            ids, page_number,
                            " ".join(w.text for w in label_part).rstrip(":") + ":",
                            " ".join(w.text for w in value_part),
                            "same_line_separator",
                            _union([(w.x0, w.y0, w.x1, w.y1) for w in label_part]) or seg.bbox,
                            _union([(w.x0, w.y0, w.x1, w.y1) for w in value_part]) or seg.bbox,
                            pair_text, extraction_method,
                        )
                    )
                seg.used = True
                continue

            if text.endswith(":"):
                right = segments[position + 1] if position + 1 < len(segments) else None
                if right is not None and not right.used and not right.text.rstrip().endswith(":"):
                    fields.append(
                        _field(
                            ids, page_number, text, right.text, "left_right_separator",
                            seg.bbox, right.bbox, f"{text} {right.text}", extraction_method,
                        )
                    )
                    seg.used = right.used = True
                    continue
                below = _values_below(seg, line, lines)
                if below:
                    value = "\n".join(s.text for s in below)
                    fields.append(
                        _field(
                            ids, page_number, text, value, "label_above_value",
                            seg.bbox, _union([s.bbox for s in below]), f"{text}\n{value}",
                            extraction_method,
                        )
                    )
                    seg.used = True
                    for s in below:
                        s.used = True
                continue

            # Typography: a bold label-shaped run followed by a regular run.
            right = segments[position + 1] if position + 1 < len(segments) else None
            if (
                seg.bold
                and right is not None
                and not right.used
                and not right.bold
                and label_rejection(text) is None
                and len(text.split()) <= 4
                and "," not in text
                and abs(seg.size - right.size) <= 0.15 * max(seg.size, right.size)
                and value_rejection(right.text) is None
            ):
                fields.append(
                    _field(
                        ids, page_number, text, right.text, "left_right_typography",
                        seg.bbox, right.bbox, f"{text} {right.text}", extraction_method,
                    )
                )
                seg.used = right.used = True

    return fields


# "Roll No, 782710" read as ONE run: a caption ending in an identifier word,
# then a digit-bearing value of at most three words.
_FUSED_ID_PAIR = re.compile(
    r"^(?P<label>[A-Z][A-Za-z .'/()-]{0,30}?\b(?:No|Number|ID|#)[.,:;]?)\s+(?P<value>(?=\S*\d)\S+(?:\s\S+){0,2})$"
)


def _rescue_form_captions(fields: list[FieldCandidate]) -> None:
    """A "Caption: VALUE" pair rejected ONLY because its caption reads like
    a sentence ("His / Her mark of identification :") is a form fill-in when
    the value is a filled entry (capitals, digits, underline). Pairs
    rejected for their value (prose after "Note:") stay rejected."""

    for field in fields:
        if field.acceptance != "rejected" or not field.reasons:
            continue
        # Only a value written beside its caption: a caption whose own blank
        # is empty must not borrow the next line (a title, a table header).
        if field.structural_relation not in ("left_right_separator", "same_line_separator"):
            continue
        if not all(reason.startswith("label_") and reason != "empty_label" for reason in field.reasons):
            continue
        value = _clean_value(field.raw_value)
        letters = [ch for ch in value if ch.isalpha()]
        filled = _filled_entry(field.raw_value) or (len(letters) >= 2 and all(ch.isupper() for ch in letters))
        if filled and len(field.label_text.split()) <= 8 and value_rejection(value) is None:
            field.acceptance = "accepted"
            field.reasons = []
            field.structural_relation = "form_fill_in"
            field.raw_value = value
            field.label_text = normalize_space(field.label_text.rstrip(": "))


def _fill_in_pairs(segments: list[Segment]) -> list[tuple[Segment, Segment]]:
    """Form fill-in relationships on one line: printed wording followed by
    the value written into its blank — "Certified that  NOSHEEN TARIQ",
    "whose date of birth is  10-07-1986", "grade  B". Pure geometry and
    shape, no vocabulary: the caption is lower-/mixed-case printed text,
    the value is visually separate and reads as a filled entry — it sits on
    an underline ("_GENERAL"), is in capitals, or carries digits — and both
    share a type size. Pairs are taken left to right."""

    free = [s for s in segments if not s.used]
    pairs: list[tuple[Segment, Segment]] = []
    index = 0
    while index + 1 < len(free):
        caption, value = free[index], free[index + 1]
        caption_text = caption.text.strip().rstrip(":").strip()
        value_text = _clean_value(value.text)
        caption_letters = [ch for ch in caption_text if ch.isalpha()]
        value_letters = [ch for ch in value_text if ch.isalpha()]
        filled = value.text.lstrip().startswith("_") or (
            value_letters and all(ch.isupper() for ch in value_letters) and len(value_letters) >= 1
        ) or any(ch.isdigit() for ch in value_text)
        caption_ok = (
            # "Tax  $36.25": a 3-letter caption is enough before a number.
            len(caption_letters) >= (3 if any(ch.isdigit() for ch in value_text) else 4)
            and any(ch.islower() for ch in caption_letters)
            and len(caption_text.split()) <= 8
            and not caption_text.endswith((".", ";"))
            and not any(ch.isdigit() for ch in caption_text)
        )
        value_ok = (
            bool(value_text)
            and len(value_text.split()) <= 8
            and not value_text.endswith(":")
            and value_rejection(value_text) is None
        )
        same_size = _filled_entry(value.text) or abs(caption.size - value.size) <= 0.2 * max(caption.size, value.size)
        if caption_ok and value_ok and filled and same_size and value.x0 - caption.x1 > 0:
            pairs.append((caption, value))
            index += 2
        else:
            index += 1
    return pairs


def _loose_label_value_candidates(
    ids: _Ids, page_number: int, lines: list[Line], extraction_method: str
) -> list[FieldCandidate]:
    """Separator-less pairings — whitespace captions and form fill-ins. Run
    AFTER every table detector has claimed its cells, so table rows are
    never read as label/value pairs."""

    fields: list[FieldCandidate] = []
    for line in lines:
        for seg in line.free_segments:
            fused = _FUSED_ID_PAIR.match(seg.text.strip())
            if fused and _position_label(fused.group("label")):
                label_words = len(fused.group("label").split())
                label, value = _clean_label(fused.group("label")), _clean_value(fused.group("value"))
                fields.append(
                    _field(
                        ids, page_number, label, value, "left_right_whitespace",
                        _union([(w.x0, w.y0, w.x1, w.y1) for w in seg.words[:label_words]]) or seg.bbox,
                        _union([(w.x0, w.y0, w.x1, w.y1) for w in seg.words[label_words:]]) or seg.bbox,
                        seg.text, extraction_method,
                    )
                )
                seg.used = True
        for label_seg, value_seg in _whitespace_pairs(line.segments):
            label = _clean_label(label_seg.text)
            value = _clean_value(value_seg.text)
            fields.append(
                _field(
                    ids, page_number, label, value, "left_right_whitespace",
                    label_seg.bbox, value_seg.bbox, f"{label_seg.text} {value_seg.text}", extraction_method,
                )
            )
            label_seg.used = value_seg.used = True
        for caption_seg, value_seg in _fill_in_pairs(line.segments):
            caption = caption_seg.text.strip().rstrip(":").strip()
            value = _clean_value(value_seg.text)
            candidate = _field(
                ids, page_number, caption, value, "form_fill_in",
                caption_seg.bbox, value_seg.bbox, f"{caption_seg.text} {value_seg.text}", extraction_method,
            )
            # The caption is printed wording, not a noun-phrase label — the
            # geometry makes it a field; label-shape rejection doesn't apply.
            if candidate.acceptance == "rejected" and all(r.startswith("label_") for r in candidate.reasons):
                candidate.acceptance = "accepted"
                candidate.reasons = []
            fields.append(candidate)
            caption_seg.used = value_seg.used = True
    return fields


def _values_below(label: Segment, line: Line, lines: list[Line]) -> list[Segment]:
    """Consecutive left-aligned runs directly under a "Label:" run — e.g. a
    multi-line address under "Bill To:"."""

    def aligned(candidate_line: Line) -> Segment | None:
        return next(
            (
                s
                for s in candidate_line.free_segments
                if abs(s.x0 - label.x0) <= 12.0 or (s.x0 >= label.x0 - 2 and s.x0 <= label.x1)
            ),
            None,
        )

    window = lines[line.index + 1 : line.index + 9]
    collected: list[Segment] = []
    previous_bottom = line.y1
    for position, below_line in enumerate(window):
        if below_line.y0 - previous_bottom > 1.6 * line.height:
            break
        match = aligned(below_line)
        if match is None:
            # A line belonging only to another column (e.g. a right-hand
            # key/value block interleaved with this one) is skipped, not
            # treated as the end of the value.
            continue
        text = match.text.strip()
        if _is_label_segment(match) or _LIST_ITEM.match(text):
            # A list under a heading-like "Label:" is a list, not a value.
            break
        if _INLINE_SEP.match(text):
            # "Attn: Accounts Payable" INSIDE an address block (a plain
            # aligned line follows it) belongs to the block; a "Label:
            # value" line that starts a stack of fields ends it.
            following = next(
                (
                    s
                    for later in window[position + 1 : position + 3]
                    if later.y0 - below_line.y1 <= 1.6 * line.height
                    for s in [aligned(later)]
                    if s is not None
                ),
                None,
            )
            if not collected or following is None or _INLINE_SEP.match(following.text.strip()) or _is_label_segment(following):
                break
        collected.append(match)
        previous_bottom = below_line.y1
    return collected


def _form_widget_candidates(ids: _Ids, page, page_number: int) -> list[FieldCandidate]:
    fields = []
    try:
        widgets = list(page.widgets() or [])
    except Exception:  # noqa: BLE001
        return fields
    for widget in widgets:
        value = str(widget.field_value or "").strip()
        if not value or value.lower() in ("off", "false"):
            continue
        name = widget.field_label or widget.field_name or ""
        label = re.sub(r"(?<=[a-z])(?=[A-Z])|[_.]+", " ", name).strip()
        rect = widget.rect
        fields.append(
            _field(
                ids, page_number, label, value, "form_widget",
                None, (rect.x0, rect.y0, rect.x1, rect.y1), f"{label}: {value}", "form_widget",
            )
        )
    return fields


def _group_key_values(ids: _Ids, page_number: int, fields: list[FieldCandidate]) -> list[StructuredRegion]:
    """Stacked, left-aligned label/value pairs form one KEY_VALUE_GROUP."""

    groups: list[list[FieldCandidate]] = []
    accepted = sorted(
        (f for f in fields if f.acceptance == "accepted" and f.label_bbox),
        key=lambda f: (f.label_bbox[0], f.label_bbox[1]),
    )
    for f in accepted:
        for group in groups:
            last = group[-1]
            if abs(last.label_bbox[0] - f.label_bbox[0]) <= 4 and 0 < f.label_bbox[1] - last.label_bbox[3] <= 14:
                group.append(f)
                break
        else:
            groups.append([f])
    regions = []
    for group in groups:
        if len(group) < 2:
            continue
        region_id = ids.next("kvgroup")
        for f in group:
            f.group_id = region_id
        regions.append(
            StructuredRegion(
                region_id=region_id,
                region_type="KEY_VALUE_GROUP",
                text="\n".join(f.evidence_text for f in group),
                normalized_text="\n".join(f.evidence_text for f in group).lower(),
                page=page_number,
                bbox=_union([_union([f.label_bbox, f.value_bbox]) for f in group]),
                children=[f.candidate_id for f in group],
            )
        )
    return regions


_CONTACT_SIGNAL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+|\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}|\b[A-Z]{2}\s+\d{5}\b")


_ABBREVIATION_END = re.compile(r"(?:^|\s)(?:[A-Za-z]{1,4}\.|(?:[A-Za-z]\.){2,})$")


def _ends_like_sentence_or_label(text: str) -> bool:
    """A trailing colon/comma, or a sentence-final period — but not the
    period of an abbreviation ("Supply Co.", "Events B.V.")."""

    stripped = text.rstrip()
    if stripped.endswith((":", ",")):
        return True
    return stripped.endswith(".") and not _ABBREVIATION_END.search(stripped)


def _typography_break(upper: Segment, lower: Segment) -> bool:
    larger = upper.size >= 1.2 * lower.size
    weight = upper.bold and not lower.bold and len(upper.text.split()) <= 10
    return larger or weight


def _caps_title(text: str) -> bool:
    """OCR carries no bold/weight, so a title line is recognised by shape:
    several all-capital words, mostly letters ("HIGHER SECONDARY SCHOOL
    CERTIFICATE EXAMINATION", "ANNUAL 2005")."""

    words = text.split()
    letters = [ch for ch in text if ch.isalpha()]
    alnum = [ch for ch in text if ch.isalnum()]
    return (
        # Text on an underline ("_NOSHEEN TARIQ") fills in a form blank.
        not text.lstrip().startswith("_")
        and len(words) >= 2
        and len(letters) >= 6
        and all(ch.isupper() for ch in letters)
        and len(letters) >= 0.6 * len(alnum)
    )


def _text_regions(ids: _Ids, page_number: int, lines: list[Line], extraction_method: str) -> list[StructuredRegion]:
    """Headings, paragraphs/narrative and contact blocks from the runs no
    table or label/value claimed. Runs join a block only when they are on
    consecutive lines AND left-aligned with it, so side-by-side columns
    (a letterhead left, a title right) stay separate blocks."""

    runs = [seg for line in lines for seg in line.free_segments]
    if not runs:
        return []
    body_size = statistics.median(s.size for s in runs)
    line_of = {id(seg): line for line in lines for seg in line.segments}

    # "A.   General Information": a lettered section marker and its title,
    # alone on a line and set larger than the body, printed as two runs.
    regions: list[StructuredRegion] = []
    for line in lines:
        free = line.free_segments
        if len(free) != 2 or len(line.segments) != 2:
            continue
        marker, title = free
        title_text = title.text.strip()
        if (
            _SECTION_MARKER.fullmatch(marker.text.strip())
            and 1 <= len(title_text.split()) <= 10
            and title_text[:1].isupper()
            and not _ends_like_sentence_or_label(title_text)
            and max(marker.size, title.size) >= 1.1 * body_size
        ):
            text = f"{marker.text.strip()} {title_text}"
            regions.append(
                StructuredRegion(
                    region_id=ids.next("heading"),
                    region_type="HEADING",
                    text=text,
                    normalized_text=normalize_space(text).lower(),
                    page=page_number,
                    bbox=_union([marker.bbox, title.bbox]),
                    extraction_method=extraction_method,
                )
            )
            marker.used = title.used = True
    runs = [seg for line in lines for seg in line.free_segments]
    if not runs:
        return regions

    blocks: list[list[Segment]] = []
    for seg in runs:
        line = line_of[id(seg)]
        target = None
        for block in reversed(blocks[-12:]):
            last = block[-1]
            last_line = line_of[id(last)]
            if (
                last_line.index < line.index
                and line.y0 - last_line.y1 <= 1.2 * last_line.height
                and abs(seg.x0 - block[0].x0) <= 12.0
                # A typography change (a larger or bold name line above
                # regular address lines) starts a new block.
                and not (len(block) == 1 and _typography_break(last, seg))
            ):
                target = block
                break
        if target is None:
            blocks.append([seg])
        else:
            target.append(seg)

    for block in blocks:
        text = "\n".join(s.text for s in block)
        words = len(text.split())
        bbox = _union([s.bbox for s in block])
        size = statistics.median(s.size for s in block)
        if (
            len(block) == 1
            and words <= 10
            and not _ends_like_sentence_or_label(text)
            and (block[0].bold or size >= 1.2 * body_size or (extraction_method == "ocr" and _caps_title(text)))
            and re.search(r"[A-Za-z]", text)
            # "grade" set in a larger OCR box is still a lowercase word, not a title.
            and not text[:1].islower()
            # An email/URL run can look "large" to OCR ('@', descenders)
            # but is contact data, never a heading.
            and not re.search(r"@|www\.|https?://", text)
        ):
            kind = "HEADING"
        elif _CONTACT_SIGNAL.search(text) and len(block) <= 8 and words <= 60:
            kind = "CONTACT_BLOCK"
        elif words >= 25:
            kind = "NARRATIVE"
        else:
            kind = "PARAGRAPH"
        regions.append(
            StructuredRegion(
                region_id=ids.next(kind.lower()),
                region_type=kind,  # type: ignore[arg-type]
                text=text if kind != "NARRATIVE" else text[:_NARRATIVE_LIMIT],
                normalized_text=normalize_space(text).lower()[:600],
                page=page_number,
                bbox=bbox,
                extraction_method=extraction_method,
                structural_metadata={
                    "lines": len(block),
                    "words": words,
                    "font_size": round(size, 1),
                    # Each line's own size: a heading line inside a block of
                    # body text ("EDUCATION" over its entries).
                    "line_sizes": [round(s.size, 1) for s in block],
                    "bold": all(s.bold for s in block),
                },
            )
        )
    return regions


def _min_ocr_confidence(words: list[Word], bbox) -> float | None:
    """Lowest confidence of the OCR words inside `bbox`; None when any of
    them has no confidence (unknown must not look certain)."""

    if not bbox:
        return None
    x0, y0, x1, y1 = bbox
    inside = [
        w for w in words
        if x0 - 1 <= (w.x0 + w.x1) / 2 <= x1 + 1 and y0 - 1 <= (w.y0 + w.y1) / 2 <= y1 + 1
    ]
    if not inside or any(w.conf is None for w in inside):
        return None
    return min(w.conf for w in inside)


def _ocr_contested(words: list[Word], bbox) -> bool:
    """Whether any OCR word inside `bbox` was read differently by the two
    OCR passes (an unresolved disagreement)."""

    if not bbox:
        return False
    x0, y0, x1, y1 = bbox
    return any(
        w.contested
        for w in words
        if x0 - 1 <= (w.x0 + w.x1) / 2 <= x1 + 1 and y0 - 1 <= (w.y0 + w.y1) / 2 <= y1 + 1
    )


def _assign_ocr_confidence(result: "PageStructure", words: list[Word]) -> None:
    for field in result.fields:
        if field.structural_relation == "ruled_form_box":
            # Read from the box's own OCR and reconciled with the page pass
            # (_raster_form_fields): its own confidence and disagreement stand.
            continue
        field.ocr_confidence = _min_ocr_confidence(words, field.value_bbox)
        field.ocr_contested = _ocr_contested(words, field.value_bbox)
    for table in result.tables:
        for row in table.rows:
            for cell in row:
                cell.ocr_confidence = _min_ocr_confidence(words, cell.bbox)
                cell.ocr_contested = _ocr_contested(words, cell.bbox)
        for cell in table.header_cells:
            cell.ocr_confidence = _min_ocr_confidence(words, cell.bbox)
            cell.ocr_contested = _ocr_contested(words, cell.bbox)
    for region in result.regions:
        region.structural_metadata["ocr_confidence"] = _min_ocr_confidence(words, region.bbox)
        if _ocr_contested(words, region.bbox):
            region.structural_metadata["ocr_contested"] = True


# A column gutter: an empty vertical band at least this wide (points).
_MIN_GUTTER = 8.0


def _wordy_rows(words: list[Word]) -> int:
    """Rows (by height) holding three or more words: running text, not a
    column of short labels or a list of dates."""

    rows: dict[int, int] = {}
    for word in words:
        key = int(word.y0 // 4)
        rows[key] = rows.get(key, 0) + 1
    return sum(1 for count in rows.values() if count >= 3)


def _row_alignment(left: list[Word], right: list[Word]) -> float:
    """Share of the sparser side's text rows that have a row on the other
    side at the same height. Table columns line up row by row (≈1); a
    sidebar's lines and the main column's lines are independent."""

    def rows(side: list[Word]) -> set[int]:
        return {round(w.y1) for w in side}

    a, b = rows(left), rows(right)
    fewer, other = (a, b) if len(a) <= len(b) else (b, a)
    if not fewer:
        return 1.0
    matched = sum(1 for row in fewer if {row - 1, row, row + 1} & other)
    return matched / len(fewer)


def _aligned_run(left: list[Word], right: list[Word]) -> int:
    """The longest run of consecutive rows (in the sparser side's order)
    that line up with the other side: a table crossing the band (an
    invoice's line items) aligns several rows in a row; a sidebar meets the
    main column's lines only by chance."""

    rows_left = {round(w.y1) for w in left}
    rows_right = {round(w.y1) for w in right}
    fewer, other = (rows_left, rows_right) if len(rows_left) <= len(rows_right) else (rows_right, rows_left)
    best = run = 0
    for row in sorted(fewer):
        run = run + 1 if {row - 1, row, row + 1} & other else 0
        best = max(best, run)
    return best


def column_gutter(words: list[Word]) -> float | None:
    """The x of the gutter between two page columns (a sidebar beside a main
    column), or None for a single-column page. A gutter is an empty vertical
    band no word crosses anywhere on the page, with substantial running text
    on both sides over a good part of the page's height, whose lines do not
    line up row by row (that is a table's columns). Full-width text (a
    summary paragraph, a table spanning the page) rules a split out, so
    side-by-side blocks within one column never trigger it."""

    if len(words) < 40:
        return None
    left_edge = min(w.x0 for w in words)
    right_edge = max(w.x1 for w in words)
    width = right_edge - left_edge
    if width <= 0:
        return None
    covered = [False] * (int(right_edge) + 2)
    for word in words:
        for x in range(max(0, int(word.x0)), min(len(covered), int(word.x1) + 1)):
            covered[x] = True
    top = min(w.y0 for w in words)
    height = max(w.y1 for w in words) - top
    best: tuple[float, float] | None = None
    x = int(left_edge + 0.15 * width)
    stop = int(left_edge + 0.85 * width)
    while x < stop:
        if covered[x]:
            x += 1
            continue
        start = x
        while x < len(covered) and not covered[x]:
            x += 1
        band = x - start
        if band < _MIN_GUTTER:
            continue
        gutter = (start + x) / 2
        left = [w for w in words if w.x1 <= gutter]
        right = [w for w in words if w.x0 >= gutter]
        if min(len(left), len(right)) < 0.08 * len(words):
            continue
        spans = [max(w.y1 for w in side) - min(w.y0 for w in side) for side in (left, right)]
        if min(spans) < 0.2 * height or min(_wordy_rows(left), _wordy_rows(right)) < 2:
            continue
        if _row_alignment(left, right) >= 0.5 or _aligned_run(left, right) >= 3:
            continue
        if best is None or band > best[1]:
            best = (gutter, band)
    return best[0] if best else None


def extract_page_structure(
    *,
    page_number: int,
    words: list[Word],
    extraction_method: str,
    fitz_page=None,
    raster_grids: list | None = None,
) -> PageStructure:
    """A page's structure. A two-column page (a sidebar beside the main
    text) is read column by column, so lines, fields and tables never join
    words across the gutter."""

    ids = _Ids(page_number)
    # Native text only: OCR baselines drift with skew, so a scanned table's
    # rows no longer line up and could pass for independent columns.
    gutter = column_gutter(words) if words and extraction_method == "native" else None
    if gutter is None:
        return _extract_structure(
            ids, page_number=page_number, words=words, extraction_method=extraction_method,
            fitz_page=fitz_page, raster_grids=raster_grids,
        )
    result = PageStructure()
    for column in ([w for w in words if w.x1 <= gutter], [w for w in words if w.x0 >= gutter]):
        # Vector ruling and form widgets are page-wide; a column run would
        # find them twice, so columns read from their words alone.
        part = _extract_structure(
            ids, page_number=page_number, words=column, extraction_method=extraction_method,
            fitz_page=None, raster_grids=None,
        )
        for region in part.regions:
            region.structural_metadata["column"] = "left" if column and column[0].x1 <= gutter else "right"
        result.regions.extend(part.regions)
        result.fields.extend(part.fields)
        result.tables.extend(part.tables)
    return result


def _extract_structure(
    ids: _Ids,
    *,
    page_number: int,
    words: list[Word],
    extraction_method: str,
    fitz_page=None,
    raster_grids: list | None = None,
) -> PageStructure:
    result = PageStructure()
    if not words:
        return result
    lines = build_lines(words)
    page_text = "\n".join(" ".join(s.text for s in line.segments) for line in lines)

    # 1. Ruled tables (native only — OCR has no vector ruling lines). The
    # table finder is the expensive step, so it only runs where the words
    # already show multi-column structure.
    multi_column_lines = sum(1 for line in lines if len(line.segments) >= 3)
    if fitz_page is not None and extraction_method == "native" and multi_column_lines >= 3:
        for bbox, data, cell_boxes, header_names in _ruled_tables(fitz_page, page_number):
            texts = [[normalize_space(str(c or "")) for c in row] for row in data]
            boxes = [[tuple(b) if b else None for b in row] for row in cell_boxes]
            header, body = texts[0], texts[1:]
            header_ok = all(h and not is_numeric_value(h) for h in header)
            table, regions = _table_from_grid(
                ids, page_number, "pdf_ruling_lines", extraction_method,
                header if header_ok else None,
                boxes[0] if header_ok else [],
                body if header_ok else texts,
                boxes[1:] if header_ok else boxes,
                page_text, tuple(bbox),
            )
            result.tables.append(table)
            result.regions.extend(regions)
            if table.acceptance == "accepted":
                x0, y0, x1, y1 = bbox
                for line in lines:
                    for seg in line.segments:
                        sx0, sy0, sx1, sy1 = seg.bbox
                        if sx0 >= x0 - 1 and sx1 <= x1 + 1 and sy0 >= y0 - 1 and sy1 <= y1 + 1:
                            seg.used = True

    # 1b. Ruled tables printed on a raster (OCR) page — from the image's own
    # column rules. Claimed before any label/value pairing, so table cells
    # never become scalar fields.
    # A grid whose dividers change from row to row is a form of boxes, read
    # box by box (caption over value), never as a table.
    form_box_fields: list[FieldCandidate] = []
    for grid in raster_grids or []:
        boxes = grid.form_boxes() if hasattr(grid, "form_boxes") else None
        if boxes:
            form_box_fields.extend(_raster_form_fields(
                ids, page_number, lines, boxes, extraction_method,
                box_words=getattr(grid, "box_words", None), page_text=getattr(grid, "page_text", ""),
            ))
            continue
        # Cut to its ruled frame: a screenshot's page edges and toolbar
        # aren't columns of the table.
        framed = grid if getattr(grid, "cell_boxes", None) or not hasattr(grid, "framed") else grid.framed()
        built = _raster_grid_table(ids, page_number, lines, framed, extraction_method, page_text)
        if built is not None:
            table, regions = built
            result.tables.append(table)
            result.regions.extend(regions)

    # 1c. Ruled "tables" that are grids of captions and values are fields.
    grid_fields: list[FieldCandidate] = []
    kept_tables = []
    for table in result.tables:
        converted = _key_value_grid_fields(ids, page_number, table, extraction_method)
        if converted:
            grid_fields.extend(converted)
            result.regions = [r for r in result.regions if not (r.region_id or "").startswith(table.region_id)]
        else:
            kept_tables.append(table)
    result.tables = kept_tables

    # 1d. Form rows written on drawn underlines, before anything reads the
    # caption | sub-caption | value columns as a table.
    ruled_fields: list[FieldCandidate] = []
    if fitz_page is not None and extraction_method == "native":
        claimed = [t.bbox for t in result.tables if t.bbox and t.acceptance == "accepted"]
        ruled_fields = _ruled_form_fields(ids, page_number, fitz_page, lines, extraction_method, claimed)

    # 2. Label/value pairs claim their segments before column alignment,
    # so a stack of "Label: value" lines is never mistaken for a table.
    widget_fields = _form_widget_candidates(ids, fitz_page, page_number) if fitz_page is not None else []
    fields = _label_value_candidates(ids, page_number, lines, extraction_method)
    fields[:0] = ruled_fields
    fields.extend(widget_fields)

    # 3. Column-aligned tables from the remaining runs.
    for bands, grid, members in _alignment_tables(lines):
        header_is_first = _is_header_row(grid[0], grid[1:])
        header_cells = grid[0] if header_is_first else None
        body = grid[1:] if header_is_first else grid
        table, regions = _table_from_grid(
            ids, page_number, "pdf_column_alignment", extraction_method,
            [_cell_text(c) for c in header_cells] if header_cells else None,
            [_union([s.bbox for s in c]) for c in header_cells] if header_cells else [],
            [[_cell_text(c) for c in row] for row in body],
            [[_union([s.bbox for s in c]) for c in row] for row in body],
            page_text,
            _union([s.bbox for line in members for s in line.free_segments]),
        )
        result.tables.append(table)
        result.regions.extend(regions)
        if table.acceptance == "accepted":
            for line in members:
                for seg in line.free_segments:
                    seg.used = True

    # 4. Separator-less pairs, only from what no table claimed.
    fields.extend(_loose_label_value_candidates(ids, page_number, lines, extraction_method))
    fields[:0] = form_box_fields + grid_fields
    _rescue_form_captions(fields)

    for f in fields:
        result.regions.append(
            StructuredRegion(
                region_id=f"{f.candidate_id}:region",
                region_type="FORM_FIELD" if f.structural_relation == "form_widget" else "LABEL_VALUE",
                text=f.evidence_text,
                normalized_text=normalize_space(f.evidence_text).lower(),
                page=page_number,
                bbox=_union([f.label_bbox, f.value_bbox]),
                extraction_method=extraction_method,
                structural_metadata={"acceptance": f.acceptance, "relation": f.structural_relation},
            )
        )
        f.source_region_ids.append(f"{f.candidate_id}:region")
    result.fields = fields
    result.regions.extend(_group_key_values(ids, page_number, fields))
    result.regions.extend(_text_regions(ids, page_number, lines, extraction_method))
    if extraction_method == "ocr":
        # Words read from a box's or cell's own crop count too: a value
        # taken from one carries that reading's confidence.
        cropped = [w for grid in raster_grids or [] for ws in (getattr(grid, "box_words", None) or {}).values() for w in ws]
        _assign_ocr_confidence(result, words + cropped)
    return result
