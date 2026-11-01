"""A fillable form page as printed: its ruled cells, its numbered item
captions, and every form box on it (empty and unticked ones included),
read straight from the PDF.

The Original File layout uses it to number a form's boxes by the printed
form rather than by the boxes' built-in descriptions, to show unticked
choices, to read the form's own tables, and to recognise text-extractor
rows that only repeat the form. The structure reader, and so the Advanced
Grid, staging and Oracle mapping, is not involved.

Everything here is decided from the page's geometry, never from a known
form: a box belongs to the printed caption in its own ruled cell.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

from app.source_structure.text_shapes import normalize_space

logger = logging.getLogger(__name__)

BBox = tuple[float, float, float, float]

# "7. ISSUED BY", "15A. NAME AND": a printed item number and its caption.
_CAPTION = re.compile(r"^(\d{1,3}[A-Z]?)\.\s+(\S.*)$")
_CHOICE_KINDS = {"CheckBox", "RadioButton"}
_OFF = {"", "off", "false", "no", "0"}
# Rules are strokes thinner than this, in points.
_THIN = 1.5
_NEAR = 2.0

SELECTED, NOT_SELECTED, UNRECOGNIZED = "selected", "not_selected", "unrecognized"
STATE_LABELS = {SELECTED: "Selected", NOT_SELECTED: "Not Selected"}


@dataclass(frozen=True)
class Rule:
    at: float  # y of a horizontal rule, x of a vertical one
    start: float
    end: float

    def crosses(self, point: float) -> bool:
        return self.start - _NEAR <= point <= self.end + _NEAR


@dataclass(frozen=True)
class PrintedLine:
    text: str
    bbox: BBox

    @property
    def center(self) -> tuple[float, float]:
        return (self.bbox[0] + self.bbox[2]) / 2, (self.bbox[1] + self.bbox[3]) / 2


@dataclass(frozen=True)
class FormBox:
    name: str
    # Its built-in description, worded as the structure reader words it.
    label: str
    kind: str  # Text | CheckBox | RadioButton | ComboBox | ListBox | Signature
    value: str  # as stored in the form
    on_state: str | None
    rect: BBox
    # False: the box has no description of its own, only an internal name.
    described: bool = True

    @property
    def is_choice(self) -> bool:
        return self.kind in _CHOICE_KINDS

    @property
    def center(self) -> tuple[float, float]:
        return (self.rect[0] + self.rect[2]) / 2, (self.rect[1] + self.rect[3]) / 2

    @property
    def state(self) -> str | None:
        """A choice box's state: selected, not selected, or a value the box
        doesn't define (unrecognized). None for other boxes."""

        if not self.is_choice:
            return None
        value = self.value.strip()
        # The box's own "on" value first: some forms name it "0".
        if self.on_state and value == self.on_state:
            return SELECTED
        if value.lower() in _OFF:
            return NOT_SELECTED
        if value.lower() in {"1", "on", "yes", "true", "x", "checked"}:
            return SELECTED
        return UNRECOGNIZED


@dataclass(frozen=True)
class Caption:
    number: str
    # The printed wording after the number, its continuation lines joined.
    text: str
    bbox: BBox


@dataclass(frozen=True)
class FormTable:
    """A printed table of form boxes: its columns as printed, its rows in
    reading order, each cell's text exactly as the page or box holds it."""

    number: str
    caption: Caption | None
    headers: list[str]
    header_boxes: list[BBox]
    rows: list[list[str]]
    row_boxes: list[list[BBox]]
    # The form boxes each row holds.
    row_sources: list[list[str]]
    boxes: frozenset[str]
    bbox: BBox
    # Read left half, then right half: the halves are separate lists.
    folded: bool


def _inside(point: tuple[float, float], box: BBox, pad: float = 0.0) -> bool:
    return box[0] - pad <= point[0] <= box[2] + pad and box[1] - pad <= point[1] <= box[3] + pad


def _covered(line: BBox, box: BBox) -> float:
    """How much of a line of text lies inside a box (0–1)."""

    width = max(0.0, min(line[2], box[2]) - max(line[0], box[0]))
    height = max(0.0, min(line[3], box[3]) - max(line[1], box[1]))
    return width * height / max(1e-6, (line[2] - line[0]) * (line[3] - line[1]))


