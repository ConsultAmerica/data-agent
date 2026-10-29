"""Native parsers that feed the common DocumentPage model (no OCR)."""

from __future__ import annotations

import csv
import re
from io import StringIO
from pathlib import Path


_BOMS = (
    (b"\xef\xbb\xbf", "utf-8-sig"),
    (b"\xff\xfe\x00\x00", "utf-32"),
    (b"\x00\x00\xfe\xff", "utf-32"),
    (b"\xff\xfe", "utf-16"),
    (b"\xfe\xff", "utf-16"),
)


def decode_text_bytes(raw: bytes) -> tuple[str, str]:
    """Decode a text file of unknown encoding → (text, encoding used).

    A byte-order mark wins; then strict UTF-8; then charset-normalizer's
    guess (UTF-16 without a BOM, Shift-JIS, …); Windows-1252 last, which
    decodes any byte string."""

    for bom, encoding in _BOMS:
        if raw.startswith(bom):
            return raw.decode(encoding, errors="replace"), encoding
    try:
        return raw.decode("utf-8"), "utf-8"
    except UnicodeDecodeError:
        pass
    try:
        from charset_normalizer import from_bytes

        best = from_bytes(raw[:200_000]).best()
        if best is not None and best.encoding:
            return raw.decode(best.encoding, errors="replace"), best.encoding
    except (ImportError, LookupError):
        pass
    try:
        return raw.decode("cp1252"), "cp1252"
    except UnicodeDecodeError:
        return raw.decode("latin-1"), "latin-1"


# What decode_text_bytes returns when it knows: a byte-order mark, or bytes
# that are valid UTF-8. Anything else is charset-normalizer's guess or the
# Windows-1252 fallback, which reviewers should double-check.
_CERTAIN_ENCODINGS = frozenset({"utf-8", "utf-8-sig", "utf-16", "utf-32"})


def encoding_was_guessed(encoding: str) -> bool:
    return encoding not in _CERTAIN_ENCODINGS


def parse_plain_text(file_path: str | Path) -> dict:
    text, encoding = decode_text_bytes(Path(file_path).read_bytes())
    paragraphs = [line for line in text.splitlines() if line.strip()]
    return {
        "paragraphs": paragraphs,
        "tables": [],
        "text": text,
        "encoding": encoding,
        "encoding_guessed": encoding_was_guessed(encoding),
    }


_DELIMITERS = ",;\t|"
_DELIMITER_NAMES = {",": "comma", ";": "semicolon", "\t": "tab", "|": "pipe"}


def sniff_delimiter(sample: str, default: str = ",") -> str:
    """The delimiter that splits the sample's lines most consistently."""

    try:
        return csv.Sniffer().sniff(sample, delimiters=_DELIMITERS).delimiter
    except csv.Error:
        pass
    # The sniffer gives up on quoted multi-line samples; fall back to the
    # candidate that appears the same (non-zero) number of times per line.
    lines = [line for line in sample.splitlines()[:50] if line.strip()]
    best, best_score = default, 0
    for candidate in _DELIMITERS:
        counts = [line.count(candidate) for line in lines]
        if not counts or min(counts) == 0:
            continue
        score = sum(1 for count in counts if count == counts[0])
        if score > best_score:
            best, best_score = candidate, score
    return best


def parse_csv_file(file_path: str | Path) -> dict:
    """CSV/TSV with the encoding and delimiter detected, not assumed.

    A .tsv file is tab-separated unless its content clearly isn't."""

    path = Path(file_path)
    text, encoding = decode_text_bytes(path.read_bytes())
    default = "\t" if path.suffix.lower() == ".tsv" else ","
    delimiter = sniff_delimiter(text[:64_000], default=default)
    reader = csv.reader(StringIO(text), delimiter=delimiter)
    rows = [list(row) for row in reader]
    paragraphs = [" | ".join(cell.strip() for cell in row) for row in rows]
    tables = [rows] if rows else []
    return {
        "paragraphs": paragraphs,
        "tables": tables,
        "text": "\n".join(paragraphs),
        "encoding": encoding,
        "encoding_guessed": encoding_was_guessed(encoding),
        "delimiter": _DELIMITER_NAMES.get(delimiter, delimiter),
    }


