"""Schema & Label Designer: definitions, inheritance, versioning, review
forms, rules, Field Discovery, import/export, mapping impact, isolation."""

from __future__ import annotations

import secrets
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.database.session import SessionLocal
from app.doc_schemas.definition import Definition, DefinitionError, humanize, merge, parse_definition
from app.doc_schemas.resolve import build_form
from app.doc_schemas.service import SchemaError, effective
from app.main import app
from app.models.document_schema import DocumentSchemaVersion
from tests.test_document_isolation import enforced
from tests.test_export_consistency import _process
from tests.test_oracle_templates import _workbook as synthetic_workbook

client = TestClient(app)
INVOICES = Path(__file__).resolve().parent / "fixtures" / "invoices"


def _definition(**extra) -> dict:
    definition = {
        "groups": [
            {"group_id": "header", "label": "Header", "fields": [
                {"field_id": "contract.number", "label": "Contract Number", "type": "identifier", "required": True,
                 "source": {"kind": "field", "dataset_id": "contract_details", "field": "contract.detail.value",
                            "shape": "pair", "pair_by": "field_id", "pair_key": "contract.contract_number"}},
                {"field_id": "contract.currency", "label": "Currency", "type": "text"},
                {"field_id": "contract.start", "label": "Award Date", "type": "date", "normalization": "date_iso",
                 "source": {"kind": "field", "dataset_id": "contract_details", "field": "contract.detail.value",
                            "shape": "pair", "pair_by": "field_id", "pair_key": "contract.award_date"}},
                {"field_id": "contract.end", "label": "End Date", "type": "date", "default": "2020-01-01"},
            ]},
            {"group_id": "lines", "label": "Contract Lines", "kind": "repeating", "source_dataset": "line_items",
             "key_field": "line.number", "fields": [
                {"field_id": "line.number", "label": "CLIN", "type": "identifier",
                 "source": {"kind": "field", "dataset_id": "line_items", "field": "contract.line.item_number", "shape": "column"}},
                {"field_id": "line.amount", "label": "Amount", "type": "currency", "normalization": "number",
                 "source": {"kind": "field", "dataset_id": "line_items", "field": "contract.line.amount", "shape": "column"}},
            ]},
        ],
        "rules": [{"rule_id": "dates", "kind": "date_order", "fields": ["contract.start", "contract.end"]}],
    }
    definition.update(extra)
    return definition


def _create(name: str = "Test Schema", **body) -> dict:
    response = client.post("/api/schemas", json={"name": f"{name} {uuid4().hex[:6]}", "category": "contracts",
                                                 "definition": _definition(), **body})
    assert response.status_code == 201, response.text
    return response.json()


def _version(schema: dict) -> dict:
    return schema["latest"]


# ---------------------------------------------------------------- definitions


def test_labels_are_generated_from_raw_keys() -> None:
    assert [humanize(raw) for raw in ("contract_no", "supplier_nm", "eff_dt", "exp_dt", "po_num", "amt_total")] == [
        "Contract Number", "Supplier Name", "Effective Date", "Expiration Date", "Purchase Order Number", "Total Amount",
    ]
    assert humanize("2. CONTRACT NUMBER") == "Contract Number"


@pytest.mark.parametrize("definition, problem", [
    ({"groups": [{"group_id": "a", "label": "A", "fields": [{"field_id": "x", "label": "X"}, {"field_id": "x", "label": "Y"}]}]}, "Duplicate field id"),
    ({"groups": [{"group_id": "a", "label": "A", "fields": [{"field_id": "x", "label": "X", "type": "spreadsheet"}]}]}, "type"),
    ({"groups": [{"group_id": "a", "label": "A", "fields": [{"field_id": "Bad Id", "label": "X"}]}]}, "field ids"),
    ({"groups": [], "rules": [{"rule_id": "r", "kind": "pattern", "fields": ["missing"], "params": {"pattern": "a"}}]}, "unknown field"),
    ({"groups": [{"group_id": "a", "label": "A", "fields": [{"field_id": "x", "label": "X"}]}],
      "rules": [{"rule_id": "r", "kind": "pattern", "fields": ["x"], "params": {"pattern": "(["}}]}, "invalid pattern"),
    ({"groups": [{"group_id": "a", "label": "A", "fields": [], "script": "import os"}]}, "Extra inputs"),
])
def test_invalid_definitions_are_rejected(definition: dict, problem: str) -> None:
    response = client.post("/api/schemas", json={"name": "Bad", "definition": definition})
    assert response.status_code == 422 and problem in response.text


