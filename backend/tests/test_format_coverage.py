"""VNext format coverage: JSON, TSV/CSV dialects, XLSM and ODS — and ZIP / EML refused."""

from __future__ import annotations

import json
import zipfile
from io import BytesIO
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook
from sqlalchemy import select

from app.database.session import SessionLocal
from app.main import app
from app.models.document import Document
from app.models.document_page import DocumentPage
from app.parsers.data_file_parsers import (
    DataFileError,
    load_json_bytes,
    parse_json_file,
    parse_ods_sheets,
)
from app.parsers.office_text_parsers import decode_text_bytes, parse_csv_file
from app.services.security_validation import (
    SecurityValidationError,
    validate_ods_structure,
)

client = TestClient(app)


# ── builders ─────────────────────────────────────────────────────────


def make_zip(entries: dict[str, bytes], *, compression=zipfile.ZIP_DEFLATED) -> bytes:
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w", compression) as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    return buffer.getvalue()


_ODS_CONTENT ="""<?xml version="1.0" encoding="UTF-8"?>
<office:document-content
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
 <office:body><office:spreadsheet>
  <table:table table:name="Rates">
   <table:table-row>
    <table:table-cell><text:p>Item</text:p></table:table-cell>
    <table:table-cell><text:p>Amount</text:p></table:table-cell>
   </table:table-row>
   <table:table-row>
    <table:table-cell><text:p>{marker}</text:p></table:table-cell>
    <table:table-cell office:value-type="float" office:value="42"><text:p>42.00</text:p></table:table-cell>
    <table:table-cell table:number-columns-repeated="16380"/>
   </table:table-row>
   <table:table-row table:number-rows-repeated="2">
    <table:table-cell table:number-columns-repeated="2"><text:p>x</text:p></table:table-cell>
   </table:table-row>
   <table:table-row table:number-rows-repeated="1048570">
    <table:table-cell table:number-columns-repeated="1024"/>
   </table:table-row>
  </table:table>
  <table:table table:name="Notes">
   <table:table-row>
    <table:table-cell><text:p>Second sheet</text:p></table:table-cell>
   </table:table-row>
  </table:table>
 </office:spreadsheet></office:body>
</office:document-content>"""


def make_ods(marker: str = "Widget", mimetype: str = "application/vnd.oasis.opendocument.spreadsheet") -> bytes:
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(zipfile.ZipInfo("mimetype"), mimetype)
        archive.writestr("content.xml", _ODS_CONTENT.replace("{marker}", marker), zipfile.ZIP_DEFLATED)
    return buffer.getvalue()


def make_xlsx(marker: str) -> bytes:
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Budget"
    sheet.append(["Line", "Cost"])
    sheet.append([marker, 12.5])
    buffer = BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def upload(filename: str, data: bytes, content_type: str = "application/octet-stream"):
    return client.post("/api/documents/upload", files={"file": (filename, data, content_type)})


def pages_of(document_id: str) -> list[dict]:
    response = client.get(f"/api/documents/{document_id}/pages")
    assert response.status_code == 200, response.text
    return response.json()


def first_page_tables(document_id: str) -> list:
    database = SessionLocal()
    try:
        page = database.scalars(
            select(DocumentPage)
            .where(DocumentPage.document_id == str(document_id))
            .order_by(DocumentPage.page_number)
        ).first()
        return page.tables_json
    finally:
        database.close()


def stored_document(document_id: str) -> Document:
    database = SessionLocal()
    try:
        document = database.get(Document, str(document_id))
        assert document is not None
        database.expunge(document)
        return document
    finally:
        database.close()


# ── text decoding and CSV dialects ───────────────────────────────────


def test_decode_text_bytes_handles_bom_utf8_and_windows_1252() -> None:
    assert decode_text_bytes("Name\tCafé".encode("utf-16")) == ("Name\tCafé", "utf-16")
    assert decode_text_bytes("Café".encode("utf-8")) == ("Café", "utf-8")
    text, encoding = decode_text_bytes("Café crème, naïve résumé façade".encode("cp1252"))
    assert "Café" in text and encoding != "utf-8"


