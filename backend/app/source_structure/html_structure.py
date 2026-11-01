"""HTML → structural regions and candidates, DOM first.

The DOM is walked in document order; decisions are made on elements
(headings, tables, dl/dt/dd, label/control, adjacent label+value elements,
inline "<b>Label:</b> value"), never on stripped page text. Every region
carries a SourceLocator: XPath, element id, heading trail, and table/row/
column indices for table cells. HTML has no pages, so no page numbers are
invented.
"""

from __future__ import annotations

import re

from lxml import etree, html as lxml_html

from app.services.table_quality import assess_table_candidate
from app.source_structure.models import (
    FieldCandidate,
    StructuredRegion,
    TableCandidate,
    TableCell,
)
from app.source_structure.table_hints import annotate_table
from app.source_structure.text_shapes import (
    candidate_quality,
    infer_value_type,
    label_rejection,
    normalize_space,
    strip_label_separator,
    value_rejection,
)
from app.staging.models import SourceLocator

# A narrative block keeps its whole text (read as document sections);
# the cap only bounds a pathological block.
_NARRATIVE_LIMIT = 20_000

_DROP = {"script", "style", "noscript", "template", "svg", "iframe", "object", "embed", "head"}
_BLOCK = {
    "address", "article", "aside", "blockquote", "dd", "div", "dl", "dt", "fieldset",
    "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header",
    "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "tbody", "td", "tfoot",
    "th", "thead", "tr", "ul", "caption", "legend",
}
_SECTIONING = {"section", "article", "aside", "nav", "header", "footer"}
_HEADINGS = {"h1": 1, "h2": 2, "h3": 3, "h4": 4, "h5": 5, "h6": 6}
_EMPHASIS = {"b", "strong", "em", "label", "span", "dfn", "th"}
_CONTROLS = {"input", "select", "textarea", "output"}
# A blank to write on ("__________"): an empty cell, not a value.
_FILL_IN = re.compile(r"[_\s]*_{3,}[_\s]*")
_PLACEHOLDER = re.compile(r"\[[^\]]*\]")
_NUMBERISH = re.compile(r"[\d$€£%.,\s()+-]+")


def _cell_text(cell) -> str:
    if cell is None:
        return ""
    text = normalize_space(element_text(cell))
    return "" if _FILL_IN.fullmatch(text) else text


_INLINE_SEP = re.compile(r"^(?P<label>[^:\n]{1,60}?[A-Za-z)#.])\s*:\s+(?P<value>\S[\s\S]*)$")


def _tag(el) -> str:
    return el.tag.lower() if isinstance(el.tag, str) else ""


def element_text(el) -> str:
    """Readable text of an element: <br> and block boundaries become line
    breaks, runs of whitespace collapse within lines."""

    if _tag(el) in _CONTROLS:
        return normalize_space(_control_value(el) or "")
    parts: list[str] = []

    def walk(node):
        tag = _tag(node)
        if tag in _DROP or not tag:
            if node.tail:
                parts.append(node.tail)
            return
        if tag == "br":
            parts.append("\n")
        elif tag in _BLOCK:
            parts.append("\n")
        if tag in _CONTROLS:
            parts.append(_control_value(node) or "")
        if node.text:
            parts.append(node.text)
        for child in node:
            walk(child)
        if tag in _BLOCK:
            parts.append("\n")
        elif not (node.tail or "").strip():
            # Adjacent inline elements (<span>Label</span><span>Value</span>)
            # render as separate words, not "LabelValue".
            parts.append(" ")
        if node.tail:
            parts.append(node.tail)

    if el.text:
        parts.append(el.text)
    for child in el:
        walk(child)
    lines = [re.sub(r"[ \t\r\f\v ]+", " ", line).strip() for line in "".join(parts).split("\n")]
    return "\n".join(line for line in lines if line)


def _control_value(el) -> str | None:
    tag = _tag(el)
    if tag == "input":
        kind = (el.get("type") or "text").lower()
        if kind in ("checkbox", "radio"):
            return "Yes" if el.get("checked") is not None else "No"
        if kind in ("hidden", "submit", "button", "password", "image", "reset", "file"):
            return None
        return el.get("value")
    if tag == "textarea":
        return el.text or ""
    if tag == "select":
        chosen = el.xpath(".//option[@selected]") or el.xpath(".//option")[:1]
        return normalize_space(chosen[0].text_content()) if chosen else None
    if tag == "output":
        return normalize_space(el.text_content())
    return None