def is_label_caption(text: str) -> bool:
    """A caption printed as a label ("TYPE OF SOLICITATION"), not a sentence
    ("Sealed offers in original and …"): its words outside parentheses are
    capitals."""

    letters = [ch for ch in re.sub(r"\([^)]*\)", "", text) if ch.isalpha()]
    return bool(letters) and sum(ch.isupper() for ch in letters) >= 0.8 * len(letters)


@dataclass
class FormPage:
    page: int
    frame: BBox
    horizontal: list[Rule]
    vertical: list[Rule]
    # Printed text outside the form's boxes (a box's own rendering is its value).
    lines: list[PrintedLine]
    # Every line of printed text, box renderings included.
    all_text: list[str]
    boxes: list[FormBox]
    captions: list[Caption] = field(default_factory=list)

    # -- cells -----------------------------------------------------------

    def cell(self, point: tuple[float, float], dropped: frozenset[Rule] = frozenset()) -> tuple[BBox, tuple[Rule | None, ...]]:
        """The ruled cell around a point, and the rules bounding it (top,
        bottom, left, right; None where the page frame bounds it)."""

        x, y = point
        above = [r for r in self.horizontal if r not in dropped and r.at < y and r.crosses(x)]
        below = [r for r in self.horizontal if r not in dropped and r.at > y and r.crosses(x)]
        left = [r for r in self.vertical if r not in dropped and r.at < x and r.crosses(y)]
        right = [r for r in self.vertical if r not in dropped and r.at > x and r.crosses(y)]
        top = max(above, key=lambda r: r.at, default=None)
        bottom = min(below, key=lambda r: r.at, default=None)
        west = max(left, key=lambda r: r.at, default=None)
        east = min(right, key=lambda r: r.at, default=None)
        box = (
            west.at if west else self.frame[0],
            top.at if top else self.frame[1],
            east.at if east else self.frame[2],
            bottom.at if bottom else self.frame[3],
        )
        return box, (top, bottom, west, east)

    def _own_rules(self, cell: BBox, rules: tuple[Rule | None, ...]) -> frozenset[Rule]:
        """The bounding rules that frame only this cell: a small box drawn
        inside a larger one (a "CODE" box in an address block)."""

        top, bottom, west, east = rules
        own = set()
        for rule in (top, bottom):
            if rule is not None and rule.start >= cell[0] - _NEAR and rule.end <= cell[2] + _NEAR:
                own.add(rule)
        for rule in (west, east):
            if rule is not None and rule.start >= cell[1] - _NEAR and rule.end <= cell[3] + _NEAR:
                own.add(rule)
        return frozenset(own)

    def text_in(self, cell: BBox) -> list[PrintedLine]:
        return [line for line in self.lines if _inside(line.center, cell)]

    def captions_in(self, cell: BBox) -> list[Caption]:
        return [c for c in self.captions if _inside(((c.bbox[0] + c.bbox[2]) / 2, (c.bbox[1] + c.bbox[3]) / 2), cell)]

    def text_beside(self, box: FormBox) -> str | None:
        """The printed text a box stands in front of (a choice's own option
        wording), on the same line, starting just right of it."""

        line = next(
            (l for l in self.lines if 0 <= l.bbox[0] - box.rect[2] <= 12
             and _covered((box.rect[0], l.bbox[1], box.rect[2], l.bbox[3]), box.rect) > 0.5),
            None,
        )
        return line.text if line else None

    def box_cells(self, box: FormBox) -> tuple[BBox, BBox | None]:
        """A box's own cell, and the cell it is drawn inside when its own
        cell is only a frame around it (holds no printed text)."""

        cell, rules = self.cell(box.center)
        if self.text_in(cell) or self.captions_in(cell):
            return cell, None
        own = self._own_rules(cell, rules)
        if not own:
            return cell, None
        outer, _ = self.cell(box.center, own)
        return cell, outer if outer != cell else None

    def printed_number(self, box: FormBox, described: str) -> tuple[str, str]:
        """A box's item number as the page prints it, and where it came from:

        - "printed": the one numbered caption in the box's own ruled cell
          (or, for a box without a number of its own, in the cell it is
          drawn inside, or the label column printed beside that cell);
        - "form_field": the box's built-in description, when the page
          doesn't show its caption;
        - "none": neither; the box is shown on its own, with no number.

        `described` is the number in the box's description ("" for none)."""

        cell, outer = self.box_cells(box)
        numbers = {c.number for c in self.captions_in(cell)}
        if len(numbers) == 1:
            return next(iter(numbers)), "printed"
        if not numbers and not described and outer is not None:
            numbers = {c.number for c in self.captions_in(outer)}
            if not numbers:
                # The caption printed in a label column beside the box's cell.
                side, _ = self.cell((outer[0] - 3, (outer[1] + outer[3]) / 2))
                if side[1] >= outer[1] - _NEAR and side[3] <= outer[3] + _NEAR and not any(_inside(b.center, side) for b in self.boxes):
                    numbers = {c.number for c in self.captions_in(side) if is_label_caption(c.text)}
            if len(numbers) == 1:
                return next(iter(numbers)), "printed"
        if described:
            return described, "form_field"
        return "", "none"

    # -- tables ----------------------------------------------------------

    def _columns(self, band: tuple[float, float], span: tuple[float, float]) -> list[float]:
        y = (band[0] + band[1]) / 2
        inner = sorted({round(r.at, 1) for r in self.vertical if span[0] + _NEAR < r.at < span[1] - _NEAR and r.crosses(y)
                        and r.start <= band[0] + _NEAR and r.end >= band[1] - _NEAR})
        return [span[0], *inner, span[1]]

    def _covering(self, span: tuple[float, float]) -> list[Rule]:
        return [r for r in self.horizontal if r.start <= span[0] + 3 and r.end >= span[1] - 3]

    def _cell_text(self, cell: BBox, used: set[str]) -> str:
        parts: list[tuple[float, float, str]] = []
        for box in self.boxes:
            if _inside(box.center, cell):
                used.add(box.name)
                text = STATE_LABELS.get(box.state, box.value) if box.is_choice else box.value
                parts.append((box.rect[1], box.rect[0], normalize_space(text)))
        for line in self.text_in(cell):
            parts.append((line.bbox[1], line.bbox[0], line.text))
        return " ".join(text for _, _, text in sorted(parts) if text)

    def table(self, number: str, boxes: list[FormBox]) -> FormTable | None:
        """The printed table an item's boxes fill, when the page prints one:
        a header band whose ruled columns match the boxes' rows, directly
        above them. None when the boxes are not laid out as a table."""

        if len(boxes) < 4:
            return None
        x0, y0 = min(b.rect[0] for b in boxes), min(b.rect[1] for b in boxes)
        x1, y1 = max(b.rect[2] for b in boxes), max(b.rect[3] for b in boxes)
        lefts = [r.at for r in self.vertical if r.at <= x0 + 1.5 and r.crosses((y0 + y1) / 2)]
        rights = [r.at for r in self.vertical if r.at >= x1 - 1.5 and r.crosses((y0 + y1) / 2)]
        across = [r for r in self.horizontal if r.start <= x0 + 3 and r.end >= x1 - 3]
        if not across:
            return None
        span = (max(lefts, default=min(r.start for r in across)), min(rights, default=max(r.end for r in across)))
        rules = sorted({r.at for r in self._covering(span)})
        tops = [at for at in rules if at <= y0 + 1.5]
        bottoms = [at for at in rules if at >= y1 - 1.5]
        if not tops or not bottoms:
            return None
        top, bottom = tops[-1], bottoms[0]
        body_rows = [at for at in rules if top < at < bottom]
        first_row = (top, body_rows[0] if body_rows else bottom)
        columns = self._columns(first_row, span)
        if len(columns) < 3:
            return None
        # The header: the nearest band above with the same printed columns.
        header: tuple[float, float] | None = None
        above = [at for at in rules if at < top]
        lead = top
        for upper in reversed(above[-3:]):
            band = (upper, lead)
            band_box = (span[0], band[0], span[1], band[1])
            if self.captions_in(band_box) or any(_inside(b.center, band_box) for b in self.boxes):
                break
            printed = self._columns(band, span)
            if len(printed) == len(columns) and all(abs(a - b) <= _NEAR for a, b in zip(printed, columns)):
                header = band
                break
            lead = upper
        if header is None:
            return None
        if self.captions_in((span[0], header[0], span[1], bottom)):
            return None
        header_cells = [(columns[i], header[0], columns[i + 1], header[1]) for i in range(len(columns) - 1)]
        headers = [" ".join(line.text for line in sorted(self.text_in(cell), key=lambda l: (l.bbox[1], l.bbox[0]))) for cell in header_cells]
        if sum(1 for h in headers if h) < 2:
            return None

        # Halves printed side by side with the same headers.
        width = len(headers)
        keys = [normalize_space(h).lower() for h in headers]
        period = next((p for p in range(1, width) if width % p == 0 and all(keys[i] == keys[i % p] for i in range(width))), width)
        groups = [(columns[k * period], columns[(k + 1) * period], k * period) for k in range(width // period)]
        bands_of = []
        for start, end, _ in groups:
            cuts = sorted({at for at in (r.at for r in self._covering((start, end))) if header[1] < at < bottom})
            bands_of.append([header[1], *cuts, bottom])
        folded = period < width and any(bands != bands_of[0] for bands in bands_of)
        if not folded:
            groups = [(span[0], span[1], 0)]
            bands_of = [bands_of[0] if period < width else [header[1], *[at for at in rules if header[1] < at < bottom], bottom]]
            period = width
        used: set[str] = set()
        rows, row_boxes, row_sources = [], [], []
        for (start, _, first), bands in zip(groups, bands_of):
            for upper, lower in zip(bands, bands[1:]):
                cells = [(columns[first + i], upper, columns[first + i + 1], lower) for i in range(period)]
                before = set(used)
                texts = [self._cell_text(cell, used) for cell in cells]
                if not any(texts):
                    continue
                rows.append(texts)
                row_boxes.append(cells)
                row_sources.append(sorted(used - before))
        if not rows:
            return None
        names = frozenset(b.name for b in boxes)
        caption = next((c for c in self.captions if c.number == number), None)
        return FormTable(
            number=number,
            caption=caption,
            headers=headers[:period],
            header_boxes=header_cells[:period],
            rows=rows,
            row_boxes=row_boxes,
            row_sources=row_sources,
            boxes=names | frozenset(used),
            bbox=(span[0], header[0], span[1], bottom),
            folded=folded,
        )


def _join_captions(lines: list[PrintedLine], horizontal: list[Rule], boxes: list[FormBox]) -> list[Caption]:
    """Each numbered caption with the lines printed under it in its cell
    ("10. FOR" / "INFORMATION" / "CALL:"), stopping at a note in
    parentheses, a line with figures, or a rule."""

    captions = []
    for line in lines:
        match = _CAPTION.match(line.text)
        if not match:
            continue
        words = [match.group(2)]
        bottom = line.bbox[3]
        height = line.bbox[3] - line.bbox[1]
        for following in sorted((l for l in lines if l.bbox[1] > line.bbox[1]), key=lambda l: l.bbox[1]):
            if following.bbox[1] - bottom > 0.6 * height:
                break
            if not (line.bbox[0] - 3 <= following.bbox[0] <= line.bbox[0] + 20):
                continue
            text = following.text
            if _CAPTION.match(text) or text.startswith("(") or re.search(r"\d", text) or len(words) > 3:
                break
            # A choice's own printed label, beside its box, isn't the caption.
            if any(0 <= following.bbox[0] - b.rect[2] <= 12 and _covered((b.rect[0], following.bbox[1], b.rect[2], following.bbox[3]), b.rect) > 0.5
                   for b in boxes):
                break
            if any(bottom - 1 < r.at < following.bbox[1] + 1 and r.crosses(following.center[0]) for r in horizontal):
                break
            words.append(text)
            bottom = following.bbox[3]
        captions.append(Caption(match.group(1), normalize_space(" ".join(words)), line.bbox))
    return captions


def _rules(page) -> tuple[list[Rule], list[Rule]]:
    horizontal: set[Rule] = set()
    vertical: set[Rule] = set()
    for drawing in page.get_drawings():
        for item in drawing.get("items", []):
            if item[0] == "l":
                a, b = item[1], item[2]
                if abs(a.y - b.y) < 0.8 and abs(a.x - b.x) > 5:
                    horizontal.add(Rule(round((a.y + b.y) / 2, 1), round(min(a.x, b.x), 1), round(max(a.x, b.x), 1)))
                elif abs(a.x - b.x) < 0.8 and abs(a.y - b.y) > 5:
                    vertical.add(Rule(round((a.x + b.x) / 2, 1), round(min(a.y, b.y), 1), round(max(a.y, b.y), 1)))
            elif item[0] == "re":
                r = item[1]
                if r.height < _THIN and r.width > 5:
                    horizontal.add(Rule(round((r.y0 + r.y1) / 2, 1), round(r.x0, 1), round(r.x1, 1)))
                elif r.width < _THIN and r.height > 5:
                    vertical.add(Rule(round((r.x0 + r.x1) / 2, 1), round(r.y0, 1), round(r.y1, 1)))
    return sorted(horizontal, key=lambda r: (r.at, r.start)), sorted(vertical, key=lambda r: (r.at, r.start))


def box_label(widget) -> str:
    """A box's description, worded as the structure reader words it."""

    name = widget.field_label or widget.field_name or ""
    return normalize_space(re.sub(r"(?<=[a-z])(?=[A-Z])|[_.]+", " ", name).strip()).rstrip(":").strip()


def read_page(page, page_number: int) -> FormPage | None:
    boxes = []
    for widget in page.widgets() or []:
        rect = widget.rect
        on = None
        if widget.field_type_string in _CHOICE_KINDS:
            try:
                on = str(widget.on_state())
            except Exception:  # noqa: BLE001 - a box without an "on" appearance
                on = None
        boxes.append(FormBox(
            name=widget.field_name or "", label=box_label(widget), kind=widget.field_type_string,
            value=str(widget.field_value or ""), on_state=on, rect=(rect.x0, rect.y0, rect.x1, rect.y1),
            described=bool((widget.field_label or "").strip()),
        ))
    if not boxes:
        return None
    horizontal, vertical = _rules(page)
    lines, every = [], []
    for block in page.get_text("dict").get("blocks", []):
        for line in block.get("lines", []):
            text = normalize_space("".join(span["text"] for span in line["spans"]))
            if not text:
                continue
            every.append(text)
            printed = PrintedLine(text, tuple(line["bbox"]))
            # A box's own rendering of its value lies inside it; a caption
            # printed across its top edge doesn't.
            if not any(_covered(printed.bbox, b.rect) >= 0.6 for b in boxes):
                lines.append(printed)
    lines.sort(key=lambda l: (l.bbox[1], l.bbox[0]))
    xs = [r.start for r in horizontal] + [r.end for r in horizontal]
    ys = [r.start for r in vertical] + [r.end for r in vertical]
    frame = (
        min(xs, default=0.0), min(ys + [r.at for r in horizontal], default=0.0),
        max(xs, default=float(page.rect.width)), max(ys + [r.at for r in horizontal], default=float(page.rect.height)),
    )
    form = FormPage(page_number, frame, horizontal, vertical, lines, every, boxes)
    form.captions = _join_captions(lines, horizontal, boxes)
    return form


@lru_cache(maxsize=16)
def _read(path: str, stamp: tuple[int, int], pages: tuple[int, ...]) -> dict[int, FormPage]:
    import fitz

    forms: dict[int, FormPage] = {}
    with fitz.open(path) as pdf:
        for number in pages:
            if 1 <= number <= pdf.page_count:
                form = read_page(pdf[number - 1], number)
                if form is not None:
                    forms[number] = form
    return forms


@lru_cache(maxsize=64)
def _box_pages(path: str, stamp: tuple[int, int]) -> frozenset[int]:
    import fitz

    with fitz.open(path) as pdf:
        if not pdf.is_form_pdf:
            return frozenset()
        return frozenset(index + 1 for index, page in enumerate(pdf) if page.first_widget is not None)


def form_box_pages(path: Path | str) -> set[int]:
    """The pages holding form boxes, filled or not (a blank form has no
    filled box, yet its boxes are what it prints)."""

    try:
        stat = Path(path).stat()
        return set(_box_pages(str(path), (stat.st_mtime_ns, stat.st_size)))
    except Exception:  # noqa: BLE001 - geometry only refines the layout
        logger.warning("Could not list the form pages of %s", path, exc_info=True)
        return set()


def read_form_pages(path: Path | str, pages: set[int]) -> dict[int, FormPage]:
    """The form pages among `pages` (those holding form boxes), read once per
    file version. A file that can't be read gives none: the layout then
    falls back to the boxes' own descriptions."""

    try:
        stat = Path(path).stat()
        return _read(str(path), (stat.st_mtime_ns, stat.st_size), tuple(sorted(pages)))
    except Exception:  # noqa: BLE001 - geometry only refines the layout
        logger.warning("Could not read the form geometry of %s", path, exc_info=True)
        return {}