def test_csv_semicolon_and_quoted_delimiters(tmp_path: Path) -> None:
    path = tmp_path / "rates.csv"
    path.write_bytes('Item;Description;Amount\n0001;"Labor; senior";1.234,50\n0002;Travel;99\n'.encode("cp1252"))
    parsed = parse_csv_file(path)
    assert parsed["delimiter"] == "semicolon"
    assert parsed["tables"][0][1] == ["0001", "Labor; senior", "1.234,50"]


def test_tsv_is_tab_separated_and_keeps_leading_zeros(tmp_path: Path) -> None:
    path = tmp_path / "lines.tsv"
    path.write_text("CLIN\tAmount\n0001\t10,000.00\n0002\t5.00\n", encoding="utf-8")
    parsed = parse_csv_file(path)
    assert parsed["delimiter"] == "tab"
    assert parsed["tables"][0][1] == ["0001", "10,000.00"]


# ── JSON ─────────────────────────────────────────────────────────────


def test_json_paths_and_record_tables(tmp_path: Path) -> None:
    path = tmp_path / "invoice.json"
    path.write_text(
        json.dumps(
            {
                "invoice": {"number": "INV-7", "paid": False},
                "lines": [{"sku": "A1", "qty": 2}, {"sku": "B2", "qty": 1, "note": None}],
            }
        ),
        encoding="utf-8",
    )
    parsed = parse_json_file(path)
    assert "invoice.number: INV-7" in parsed["paragraphs"]
    assert "invoice.paid: false" in parsed["paragraphs"]
    assert "lines[1].sku: B2" in parsed["paragraphs"]
    assert parsed["tables"] == [[["sku", "qty", "note"], ["A1", "2", ""], ["B2", "1", ""]]]


def test_invalid_and_deeply_nested_json_is_refused() -> None:
    with pytest.raises(DataFileError):
        load_json_bytes(b"{not json")
    with pytest.raises(DataFileError):
        load_json_bytes(b"[" * 100_000 + b"]" * 100_000)


# ── ODS ──────────────────────────────────────────────────────────────


def test_ods_sheets_expand_content_but_not_padding(tmp_path: Path) -> None:
    path = tmp_path / "rates.ods"
    path.write_bytes(make_ods("Widget-9"))
    sheets = parse_ods_sheets(path)
    assert [sheet["name"] for sheet in sheets] == ["Rates", "Notes"]
    rows = sheets[0]["tables"][0]
    # Trailing padding (16,380 empty cells, ~1M empty rows) is not expanded;
    # repeated content is.
    assert rows == [["Item", "Amount"], ["Widget-9", "42.00"], ["x", "x"], ["x", "x"]]
    assert sheets[1]["text"] == "Second sheet"


def test_ods_structure_requires_spreadsheet_mimetype(tmp_path: Path) -> None:
    path = tmp_path / "letter.ods"
    path.write_bytes(make_ods(mimetype="application/vnd.oasis.opendocument.text"))
    with pytest.raises(SecurityValidationError):
        validate_ods_structure(path)


# ── Upload API ───────────────────────────────────────────────────────


def test_upload_json_and_reject_invalid_json() -> None:
    marker = f"INV-{uuid4().hex[:8]}"
    response = upload("invoice.json", json.dumps({"invoice": {"number": marker}}).encode(), "application/json")
    assert response.status_code == 201, response.text
    assert f"invoice.number: {marker}" in pages_of(response.json()["document_id"])[0]["final_text"]

    assert upload("broken.json", b'{"a": ', "application/json").status_code == 400


def test_source_json_returns_the_parsed_file_for_json_documents_only() -> None:
    marker = uuid4().hex[:8]
    payload = {"invoice": {"number": marker, "lines": [{"sku": "A1"}]}}
    document_id = upload("tree.json", json.dumps(payload).encode(), "application/json").json()["document_id"]
    response = client.get(f"/api/documents/{document_id}/source-json")
    assert response.status_code == 200, response.text
    assert response.json() == {"data": payload}

    csv_id = upload("plain.csv", f"a,{marker}\n".encode(), "text/csv").json()["document_id"]
    assert client.get(f"/api/documents/{csv_id}/source-json").status_code == 422
    assert client.get(f"/api/documents/{uuid4()}/source-json").status_code == 404