class HtmlStructureExtractor:
    def __init__(self, raw: bytes):
        self.root = lxml_html.document_fromstring(raw)
        for bad in self.root.xpath("//script|//style|//noscript|//template|//comment()"):
            parent = bad.getparent()
            if parent is not None:
                if bad.tail:
                    previous = bad.getprevious()
                    if previous is not None:
                        previous.tail = (previous.tail or "") + bad.tail
                    else:
                        parent.text = (parent.text or "") + bad.tail
                parent.remove(bad)
        self.tree = self.root.getroottree()
        self.order = {el: index for index, el in enumerate(self.root.iter())}
        self.claimed: set = set()
        self.regions: list[StructuredRegion] = []
        self.fields: list[FieldCandidate] = []
        self.tables: list[TableCandidate] = []
        # (level, text, scope): a heading governs only the content of its
        # nearest sectioning ancestor (None = the whole document).
        self.heading_stack: list[tuple[int, str, object]] = []
        self.table_index = 0
        self.counts: dict[str, int] = {}

    # --- helpers ---------------------------------------------------------

    def _id(self, kind: str) -> str:
        self.counts[kind] = self.counts.get(kind, 0) + 1
        return f"html:{kind}:{self.counts[kind]}"

    def _locator(self, el, **extra) -> SourceLocator:
        return SourceLocator(
            dom_path=self.tree.getpath(el),
            element_id=el.get("id"),
            section_path=self._section_path(el),
            document_order=self.order.get(el),
            **extra,
        )

    def _section_path(self, el) -> list[str]:
        ancestors = set(el.iterancestors())
        return [text for _, text, scope in self.heading_stack if scope is None or scope in ancestors]

    def _claim(self, el) -> None:
        self.claimed.add(el)
        for child in el.iterdescendants():
            self.claimed.add(child)

    def _region(self, kind: str, el, text: str, **meta) -> StructuredRegion:
        region = StructuredRegion(
            region_id=self._id(kind.lower()),
            region_type=kind,  # type: ignore[arg-type]
            text=text if kind != "NARRATIVE" else text[:_NARRATIVE_LIMIT],
            normalized_text=normalize_space(text).lower()[:600],
            source_locator=self._locator(el),
            extraction_method="dom",
            structural_metadata={"tag": _tag(el), **meta},
        )
        self.regions.append(region)
        return region

    def _field(self, label_el, value_el, label_raw: str, value_raw: str, relation: str) -> None:
        label_text = normalize_space(strip_label_separator(label_raw))
        reasons = [r for r in (label_rejection(label_text), value_rejection(value_raw)) if r]
        anchor = value_el if value_el is not None else label_el
        quality_score, quality_flags = candidate_quality(label_text, value_raw, relation)
        candidate = FieldCandidate(
            quality_score=quality_score,
            quality_flags=quality_flags,
            candidate_id=self._id("field"),
            raw_label=label_raw,
            raw_value=value_raw,
            label_text=label_text,
            value_type_hint=infer_value_type(value_raw),
            structural_relation=relation,  # type: ignore[arg-type]
            source_locator=self._locator(anchor),
            evidence_text=f"{normalize_space(label_raw)} {value_raw}".strip()
            if relation != "html_definition_list"
            else f"{label_text}\n{value_raw}",
            extraction_method="dom",
            acceptance="rejected" if reasons else "accepted",
            reasons=reasons,
            validation_hints=[] if reasons else ["label_noun_phrase_shape"],
        )
        region = self._region(
            "FORM_FIELD" if relation == "html_label_for" else "LABEL_VALUE",
            anchor,
            candidate.evidence_text,
            acceptance=candidate.acceptance,
            relation=relation,
            label_dom_path=self.tree.getpath(label_el) if label_el is not None else None,
        )
        candidate.source_region_ids.append(region.region_id)
        self.fields.append(candidate)

    # --- handlers ----------------------------------------------------------

    def _heading(self, el) -> None:
        level = _HEADINGS.get(_tag(el)) or int(el.get("aria-level") or 2)
        text = normalize_space(element_text(el))
        if not text:
            return
        ancestors = set(el.iterancestors())
        self.heading_stack = [h for h in self.heading_stack if h[2] is None or h[2] in ancestors]
        while self.heading_stack and self.heading_stack[-1][0] >= level:
            self.heading_stack.pop()
        scope = next((a for a in el.iterancestors() if _tag(a) in _SECTIONING), None)
        self.heading_stack.append((level, text, scope))
        self._region("HEADING", el, text, level=level)
        self._claim(el)

    def _table_rows(self, table):
        own = [tr for tr in table.xpath(".//tr") if tr.xpath("ancestor::table[1]")[0] is table]
        head, body, foot = [], [], []
        for tr in own:
            section = _tag(tr.getparent())
            (head if section == "thead" else foot if section == "tfoot" else body).append(tr)
        if not head and body and all(_tag(c) == "th" for c in body[0] if _tag(c) in ("td", "th")):
            head, body = [body[0]], body[1:]
        return head, body, foot

    @staticmethod
    def _cells(tr) -> list:
        expanded = []
        for cell in tr:
            if _tag(cell) not in ("td", "th"):
                continue
            span = max(1, min(int(cell.get("colspan") or 1), 20)) if str(cell.get("colspan") or "1").isdigit() else 1
            expanded.append(cell)
            expanded.extend([None] * (span - 1))
        return expanded

    def _fill_in_header(self, head: list, body: list) -> tuple[list, list, list[str]]:
        """A form's fill-in table printed without <th> cells: title rows
        spanning the table, then a row of column labels over blank lines to
        write on. The labels are its header, the titles its caption."""

        width = max([len(self._cells(tr)) for tr in head + body] or [0])

        def texts(tr) -> list[str]:
            return [_cell_text(c) for c in self._cells(tr) if c is not None]

        def title(tr) -> str | None:
            # One line of text in the first cell, the rest of the row empty.
            cells = texts(tr)
            return cells[0] if width > 1 and cells and cells[0] and not any(cells[1:]) else None

        titles: list[str] = []
        if head:
            # A <thead> holding only a title spanning the table.
            if not all(title(tr) for tr in head):
                return head, body, []
            titles = [title(tr) or "" for tr in head]
        start = 0
        while start < len(body) and title(body[start]):
            start += 1
        if start < len(body) - 1:
            labels = texts(body[start])
            rest = body[start + 1:]
            if (
                labels
                and all(t and len(t) <= 160 and not _NUMBERISH.fullmatch(t) for t in labels)
                # Below it only blanks, or the drafter's "[insert …]" notes.
                and all(not t or _PLACEHOLDER.fullmatch(t) for tr in rest for t in texts(tr))
            ):
                return [body[start]], rest, titles + [title(tr) or "" for tr in body[:start]]
        return ([], body, titles) if head and titles else (head, body, [])

    def _table(self, table) -> None:
        head, body, foot = self._table_rows(table)
        self._claim(table)
        head, body, titles = self._fill_in_header(head, body)

        # A header-less two-column table of <th>/label → <td>/value rows is
        # a key/value layout, not a data table.
        rows_cells = [[c for c in self._cells(tr) if c is not None] for tr in body + foot]
        if not head and rows_cells and all(len(r) == 2 for r in rows_cells):
            label_like = all(
                _tag(r[0]) == "th" or element_text(r[0]).rstrip().endswith(":") for r in rows_cells
            )
            if label_like:
                for label_cell, value_cell in rows_cells:
                    self._field(
                        label_cell, value_cell, element_text(label_cell),
                        element_text(value_cell), "html_table_header_cell",
                    )
                return

        index = self.table_index
        self.table_index += 1
        region_id = self._id("table")
        header_cells_el = self._cells(head[-1]) if head else []
        headers = [_cell_text(c) for c in header_cells_el]
        body_rows = body + foot
        width = max([len(headers)] + [len(self._cells(tr)) for tr in body_rows] or [0])
        if not headers:
            headers = [f"Column {i + 1}" for i in range(width)]
        headers += [""] * (width - len(headers))

        header_cells = [
            TableCell(
                row_index=-1,
                column_index=c,
                text=headers[c],
                source_locator=self._locator(el, table_index=index, row_index=-1, column_index=c)
                if el is not None
                else None,
            )
            for c, el in enumerate(header_cells_el)
        ]
        rows: list[list[TableCell]] = []
        for r, tr in enumerate(body_rows):
            cells = []
            row_id = f"{region_id}:r{r}"
            for c, cell in enumerate(self._cells(tr) + [None] * (width - len(self._cells(tr)))):
                text = _cell_text(cell)
                cell_id = f"{row_id}:c{c}"
                locator = (
                    self._locator(cell, table_index=index, row_index=r, column_index=c)
                    if cell is not None
                    else None
                )
                cells.append(
                    TableCell(row_index=r, column_index=c, text=text, source_locator=locator, region_id=cell_id)
                )
                if text:
                    self.regions.append(
                        StructuredRegion(
                            region_id=cell_id,
                            region_type="TABLE_CELL",
                            text=text,
                            normalized_text=text.lower(),
                            source_locator=locator,
                            parent_region_id=row_id,
                            extraction_method="dom",
                            structural_metadata={"row_index": r, "column_index": c},
                        )
                    )
            rows.append(cells)

        assessment = assess_table_candidate(
            headers=headers, rows=[[c.text for c in row] for row in rows]
        )
        explicit_header = bool(head) and any(h for h in headers)
        accepted = assessment.table_acceptance_status == "accepted" or (explicit_header and rows)
        caption = table.find("caption")
        caption_text = normalize_space(element_text(caption)) if caption is not None else ""
        caption_text = " — ".join([t for t in [caption_text, *titles] if t]) or None
        candidate = TableCandidate(
            candidate_id=region_id,
            region_id=region_id,
            source_locator=self._locator(table, table_index=index),
            detection_method="html_dom",
            extraction_method="dom",
            headers=headers,
            header_cells=header_cells,
            caption=caption_text,
            rows=rows,
            structure_score=round(assessment.table_structure_score, 3),
            acceptance="accepted" if accepted else "rejected",
            reasons=[] if accepted else [assessment.rejection_reason or "table_quality_gate"],
        )
        annotate_table(candidate)
        foot_start = len(body)
        for r in range(foot_start, len(body_rows)):
            if r not in candidate.total_row_indices:
                candidate.total_row_indices.append(r)
        if foot and "has_total_row" not in candidate.table_hints:
            candidate.table_hints.append("has_total_row")
        self.tables.append(candidate)
        self.regions.append(
            StructuredRegion(
                region_id=region_id,
                region_type="TABLE",
                text=caption_text or " | ".join(headers),
                normalized_text=" | ".join(headers).lower(),
                source_locator=candidate.source_locator,
                children=[f"{region_id}:r{r}" for r in range(len(rows))],
                extraction_method="dom",
                structural_metadata={"acceptance": candidate.acceptance, "rows": len(rows), "columns": width},
            )
        )

    def _definition_list(self, dl) -> None:
        self._claim(dl)
        label_el = None
        values: list = []

        def flush():
            if label_el is not None and values:
                self._field(
                    label_el, values[0], element_text(label_el),
                    "\n".join(element_text(v) for v in values), "html_definition_list",
                )

        for child in dl.iter():
            tag = _tag(child)
            if tag == "dt":
                flush()
                label_el, values = child, []
            elif tag == "dd":
                values.append(child)
        flush()

    def _label(self, label) -> bool:
        control = None
        target = label.get("for")
        if target:
            found = self.root.xpath("//*[@id=$id]", id=target)
            control = found[0] if found else None
        if control is None:
            nested = [c for c in label.iterdescendants() if _tag(c) in _CONTROLS]
            control = nested[0] if nested else None
        if control is not None:
            value = _control_value(control)
            if _tag(control) not in _CONTROLS:
                value = element_text(control)
            label_text = normalize_space(label.text or element_text(label))
            if value:
                self._field(label, control, label_text, value, "html_label_for")
            self._claim(label)
            self.claimed.add(control)
            return True
        return False

    def _adjacent_pair(self, el) -> bool:
        """<div><span>Label</span><span>Value</span></div> — a container
        whose only content is one label-shaped element and one value."""

        children = [c for c in el if _tag(c) and _tag(c) not in _DROP]
        if len(children) != 2 or normalize_space(el.text or "") or any(
            normalize_space(c.tail or "") for c in children
        ):
            return False
        first, second = children
        if any(_tag(d) in ("table", "ul", "ol", "dl") for c in children for d in c.iter()):
            return False
        # <h1>Org</h1><address>…</address> is a titled contact block (a
        # letterhead), not "Org: address" — keep the heading and the block.
        if _tag(first) == "h1" or _tag(second) == "address":
            return False
        label_raw = element_text(first)
        value_raw = element_text(second)
        if not label_raw or not value_raw or "\n" in label_raw:
            return False
        if label_rejection(strip_label_separator(label_raw)) is not None:
            return False
        if value_rejection(value_raw) is not None:
            return False
        self._field(first, second, label_raw, value_raw, "html_adjacent_elements")
        self._claim(el)
        return True

    def _inline_pair(self, el) -> bool:
        """<p><b>Label:</b> value</p> or a leaf "Label: value"."""

        text = element_text(el)
        if not text or len(text) > 260 or "\n" in text.strip():
            return False
        children = [c for c in el if _tag(c)]
        if any(_tag(c) in _BLOCK for c in children):
            return False
        match = _INLINE_SEP.match(text)
        if not match:
            return False
        label_el = children[0] if children and _tag(children[0]) in _EMPHASIS else el
        self._field(label_el, el, match.group("label") + ":", match.group("value"), "html_inline_separator")
        self._claim(el)
        return True

    # --- walk ------------------------------------------------------------------

    def extract(self) -> None:
        body = self.root.find("body")
        root = body if body is not None else self.root
        for el in root.iter():
            tag = _tag(el)
            if not tag or el in self.claimed or tag in _DROP:
                continue
            if tag in _HEADINGS or el.get("role") == "heading":
                self._heading(el)
            elif tag == "table":
                self._table(el)
            elif tag == "dl":
                self._definition_list(el)
            elif tag == "label":
                if not self._label(el) and el.getparent() is not None:
                    self._adjacent_pair(el.getparent())
            elif tag == "address":
                text = element_text(el)
                if text:
                    self._region("CONTACT_BLOCK", el, text)
                self._claim(el)
            elif tag in ("section", "article", "fieldset", "form", "main", "aside"):
                legend = el.find("legend")
                title = (
                    el.get("aria-label")
                    or (normalize_space(element_text(legend)) if legend is not None else None)
                    or next(
                        (normalize_space(element_text(h)) for h in el.iter() if _tag(h) in _HEADINGS),
                        tag,
                    )
                )
                self._region("SECTION", el, title)
            elif tag in ("div", "li", "p", "span", "td", "header", "footer"):
                labels = [c for c in el if _tag(c) == "label"]
                if labels and all(self._label(label) for label in labels):
                    self._claim(el)
                    continue
                if self._adjacent_pair(el) or self._inline_pair(el):
                    continue
                if tag == "li":
                    text = element_text(el)
                    if text:
                        self._region("LIST_ITEM", el, text)
                    self._claim(el)
                elif tag == "p" or (tag == "div" and not any(_tag(c) in _BLOCK for c in el)):
                    text = element_text(el)
                    if text:
                        words = len(text.split())
                        self._region("NARRATIVE" if words >= 25 else "PARAGRAPH", el, text, words=words)
                    self._claim(el)