# ---------------------------------------------------------------- workflow and versions


def test_create_edit_submit_publish_and_published_versions_are_immutable() -> None:
    schema = _create()
    sid, v1 = schema["id"], _version(schema)
    assert (v1["version"], v1["status"]) == ("1.0", "draft")

    edited = _definition()
    edited["groups"][0]["fields"][1]["label"] = "Currency Code"
    saved = client.put(f"/api/schemas/{sid}/versions/{v1['id']}", json={"definition": edited, "change_summary": "label"})
    assert saved.status_code == 200 and saved.json()["definition"]["groups"][0]["fields"][1]["label"] == "Currency Code"

    assert client.post(f"/api/schemas/{sid}/versions/{v1['id']}/submit").json()["version"]["status"] == "in_review"
    assert client.put(f"/api/schemas/{sid}/versions/{v1['id']}", json={"definition": edited}).status_code == 422
    assert client.post(f"/api/schemas/{sid}/versions/{v1['id']}/publish").json()["version"]["status"] == "published"
    refused = client.put(f"/api/schemas/{sid}/versions/{v1['id']}", json={"definition": _definition()})
    assert refused.status_code == 422 and "start a new draft" in refused.json()["detail"]

    draft = client.post(f"/api/schemas/{sid}/drafts", json={}).json()
    assert (draft["version"]["version"], draft["version"]["status"]) == ("1.1", "draft")
    assert client.post(f"/api/schemas/{sid}/drafts", json={}).json()["version"]["id"] == draft["version"]["id"]
    client.post(f"/api/schemas/{sid}/versions/{draft['version']['id']}/publish")
    detail = client.get(f"/api/schemas/{sid}").json()
    assert [(v["version"], v["status"]) for v in detail["all_versions"]] == [("1.1", "published"), ("1.0", "deprecated")]
    assert {"create", "edit", "submit", "publish", "new_draft"} <= {e["action"] for e in detail["events"]}

    assert client.post(f"/api/schemas/{sid}/archive").json()["archived"] is True
    assert sid not in {s["id"] for s in client.get("/api/schemas").json()}


def test_system_schemas_are_listed_and_read_only() -> None:
    schemas = {s["schema_key"]: s for s in client.get("/api/schemas").json()}
    contract = schemas["system.contract_v3"]
    assert contract["is_system"] and contract["published"]["version"] == "1.0"
    assert schemas["system.contract_v3.sf1442"]["parent"].startswith("Government Contract")
    version = contract["published"]["id"]
    assert client.put(f"/api/schemas/{contract['id']}/versions/{version}", json={"definition": {}}).status_code == 422
    assert client.post(f"/api/schemas/{contract['id']}/drafts", json={}).status_code == 422


# ---------------------------------------------------------------- inheritance


