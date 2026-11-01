"""File verification: what the stored file is, before anything is read
from it.

Upload already refuses files of an unsupported type, with a wrong
signature, empty, oversized, password-protected or corrupt
(app/services/security_validation.py, pdf_validation.py). This checks the
stored copy again and records what extraction needs to know: digital,
scanned or mixed pages, a text layer, fillable form fields, rotated pages
and duplicates of the same file. After OCR it adds how readable the
scanned pages turned out.

Each check: {code, label, status: passed | warning | failed | info, detail}.
A file verifies when no check failed.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path, PurePath
from typing import Any

from app.models.document import Document
from app.models.document_page import DocumentPage
from app.source_structure.form_geometry import _CHOICE_KINDS, FormBox, box_label

VERSION = 1
# A page with fewer characters than this and an image is a scan.
_SCANNED_CHARS = 20
# Mean OCR word confidence (0-1) below which a page is hard to read.
_LOW_OCR_CONFIDENCE = 0.6

_SIGNATURES: dict[str, tuple[bytes, ...]] = {
    ".pdf": (b"%PDF-",),
    ".png": (b"\x89PNG\r\n\x1a\n",),
    ".jpg": (b"\xff\xd8\xff",),
    ".jpeg": (b"\xff\xd8\xff",),
    ".gif": (b"GIF87a", b"GIF89a"),
    ".tif": (b"II*\x00", b"MM\x00*"),
    ".tiff": (b"II*\x00", b"MM\x00*"),
    ".bmp": (b"BM",),
    ".webp": (b"RIFF",),
    ".docx": (b"PK\x03\x04",),
    ".xlsx": (b"PK\x03\x04",),
    ".pptx": (b"PK\x03\x04",),
    ".odt": (b"PK\x03\x04",),
    ".ods": (b"PK\x03\x04",),
    ".doc": (b"\xd0\xcf\x11\xe0",),
    ".xls": (b"\xd0\xcf\x11\xe0",),
    ".ppt": (b"\xd0\xcf\x11\xe0",),
    ".rtf": (b"{\\rtf",),
}
_TEXT_FORMATS = {".txt", ".csv", ".tsv", ".json", ".xml", ".html", ".htm", ".md"}
# A box counts as filled as the structure reader counts it
# (pdf_structure._form_widget_candidates).
_UNFILLED = {"", "off", "false"}
_RASTER = {".png", ".jpg", ".jpeg", ".gif", ".tif", ".tiff", ".bmp", ".webp"}


def _check(code: str, label: str, status: str, detail: str = "", **extra: Any) -> dict[str, Any]:
    return {"code": code, "label": label, "status": status, "detail": detail, **extra}


def _size(size: int) -> str:
    if size >= 1024 * 1024:
        return f"{size / (1024 * 1024):.1f} MB"
    return f"{max(1, round(size / 1024))} KB"


def _signature(path: Path, suffix: str) -> dict[str, Any]:
    with path.open("rb") as handle:
        head = handle.read(4096)
    expected = _SIGNATURES.get(suffix)
    if expected is not None:
        if any(head.startswith(sig) for sig in expected):
            return _check("signature", "File type and signature", "passed", f"{suffix[1:].upper()} signature matches")
        return _check("signature", "File type and signature", "failed",
                      f"The file's content isn't a {suffix[1:].upper()} file")
    if suffix in _TEXT_FORMATS:
        try:
            head.decode("utf-8")
        except UnicodeDecodeError as exc:
            if exc.start >= len(head) - 4:
                return _check("signature", "File type and signature", "passed", f"{suffix[1:].upper()} text")
            return _check("signature", "File type and signature", "warning", "The text isn't UTF-8; read with a fallback encoding")
        return _check("signature", "File type and signature", "passed", f"{suffix[1:].upper()} text")
    return _check("signature", "File type and signature", "info", "Checked at upload")


def form_boxes_of(pdf) -> list[dict[str, Any]]:
    """Every form box of an open PDF, filled or not: page, name, label,
    kind, value, rect, its state (a choice box) and whether it's filled."""

    boxes = []
    for page in pdf:
        for widget in page.widgets() or []:
            on = None
            if widget.field_type_string in _CHOICE_KINDS:
                try:
                    on = str(widget.on_state())
                except Exception:  # noqa: BLE001 - a box without an "on" appearance
                    on = None
            rect = widget.rect
            box = FormBox(
                name=widget.field_name or "", label=box_label(widget), kind=widget.field_type_string,
                value=str(widget.field_value or ""), on_state=on, rect=(rect.x0, rect.y0, rect.x1, rect.y1),
            )
            boxes.append({
                "page": page.number + 1, "name": box.name, "label": box.label, "kind": box.kind,
                "value": box.value, "rect": box.rect, "state": box.state,
                "filled": box.value.strip().lower() not in _UNFILLED,
            })
    return boxes