def test_upload_tsv_and_semicolon_csv_record_dialect() -> None:
    marker = uuid4().hex[:8]
    response = upload("lines.tsv", f"CLIN\tItem\n0001\t{marker}\n".encode(), "text/tab-separated-values")
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["ingestion_provenance"]["delimiter"] == "tab"
    assert first_page_tables(body["document_id"])[0][1] == ["0001", marker]

    response = upload("rates.csv", f"Name;City\n{marker};Zürich\n".encode("cp1252"), "text/csv")
    assert response.status_code == 201, response.text
    provenance = response.json()["ingestion_provenance"]
    assert provenance["delimiter"] == "semicolon"
    assert provenance["encoding"] != "utf-8"
    # Not UTF-8 and no byte-order mark: flagged for the reviewer.
    assert provenance["encoding_guessed"] is True
    assert body["ingestion_provenance"]["encoding_guessed"] is False
    assert "Zürich" in pages_of(response.json()["document_id"])[0]["final_text"]


def test_upload_xlsm_and_ods() -> None:
    marker = f"Macro-{uuid4().hex[:8]}"
    response = upload("budget.xlsm", make_xlsx(marker), "application/vnd.ms-excel.sheet.macroEnabled.12")
    assert response.status_code == 201, response.text
    assert marker in pages_of(response.json()["document_id"])[0]["final_text"]

    marker = f"Ods-{uuid4().hex[:8]}"
    response = upload("rates.ods", make_ods(marker), "application/vnd.oasis.opendocument.spreadsheet")
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["page_count"] == 2
    pages = pages_of(body["document_id"])
    assert [page["page_label"] for page in pages] == ["Rates", "Notes"]
    assert marker in pages[0]["final_text"]

    assert upload("fake.ods", make_zip({"content.xml": b"<x/>"}), "application/zip").status_code == 400




# ── ZIP and EML are not accepted (Increment 6B.0) ────────────────────


def make_eml(subject: str = "Award") -> bytes:
    return (
        "From: Contracting Officer <co@agency.example>\r\n"
        "To: vendor@example.com\r\n"
        f"Subject: {subject}\r\n"
        "Message-ID: <1@agency.example>\r\n"
        "MIME-Version: 1.0\r\n"
        "Content-Type: text/plain\r\n\r\n"
        "Please review the attached award.\r\n"
    ).encode()


@pytest.mark.parametrize(
    "filename, data, mime, says",
    [
        ("batch.zip", make_zip({"a.csv": b"a,b\n"}), "application/zip", "ZIP archives aren't supported"),
        ("award.eml", make_eml(), "message/rfc822", "Email (.eml) files aren't supported"),
        ("award.msg", b"\xd0\xcf\x11\xe0msg", "application/vnd.ms-outlook", "Email (.msg) files aren't supported"),
    ],
)
def test_zip_and_email_uploads_are_refused(filename, data, mime, says) -> None:
    response = upload(filename, data, mime)
    assert response.status_code == 400
    assert says in response.json()["detail"]
    assert "individually" in response.json()["detail"]


