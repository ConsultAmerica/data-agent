# FAR Master Reference Data Manifest

Source of truth: `reference/schemas/part_52_FAR_Master_FINAL.xlsx` (read directly, all sheets, Phase 1 —
2026-09-22). This is **read-only reference data** — a normalized extraction of FAR Part 52 (Solicitation
Provisions and Contract Clauses) from `part_52(1).html`, SHA-256 `97773555ed68fdcb91d2f74974876e841e554206d40a6b0dcefa316f4483e38f`,
extraction version `FAR-MASTER-1.0`. Per the workbook's own README sheet: "Production-oriented reference
master for Dataomatix ingestion after verification."

7 sheets, all visible, no hidden sheets.

## 1. FAR Master (the primary lookup table)

760 rows (757 real records per the QA Review sheet's self-reported count; +3 for header/title rows).
Primary key: `FAR Record ID` (e.g. `FAR-52.204-21`). Join key for contract-derived clause numbers:
**`FAR Number`** (e.g. `52.204-21` — no leading `FAR-` prefix, matches the bare number a contract states).

| Column | Notes |
|---|---|
| FAR Record ID | PK, `FAR-<number>` |
| FAR Number | **join key** — bare dotted number, e.g. `52.202-1`, `52.204-21` |
| Official Display Title | Full display string including number, e.g. `"52.202-1 Definitions"` |
| Record Type | Enum, 4 values observed (see counts below) |
| Effective Date | String, e.g. `"Jun 2020"` — **note casing differs from contract text** (`JUN 2020` in V3 ground truth, `Jun 2020` here) — normalize case before comparing |
| Prescribed In | FAR citation of where this provision/clause is prescribed, e.g. `"2.201"` |
| Prescription Text | The "As prescribed in X, insert the following..." sentence |
| Alternates | Populated only when the record has alternates (cross-reference to Alternates sheet); `None` otherwise |
| Reserved | `"Yes"` / `"No"` string flag |
| HTML ID | Internal anchor id, e.g. `FAR_52_202_1` |
| Clause / Provision Text | The clause/provision body text (first ~portion in some rows, full in others) |
| Clean Body Text | Prescription + title + date + full body, cleaned |
| Raw Body Text | Same as Clean Body Text in sampled rows (no observed divergence) |
| Source File | `"part_52(1).html"` throughout |
| Source SHA-256 | Constant, workbook-wide |
| Extraction Version | `"FAR-MASTER-1.0"` constant |

**Record Type distribution (all 757 records):**

| Record Type | Count | Meaning |
|---|---|---|
| `Clause` | 482 | An actual FAR contract clause |
| `Reserved` | 136 | A `[Reserved]` placeholder number with no content |
| `Provision` | 128 | A solicitation *provision* (offeror-facing, not a contract clause) |
| `Instruction / Scope / Section` | 11 | Subpart/section-level scope/instruction text (e.g. `52.101 Using Part 52.`), not a clause or provision at all |

**This Record Type field is the primary validation signal**: a contract-extracted "clause number" only
counts as a legitimate FAR *clause* if the matching FAR Master row has `Record Type == "Clause"`. If it
resolves to `Provision`, `Reserved`, or `Instruction/Scope/Section`, the contract's usage is either wrong,
a citation of something else, or the number doesn't exist in FAR — any of those should route to QA, not be
silently accepted as a Clauses-sheet row.

Confirmed via direct lookup (both are `Record Type = "Clause"`, both validate cleanly against the
regression and ground-truth contracts' clause listings):
- `52.202-1` → Official Display Title `"52.202-1 Definitions"`, Effective Date `"Jun 2020"` — matches V3
  ground truth's Clauses row 4 (`Clause Title = "Definitions"`, `Effective Date = "JUN 2020"`) exactly
  modulo case.
- `52.204-21` → `"52.204-21 Basic Safeguarding of Covered Contractor Information Systems"`, `"Nov 2021"` —
  matches the regression contract's Section I clause listing (`FAR 52.204-21 Basic Safeguarding of
  Covered Contractor Information Systems`) exactly.

## 2. Paragraphs

11,790 rows. Sub-paragraph-level breakdown of every FAR Master record (`FAR Record ID`, `FAR Number`,
`Sequence`, `Paragraph Label` e.g. `"(a)"`, `Clean Paragraph Text`, `Raw Paragraph Text`, `Paragraph HTML
ID`, `Parent HTML ID`). Not needed for clause-presence validation/enrichment — this is fine-grained
citation-level detail (e.g. "does the contract's evidence text match paragraph (a) specifically"), out of
scope unless a future QA rule needs paragraph-level provenance matching.

## 3. Cross References

1,882 rows. `FAR Record ID`, `FAR Number`, `Referenced Text`, `Href`, `Parent HTML ID` — internal FAR
cross-reference graph (which sections reference which other sections). Not needed for the V3 pipeline's
Clause/FAR-Reference/DFARS routing — this is FAR-internal navigation data, unrelated to contract-to-FAR
matching.

## 4. Alternates

222 rows. `Alternate Record ID`, `Parent FAR Record ID`, `FAR Number`, `Alternate` (e.g. `"I"`, `"II"`),
`Alternate Effective Date`, `Alternate Source Text`, `Parent HTML ID`. **Directly relevant**: the V3
ground-truth Clauses sheet has an `Alternate / Deviation` column (blank in the sampled ground-truth rows,
but populated in the regression contract, e.g. `"FAR 52.216-32 Task-Order and Delivery-Order Ombudsman
(Alternate I)"`). When a contract cites `52.216-32 Alternate I`, this sheet is where you'd look up whether
that alternate actually exists for that FAR number and what its stated effective date is, distinct from
the base clause's effective date.

## 5. Subparts

6 rows. Just the top-level Subpart 52.1/52.2/52.3 metadata (title, source file/hash). Not needed for
per-clause validation.

## 6. QA Review

24 rows (only 5 shown in this manifest's sample — see raw dump for full list). Self-describing metadata
about the FAR Master extraction itself: source file, SHA-256, extraction version, `"FAR Master records:
757"`, `"Clause records: 482"`. This is **metadata about the reference dataset**, not a QA mechanism to
reuse for contract-level QA Review — do not confuse this sheet with the V3 QA Review sheet.

## 7. README

Static: purpose statement, source file, SHA-256, extraction version, and explicitly documents:
- **Primary Key**: `FAR Record ID`, e.g. `FAR-52.204-21`
- **Machine Join Key**: `FAR Number`, e.g. `52.204-21`

This confirms `FAR Number` (not `FAR Record ID`) is the intended join key for matching contract-extracted
clause numbers — no `FAR-` prefix needed on the contract side.

---

## How FAR Master should validate/enrich contract clauses (per the P0 prompt's own rule + what the data supports)

The P0 prompt is explicit: **"FAR Master must never determine that a clause exists in a contract. Contract
evidence determines clause/reference presence."** The data in this workbook supports exactly that flow and
no other:

```
1. Contract evidence (a clause-citation line, e.g. "52.202-1 Definitions JUN 2020" from a
   Section I / "incorporated by reference" listing) is detected by CONTRACT-SIDE extraction.
   -> this determines a clause candidate EXISTS. FAR Master is not consulted yet.

2. Classify: is this citation in an "incorporated clauses" listing (-> Clause candidate) or
   incidental narrative ("in accordance with FAR X.X")? (-> FAR Reference candidate, skip step 3-4)

3. Normalize the cited number to FAR Master's join key format (strip "FAR "/"DFARS " prefix,
   keep the bare dotted number, e.g. "52.202-1").

4. Look up FAR Number in FAR Master:
   - Not found at all -> QA Review ("unmatched FAR clause" — the P0 prompt's own QA category).
   - Found, Record Type != "Clause" (i.e. Provision/Reserved/Instruction) -> QA Review
     ("contract cites X as a clause but FAR classifies it as a Provision/Reserved/Instruction").
   - Found, Record Type == "Clause":
       - Compare contract's stated title against Official Display Title -> flag QA on mismatch
         ("title mismatch", another P0 QA category).
       - Compare contract's stated date against Effective Date (case-insensitive) -> flag QA on
         mismatch ("date mismatch", another P0 QA category).
       - If contract cites an Alternate, look it up in the Alternates sheet by FAR Number +
         Alternate id -> flag QA if the cited alternate doesn't exist for that FAR Number.
       - Otherwise: enrich the persisted V3 Clauses record with FAR Master's canonical title/date
         (or keep the contract's own text as primary and store FAR Master's as a
         validation/enrichment side-channel — implementation decision, not a data question).

5. Persist the V3 record. FAR Master was consulted only to VALIDATE/ENRICH a candidate that
   contract evidence already established — it was never the source of the candidate itself.
```

**DFARS clauses (252.xxx-x) are not in this FAR Master workbook at all** — it is FAR Part 52 only. There is
currently **no equivalent master reference file for DFARS** provided. DFARS clause candidates from the
contract can still be extracted and routed to the V3 DFARS sheet (contract evidence alone is sufficient
per the ground-truth DFARS sheet, which carries no FAR-Master-style enrichment columns — just Regulation/
Number/Title/Date/Incorporation Type/Source Page/Evidence/QA Status, all populated directly from contract
text). Validation/enrichment against an authoritative DFARS master is **not possible in this phase** —
flag as a known limitation, not a blocker (DFARS records can still be `Verified` from contract evidence
alone, same as the ground-truth DFARS sheet demonstrates).

**GSAR clauses (552.xxx-x, seen in the regression contract)** have no master reference file either. Same
treatment as DFARS: extract and route from contract evidence alone, no external validation available yet.