def test_child_inherits_overrides_and_is_pinned_to_its_parent_version() -> None:
    parent = _create("Parent")
    pid, pv = parent["id"], _version(parent)["id"]
    client.post(f"/api/schemas/{pid}/versions/{pv}/publish")
    child = client.post(f"/api/schemas/{pid}/extend", json={"name": f"Child {uuid4().hex[:4]}"}).json()
    cid, cv = child["id"], _version(child)["id"]
    own = {"groups": [{"group_id": "extra", "label": "Extra", "fields": [{"field_id": "extra.note", "label": "Note"}]}],
           "overrides": {"contract.currency": {"label": "Billing Currency", "visible": False}}}
    saved = client.put(f"/api/schemas/{cid}/versions/{cv}", json={"definition": own}).json()
    labels = {f["field_id"]: f for g in saved["effective"]["groups"] for f in g["fields"]}
    assert labels["contract.number"]["label"] == "Contract Number"  # inherited
    assert labels["contract.currency"]["label"] == "Billing Currency" and labels["contract.currency"]["visible"] is False
    assert "extra.note" in labels and "contract.number" in saved["inherited_field_ids"]

    bad = client.put(f"/api/schemas/{cid}/versions/{cv}", json={"definition": {"overrides": {"nope": {"label": "x"}}}})
    assert bad.status_code == 422 and "no such field in the parent" in bad.json()["detail"]
    clash = client.put(f"/api/schemas/{cid}/versions/{cv}", json={"definition": {
        "groups": [{"group_id": "x", "label": "X", "fields": [{"field_id": "contract.number", "label": "Dup"}]}]}})
    assert clash.status_code == 422 and "Duplicate field id" in clash.json()["detail"]
    client.post(f"/api/schemas/{cid}/versions/{cv}/publish")

    # A new parent version doesn't change the published child.
    draft = client.post(f"/api/schemas/{pid}/drafts", json={}).json()["version"]["id"]
    renamed = _definition()
    renamed["groups"][0]["fields"][0]["label"] = "Award Number"
    client.put(f"/api/schemas/{pid}/versions/{draft}", json={"definition": renamed})
    client.post(f"/api/schemas/{pid}/versions/{draft}/publish")
    still = client.get(f"/api/schemas/{cid}/versions/{cv}").json()
    assert {f["field_id"]: f["label"] for g in still["effective"]["groups"] for f in g["fields"]}["contract.number"] == "Contract Number"


def test_circular_inheritance_is_refused() -> None:
    a = _create("Cycle A")
    database = SessionLocal()
    try:
        version = database.get(DocumentSchemaVersion, _version(a)["id"])
        version.parent_version_id = version.id
        database.commit()
        with pytest.raises(SchemaError, match="Circular"):
            effective(database, version)
        version.parent_version_id = None
        database.commit()
    finally:
        database.close()


# ---------------------------------------------------------------- forms and rules (synthetic data)


def test_form_reads_bound_fields_tables_and_rules_without_changing_values() -> None:
    workbook = synthetic_workbook()
    form = build_form(workbook, parse_definition(_definition()))
    header = {f.field_id: f.value for f in form.groups[0].fields}
    assert header["contract.number"].value == "FA300224C0008" and header["contract.number"].status == "found"
    assert header["contract.start"].value == "2023-04-21"  # normalized for display
    assert header["contract.currency"].status == "matched_by_label" and header["contract.currency"].value == "USD"
    assert header["contract.end"].status == "default"
    lines = form.groups[1]
    assert lines.kind == "repeating" and lines.total_rows == 2
    assert [r.cells["line.number"].value for r in lines.rows] == ["0001", "0002"]
    # End (default 2020-01-01) precedes the award date: reported, values untouched.
    assert [i.rule_id for i in form.issues] == ["dates"]
    assert workbook.datasets[1].records[2].cells["contract.detail.value"].value == "21 Apr 2023"


def test_sum_and_required_rules_and_calculated_fields() -> None:
    definition = _definition(rules=[
        {"rule_id": "total", "kind": "sum_matches", "fields": ["line.amount", "contract.total"]},
        {"rule_id": "cur", "kind": "required", "fields": ["contract.missing"]},
    ])
    definition["groups"][0]["fields"] += [
        {"field_id": "contract.total", "label": "Total", "type": "calculated",
         "calculation": {"op": "sum", "args": ["line.amount"]}},
        {"field_id": "contract.missing", "label": "Missing Thing"},
    ]
    form = build_form(synthetic_workbook(), parse_definition(definition))
    fields = {f.field_id: f.value for f in form.groups[0].fields}
    assert fields["contract.total"].value == "1450351.7" and fields["contract.total"].status == "calculated"
    codes = {i.rule_id for i in form.issues}
    assert "cur" in codes and "total" not in codes


