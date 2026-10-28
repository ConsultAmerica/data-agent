"""Supplier/PO matching, IDR-style recognition status and learning from a
reviewer's supplier correction. Suppliers and POs are fictional."""

from __future__ import annotations

from unittest.mock import patch
from uuid import uuid4

import fitz
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete

from app.core.config import Settings, get_settings
from app.database.session import SessionLocal
from app.main import app
from app.models.document import Document
from app.models.reference_data import PurchaseOrder, Supplier, SupplierAlias, SupplierSite
from app.staging.preparation import prepare_staging
from demo.synthetic import invoice_pdf

client = TestClient(app)

SUPPLIERS = [
    {
        "supplier_number": "S-1001", "name": "Northwind Office Supply Company", "tax_id": "91-1234567",
        "sites": [{"site_code": "SEA-MAIN", "address": "1200 Harbor Way, Suite 400, Seattle, WA 98101",
                   "business_unit": "US West BU"}],
    },
    {
        "supplier_number": "S-2002", "name": "Contoso Laboratory Services",
        "sites": [{"site_code": "PO-BOX", "address": "PO Box 7781, Denver, CO 80201"}],
    },
    {"supplier_number": "S-9000", "name": "Demo Corp Internal Services", "excluded_from_recognition": True, "sites": []},
]
POS = [
    {"po_number": "PO-4500012345", "supplier_number": "S-1001", "business_unit": "US West BU", "currency": "USD", "amount": 5000},
    {"po_number": "PO-4500099999", "supplier_number": "S-2002", "business_unit": "US Central BU"},
    {"po_number": "PO-4500000001", "supplier_number": "S-1001", "status": "closed"},
]
PO_FORMAT = r"PO-\d{10}"


@pytest.fixture(autouse=True)
def reference_data():
    assert client.post("/api/reference/suppliers", json=SUPPLIERS).status_code == 200
    assert client.post("/api/reference/purchase-orders", json=POS).status_code == 200
    with patch.object(get_settings(), "invoice_po_formats", PO_FORMAT):
        yield
    database = SessionLocal()
    try:
        for model in (SupplierAlias, PurchaseOrder, SupplierSite, Supplier):
            database.execute(delete(model))
        database.commit()
    finally:
        database.close()


def _workbook(content: bytes) -> dict:
    pdf = fitz.open("pdf", content)
    pdf.set_metadata({"subject": str(uuid4())})
    upload = client.post("/api/documents/upload", files={"file": (f"inv-{uuid4()}.pdf", pdf.tobytes(), "application/pdf")})
    assert upload.status_code == 201, upload.text
    document_id = upload.json()["document_id"]
    assert client.post(f"/api/documents/{document_id}/extract-pages", json={"run_ocr": False}).status_code == 200
    database = SessionLocal()
    try:
        prepare_staging(database, database.get(Document, document_id))
    finally:
        database.close()
    return _read(document_id)


def _read(document_id: str) -> dict:
    body = client.get(f"/api/documents/{document_id}/staging-workbook").json()
    assert body["profile"]["profile_id"] == "invoice", body["processing_metadata"]
    body["_id"] = document_id
    return body


def _erp(wb: dict) -> dict[str, dict]:
    ds = next(d for d in wb["datasets"] if d["dataset_id"] == "erp_staging")
    return {r["cells"]["invoice.erp.field"]["value"]: {k.split(".")[-1]: c["value"] for k, c in r["cells"].items()} for r in ds["records"]}


def _validation(wb: dict) -> dict[str, tuple[str, str]]:
    ds = next(d for d in wb["datasets"] if d["dataset_id"] == "invoice_validation")
    rows = {}
    for r in ds["records"]:
        cells = r["cells"]
        rows.setdefault(cells["invoice.validation.check"]["value"], (cells["invoice.validation.result"]["value"], cells["invoice.validation.details"]["value"]))
    return rows


def _supplier_cell(wb: dict) -> dict:
    ds = next(d for d in wb["datasets"] if d["dataset_id"] == "supplier")
    return ds["records"][0]["cells"]["invoice.supplier.name"]


def test_matched_supplier_and_valid_po_are_not_validated_status() -> None:
    wb = _workbook(invoice_pdf())
    erp = _erp(wb)
    assert erp["Recognition Status"]["value"] == "Not Validated", erp["Recognition Status"]
    assert erp["Supplier"]["value"] == "Northwind Office Supply Company"
    assert erp["Supplier"]["status"] == "Matched by exact name"
    assert erp["Supplier Number"]["value"] == "S-1001"
    assert erp["Supplier Site"]["value"] == "SEA-MAIN"
    assert erp["Business Unit"]["value"] == "US West BU"
    assert erp["PO Number"]["status"] == "Validated"
    checks = _validation(wb)
    assert checks["PO format"][0] == checks["PO exists"][0] == checks["PO supplier"][0] == "PASS"