@pytest.mark.parametrize(
    "filename, mime",
    [
        ("renamed.txt", "text/plain"),
        ("renamed.csv", "text/csv"),
        ("renamed.json", "application/json"),
        ("renamed.xml", "application/xml"),
        ("renamed.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        ("renamed.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        ("renamed.ods", "application/vnd.oasis.opendocument.spreadsheet"),
        ("renamed.pdf", "application/pdf"),
    ],
)
def test_a_renamed_zip_is_refused_by_its_content(filename, mime) -> None:
    archive = make_zip({f"{uuid4().hex}.csv": b"a,b\n1,2\n"})
    assert upload(filename, archive, mime).status_code == 400


@pytest.mark.parametrize("filename, mime", [("renamed.txt", "text/plain"), ("renamed.csv", "text/csv"), ("renamed.html", "text/html")])
def test_a_renamed_email_is_refused_by_its_content(filename, mime) -> None:
    response = upload(filename, make_eml(uuid4().hex), mime)
    assert response.status_code == 400
    assert "The file content is an email message" in response.json()["detail"]


def test_a_note_that_merely_starts_with_from_is_still_text() -> None:
    note = f"From: the field office\nRe: site visit {uuid4().hex}\n\nAll good.\n".encode()
    assert upload("note.txt", note, "text/plain").status_code == 201
    headers_only = f"Name: CLIN 0001\nAmount: 5\nRef: {uuid4().hex}\n".encode()
    assert upload("fields.txt", headers_only, "text/plain").status_code == 201


def test_every_supported_format_still_uploads() -> None:
    import fitz
    from docx import Document as DocxDocument
    from PIL import Image

    marker = uuid4().hex[:8]
    pdf = fitz.open()
    pdf.new_page().insert_text((72, 72), f"Contract {marker}")
    docx = DocxDocument()
    docx.add_paragraph(f"Statement {marker}")
    docx_bytes = BytesIO()
    docx.save(docx_bytes)
    png = BytesIO()
    Image.new("RGB", (40, 20), "white").save(png, format="PNG")
    uploads = [
        ("c.pdf", pdf.tobytes(), "application/pdf"),
        ("s.docx", docx_bytes.getvalue(), "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        ("b.xlsx", make_xlsx(f"x{marker}"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        ("b.ods", make_ods(f"o{marker}"), "application/vnd.oasis.opendocument.spreadsheet"),
        ("r.csv", f"a,b\n1,c{marker}\n".encode(), "text/csv"),
        ("r.tsv", f"a\tb\n1\tt{marker}\n".encode(), "text/tab-separated-values"),
        ("d.json", json.dumps({"j": marker}).encode(), "application/json"),
        ("d.xml", f"<a><b>{marker}</b></a>".encode(), "application/xml"),
        ("i.png", png.getvalue() + marker.encode(), "image/png"),
    ]
    for name, data, mime in uploads:
        response = upload(name, data, mime)
        assert response.status_code == 201, (name, response.text)


def test_previously_imported_email_documents_stay_readable_but_cannot_be_reprocessed() -> None:
    """Emails imported before 6B.0 keep their record, pages and links; a
    queued or requested re-read of the .eml is refused, not processed."""

    from datetime import datetime, timezone

    from app.core.config import get_settings
    from app.services.document_extraction import DocumentExtractionError
    from app.services.file_processors import get_processor

    document_id = str(uuid4())
    stored = f"{document_id}.eml"
    (get_settings().upload_path / stored).write_bytes(make_eml("Historical"))
    database = SessionLocal()
    try:
        database.add(Document(
            id=document_id, original_filename="historical.eml", stored_filename=stored, content_type="message/rfc822",
            size_bytes=200, checksum_sha256=uuid4().hex, page_count=1, encrypted=False, status="ready",
            uploaded_at=datetime.now(timezone.utc),
        ))
        database.flush()
        database.add(DocumentPage(
            document_id=document_id, page_number=1, native_text="Subject: Historical", final_text="Subject: Historical",
            text_length=19, extraction_method="native", requires_ocr=False, ocr_attempted=False, ocr_succeeded=False,
            character_count=19, word_count=2, text_block_count=1, image_count=0, text_coverage_ratio=1.0,
            image_coverage_ratio=0.0, page_width=0.0, page_height=0.0, extraction_status="completed",
            has_tables=False, has_form_fields=False, is_scanned=False,
        ))
        database.commit()
    finally:
        database.close()

    assert client.get(f"/api/documents/{document_id}").status_code == 200
    assert pages_of(document_id)[0]["final_text"] == "Subject: Historical"
    assert client.get(f"/api/documents/{document_id}/source-view").json()["viewer"] == "unsupported"
    with pytest.raises(DocumentExtractionError):
        get_processor(Path(stored))