def test_nested_repeating_groups_link_child_rows_to_parent_keys() -> None:
    workbook = synthetic_workbook()
    definition = _definition()
    definition["groups"][1]["children"] = [{
        "group_id": "line_detail", "label": "Line Detail", "kind": "repeating", "source_dataset": "line_items",
        "parent_key_field": "detail.clin", "fields": [
            {"field_id": "detail.clin", "label": "CLIN", "source": {"kind": "field", "dataset_id": "line_items",
                                                                    "field": "contract.line.item_number", "shape": "column"}},
            {"field_id": "detail.description", "label": "Description", "source": {
                "kind": "field", "dataset_id": "line_items", "field": "contract.line.description", "shape": "column"}},
        ]}]
    form = build_form(workbook, parse_definition(definition))
    first = form.groups[1].rows[0]
    assert first.children[0].rows[0].cells["detail.description"].value == "ALL SERVICES"
    assert first.children[0].total_rows == 1


# ---------------------------------------------------------------- documents: forms, assignment, discovery


@pytest.fixture(scope="module")
def invoice() -> str:
    return _process("invoice.pdf", (INVOICES / "f1_digital_simple.pdf").read_bytes(), "application/pdf")


def test_document_keeps_its_schema_version_until_explicitly_migrated(invoice: str) -> None:
    form = client.get(f"/api/documents/{invoice}/schema-form").json()
    assert form["schema_name"] == "Invoice" and form["assignment_kind"] == "automatic"
    assert form["form"]["found"] > 0

    schema = client.post("/api/schemas/" + str(form["schema_id"]) + "/duplicate", json={"name": f"My Invoice {uuid4().hex[:4]}"}).json()
    sid, v1 = schema["id"], _version(schema)["id"]
    client.post(f"/api/schemas/{sid}/versions/{v1}/publish")
    moved = client.post(f"/api/documents/{invoice}/schema-assignment", json={"version_id": v1, "note": "custom"}).json()
    assert (moved["schema_id"], moved["version"], moved["assignment_kind"]) == (sid, "1.0", "migration")

    draft = client.post(f"/api/schemas/{sid}/drafts", json={}).json()["version"]
    client.post(f"/api/schemas/{sid}/versions/{draft['id']}/publish")
    kept = client.get(f"/api/documents/{invoice}/schema-form").json()
    assert kept["version"] == "1.0" and kept["newer_version"]["version"] == "1.1"
    diff = client.get(f"/api/documents/{invoice}/schema-assignment/diff", params={"version_id": draft["id"]}).json()
    assert diff["from"] == "1.0" and diff["to"] == "1.1"


def test_discovery_proposes_found_and_expected_fields_without_inventing_values(invoice: str) -> None:
    discovery = client.post(f"/api/documents/{invoice}/schema-discovery").json()
    found = [s for s in discovery["suggestions"] if s["origin"] == "found"]
    expected = [s for s in discovery["suggestions"] if s["origin"] == "category"]
    assert found and expected
    assert all(s["value"] for s in found if s["group_id"] != "expected_for_type")
    assert all(s["value"] is None for s in expected)
    fields = client.get(f"/api/documents/{invoice}/oracle/fields").json()["fields"]
    samples = {f["sample"][:300] for f in fields}
    assert all(s["value"] in samples for s in found)

    # Approve a subset: keep found fields only, then save it as a schema.
    definition = discovery["definition"]
    definition["groups"] = [g for g in definition["groups"] if g["group_id"] != "expected_for_type"][:3]
    created = client.post("/api/schemas", json={"name": f"Discovered {uuid4().hex[:4]}", "definition": definition})
    assert created.status_code == 201, created.text
    preview = client.post(f"/api/documents/{invoice}/schema-form/preview", json={"definition": definition}).json()
    assert preview["found"] > 0


# ---------------------------------------------------------------- oracle mapping impact, import/export