def test_unknown_supplier_is_incomplete_and_needs_review() -> None:
    wb = _workbook(invoice_pdf(supplier="Fabrikam Furniture Partners", address="9 Elm St, Austin, TX 78701"))
    erp = _erp(wb)
    assert erp["Recognition Status"]["value"] == "Incomplete"
    assert "supplier not matched" in erp["Recognition Status"]["status"]
    assert _supplier_cell(wb)["review_status"] == "Needs Review"
    assert _validation(wb)["Supplier"][0] == "REVIEW"


def test_po_problems_are_reported_on_the_po_cell() -> None:
    wrong_format = _workbook(invoice_pdf(po_number="4500012345"))
    assert _validation(wrong_format)["PO format"][0] == "REVIEW"
    other_supplier = _workbook(invoice_pdf(po_number="PO-4500099999"))
    assert _validation(other_supplier)["PO supplier"][0] == "REVIEW"
    assert "Contoso" in _validation(other_supplier)["PO supplier"][1]
    closed = _workbook(invoice_pdf(po_number="PO-4500000001"))
    assert _validation(closed)["PO status"][0] == "REVIEW"
    for wb in (wrong_format, other_supplier, closed):
        ref = next(d for d in wb["datasets"] if d["dataset_id"] == "reference")["records"][0]["cells"]
        assert ref["invoice.reference.po_number"]["review_status"] == "Needs Review"
        assert _erp(wb)["Recognition Status"]["value"] == "Incomplete"


def test_reviewer_correction_teaches_the_supplier_for_later_invoices() -> None:
    printed = "NW Supply Wholesale Div."
    first = _workbook(invoice_pdf(supplier=printed, invoice_number="NW-1"))
    assert _erp(first)["Recognition Status"]["value"] == "Incomplete"

    supplier_id = next(s["id"] for s in client.get("/api/reference/suppliers").json() if s["supplier_number"] == "S-1001")
    corrected = client.post(f"/api/documents/{first['_id']}/invoice/supplier-match", json={"supplier_id": supplier_id})
    assert corrected.status_code == 200, corrected.text
    assert corrected.json()["alias_learned"] is True and corrected.json()["method"] == "learned alias"

    # The corrected invoice and a NEW invoice from the same supplier now match.
    assert _erp(_read(first["_id"]))["Supplier"]["status"] == "Matched by learned alias"
    later = _workbook(invoice_pdf(supplier=printed, invoice_number="NW-2"))
    erp = _erp(later)
    assert erp["Supplier Number"]["value"] == "S-1001"
    assert erp["Recognition Status"]["value"] == "Not Validated"

    # Rollback: retiring the alias stops future matches.
    alias = client.get("/api/reference/supplier-aliases").json()[0]
    assert client.post(f"/api/reference/supplier-aliases/{alias['id']}/retire").status_code == 200
    assert _erp(_read(later["_id"]))["Recognition Status"]["value"] == "Incomplete"


def test_supplier_correction_needs_review_permission_and_the_gate() -> None:
    wb = _workbook(invoice_pdf(supplier="Unknown Vendor LLC"))
    url = f"/api/documents/{wb['_id']}/invoice/supplier-match"
    assert client.post(url, json={"supplier_id": 1}, headers={"X-Actor-Id": "actor-viewer-default"}).status_code == 403
    gated = Settings(app_env="development", metadata_review_mutations_enabled=False)
    with patch("app.core.feature_gates.get_settings", return_value=gated):
        assert client.post(url, json={"supplier_id": 1}).status_code == 403


def test_po_box_vs_street_address_is_explained() -> None:
    wb = _workbook(invoice_pdf(supplier="Contoso Laboratory Services", address="455 Lab Park Drive, Denver, CO 80202",
                               po_number="PO-4500099999"))
    site = _validation(wb).get("Supplier site")
    assert site and site[0] == "REVIEW" and "PO Box" in site[1]


def test_excluded_supplier_is_not_auto_recognized() -> None:
    wb = _workbook(invoice_pdf(supplier="Demo Corp Internal Services"))
    assert _validation(wb)["Supplier"][0] == "REVIEW"
    assert "excluded" in _validation(wb)["Supplier"][1]


def test_reference_data_writes_need_admin() -> None:
    response = client.post("/api/reference/suppliers", json=SUPPLIERS, headers={"X-Actor-Id": "actor-reviewer-default"})
    assert response.status_code == 403
