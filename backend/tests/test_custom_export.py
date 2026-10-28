"""Custom export: renamed, combined and reordered fields as an import file."""

from __future__ import annotations

import csv
import io
import json
from uuid import uuid4

from fastapi.testclient import TestClient
from openpyxl import load_workbook

from app.database.session import SessionLocal
from app.main import app
from app.models.document import Document
from app.staging.preparation import prepare_staging
from tests.test_driving_licence_profile import us_licence

client = TestClient(app)


def _licence_document() -> str:
    upload = client.post("/api/documents/upload", files={"file": (f"licence-{uuid4()}.pdf", us_licence(), "application/pdf")})
    assert upload.status_code == 201, upload.text
    document_id = upload.json()["document_id"]
    assert client.post(f"/api/documents/{document_id}/extract-pages", json={"run_ocr": False}).status_code == 200
    database = SessionLocal()
    try:
        prepare_staging(database, database.get(Document, document_id))
    finally:
        database.close()
    return document_id


def _value(field: str) -> dict:
    return {"dataset_id": "licence_data", "record_id": f"field:{field}", "field": "licence.field.value"}


def _export(document_id: str, manifest: dict):
    return client.post(f"/api/documents/{document_id}/staging-workbook/export-custom", json=manifest)


def _rows(response) -> list[list[str]]:
    return list(csv.reader(io.StringIO(response.content.decode("utf-8-sig"))))


def test_renamed_and_combined_fields_make_one_import_row() -> None:
    document_id = _licence_document()
    response = _export(document_id, {
        "format": "csv",
        "columns": [
            {"label": "LicenceNo", "sources": [_value("licence_number")]},
            {"label": "FullName", "sources": [_value("given_names"), _value("surname")], "separator": " "},
            {"label": "Status", "sources": [{"dataset_id": "validity", "record_id": "validity",
                                             "field": "licence.validity.status"}]},
        ],
    })
    assert response.status_code == 200, response.text
    assert "attachment" in response.headers["content-disposition"]
    assert _rows(response) == [["LicenceNo", "FullName", "Status"], ["D1234567", "SOFIA ANN RIVERA", "Valid"]]


def test_table_columns_give_one_row_per_record_with_document_fields_repeated() -> None:
    document_id = _licence_document()
    response = _export(document_id, {
        "format": "csv",
        "columns": [
            {"label": "Licence", "sources": [_value("licence_number")]},
            {"label": "Check", "sources": [{"dataset_id": "licence_checks", "field": "licence.check.name"}]},
            {"label": "Result", "sources": [{"dataset_id": "licence_checks", "field": "licence.check.result"}]},
        ],
        "include_header": False,
    })
    assert response.status_code == 200, response.text
    rows = _rows(response)
    assert len(rows) >= 4 and all(row[0] == "D1234567" for row in rows)
    assert ["D1234567", "Licence number present", "PASS"] in rows


def test_excel_is_a_plain_table_and_json_is_records() -> None:
    document_id = _licence_document()
    columns = [{"label": "Surname", "sources": [_value("surname")]}, {"label": "Class", "sources": [_value("vehicle_class")]}]
    xlsx = _export(document_id, {"format": "xlsx", "columns": columns, "file_name": "licence import"})
    assert xlsx.status_code == 200
    assert "licence import.xlsx" in xlsx.headers["content-disposition"]
    sheet = load_workbook(io.BytesIO(xlsx.content)).active
    assert [cell.value for cell in sheet[1]] == ["Surname", "Class"]
    assert [cell.value for cell in sheet[2]] == ["RIVERA", "C"]

    payload = json.loads(_export(document_id, {"format": "json", "columns": columns}).content)
    assert payload == [{"Surname": "RIVERA", "Class": "C"}]


def test_mappings_that_would_make_a_bad_import_file_are_refused() -> None:
    document_id = _licence_document()
    duplicate = _export(document_id, {"format": "csv", "columns": [
        {"label": "Name", "sources": [_value("surname")]}, {"label": "Name", "sources": [_value("given_names")]},
    ]})
    assert duplicate.status_code == 422 and "unique" in duplicate.json()["detail"]

    two_tables = _export(document_id, {"format": "csv", "columns": [
        {"label": "Check", "sources": [{"dataset_id": "licence_checks", "field": "licence.check.name"}]},
        {"label": "Field", "sources": [{"dataset_id": "licence_data", "field": "licence.field.name"}]},
    ]})
    assert two_tables.status_code == 422 and "one table" in two_tables.json()["detail"]

    unknown = _export(document_id, {"format": "csv", "columns": [
        {"label": "X", "sources": [{"dataset_id": "licence_data", "record_id": "field:surname", "field": "nope"}]},
    ]})
    assert unknown.status_code == 422