def test_label_change_is_harmless_but_removing_a_mapped_field_flags_mappings() -> None:
    schema = _create("Mapped")
    sid, v1 = schema["id"], _version(schema)["id"]
    client.post(f"/api/schemas/{sid}/versions/{v1}/publish")
    template = client.post("/api/oracle/templates", files={"file": (f"Map_{uuid4().hex[:6]}.csv", b"ContractNumber\n", "text/csv")}).json()
    number_source = _definition()["groups"][0]["fields"][0]["source"]
    client.post(f"/api/oracle/templates/{template['id']}/profiles", json={
        "name": "Uses contract.number", "spec": {"mappings": [{"column": "ContractNumber", "source": number_source}]}})

    relabel = client.post(f"/api/schemas/{sid}/drafts", json={}).json()["version"]["id"]
    renamed = _definition()
    renamed["groups"][0]["fields"][0]["label"] = "Award Number"
    client.put(f"/api/schemas/{sid}/versions/{relabel}", json={"definition": renamed})
    harmless = client.get(f"/api/schemas/{sid}/versions/{relabel}/diff", params={"against": v1}).json()
    assert [c["change"] for c in harmless["changes"]] == ["label_changed"]
    assert harmless["breaking"] == [] and harmless["mappings_to_review"] == []

    removed = _definition()
    removed["groups"][0]["fields"].pop(0)
    client.put(f"/api/schemas/{sid}/versions/{relabel}", json={"definition": removed})
    breaking = client.get(f"/api/schemas/{sid}/versions/{relabel}/diff", params={"against": v1}).json()
    assert {c["field_id"] for c in breaking["breaking"]} == {"contract.number"}
    assert any(m["name"] == "Uses contract.number" for m in breaking["mappings_to_review"])


def test_export_import_round_trip_and_import_validation() -> None:
    schema = _create("Exported")
    sid, v1 = schema["id"], _version(schema)["id"]
    exported = client.get(f"/api/schemas/{sid}/versions/{v1}/export").json()
    assert exported["format"] == "dataomatix.schema/1" and exported["version"] == "1.0"
    exported["schema_name"] = f"Imported {uuid4().hex[:4]}"
    imported = client.post("/api/schemas/import", json=exported)
    assert imported.status_code == 201, imported.text
    version = client.get(f"/api/schemas/{imported.json()['id']}/versions/{_version(imported.json())['id']}").json()
    assert version["definition"]["groups"] == exported["definition"]["groups"]

    assert client.post("/api/schemas/import", json={"format": "other"}).status_code == 422
    duplicate = dict(exported, definition={"groups": [{"group_id": "a", "label": "A", "fields": [
        {"field_id": "x", "label": "X"}, {"field_id": "x", "label": "X"}]}]})
    assert "Duplicate field id" in client.post("/api/schemas/import", json=duplicate).text
    missing_parent = dict(exported, parent={"schema_key": "nowhere", "version": "1.0"})
    assert client.post("/api/schemas/import", json=missing_parent).status_code == 422


# ---------------------------------------------------------------- isolation and permissions


def test_workspaces_only_see_their_own_schemas_and_cant_publish() -> None:
    a = {"X-Workspace-Token": secrets.token_hex(32)}
    b = {"X-Workspace-Token": secrets.token_hex(32)}
    with enforced():
        created = client.post("/api/schemas", json={"name": "Private", "definition": _definition()}, headers=a)
        assert created.status_code == 201, created.text
        sid, v1 = created.json()["id"], created.json()["latest"]["id"]
        assert client.get(f"/api/schemas/{sid}", headers=a).status_code == 200
        assert client.get(f"/api/schemas/{sid}", headers=b).status_code == 404
        assert sid not in {s["id"] for s in client.get("/api/schemas", headers=b).json()}
        assert any(s["is_system"] for s in client.get("/api/schemas", headers=b).json())
        assert client.post(f"/api/schemas/{sid}/versions/{v1}/publish", headers=a).status_code == 403
        assert client.post(f"/api/schemas/{sid}/archive", headers=a).status_code == 403


def test_merge_never_mutates_the_parent_definition() -> None:
    parent = parse_definition(_definition())
    child = Definition(overrides={"contract.number": {"label": "Changed"}})
    merged = merge(parent, child)
    assert parent.groups[0].fields[0].label == "Contract Number"
    assert merged.groups[0].fields[0].label == "Changed"
    with pytest.raises(DefinitionError):
        parse_definition({"groups": "nope"})
