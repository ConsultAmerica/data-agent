"""The boxes of a ruled form on a raster page, each read on its own.

A page-wide OCR pass reads a form's small captions poorly: on a low
resolution scan or screenshot it drops whole boxes ("d Control number",
"15 State  CA") and blurs captions into their neighbours. Cropped to one
box, Tesseract reads its caption and value far more reliably. The box's
words come back in PDF points, so the caption/value reading
(pdf_structure._raster_form_fields) treats them like any page words.

Tesseract runs as its own process (pytesseract), so the server keeps
answering while a form is read; a box that can't be read keeps the page
pass's words.
"""

from __future__ import annotations

import logging
import re

from app.source_structure.pdf_structure import Word

logger = logging.getLogger(__name__)

# Long side of the page render, in pixels: small print reaches a size
# Tesseract reads well, without the memory of a full 300 DPI poster.
_RENDER_LONG_SIDE_PX = 2400
_MAX_DPI = 400
# Pixels trimmed inside each box so its rules aren't read as "|" or "I",
# and the white gap between stacked crops (measured on a W-2 and an
# invoice line table: as accurate as one Tesseract run per box, ~8x faster).
_INSET_PX = 6
_GAP_PX = 40
_MAX_BOXES = 200
# Seconds for the page's Tesseract run, plus this much per ten boxes.
_BOX_TIMEOUT_S = 15


def read_box_words(
    fitz_page,
    boxes: list[tuple[float, float, float, float]],
    *,
    language: str,
) -> dict[int, list[Word]]:
    """Each box's words (index into `boxes` → words in PDF points). A box
    that fails or reads nothing is left out. Tesseract finds its language
    data as the page pass does (TESSDATA_PREFIX)."""

    if not boxes or len(boxes) > _MAX_BOXES:
        return {}
    try:
        import fitz
        import pytesseract
        from PIL import Image

        from app.services.embedded_image_ocr import _configure_pytesseract

        _configure_pytesseract()
        long_side = max(fitz_page.rect.width, fitz_page.rect.height) or 1.0
        dpi = max(72, min(_MAX_DPI, int(_RENDER_LONG_SIDE_PX * 72 / long_side)))
        pixmap = fitz_page.get_pixmap(dpi=dpi, colorspace=fitz.csGRAY)
        image = Image.frombytes("L", (pixmap.width, pixmap.height), pixmap.samples)
    except Exception:  # noqa: BLE001 - the page pass's words are kept
        logger.warning("Could not render a form page for box OCR", exc_info=True)
        return {}

    scale = dpi / 72.0
    # Every crop stacked into one image, a white gap between them, read by
    # one Tesseract run: it loads its language model once per page, not
    # once per box (seconds each on a small host).
    crops: list[tuple[int, int, int, int, int]] = []  # index, left, top, right, bottom
    for index, (x0, y0, x1, y1) in enumerate(boxes):
        left, top = int(x0 * scale) + _INSET_PX, int(y0 * scale) + _INSET_PX
        right, bottom = int(x1 * scale) - _INSET_PX, int(y1 * scale) - _INSET_PX
        if right - left >= 8 and bottom - top >= 8:
            crops.append((index, left, top, right, bottom))
    if not crops:
        image.close()
        return {}
    gap = _GAP_PX
    sheet = Image.new("L", (max(r - l for _, l, _, r, _ in crops) + 2 * gap, sum(b - t + gap for *_, t, _, b in crops) + gap), 255)
    placed: list[tuple[int, int, int, int, int]] = []  # index, sheet y, height, page left, page top
    y = gap
    for index, left, top, right, bottom in crops:
        sheet.paste(image.crop((left, top, right, bottom)), (gap, y))
        placed.append((index, y, bottom - top, left, top))
        y += bottom - top + gap
    image.close()
    try:
        data = pytesseract.image_to_data(
            sheet, lang=language, config=f"--psm 6 --dpi {dpi}",
            output_type=pytesseract.Output.DICT, timeout=_BOX_TIMEOUT_S + _BOX_TIMEOUT_S * len(crops) // 10,
        )
    except Exception:  # noqa: BLE001 - the page pass's words are kept
        logger.warning("Box OCR failed on a form page", exc_info=True)
        return {}
    finally:
        sheet.close()

    out: dict[int, list[Word]] = {}
    for text, conf, wl, wt, ww, wh in zip(
        data["text"], data["conf"], data["left"], data["top"], data["width"], data["height"]
    ):
        text = str(text).strip()
        if not text or re.fullmatch(r"[|_~.,'`]+", text):
            continue
        middle = wt + wh / 2
        home = next((p for p in placed if p[1] <= middle < p[1] + p[2]), None)
        if home is None:
            continue
        index, sheet_top, _, page_left, page_top = home
        wx0, wy0 = (page_left + wl - gap) / scale, (page_top + wt - sheet_top) / scale
        wx1, wy1 = wx0 + ww / scale, wy0 + wh / scale
        confidence = float(conf) / 100 if float(conf) >= 0 else None
        out.setdefault(index, []).append(Word(text, wx0, wy0, wx1, wy1, size=max(1.0, (wy1 - wy0) * 0.85), conf=confidence))
    return out
