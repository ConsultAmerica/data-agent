# VNEXT-04 — Increment 3 Report: Schema & Label Designer

**Status:** implemented and tested locally; **not committed, pushed or deployed**.
**Date:** 2026-10-29 · **Base:** `main` @ `bbd7210` plus Increments 1–2 (uncommitted)
**Scope:** brief "Dataomatix VNext — Increment 3".

---

## 1. Architecture assessment (Phase 1)

Verified in the working tree before building:

| Increment | Present | Evidence |
|---|---|---|
| 1 — Oracle Template Manager | Yes | `app/oracle_templates/`, `app/api/oracle_templates.py`, migration `e5a7c9d1f3b6`, 28 tests |
| 2 — Classification | Yes | `app/classification/`, `app/api/classification.py`, migration `f6b8d0e2a4c7`, 14 tests; full backend suite 1147 passed |

What already existed for schemas:
- **Code-defined schemas:** every built-in document type is a staging profile (`app/staging/profiles/*`) with datasets, fields, labels, value types and rules. The extraction pipeline depends on them.
- **Custom field lists:** extraction models (`api/extraction_models.py`) are flat lists of extra fields, with no groups, versions or inheritance.

Design decision: the built-in profiles keep doing extraction, untouched. The designer adds a **data-defined schema layer** over the extracted data:
- **System schemas:** each profile is described as a published, read-only built-in schema.
- **User schemas:** created, extended or duplicated in the designer.
- **Field bindings:** fields are bound to extracted data with the Increment 1 references, or found by label.

So a schema decides how data is organised, labelled, validated and reviewed, and never rewrites extracted or approved values.

## 2. Database design (migration `a7c9e1f3b5d8`, additive)

| Table | Purpose |
|---|---|
| `document_schemas` | Schema: stable key, name, category, profile, family, built-in flag, owner workspace, archived time |
| `document_schema_versions` | Version (`major.minor`), status, **pinned parent version**, definition (JSON), change summary, author, submitted / published by and when, effective date |
| `document_schema_events` | Audit trail: create, edit, new_draft, submit, withdraw, publish, deprecate, archive, duplicate, import, assign |
| `document_schema_assignments` | The schema version each document is reviewed with (automatic / manual / migration); only one is current |

The brief's suggested separate tables (fields, groups, validations, inheritance, approvals, usage) are folded in as follows:
- **Fields, groups and rules:** the versioned definition JSON, validated in full on every save, which keeps published versions immutable as one unit.
- **Inheritance:** the pinned `parent_version_id`.
- **Approvals:** the version workflow, plus events.
- **Usage:** the assignments.

Verified up / down / up on SQLite; one alembic head.

## 3. What was built

| Area | Implementation |
|---|---|
| Definition language | `app/doc_schemas/definition.py`. Field types: text, number, currency, date, boolean, dropdown, email, address, identifier, signature, attachment, calculated. Groups: section, repeating (table) and nested object, up to 3 levels. Repeating groups can carry key and parent-key fields for nested tables. Field properties: id, label, description, type, required, default, allowed values, instructions, normalization, confidence threshold, visibility, evidence required, binding, calculation. Rules: required, pattern, range, allowed values, date order, sum matches total, conditional required. **Nothing is executed:** calculations are a closed set of operations, patterns are length-limited and compiled only to validate, unknown keys are rejected, and instructions are text only. |
| System schemas | `app/doc_schemas/system.py`: one published 1.0 per built-in profile (Government Contract, Invoice, Passport, Driving Licence, Transcript, FAR Regulation, FAR Final Rule, XML, Generic), plus **SF 1442** and **SF 33** as child schemas of Government Contract (inheritance). Read-only. |
| Inheritance | A child stores only its own groups and fields, its own rules, and **overrides** of inherited fields (label, description, instructions, visibility, order, required, allowed values, threshold, normalization). The parent is pinned by version, so a parent's later versions never change a published child. Validation rejects overrides of non-existent fields, duplicate ids across parent and child, and cycles (also on import). |
| Versioning | `major.minor`. Only drafts are editable; *submit* moves a version to in review, and *publish* (admin) makes it immutable. Editing a published version starts a new draft (1.0 → 1.1, or 2.0 on request). Publishing deprecates the previous published version. **Documents keep their assigned version** until explicitly migrated; the migration screen shows the field differences and affected Oracle mappings. |
| Review forms | `app/doc_schemas/resolve.py` + `components/schemas/schema-form.tsx`. Every schema renders the same way: top-level groups as tabs, sections as label/value cards (or a table view), and repeating groups as paginated tables whose nested child groups expand per row. Values come from the extraction through bindings; an unbound field is found by its label (exact, label or synonym match only). Calculated and default values are marked as such. Each value links to its page. Rules report errors and warnings **without modifying values**. |
| Field Discovery | `app/doc_schemas/discovery.py`. Proposes groups from the document's printed label/value pairs (grouped by section), single fields and tables, with labels generated from the document's own wording. For a classified document it adds the fields its type's built-in schema expects. Every suggestion is marked **found** (value, page, printed label), **suggested for this type** (not found) or **not found**. Values are never invented; a test checks that every "found" value is one the extraction produced. **This is deterministic, not an AI model**, and is labelled "Field Discovery". |
| Label layers | Kept distinct: canonical id, document's printed label, built-in or user display label, child-schema override, and Oracle display label and technical name (Increment 1, never overwritten). A label change never changes the canonical id. |
| Oracle compatibility | A version diff (`version_diff`) classifies changes as added, removed, type changed, binding changed, label changed or required changed. **Removed, type-changed or rebound fields** mark the saved Oracle mappings that read them for review. A **label-only change marks nothing**. Mapping versions and export history are untouched. |
| Import / export | JSON (`format: dataomatix.schema/1`), with own definition plus parent reference, or flattened. Import validates everything and rejects: wrong format, duplicate ids, invalid types, unknown keys, bad patterns, missing or unpublished parents, and cycles. Built-in keys are renamed. Limited to 2 MB. |
| API | `/api/schemas` (list, filter, detail, versions, save draft, new draft, submit / withdraw / publish / deprecate, archive, duplicate, extend, diff, export, import, usage, effective-by-version, field types). `/api/documents/{id}/schema-form`, `…/schema-form/preview`, `…/schema-assignment` (+ diff), `…/schema-discovery`. |
| Permissions and isolation | Read: `documents.view`. Create and edit drafts: `fields.edit_draft`. Publish, deprecate and archive: `admin.integrations`. User schemas are scoped to the owner workspace for anonymous callers, while built-ins are visible to all. Document routes use the existing per-document isolation. Every change is an audit event. |
| UI | **Schema & Label Designer** (sidebar, Intelligence & AI): **Schema Library** (search, category and status filters, version, status and document counts; new blank / extend / analyze a document with approve-or-reject of each suggestion; import; duplicate, extend, export, archive). **Designer**: searchable palette (click or drag), canvas with collapsible groups, drag-and-drop plus keyboard ↑/↓ reordering, inline label editing, field search, properties panel, rules builder, live preview against a real document (desktop / tablet / mobile, form / table), undo / redo, draft autosave, version switcher, workflow buttons, history and audit trail, and Field Discovery into the current draft. **Review form** page per document (link in the workspace), with evidence viewer and explicit version migration. |

