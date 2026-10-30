import logging
import os
import time
from concurrent.futures import ProcessPoolExecutor
from uuid import uuid4

import pdfplumber

from app.core.observability import log_event
from app.services.table_quality import is_accepted_table

logger = logging.getLogger(__name__)


def clean_cell(
    value: object,
) -> str:

    if value is None:
        return ""

    return " ".join(
        str(value)
        .replace("\n", " ")
        .split()
    )


def make_unique_headers(
    raw_headers: list[object],
) -> list[str]:

    used: dict[str, int] = {}
    headers: list[str] = []

    for index, value in enumerate(
        raw_headers
    ):

        base = clean_cell(value)

        if not base:
            base = f"Column {index + 1}"

        count = used.get(base, 0) + 1

        used[base] = count

        if count > 1:
            base = f"{base} ({count})"

        headers.append(base)

    return headers


# Below this many ruled edges each way a page can't hold a lattice table:
# pdfplumber's default ("lines") strategy builds cells only from drawn
# horizontal and vertical edges, so it would find nothing there.
_MIN_RULED_EDGES = 2
_STRAIGHT = 1.0  # points of slant still counted as horizontal / vertical


def page_may_have_ruled_table(fitz_page) -> bool:
    """Cheap PyMuPDF check (milliseconds) before the slow pdfplumber pass:
    does the page draw at least two horizontal and two vertical edges?"""

    horizontal = vertical = 0
    for path in fitz_page.get_drawings():
        for item in path.get("items", ()):
            kind = item[0]
            if kind == "re":
                rect = item[1]
                if rect.width >= 3:
                    horizontal += 2
                if rect.height >= 3:
                    vertical += 2
            elif kind == "qu":
                horizontal += 2
                vertical += 2
            elif kind == "l":
                start, end = item[1], item[2]
                if abs(start.y - end.y) <= _STRAIGHT and abs(start.x - end.x) >= 3:
                    horizontal += 1
                elif abs(start.x - end.x) <= _STRAIGHT and abs(start.y - end.y) >= 3:
                    vertical += 1
            if horizontal >= _MIN_RULED_EDGES and vertical >= _MIN_RULED_EDGES:
                return True
    return False


class PageTableExtractor:
    """Tables page by page from one open PDF.

    Opening the file per page made pdfplumber re-read every page's object
    tree for every page — quadratic in the page count, minutes on a
    300-page contract. The document is opened once (lazily: pages with no
    ruled grid never need it) and each page's parse cache is dropped after
    use so memory stays flat."""

    def __init__(self, pdf_path):
        self.pdf_path = pdf_path
        self._pdf = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def close(self) -> None:
        if self._pdf is not None:
            self._pdf.close()
            self._pdf = None

    def page_tables(self, page_number: int, fitz_page=None) -> list[dict]:
        if fitz_page is not None and not page_may_have_ruled_table(fitz_page):
            return []
        if self._pdf is None:
            self._pdf = pdfplumber.open(self.pdf_path)
        if page_number < 1 or page_number > len(self._pdf.pages):
            return []
        page = self._pdf.pages[page_number - 1]
        try:
            return _tables_from_page(page)
        finally:
            page.close()


# Large documents read their tables in parallel worker processes before
# the page loop (pdfplumber is pure Python, so threads wouldn't help).
PARALLEL_MIN_PAGES = 24
MAX_TABLE_WORKERS = 6
# Measured on a 288-page contract: each worker adds ~70 MB; the main
# process and web server need the rest. Six workers peaked at 532 MB —
# over a 512 MB instance on their own.
WORKER_MEMORY_MB = 80
RESERVED_MEMORY_MB = 400


def _read_text(path: str) -> str | None:
    try:
        with open(path, encoding="ascii") as handle:
            return handle.read().strip()
    except OSError:
        return None


def container_memory_limit_mb() -> int | None:
    """The cgroup memory limit (v2, then v1); None when unlimited/unknown."""

    for path in ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
        value = _read_text(path)
        if value and value.isdigit() and int(value) < 1 << 60:
            return int(value) // (1024 * 1024)
    return None


