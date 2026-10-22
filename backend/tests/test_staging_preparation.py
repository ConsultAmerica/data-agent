"""Phase C.1: source structure is built only when the resolved profile (or
an uncertain resolution) needs it; skipping never yields a blank Generic
workbook; raw table columns and continuation metadata are preserved."""

from uuid import uuid4

import fitz
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.database.session import SessionLocal
from app.main import app
from app.models.document import Document
from app.models.document_page import DocumentPage
from app.models.document_source_structure import DocumentSourceStructure
from app.models.document_staging_workbook import DocumentStagingWorkbook
from app.services.v3_orchestrator import run_and_persist_v3_extraction
from app.source_structure.models import TableCandidate, TableCell
from app.source_structure.service import (
    build_and_persist_source_structure,
    load_source_structure,
)
from app.source_structure.table_continuity import annotate_geometry, link_continuations
from app.staging import preparation, registry
from app.staging.preparation import prepare_staging, source_structure_needed
from app.staging.resolver import ProfileResolution

client = TestClient(app)

CONTRACT = registry.get_profile("contract_v3", 1)
GENERIC = registry.latest("generic_business_document")


# --- capability rules ---------------------------------------------------------


def test_required_profile_always_builds_structure():
    assert source_structure_needed(GENERIC, confident=True)[0] is True
    assert source_structure_needed(GENERIC, confident=False)[0] is True


def test_optional_profile_skips_only_when_resolution_is_confident():
    assert source_structure_needed(CONTRACT, confident=True)[0] is False
    needed, reason = source_structure_needed(CONTRACT, confident=False)
    assert needed is True
    assert "not confident" in reason


def test_profiles_declare_their_requirement_in_the_registry():
    assert CONTRACT.source_structure == "optional"
    assert GENERIC.source_structure == "required"
    assert registry.get_profile("generic_business_document", 1).source_structure == "none"


# --- orchestration --------------------------------------------------------------


def _statement_pdf() -> bytes:
    doc = fitz.open()
    page = doc.new_page(width=612, height=792)
    page.insert_text((40, 90), "Account Number:", fontsize=10)
    page.insert_text((160, 90), "ACCT-4471", fontsize=10)
    page.insert_text((40, 104), "Statement Date:", fontsize=10)
    page.insert_text((160, 104), "08/31/2026", fontsize=10)
    doc.set_metadata({"subject": str(uuid4())})
    return doc.tobytes()


def _uploaded_processed_document() -> str:
    response = client.post(
        "/api/documents/upload",
        files={"file": (f"stmt-{uuid4()}.pdf", _statement_pdf(), "application/pdf")},
    )
    assert response.status_code == 201, response.text
    document_id = response.json()["document_id"]
    assert client.post(
        f"/api/documents/{document_id}/extract-pages", json={"run_ocr": False}
    ).status_code == 200
    database = SessionLocal()
    try:
        document = database.get(Document, document_id)
        pages = list(database.scalars(select(DocumentPage).where(DocumentPage.document_id == document_id)))
        run_and_persist_v3_extraction(database=database, document=document, pages=pages)
    finally:
        database.close()
    return document_id


def _structure_row(database, document_id):
    return database.scalars(
        select(DocumentSourceStructure).where(DocumentSourceStructure.document_id == document_id)
    ).first()


def _run_prepare(document_id: str, resolution_factory, monkeypatch=None):
    database = SessionLocal()
    try:
        document = database.get(Document, document_id)
        if monkeypatch is not None:
            monkeypatch.setattr(preparation, "resolve_profile", lambda db, doc: resolution_factory())
        result = prepare_staging(database, document)
        profile_id = result.record.profile_id
        return result, _structure_row(database, document_id) is not None, profile_id
    finally:
        database.close()


def test_confident_optional_profile_skips_structure(monkeypatch):
    document_id = _uploaded_processed_document()
    result, stored, profile_id = _run_prepare(
        document_id,
        lambda: ProfileResolution(CONTRACT, "government_contract", "Government Contract", [], True),
        monkeypatch,
    )
    assert result.structure_built is False
    assert stored is False
    assert profile_id == "contract_v3"


def test_unconfident_resolution_does_not_skip_structure(monkeypatch):
    document_id = _uploaded_processed_document()
    result, stored, _ = _run_prepare(
        document_id,
        lambda: ProfileResolution(CONTRACT, "unknown", "Unknown", [], False),
        monkeypatch,
    )
    assert result.structure_built is True
    assert stored is True


def test_unchanged_document_reuses_its_stored_structure(monkeypatch):
    """Re-extracting an unchanged document skips the rebuild; a changed
    page, or an unconfident resolution, still rebuilds."""

    document_id = _uploaded_processed_document()
    builds: list[str] = []
    real_build = preparation.build_and_persist_source_structure

    def counting_build(database, document):
        builds.append(document.id)
        return real_build(database, document)

    monkeypatch.setattr(preparation, "build_and_persist_source_structure", counting_build)
    confident = lambda: ProfileResolution(GENERIC, "generic_business", "Generic", [], True)  # noqa: E731

    first, _, _ = _run_prepare(document_id, confident, monkeypatch)
    second, _, _ = _run_prepare(document_id, confident, monkeypatch)
    assert len(builds) == 1
    assert first.structure_built and second.structure_built
    assert "stored structure is current" in second.structure_reason

    database = SessionLocal()
    try:
        page = database.scalars(select(DocumentPage).where(DocumentPage.document_id == document_id)).first()
        page.ocr_layout_json = {"changed": str(uuid4())}
        database.commit()
    finally:
        database.close()
    _run_prepare(document_id, confident, monkeypatch)
    assert len(builds) == 2

    _run_prepare(document_id, lambda: ProfileResolution(GENERIC, "unknown", "Unknown", [], False), monkeypatch)
    assert len(builds) == 3