def read_form_boxes(path: str | Path | None) -> list[dict[str, Any]] | None:
    """form_boxes_of a file; None when it can't be read."""

    if not path:
        return None
    try:
        import fitz

        with fitz.open(path) as pdf:
            return form_boxes_of(pdf)
    except Exception:  # noqa: BLE001 - reported as not measured
        return None


def _pdf_checks(path: Path, document: Document) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    import fitz

    from app.core.config import get_settings

    checks: list[dict[str, Any]] = []
    facts: dict[str, Any] = {}
    try:
        pdf = fitz.open(path)
    except Exception as exc:  # noqa: BLE001 - reported
        return [_check("integrity", "File opens", "failed", f"The file is corrupt or incomplete: {exc}")], facts
    with pdf:
        if pdf.needs_pass:
            checks.append(_check("password", "Not password-protected", "failed",
                                 "The PDF is password-protected: remove the password and upload it again"))
            return checks, facts
        checks.append(_check("password", "Not password-protected", "info" if pdf.is_encrypted else "passed",
                             "Encrypted without an open password (permissions only)" if pdf.is_encrypted else ""))
        pages = pdf.page_count
        limit = get_settings().max_pdf_pages
        if pages == 0:
            checks.append(_check("pages", "Page count", "failed", "The PDF has no pages"))
            return checks, facts
        checks.append(_check("pages", "Page count", "passed" if pages <= limit else "failed",
                             f"{pages} page{'s' if pages != 1 else ''}" + (f" (limit {limit})" if pages > limit else "")))
        text_pages, scanned, blank, rotated, damaged = 0, [], [], [], []
        for page in pdf:
            number = page.number + 1
            try:
                chars = len(page.get_text("text").strip())
                images = len(page.get_images(full=False))
            except Exception:  # noqa: BLE001 - a page that can't be read
                damaged.append(number)
                continue
            if chars >= _SCANNED_CHARS:
                text_pages += 1
            elif images:
                scanned.append(number)
            else:
                blank.append(number)
            if page.rotation:
                rotated.append(number)
        boxes = form_boxes_of(pdf)
        widgets, filled = len(boxes), sum(1 for b in boxes if b["filled"])
        if damaged:
            checks.append(_check("integrity", "File opens", "warning",
                                 f"{len(damaged)} page(s) couldn't be read: {', '.join(map(str, damaged[:10]))}", pages=damaged))
        else:
            checks.append(_check("integrity", "File opens", "passed", "Every page opens"))
        content = "digital" if not scanned else "scanned" if not text_pages else "mixed"
        facts.update(content=content, text_pages=text_pages, scanned_pages=scanned, blank_pages=blank,
                     rotated_pages=rotated, form_boxes=widgets, filled_form_boxes=filled, pages=pages)
        checks.append(_check(
            "text_layer", "Text layer", "passed" if content == "digital" else "info",
            {"digital": f"Digital: every page with content has a text layer ({text_pages} pages)",
             "scanned": f"Scanned: {len(scanned)} page(s) are images and need OCR",
             "mixed": f"Mixed: {text_pages} digital page(s), {len(scanned)} scanned page(s) need OCR"}[content],
        ))
        if blank:
            checks.append(_check("blank_pages", "Blank pages", "info", f"{len(blank)} page(s) hold no text or image",
                                 pages=blank[:50]))
        if widgets:
            checks.append(_check("form_fields", "Fillable form fields", "info",
                                 f"{widgets} form box(es), {filled} filled: read from the form, not the page text"))
        if rotated:
            checks.append(_check("rotation", "Page orientation", "info",
                                 f"{len(rotated)} page(s) are rotated; they're read as displayed", pages=rotated[:50]))
        if document.page_count and document.page_count != pages:
            checks.append(_check("page_count_match", "Page count matches upload", "warning",
                                 f"Upload recorded {document.page_count} pages; the stored file has {pages}"))
    return checks, facts


