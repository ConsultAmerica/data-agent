"""VNext format coverage: JSON, TSV/CSV dialects, XLSM, ODS, ZIP and EML."""

from __future__ import annotations

import json
import zipfile
from email.message import EmailMessage
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
    parse_email_file,
    parse_json_file,
    parse_ods_sheets,
)
from app.parsers.office_text_parsers import decode_text_bytes, parse_csv_file
from app.services.containers import (
    EMAIL_ATTACHMENT_RELATIONSHIP,
    ContainerError,
    ContainerLimits,
    iter_email_attachments,
    iter_zip_members,
)
from app.services.security_validation import (
    SecurityValidationError,
    validate_ods_structure,
)
from app.parsers.data_file_parsers import read_email

client = TestClient(app)

LIMITS = ContainerLimits(
    max_entries=50,
    max_files=10,
    max_member_bytes=5 * 1024 * 1024,
    max_total_bytes=20 * 1024 * 1024,
    max_ratio=100,
)


# ── builders ─────────────────────────────────────────────────────────


def make_zip(entries: dict[str, bytes], *, compression=zipfile.ZIP_DEFLATED) -> bytes:
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w", compression) as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    return buffer.getvalue()


def mark_encrypted(data: bytes, name: bytes) -> bytes:
    """Set the 'encrypted' flag on an entry (zipfile can't write one)."""

    raw = bytearray(data)
    for signature, flag_at, name_at in ((b"PK\x03\x04", 6, 30), (b"PK\x01\x02", 8, 46)):
        start = 0
        while (start := raw.find(signature, start)) != -1:
            if raw[start + name_at : start + name_at + len(name)] == name:
                raw[start + flag_at] |= 0x1
            start += 4
    return bytes(raw)


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


def make_email(*, subject: str, attachments: list[tuple[str, bytes, str]] = (), html: bool = False) -> bytes:
    message = EmailMessage()
    message["From"] = "Contracting Officer <co@agency.example>"
    message["To"] = "vendor@example.com"
    message["Subject"] = subject
    message["Date"] = "Tue, 27 Oct 2026 10:00:00 +0000"
    if html:
        message.set_content("<html><body><p>Please review the <b>award</b>.</p></body></html>", subtype="html")
    else:
        message.set_content("Please review the attached award.\nThanks.")
    for filename, data, mime in attachments:
        maintype, subtype = mime.split("/")
        message.add_attachment(data, maintype=maintype, subtype=subtype, filename=filename)
    return bytes(message)


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


# ── ZIP limits ───────────────────────────────────────────────────────


def test_zip_members_skip_system_unsupported_nested_and_encrypted(tmp_path: Path) -> None:
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("docs/rates.csv", b"a,b\n1,2\n")
        archive.writestr("__MACOSX/docs/._rates.csv", b"junk")
        archive.writestr("docs/.DS_Store", b"junk")
        archive.writestr("tool.exe", b"MZ")
        archive.writestr("inner.zip", make_zip({"x.csv": b"a\n"}))
        archive.writestr("empty.txt", b"")
        archive.writestr("secret.txt", b"ciphertext")
    path = tmp_path / "batch.zip"
    path.write_bytes(mark_encrypted(buffer.getvalue(), b"secret.txt"))

    members = {member.path: member for member in iter_zip_members(path, LIMITS)}
    assert set(members) == {"docs/rates.csv", "tool.exe", "inner.zip", "empty.txt", "secret.txt"}
    assert members["docs/rates.csv"].filename == "rates.csv"
    assert members["docs/rates.csv"].data == b"a,b\n1,2\n"
    assert "Unsupported" in members["tool.exe"].skipped_reason
    assert "not unpacked" in members["inner.zip"].skipped_reason
    assert "empty" in members["empty.txt"].skipped_reason
    assert "Password" in members["secret.txt"].skipped_reason