def available_cpus() -> int:
    """CPUs this process may actually use: the cgroup quota when set, else
    its affinity mask, else os.cpu_count() (which reports the host's)."""

    quota = _read_text("/sys/fs/cgroup/cpu.max")
    if quota and not quota.startswith("max"):
        limit, period = (int(part) for part in quota.split()[:2])
        if period > 0:
            return max(1, -(-limit // period))
    try:
        return len(os.sched_getaffinity(0))
    except AttributeError:  # not on Linux
        return os.cpu_count() or 1


def prefetch_worker_count() -> int:
    from app.core.config import get_settings

    configured = get_settings().table_prefetch_workers
    if configured is not None:
        return max(0, min(configured, MAX_TABLE_WORKERS))
    workers = min(MAX_TABLE_WORKERS, available_cpus() - 1)
    memory = container_memory_limit_mb()
    if memory is not None:
        workers = min(workers, (memory - RESERVED_MEMORY_MB) // WORKER_MEMORY_MB)
    return max(0, workers)


def _tables_for_pages(pdf_path, page_numbers: list[int]) -> dict[int, list[dict]]:
    """Worker: one open document for a slice of pages."""

    import fitz

    results: dict[int, list[dict]] = {}
    with fitz.open(pdf_path) as document, PageTableExtractor(pdf_path) as extractor:
        for page_number in page_numbers:
            try:
                results[page_number] = extractor.page_tables(page_number, document[page_number - 1])
            except Exception:  # noqa: BLE001 - a bad page yields no tables, as before
                results[page_number] = []
    return results


PREFETCH_CHUNK_PAGES = 24


class TablePrefetch:
    """Tables read ahead by worker processes while the caller works through
    the pages in order: chunks are submitted in page order, so by the time
    the caller reaches a page its chunk is usually done. `get` returns None
    when a page wasn't prefetched (small document, one CPU) or its worker
    failed — the caller then reads that page itself."""

    def __init__(self, pdf_path, page_numbers: list[int], *, chunk_pages: int = PREFETCH_CHUNK_PAGES):
        self._pool = None
        self._futures: dict = {}
        self._started = time.perf_counter()
        self._pages = len(page_numbers)
        workers = prefetch_worker_count()
        if len(page_numbers) < PARALLEL_MIN_PAGES or workers < 2:
            log_event("table_prefetch", stage="table_detection", status="skipped", pages=len(page_numbers), workers=workers)
            return
        try:
            self._pool = ProcessPoolExecutor(max_workers=workers)
            for index in range(0, len(page_numbers), chunk_pages):
                chunk = page_numbers[index:index + chunk_pages]
                future = self._pool.submit(_tables_for_pages, str(pdf_path), chunk)
                for page_number in chunk:
                    self._futures[page_number] = future
        except Exception:  # noqa: BLE001 - fall back to the sequential path
            logger.warning("Parallel table extraction could not start; reading tables page by page.", exc_info=True)
            self.close()

    def get(self, page_number: int) -> list[dict] | None:
        future = self._futures.get(page_number)
        if future is None:
            return None
        try:
            return future.result().get(page_number)
        except Exception:  # noqa: BLE001 - this page falls back to the sequential path
            logger.warning("Parallel table extraction failed for page %s.", page_number, exc_info=True)
            self._futures.pop(page_number, None)
            return None

    def close(self) -> None:
        if self._pool is not None:
            self._pool.shutdown(wait=False, cancel_futures=True)
            log_event(
                "table_prefetch", stage="table_detection", status="ok", pages=self._pages,
                duration_ms=int((time.perf_counter() - self._started) * 1000),
            )
            self._pool = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def prefetch_page_tables(pdf_path, page_numbers: list[int]) -> dict[int, list[dict]]:
    """Every listed page's tables read in parallel; {} when that isn't used."""

    with TablePrefetch(pdf_path, page_numbers) as prefetch:
        results = {number: prefetch.get(number) for number in page_numbers}
    return {} if any(value is None for value in results.values()) else results


def extract_page_tables(
    pdf_path,
    page_number: int,
) -> list[dict]:
    """One page's tables (opens the file; for many pages of one document
    use PageTableExtractor)."""

    with PageTableExtractor(pdf_path) as extractor:
        return extractor.page_tables(page_number)


def _tables_from_page(page) -> list[dict]:

    tables: list[dict] = []

    raw_tables = (
        page.extract_tables()
        or []
    )

    for raw_table in raw_tables:

        if (
            not raw_table
            or len(raw_table) < 2
        ):
            continue

        headers = make_unique_headers(
            raw_table[0]
        )

        rows: list[dict] = []

        for raw_row in raw_table[1:]:

            if not raw_row:
                continue

            values = [
                clean_cell(value)
                for value
                in raw_row
            ]

            while len(values) < len(headers):
                values.append("")

            row = {
                headers[index]:
                    values[index]

                for index in range(
                    len(headers)
                )
            }

            if any(row.values()):
                rows.append(row)

        if rows and is_accepted_table(headers=headers, rows=rows):

            tables.append(
                {
                    "table_id":
                        str(uuid4()),

                    "headers":
                        headers,

                    "rows":
                        rows,
                }
            )

    return tables
