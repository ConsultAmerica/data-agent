"""Seed a Dataomatix demo environment with fictional documents and
reference data, through the public API (so it works against a local or a
hosted demo backend).

    python scripts/demo_seed.py                              # http://127.0.0.1:8001
    python scripts/demo_seed.py --api https://demo-backend.example --bearer <admin key>
    python scripts/demo_seed.py --write-only                 # just write the PDFs

What it does:
1. Writes the demo PDFs to backend/demo/output/ (drag-and-drop copies).
2. Loads the supplier master and purchase orders (needs an admin
   credential when RBAC is enforced).
3. Uploads each document, runs processing, waits for it, and prints what
   Dataomatix concluded (profile, recognition status / MRZ / GPA checks,
   key dates).

Run the backend with INVOICE_PO_FORMATS='PO-\\d{10}' so the PO format check
is configured. Everything is fictional - never seed real documents.
"""

from __future__ import annotations

import argparse
import sys
import time
from datetime import date, timedelta
from pathlib import Path

import httpx

BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))

from demo.reference_data import PURCHASE_ORDERS, SUPPLIERS  # noqa: E402
from demo.synthetic import invoice_pdf, passport_pdf, transcript_pdf  # noqa: E402

OUTPUT = BACKEND_ROOT / "demo" / "output"


def _insurance_certificate(expires: date) -> bytes:
    import fitz

    pdf = fitz.open()
    page = pdf.new_page(width=612, height=792)
    lines = [
        ("CERTIFICATE OF LIABILITY INSURANCE", 14),
        ("Insured: Northwind Office Supply Company", 10),
        ("Insurer: Example Mutual Insurance (fictional)", 10),
        ("Policy Number: GL-0045521", 10),
        (f"Policy Effective Date: {(expires - timedelta(days=365)).strftime('%m/%d/%Y')}", 10),
        (f"Policy Expiration Date: {expires.strftime('%m/%d/%Y')}", 10),
        ("General Aggregate: $2,000,000", 10),
    ]
    for i, (text, size) in enumerate(lines):
        page.insert_text((60, 70 + 22 * i), text, fontsize=size)
    pdf.set_metadata({"title": "Demo certificate of insurance (fictional)"})
    return pdf.tobytes()