def test_zip_bomb_ratio_and_size_limits(tmp_path: Path) -> None:
    path = tmp_path / "bomb.zip"
    path.write_bytes(make_zip({"zeros.txt": b"0" * (3 * 1024 * 1024), "ok.txt": b"fine"}))
    members = {member.path: member for member in iter_zip_members(path, LIMITS)}
    assert "compression ratio" in members["zeros.txt"].skipped_reason
    assert members["ok.txt"].data == b"fine"

    small = ContainerLimits(**{**LIMITS.__dict__, "max_member_bytes": 10, "max_ratio": 10_000})
    members = {member.path: member for member in iter_zip_members(path, small)}
    assert "upload-size limit" in members["zeros.txt"].skipped_reason


def test_zip_file_count_entry_count_and_total_limits(tmp_path: Path) -> None:
    path = tmp_path / "many.zip"
    path.write_bytes(make_zip({f"f{index}.txt": b"x" for index in range(12)}))
    members = list(iter_zip_members(path, LIMITS))
    assert sum(1 for m in members if m.data) == 10
    assert sum(1 for m in members if m.skipped_reason and "first 10" in m.skipped_reason) == 2

    with pytest.raises(ContainerError, match="entries"):
        list(iter_zip_members(path, ContainerLimits(**{**LIMITS.__dict__, "max_entries": 5})))
    with pytest.raises(ContainerError, match="expands"):
        list(iter_zip_members(path, ContainerLimits(**{**LIMITS.__dict__, "max_total_bytes": 5})))

    bad = tmp_path / "bad.zip"
    bad.write_bytes(b"PK\x03\x04 not really a zip")
    with pytest.raises(ContainerError):
        list(iter_zip_members(bad, LIMITS))


# ── Email ────────────────────────────────────────────────────────────


def test_email_text_and_attachments(tmp_path: Path) -> None:
    raw = make_email(
        subject="Award FA3002",
        attachments=[("award.csv", b"a,b\n1,2\n", "text/csv"), ("macro.exe", b"MZ", "application/octet-stream")],
    )
    message = read_email(raw)
    # An inline logo and an attached email are not unpacked as documents.
    logo = EmailMessage()
    logo.set_content(b"\x89PNG\r\n\x1a\n", maintype="image", subtype="png", disposition="inline", filename="logo.png")
    message.attach(logo)
    forwarded = EmailMessage()
    forwarded["Subject"] = "Earlier"
    forwarded.set_content("old")
    message.add_attachment(forwarded)

    members = list(iter_email_attachments(message, LIMITS))
    by_name = {member.filename: member for member in members}
    assert by_name["award.csv"].data == b"a,b\n1,2\n"
    assert "Unsupported" in by_name["macro.exe"].skipped_reason
    assert "logo.png" not in by_name
    assert any("Emails attached" in (m.skipped_reason or "") for m in members)

    path = tmp_path / "award.eml"
    path.write_bytes(raw)
    parsed = parse_email_file(path)
    assert "Subject: Award FA3002" in parsed["paragraphs"]
    assert "Attachments: award.csv, macro.exe" in parsed["paragraphs"]
    assert "Please review the attached award." in parsed["text"]


def test_html_email_body_is_read_as_text(tmp_path: Path) -> None:
    path = tmp_path / "html.eml"
    path.write_bytes(make_email(subject="HTML", html=True))
    text = parse_email_file(path)["text"]
    assert text.endswith("\n\nPlease review the award.")


# ── Upload API ───────────────────────────────────────────────────────


def test_upload_json_and_reject_invalid_json() -> None:
    marker = f"INV-{uuid4().hex[:8]}"
    response = upload("invoice.json", json.dumps({"invoice": {"number": marker}}).encode(), "application/json")
    assert response.status_code == 201, response.text
    assert f"invoice.number: {marker}" in pages_of(response.json()["document_id"])[0]["final_text"]

    assert upload("broken.json", b'{"a": ', "application/json").status_code == 400


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