def readable_dom_text(raw: bytes) -> tuple[str, list[dict]]:
    """Secondary transcription for HTML: readable text derived from the DOM
    (headings, paragraphs, list bullets, table rows as "a | b | c") plus the
    tables in the page-table shape the rest of ingestion stores."""

    extractor = HtmlStructureExtractor(raw)
    root = extractor.root.find("body")
    if root is None:
        root = extractor.root
    lines: list[str] = []
    tables: list[dict] = []

    def walk(el):
        tag = _tag(el)
        if not tag or tag in _DROP:
            return
        if tag in _HEADINGS:
            lines.extend(["", normalize_space(element_text(el)), ""])
            return
        if tag == "table":
            rows = []
            for tr in el.xpath(".//tr"):
                cells = [normalize_space(element_text(c)) for c in tr if _tag(c) in ("td", "th")]
                if any(cells):
                    rows.append(cells)
                    lines.append(" | ".join(cells))
            if rows:
                headers = rows[0]
                tables.append(
                    {
                        "headers": headers,
                        "rows": [dict(zip(headers, row)) for row in rows[1:]],
                    }
                )
            lines.append("")
            return
        if tag == "li":
            lines.append(f"• {normalize_space(element_text(el))}")
            return
        if tag in _CONTROLS:
            value = _control_value(el)
            if value:
                lines.append(value)
            return
        if tag in ("p", "address", "pre", "dt", "dd", "label", "blockquote") or (
            tag == "div" and not any(_tag(c) in _BLOCK for c in el)
        ):
            text = element_text(el)
            if text:
                lines.append(text)
            return
        for child in el:
            walk(child)

    walk(root)
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
    return text, tables


def extract_html_structure(raw: bytes) -> HtmlStructureExtractor:
    extractor = HtmlStructureExtractor(raw)
    extractor.extract()
    return extractor


__all__ = ["extract_html_structure", "readable_dom_text", "element_text", "etree"]