def documents() -> list[tuple[str, bytes, str]]:
    """(file name, content, what it demonstrates)."""

    return [
        ("01-invoice-northwind-matched.pdf", invoice_pdf(), "Invoice: supplier + site + PO matched -> Not Validated"),
        ("02-invoice-unfamiliar-supplier-name.pdf",
         invoice_pdf(supplier="NW Supply Wholesale Div.", invoice_number="NW-20502", po_number="PO-4500012346"),
         "Invoice: printed name not in the master -> Incomplete (correct it to teach the alias)"),
        ("03-invoice-same-supplier-later.pdf",
         invoice_pdf(supplier="NW Supply Wholesale Div.", invoice_number="NW-20517", po_number="PO-4500012346"),
         "Invoice: same unfamiliar name - matched automatically once 02 is corrected"),
        ("04-invoice-po-other-supplier.pdf", invoice_pdf(po_number="PO-4500099999", invoice_number="NW-20530"),
         "Invoice: PO belongs to another supplier -> Incomplete"),
        ("05-passport-valid.pdf", passport_pdf(), "Passport: MRZ valid, printed zone consistent"),
        ("06-passport-discrepancy.pdf", passport_pdf(discrepancy=True), "Passport: printed number/birth date differ from MRZ"),
        ("07-passport-expired.pdf", passport_pdf(expiry=date(2024, 1, 31)), "Passport: expired"),
        ("08-transcript-valid.pdf", transcript_pdf(), "Transcript: credits and GPA recalculate to the stated values"),
        ("09-transcript-gpa-discrepancy.pdf", transcript_pdf(stated_gpa="3.72", stated_credits="25"),
         "Transcript: stated GPA and credits do not match the courses"),
        ("10-insurance-certificate-expiring.pdf", _insurance_certificate(date.today() + timedelta(days=45)),
         "Any document: policy expires in 45 days -> Expiring soon"),
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--api", default="http://127.0.0.1:8001")
    parser.add_argument("--bearer", default=None, help="Admin API key (needed when RBAC is enforced).")
    parser.add_argument("--write-only", action="store_true")
    args = parser.parse_args()

    OUTPUT.mkdir(parents=True, exist_ok=True)
    docs = documents()
    for name, content, _ in docs:
        (OUTPUT / name).write_bytes(content)
    print(f"Wrote {len(docs)} demo PDFs to {OUTPUT}")
    if args.write_only:
        return 0

    headers = {"Authorization": f"Bearer {args.bearer}"} if args.bearer else {}
    with httpx.Client(base_url=args.api, headers=headers, timeout=120) as client:
        for path, body in (("/api/reference/suppliers", SUPPLIERS), ("/api/reference/purchase-orders", PURCHASE_ORDERS)):
            response = client.post(path, json=body)
            if response.status_code != 200:
                print(f"{path}: HTTP {response.status_code} {response.text[:200]}")
                return 1
        print(f"Loaded {len(SUPPLIERS)} suppliers and {len(PURCHASE_ORDERS)} purchase orders.")

        for name, content, purpose in docs:
            upload = client.post("/api/documents/upload", files={"file": (name, content, "application/pdf")})
            if upload.status_code not in (200, 201):
                print(f"{name}: upload HTTP {upload.status_code} {upload.text[:200]}")
                continue
            document_id = upload.json()["document_id"]
            # The same two jobs the upload screen runs: process, then extract
            # the discovered fields (which also stages the document).
            _wait(client, client.post(f"/api/documents/{document_id}/jobs/process").json())
            targets = client.get(f"/api/documents/{document_id}/targets").json().get("targets", [])
            ids = [t.get("id") or t.get("key") for t in targets if t.get("id") or t.get("key")][:50]
            if ids:
                _wait(client, client.post(
                    f"/api/documents/{document_id}/jobs/extract", json={"target_ids": ids, "use_ai_fallback": False}
                ).json())
            workbook = client.get(f"/api/documents/{document_id}/staging-workbook").json()
            profile = (workbook.get("profile") or {}).get("profile_id")
            print(f"\n{name}  [{profile}]  - {purpose}\n  /documents/{document_id}")
            for line in _summary(workbook):
                print("  " + line)
            expiry = client.get(f"/api/documents/{document_id}/key-dates").json().get("expiry")
            if expiry:
                print(f"  Expiry: {expiry['date']} ({expiry['status']}, {expiry['days_remaining']} days) from {expiry['source']}")
    return 0


def _wait(client: httpx.Client, job: dict, timeout_s: int = 300) -> dict:
    state = job
    for _ in range(timeout_s):
        state = client.get(f"/v1/jobs/{job['id']}").json()
        if state.get("status") in ("complete", "completed", "failed"):
            break
        time.sleep(1)
    return state


def _summary(workbook: dict) -> list[str]:
    datasets = {d["dataset_id"]: d for d in workbook.get("datasets", [])}

    def rows(dataset_id: str) -> list[dict]:
        return [{k.split(".")[-1]: c.get("value") for k, c in r["cells"].items()} for r in datasets.get(dataset_id, {}).get("records", [])]

    lines = []
    for row in rows("erp_staging")[:1]:
        lines.append(f"Recognition status: {row.get('value')} - {row.get('status')}")
    for row in rows("passport_data"):
        if row.get("consistency") in ("Mismatch",):
            lines.append(f"Discrepancy: {row.get('name')}: printed {row.get('printed')} vs MRZ {row.get('mrz')}")
    for row in rows("mrz_checks"):
        if row.get("result") != "PASS":
            lines.append(f"MRZ: {row.get('name')} {row.get('result')}")
    for row in rows("validity"):
        lines.append(f"Validity: {row.get('status')} (expires {row.get('expiry_date')})")
    for row in rows("academic_checks"):
        if row.get("name") in ("Total credits", "Cumulative GPA"):
            lines.append(f"{row.get('name')}: recalculated {row.get('computed')} vs stated {row.get('stated')} -> {row.get('result')}")
    return lines


if __name__ == "__main__":
    raise SystemExit(main())