## 4. Test evidence

| Suite | Result |
|---|---|
| `tests/test_doc_schemas.py`: labels; invalid definitions (duplicate ids, bad type, bad id, unknown rule field, bad pattern, injected keys); create → edit → submit → publish → immutable → new draft 1.1 → publish deprecates 1.0 → archive, with events; built-ins read-only; inheritance, overrides and pinning; circular inheritance; form values, label match, default and date-order rule without changing values; sum / required rules and calculated fields; nested repeating groups by parent key; document keeps its version, explicit migration and diff; discovery found / expected with no invented values, approving a subset; label change harmless vs removal flags a mapping; export / import round trip and rejection; workspace isolation and publish/archive permission (403) under enforced RBAC; merge never mutates the parent | **20 passed** |
| Increment 1 / 2 suites | `test_oracle_templates.py` 28 passed · `test_classification*.py` 14 passed |
| Backend full suite | **1167 passed, 13 skipped, 0 failed** (stress test excluded, as before) |
| Frontend: `components/schemas/__tests__` (merge, form renderer with tabs, evidence and paging, designer add-field and autosave, inherited edit as override and hide, rule builder, read-only published version, publish, library discovery approve/reject) | **8 passed** |
| Frontend full suite | **494 passed / 81 files** (`--maxWorkers=2`) |
| Type check / lint on new files | clean |

**Browser walkthrough** on the local app (screenshots taken):
1. **Library** lists the 11 built-in schemas, with SF 1442 and SF 33 shown as inheriting Government Contract.
2. **Discovery:** New schema → *Analyze a document* on `f1_digital_simple.pdf` proposes **54 found fields, 2 tables and 15 more expected for invoices**, marked not found and unticked. Values are real (Invoice BOS-24-1187, Terms Net 14).
3. **Edit and save:** the draft opens in the designer (69 fields in groups). Adding a *Date* field, renaming it "Payment Due Date" and marking it required autosaved ("All changes saved").
4. **Live preview:** on the invoice in mobile and desktop views, it shows the form with the new required field as **not found** and the rule error. Nothing was invented.
5. **Publish:** the version becomes *Published* and the designer switches to read-only.
6. **Contract form:** FA300224C0008's *Review form* uses the built-in **Government Contract v1.0** (assigned automatically and kept), with tabs and real row counts (421 line items, 200 clauses) linked to the page evidence.

## 5. Limitations

- **"AI" field discovery is deterministic.** It uses the existing extraction (key-values, tables, printed labels) plus type expectations. An LLM step could be added behind the existing provider policy; its suggestions would still need approval.
- **Schema-driven extraction reuses the existing extraction.** Schemas select, organise, label and validate what the pipeline extracts; unbound fields are found by label. A field whose value the pipeline never extracted shows as **not found**. Instructions are stored for reviewers and future extraction steps, but they don't yet drive a new extraction call. Turning instructions into targeted (AI) extraction is the next step.
- **Discovery quality follows the key-value extractor,** so some proposals are noisy (e.g. "Subtotal → USD"). Every proposal can be unticked.
- **Built-in schemas are generated once.** If a profile changes later, its system schema isn't re-versioned automatically.
- **Drag-and-drop** uses native HTML5 events; keyboard users reorder with the ↑/↓ buttons and add with click. Cross-group moves of inherited fields are refused by design.
- **Validation rules** run when a form is built (review time), not during extraction. Lookup-list validation isn't included.

## 6. Deployment readiness

- **Migrations:** three new ones, all additive (`e5a7c9d1f3b6`, `f6b8d0e2a4c7`, `a7c9e1f3b5d8`). They run on startup and were tested on SQLite only.
- **Built-in schemas** are created on first use of the library or a form.
- **Not done:** no commit, push, deploy or production data change.
