# Dataomatix Demo Walkthrough — Invoice · Passport · Transcript · Expiry

All documents and data are fictional (ICAO's "Utopia" passports; invented suppliers, students and institutions). Never demo with real passports, bank or student records.

## 1. Start a demo environment (local)

```bash
# Backend (isolated database; PO format configured; AI off)
cd backend
DATABASE_URL=sqlite:///./demo.db UPLOAD_DIRECTORY=./demo-uploads \
INVOICE_PO_FORMATS='PO-\d{10}' GEMINI_API_KEY= OPENAI_API_KEY= \
python -m uvicorn app.main:app --port 8011

# Frontend (second terminal)
cd frontend
NEXT_PUBLIC_API_URL=http://127.0.0.1:8011 npx next dev -p 3001

# Seed (third terminal): writes the PDFs to backend/demo/output and loads everything
cd backend
python scripts/demo_seed.py --api http://127.0.0.1:8011
```

Open **http://localhost:3001** (use `localhost`, not `127.0.0.1`). For a hosted demo, run the seed with `--api <backend URL> --bearer <admin key>`.

## 2. The script (≈ 12 minutes)

### Invoice — extraction, supplier/PO validation, evidence, ERP staging
1. **01-invoice-northwind-matched** → green **Not Validated** panel: supplier *S-1001*, site *SEA-MAIN*, BU *US West BU*, PO validated. Say: "Every expected field was recognized **and** matched to the supplier master and an open PO — this is IDR's *Not Validated*: ready for ERP validation."
2. Click **Split view**: the original invoice sits beside the values; each value carries its page and source text (open **Details** on a row, or the **Source** tab, to see the evidence highlighted).
3. Open **Transform → ERP Staging**: the Payables header joined to master data. "The Oracle import layout comes from your FBDI/REST template — we don't guess it."
4. **04-invoice-po-other-supplier** → **Incomplete**: "PO belongs to Contoso Laboratory Services." The PO cell is *Needs Review*.
5. **02-invoice-unfamiliar-supplier-name** → **Incomplete**: "'NW Supply Wholesale Div.' is not in the supplier master." Choose *Northwind Office Supply Company* → **Match and learn**. Status turns **Not Validated**; banner: *Dataomatix learned …*.
6. **03-invoice-same-supplier-later** (never touched) → already **Not Validated**, "Matched by learned alias". Say: "Like IDR, it learns from corrections — here as an auditable rule you can roll back."

### Passport — fields, MRZ validation, discrepancy detection
7. **05-passport-valid** → *Passport Data*: every field printed vs MRZ, all *Match*; *MRZ Validation*: all check digits PASS; header **Expiry Apr 15, 2032**.
8. **06-passport-discrepancy** → *Passport No.* and *Date of Birth* **Mismatch** (printed `UT4410257` vs MRZ `UT4410275`; `21 AUG 1990` vs `1990-08-12`) — both *Needs Review*. "Two independent readings of the same page disagree; we flag, we never pick one."
9. **07-passport-expired** → Validity **Expired**. Note: "Consistent ≠ authentic — no external verification is claimed."

### Transcript — courses, credits, GPA
10. **08-transcript-valid** → *Academic Record*: six courses with terms, credits, grades; *Credit & GPA Checks*: credits 22 = 22, GPA **3.555 → 3.55 PASS** on the printed scale.
11. **09-transcript-gpa-discrepancy** → stated GPA **3.72** and credits **25** are *Needs Review*; checks show the recalculation (78.2 points / 22 credits = 3.55).

### Expiry — any document
12. Sidebar **Expirations** → *Needs attention*: the expired passport (from the MRZ) and the insurance certificate expiring in 45 days (from "Policy Expiration Date" in its text), each linking to the page it came from.

## 3. Questions you'll get

| Question | Answer |
|---|---|
| Does it verify the passport is real? | No — it proves the document is internally consistent. Authenticity needs the issuing authority; that is a separate integration. |
| Does it learn like IDR? | Yes, deterministically: reviewer corrections become approved, auditable aliases used for every later invoice. Model training is optional and evaluated first. |
| Does it send documents to AI? | Not by default for restricted documents (passports, transcripts); external engines need an explicit approval per provider and data class. |
| Accuracy? | Measured on your documents with the benchmark harness — not claimed upfront. |
| Cheques? | Routing-number, IBAN and written-amount validators exist; the cheque profile (MICR) is next. |
