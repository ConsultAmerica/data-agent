"""MuPDF's page OCR, run in a worker process.

PyMuPDF holds the GIL for the whole of get_textpage_ocr(), which runs
Tesseract inside the calling process. In the server that froze every other
thread for as long as a page took to read — seconds on a desktop, minutes on
a small host — so the job heartbeat and /health stopped answering and the
host restarted the service mid-job ("Interrupted by a server restart").

Here the same call runs in a child process: identical text and positions,
while the server keeps answering. A page that overruns its time limit has
its worker killed (a thread could only be abandoned, still holding the
GIL), and a page that exhausts memory takes down the worker, not the server.

This module imports only fitz, so starting a worker is cheap.
"""

from __future__ import annotations

import multiprocessing
import sys
import threading
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeoutError
from concurrent.futures.process import BrokenProcessPool

import fitz

OcrResult = tuple[str, list[tuple], list[tuple]]


class OcrWorkerError(Exception):
    """The OCR worker died (for example, killed for running out of memory)."""


def _ocr_page(pdf_bytes: bytes, language: str, dpi: int, tessdata: str | None) -> OcrResult:
    """In the worker: OCR the one page of pdf_bytes; its text (sorted),
    blocks (sorted) and words, as get_text() gives them."""

    document = fitz.open("pdf", pdf_bytes)
    try:
        page = document[0]
        textpage = page.get_textpage_ocr(language=language, dpi=dpi, full=True, tessdata=tessdata)
        return (
            page.get_text("text", textpage=textpage, sort=True),
            [tuple(block) for block in page.get_text("blocks", textpage=textpage, sort=True)],
            [tuple(word) for word in page.get_text("words", textpage=textpage)],
        )
    finally:
        document.close()


def single_page_pdf(document: fitz.Document, page_index: int) -> bytes:
    """The page as a one-page PDF: copied as-is from a PDF, converted from
    an image or other format (as MuPDF would draw it)."""

    if document.is_pdf:
        single = fitz.open()
        try:
            single.insert_pdf(document, from_page=page_index, to_page=page_index)
            return single.tobytes()
        finally:
            single.close()
    return document.convert_to_pdf(from_page=page_index, to_page=page_index)


_lock = threading.Lock()
_executor: ProcessPoolExecutor | None = None
_sessions = 0


def begin() -> None:
    """Before one document's pages. The worker starts on the first page that
    needs OCR and stops at the last end(), so it holds no memory between
    jobs and one job never stops another's worker."""

    global _sessions
    with _lock:
        _sessions += 1


def end() -> None:
    """After that document's pages (always, even when they failed)."""

    global _sessions
    with _lock:
        _sessions = max(0, _sessions - 1)
        last = _sessions == 0
    if last:
        shutdown()


def _context():
    # forkserver: workers are forked from a small, clean server process, not
    # from this threaded app (forking it could copy a held lock).
    if sys.platform.startswith("linux"):
        return multiprocessing.get_context("forkserver")
    return multiprocessing.get_context("spawn")


def _worker() -> ProcessPoolExecutor:
    global _executor
    with _lock:
        if _executor is None:
            _executor = ProcessPoolExecutor(max_workers=1, mp_context=_context())
        return _executor


def shutdown(kill: bool = False) -> None:
    """Stop the worker (after a document's pages, so it holds no memory
    while idle). kill=True ends it at once, mid-page."""

    global _executor
    with _lock:
        executor, _executor = _executor, None
    if executor is None:
        return
    if kill:
        for process in list((getattr(executor, "_processes", None) or {}).values()):
            process.kill()
    executor.shutdown(wait=not kill, cancel_futures=True)


def ocr_page(
    document: fitz.Document,
    page_index: int,
    *,
    language: str,
    dpi: int,
    tessdata: str | None,
    timeout_seconds: float,
) -> OcrResult:
    """MuPDF's OCR of one page, read in the worker process. Raises
    concurrent.futures.TimeoutError past timeout_seconds (the worker is
    killed) and OcrWorkerError if the worker dies."""

    pdf_bytes = single_page_pdf(document, page_index)
    try:
        future = _worker().submit(_ocr_page, pdf_bytes, language, dpi, tessdata)
        return future.result(timeout=timeout_seconds)
    except FutureTimeoutError:
        shutdown(kill=True)
        raise
    except BrokenProcessPool as exc:
        shutdown(kill=True)
        raise OcrWorkerError("The OCR worker stopped unexpectedly (likely out of memory).") from exc