def test_upload_zip_creates_one_document_per_supported_file() -> None:
    marker = uuid4().hex[:8]
    existing = upload("existing.csv", f"dup,{marker}\n".encode(), "text/csv")
    assert existing.status_code == 201
    archive = make_zip(
        {
            "batch/rates.csv": f"Item,Amount\n{marker},1\n".encode(),
            "batch/invoice.json": json.dumps({"number": marker}).encode(),
            "batch/copy.csv": f"dup,{marker}\n".encode(),
            "batch/tool.exe": b"MZ",
            "__MACOSX/batch/._rates.csv": b"junk",
            "batch/fake.pdf": b"not a pdf",
        }
    )
    response = upload("batch.zip", archive, "application/zip")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "container_expanded"
    members = {member["path"]: member for member in body["container_members"]}
    assert set(members) == {"batch/rates.csv", "batch/invoice.json", "batch/copy.csv", "batch/tool.exe", "batch/fake.pdf"}
    assert members["batch/rates.csv"]["status"] == "created"
    assert members["batch/rates.csv"]["processing_job_id"] is not None
    assert members["batch/invoice.json"]["status"] == "created"
    assert members["batch/copy.csv"]["status"] == "duplicate"
    assert members["batch/copy.csv"]["document_id"] == existing.json()["document_id"]
    assert members["batch/tool.exe"]["status"] == "skipped"
    assert members["batch/fake.pdf"]["status"] == "failed"

    # The background job has read each new document; the archive itself is
    # not a document.
    created = members["batch/rates.csv"]["document_id"]
    assert marker in pages_of(created)[0]["final_text"]
    document = stored_document(created)
    assert document.original_filename == "rates.csv"
    assert document.ingestion_provenance["container_source"] == "batch.zip › batch/rates.csv"
    assert client.get(f"/api/documents/{body['document_id']}").status_code == 404


def test_upload_zip_refuses_broken_or_empty_archives() -> None:
    assert upload("broken.zip", b"PK\x03\x04garbage", "application/zip").status_code == 400
    assert upload("empty.zip", make_zip({"folder/": b""}), "application/zip").status_code == 400
    assert upload("renamed.zip", b"%PDF-1.4 hello", "application/zip").status_code == 400


def test_upload_email_links_attachments_to_the_email() -> None:
    marker = uuid4().hex[:8]
    raw = make_email(
        subject=f"Award {marker}",
        attachments=[
            ("award.xlsx", make_xlsx(marker), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
            ("notes.txt", f"Notes {marker}".encode(), "text/plain"),
        ],
    )
    response = upload("award.eml", raw, "message/rfc822")
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["status"] == "ready"
    email_text = pages_of(body["document_id"])[0]["final_text"]
    assert f"Subject: Award {marker}" in email_text
    assert "Attachments: award.xlsx, notes.txt" in email_text

    members = {member["filename"]: member for member in body["container_members"]}
    assert {member["status"] for member in members.values()} == {"created"}
    for member in members.values():
        assert member["parent_document_id"] == body["document_id"]
        child = stored_document(member["document_id"])
        assert child.parent_document_id == body["document_id"]
        assert child.parent_relationship_type == EMAIL_ATTACHMENT_RELATIONSHIP
        assert child.parent_relationship_status == "confirmed"
    assert marker in pages_of(members["award.xlsx"]["document_id"])[0]["final_text"]


def test_email_inside_zip_unpacks_its_attachments_one_level() -> None:
    marker = uuid4().hex[:8]
    raw = make_email(
        subject=f"Mod {marker}",
        attachments=[
            ("mod.txt", f"Modification {marker}".encode(), "text/plain"),
            ("nested.zip", make_zip({"x.txt": b"x"}), "application/zip"),
        ],
    )
    response = upload("mail.zip", make_zip({"mod.eml": raw}), "application/zip")
    assert response.status_code == 200, response.text
    members = {member["filename"]: member for member in response.json()["container_members"]}
    assert members["mod.eml"]["status"] == "created"
    assert members["mod.txt"]["status"] == "created"
    assert members["mod.txt"]["parent_document_id"] == members["mod.eml"]["document_id"]
    assert members["nested.zip"]["status"] == "skipped"


def test_upload_rejects_non_email_eml() -> None:
    assert upload("note.eml", b"just some text\nwith no headers", "message/rfc822").status_code == 400