def _image_checks(path: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    import fitz

    try:
        with fitz.open(path) as image:
            page = image[0]
            width, height = page.rect.width, page.rect.height
    except Exception as exc:  # noqa: BLE001 - reported
        return [_check("integrity", "File opens", "failed", f"The image is corrupt or incomplete: {exc}")], {}
    checks = [
        _check("integrity", "File opens", "passed", f"{int(width)} × {int(height)}"),
        _check("text_layer", "Text layer", "info", "Image: the text is read by OCR"),
    ]
    if min(width, height) < 600:
        checks.append(_check("resolution", "Image resolution", "warning",
                             f"{int(width)} × {int(height)} is small: text may be hard to read"))
    return checks, {"content": "scanned", "pages": 1}


def verify_stored_file(document: Document, path: Path | None) -> dict[str, Any]:
    """The checks that depend only on the file's bytes (cached per file)."""

    suffix = PurePath(document.original_filename or document.stored_filename or "").suffix.lower()
    checks = [_check("size", "File size", "passed" if document.size_bytes else "failed",
                     _size(document.size_bytes) if document.size_bytes else "The file is empty")]
    facts: dict[str, Any] = {}
    if path is None or not path.exists():
        checks.append(_check("stored_copy", "Stored file available", "warning",
                             "The stored file isn't available here; it was checked at upload"))
        return _verified(document, checks, facts)
    checks.append(_signature(path, suffix))
    if suffix == ".pdf":
        more, facts = _pdf_checks(path, document)
        checks += more
    elif suffix in _RASTER:
        more, facts = _image_checks(path)
        checks += more
    else:
        facts = {"content": "digital", "pages": document.page_count}
    return _verified(document, checks, facts)


def _verified(document: Document, checks: list[dict[str, Any]], facts: dict[str, Any]) -> dict[str, Any]:
    return {"version": VERSION, "checksum": document.checksum_sha256, "checks": checks, "facts": facts,
            "checked_at": datetime.now(timezone.utc).isoformat()}


def readability_check(pages: list[DocumentPage]) -> dict[str, Any] | None:
    """After OCR: scanned pages OCR couldn't read or read poorly."""

    ocr_pages = [p for p in pages if p.requires_ocr or p.is_scanned]
    if not ocr_pages:
        return None
    failed = [p.page_number for p in ocr_pages if not p.ocr_succeeded and not (p.final_text or "").strip()]
    low = []
    for p in ocr_pages:
        confidence = (p.ocr_layout_json or {}).get("mean_word_confidence") if isinstance(p.ocr_layout_json, dict) else None
        if confidence is not None:
            confidence = confidence / 100 if confidence > 1 else confidence
            if confidence < _LOW_OCR_CONFIDENCE:
                low.append(p.page_number)
    if failed:
        return _check("readability", "Scanned pages readable", "warning",
                      f"{len(failed)} scanned page(s) have no readable text yet: {', '.join(map(str, failed[:10]))}",
                      pages=failed[:50])
    if low:
        return _check("readability", "Scanned pages readable", "warning",
                      f"{len(low)} page(s) were read with low OCR confidence: check their values", pages=low[:50])
    return _check("readability", "Scanned pages readable", "passed", f"{len(ocr_pages)} scanned page(s) read by OCR")


def duplicate_check(document: Document, duplicates: list[Document]) -> dict[str, Any]:
    if not duplicates:
        return _check("duplicate", "Not a duplicate upload", "passed")
    names = ", ".join(sorted({d.original_filename for d in duplicates})[:3])
    return _check("duplicate", "Not a duplicate upload", "warning",
                  f"The same file was uploaded before ({names}): its values may be extracted twice",
                  documents=[{"id": d.id, "name": d.original_filename} for d in duplicates[:10]])


def file_status(checks: list[dict[str, Any]]) -> str:
    statuses = {c["status"] for c in checks}
    return "failed" if "failed" in statuses else "warning" if "warning" in statuses else "verified"