def parse_html_file(file_path: str | Path) -> dict:
    """Readable, DOM-derived transcription (headings, paragraphs, list
    items, table rows) — see app/source_structure/html_structure.py. The
    structural candidates themselves are extracted from the DOM separately,
    never from this flattened text."""

    import uuid

    from app.source_structure.html_structure import readable_dom_text

    path = Path(file_path)
    text, tables = readable_dom_text(path.read_bytes())
    for table in tables:
        table.setdefault("table_id", str(uuid.uuid4()))
    paragraphs = [line for line in text.splitlines() if line.strip()]
    return {"paragraphs": paragraphs, "tables": tables, "text": text}


def parse_xml_file(file_path: str | Path) -> dict:
    """Readable transcription of an XML file ('Label: value' per element,
    records under their element path) — app/xml_records/parse.py."""

    from app.xml_records.parse import readable_text

    text = readable_text(Path(file_path).read_bytes())
    paragraphs = [line for line in text.splitlines() if line.strip()]
    return {"paragraphs": paragraphs, "tables": [], "text": text}


def parse_rtf_file(file_path: str | Path) -> dict:
    path = Path(file_path)
    raw = path.read_text(encoding="utf-8", errors="replace")
    # Strip common RTF control words / groups into readable text.
    text = re.sub(r"\\'[0-9a-fA-F]{2}", " ", raw)
    text = re.sub(r"\\[a-zA-Z]+-?\d* ?", " ", text)
    text = text.replace("{", " ").replace("}", " ")
    text = re.sub(r"\s+", " ", text).strip()
    paragraphs = [text] if text else []
    return {"paragraphs": paragraphs, "tables": [], "text": text}


def parse_xlsx_sheets(file_path: str | Path) -> list[dict]:
    """Return one dict per sheet: name, paragraphs, tables, text."""

    from openpyxl import load_workbook

    workbook = load_workbook(
        filename=str(file_path),
        read_only=True,
        data_only=True,
    )
    sheets: list[dict] = []

    try:
        for sheet in workbook.worksheets:
            rows: list[list[str]] = []
            for row in sheet.iter_rows(values_only=True):
                cells = [
                    "" if cell is None else str(cell).strip()
                    for cell in row
                ]
                if any(cells):
                    rows.append(cells)

            paragraphs = [" | ".join(row) for row in rows]
            sheets.append(
                {
                    "name": sheet.title,
                    "paragraphs": paragraphs,
                    "tables": [rows] if rows else [],
                    "text": "\n".join(paragraphs),
                }
            )
    finally:
        workbook.close()

    return sheets


def parse_pptx_slides(file_path: str | Path) -> list[dict]:
    from pptx import Presentation
    from pptx.enum.shapes import MSO_SHAPE_TYPE

    from app.services.embedded_image_ocr import ocr_image_bytes

    presentation = Presentation(str(file_path))
    slides: list[dict] = []

    for index, slide in enumerate(presentation.slides, start=1):
        paragraphs: list[str] = []
        ocr_snippets: list[str] = []
        for shape in slide.shapes:
            if getattr(shape, "shape_type", None) == MSO_SHAPE_TYPE.PICTURE:
                try:
                    blob = shape.image.blob
                except Exception:
                    blob = None
                if blob:
                    text = ocr_image_bytes(blob)
                    if text:
                        ocr_snippets.append(text)
                        paragraphs.append(text)
                continue

            if not getattr(shape, "has_text_frame", False):
                continue
            for paragraph in shape.text_frame.paragraphs:
                line = "".join(run.text for run in paragraph.runs).strip()
                if line:
                    paragraphs.append(line)

            # Fallback when runs are empty but text exists.
            if shape.text_frame.text.strip():
                for line in shape.text_frame.text.splitlines():
                    stripped = line.strip()
                    if stripped and stripped not in paragraphs:
                        paragraphs.append(stripped)

        text = "\n".join(paragraphs)
        slides.append(
            {
                "name": f"Slide {index}",
                "paragraphs": paragraphs,
                "tables": [],
                "text": text,
                "ocr_used": bool(ocr_snippets),
                "ocr_snippets": ocr_snippets,
            }
        )

    return slides