def test_real_resolution_of_generic_document_builds_structure():
    document_id = _uploaded_processed_document()
    result, stored, profile_id = _run_prepare(document_id, None)
    assert profile_id == "generic_business_document"
    assert result.structure_built is True and stored is True


def test_skipped_structure_never_blanks_a_generic_workbook(monkeypatch):
    document_id = _uploaded_processed_document()
    # Structure skipped at extraction time…
    _run_prepare(
        document_id,
        lambda: ProfileResolution(CONTRACT, "government_contract", "Government Contract", [], True),
        monkeypatch,
    )
    # …then the document ends up rendered by the Generic profile.
    database = SessionLocal()
    try:
        record = database.scalars(
            select(DocumentStagingWorkbook).where(DocumentStagingWorkbook.document_id == document_id)
        ).first()
        record.profile_id, record.profile_version = GENERIC.profile_id, GENERIC.profile_version
        database.commit()
    finally:
        database.close()

    workbook = client.get(f"/api/documents/{document_id}/staging-workbook").json()
    keys = next(d for d in workbook["datasets"] if d["dataset_id"] == "key_fields")["records"]
    names = {r["cells"]["document.field.name"]["value"] for r in keys}
    assert {"Account Number", "Statement Date"} <= names
    assert workbook["outcome"]["status"] in ("populated", "needs_review")


# --- raw columns and continuation metadata ----------------------------------------


def _table(candidate_id: str, page: int, top: float, bottom: float, headers: list[str] | None):
    width = 3
    return TableCandidate(
        candidate_id=candidate_id,
        region_id=candidate_id,
        page=page,
        bbox=(40.0, top, 560.0, bottom),
        detection_method="pdf_column_alignment",
        headers=headers or [f"Column {i + 1}" for i in range(width)],
        header_cells=[TableCell(row_index=-1, column_index=i, text=h) for i, h in enumerate(headers)] if headers else [],
        rows=[[TableCell(row_index=0, column_index=i, text=str(i)) for i in range(width)]],
    )


def test_continuation_is_hinted_but_never_merged():
    first = _table("p1:table:1", 1, 500, 760, ["Item", "Description", "Amount"])
    headerless = _table("p2:table:1", 2, 60, 300, None)
    repeated = _table("p3:table:1", 3, 70, 400, ["Item", "Description", "Amount"])
    unrelated = _table("p4:table:1", 4, 50, 200, ["Date", "Note", "Amount"])
    for table in (first, headerless, repeated, unrelated):
        annotate_geometry(table, 792)
    headerless.bbox = (40.0, 60.0, 560.0, 770.0)
    annotate_geometry(headerless, 792)
    repeated.bbox = (40.0, 70.0, 560.0, 700.0)
    annotate_geometry(repeated, 792)
    link_continuations([first, headerless, repeated, unrelated])

    assert first.continuation.next_candidate_id == "p2:table:1"
    assert headerless.continuation.previous_candidate_id == "p1:table:1"
    assert headerless.continuation.next_candidate_id == "p3:table:1"
    assert "repeated_header_on_next_page" in headerless.continuation.hint_reasons[-1]
    # A different header signature is not a continuation.
    assert unrelated.continuation.previous_candidate_id is None
    # Still four separate tables.
    assert len({t.candidate_id for t in (first, headerless, repeated, unrelated)}) == 4


def test_continuation_metadata_survives_persistence():
    doc = fitz.open()
    for page_number in range(2):
        page = doc.new_page(width=612, height=792)
        top = 600 if page_number == 0 else 60
        if page_number == 0:
            for x, h in zip((40, 120, 420), ("Item", "Description", "Amount")):
                page.insert_text((x, top), h, fontsize=10, fontname="hebo")
        for r in range(4):
            y = top + 18 * (r + 1)
            page.insert_text((40, y), str(page_number * 4 + r + 1), fontsize=10)
            page.insert_text((120, y), f"Service line {page_number * 4 + r + 1}", fontsize=10)
            page.insert_text((420, y), f"{(r + 1) * 10}.00", fontsize=10)
    doc.set_metadata({"subject": str(uuid4())})
    response = client.post(
        "/api/documents/upload",
        files={"file": (f"lines-{uuid4()}.pdf", doc.tobytes(), "application/pdf")},
    )
    document_id = response.json()["document_id"]
    client.post(f"/api/documents/{document_id}/extract-pages", json={"run_ocr": False})

    database = SessionLocal()
    try:
        build_and_persist_source_structure(database, database.get(Document, document_id))
        stored = load_source_structure(database, document_id)
    finally:
        database.close()
    tables = sorted(
        (t for t in stored.table_candidates if t.acceptance == "accepted"), key=lambda t: t.page
    )
    assert len(tables) == 2  # page-local tables, not merged
    first, second = tables
    assert first.continuation.header_signature == "item|description|amount"
    assert first.continuation.ends_near_page_bottom is True
    assert first.continuation.next_candidate_id == second.candidate_id
    assert second.continuation.previous_candidate_id == first.candidate_id
    assert second.continuation.header_signature == "columns:3"
