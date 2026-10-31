# Increment 7.3.3 — Phase B: Oracle Fusion mapping workspace

Branch `feature/di-02-safety-foundation`. **Not committed, pushed or deployed. Nothing is written to Oracle.**
Phase A and A.1 are also uncommitted on this branch.

## 1. Summary

Phase B extends the Oracle template and mapping system Dataomatix already had (Template Manager, Mapping Designer,
versioned profiles, CSV export). It isn't a second mapping system. What's new:

- **Target catalog:** each registered target is grouped by Oracle application and integration method, with release,
  object code, parent object, user keys, source and status (Verified / Draft / Unsupported / Stale).
- **Verified schema registration:**
  - an official template, with its attribute definitions (data type, length, precision, scale, required, lookup,
    description) read from the workbook or from a separate definitions file;
  - or a REST object from Oracle's metadata API (`describe`), when an environment is configured;
  - targets are Draft until an administrator verifies them.
- **Mapping workflow:** Select Oracle object → Map fields → Validate → Preview → Save profile. It is reached from
  **Map to Oracle Fusion** on the document page.
- **Transformations:** 13, each configurable and previewed. Source values are never changed.
- **Validation:** checks against the target's attributes. Each attribute has a state (Valid / Warning / Error /
  Needs Review / Not Configured), kept apart from extraction confidence.
- **Contract isolation:** checked for headers, lines and parent links.
- **Profile lifecycle:**
  - Draft → Activate (approval) → Archive, plus Duplicate and Compare versions;
  - approvals don't carry over to changes, and a profile stays on its schema version;
  - every change is an audit event.
- **FAR / DFARS clause source model:** the document's cited clauses, once each, by regulation family. No Oracle clause
  object is assumed.

## 2. Gap analysis: what existed and what was added

| Area | Already in place | Added in Phase B |
|---|---|---|
| Template storage | `oracle_templates`: file kept byte for byte, parsed technical names, labels, `*` required marks, versions per object, retire, workspace scoping | Catalog metadata (`catalog` JSON) and status. Attribute definitions merged into each column. Metadata-discovered targets. |
| Mapping profiles | `oracle_mapping_profiles`: spec (sources, transform, keys, parent links), version counter, history of actor and time | `status`, `created_by`, `approved_by/at`, `source_document_type`. Per-version snapshots for Compare. Duplicate, activate, archive. Schema pinning flag. Audit events table. |
| Sources | Staging workbook (the Advanced Grid's data): single, pair and column fields with page, evidence and review status | Each field's section and extraction quality (validation passed / failed / not checked). Clause records. |
| Suggestions | Exact name, display label, synonym, similar wording, previously saved mapping; confidence and reason | Required flag. Always "needs approval". Data-type fit adjusts the score and says so. Attribute-description match. Aliases configurable (`aliases.json` + `ORACLE_MAPPING_ALIASES_PATH`). Only **approved** profiles are learned from. |
| Transformations | as is, trim, upper, ISO date, number | lower, title, currency (decimals, expected code), default, lookup table (with optional fallback), conditional, split (date range or address-block parts, or n-th piece), concatenate (several sources), and date output format. |
| Validation | Required unmapped or empty, failed conversion, unreviewed source, key blanks and duplicates, parent orphans, template mismatch, missing source | Attribute data type, length, precision and scale, lookup values, duplicate mapping, unconfigured lookup or split, shared source (info). Schema status (unsupported / retired = error; draft / newer version = warning). Multiple contracts in one record, rows of several contracts under one parent, conflicting contract numbers. Per-attribute states. |
| Preview | Built rows (50), issues, import-ready, unmapped fields | Each cell's source value, each mapping's transformation in words, per-attribute states, schema status, and the parent object's records. |
| Oracle connection | `oracle_base_url`, `oracle_api_version`, `oracle_dry_run` (send integration) | Read-only metadata discovery adapter. Credentials (`ORACLE_METADATA_USERNAME/PASSWORD`) stay server-side. |
| UI | Mapping Studio (template list, detail, upload), Mapping Designer (document, fields, mapping table, preview), links from Smart Review and verification | Catalog grouping and status badges, catalog editor, Verify, attribute-definition upload, discovery card, not-configured states, target picker, attribute details, validation-state badges, Accept / Reject on suggestions, transformation settings, Activate, Versions / History / Compare / Duplicate / Archive, mapped-values and parent previews, **Map to Oracle Fusion** on the document page. |
| Security | RBAC (`documents.view`, `oracle.preview`, `admin.integrations`), workspace scoping, export audit log | Approval also needs `review.accept`. Catalog changes need `admin.integrations`. Credentials never reach the frontend. |

Not touched: the Original File layout and its three-column export, the Advanced Grid, staging, the structure reader,
review history, and the Oracle send integration.

## 3. Database changes

Migration `a7c9e1f3b5d7_oracle_mapping_workspace` (down-revision `d5f7b9c1e3a6`), plus a matching local-dev
column patch in `app/database/oracle_mapping_columns.py`:

- `oracle_templates.catalog` (JSON, nullable). A template from before Phase B reads as an unverified Draft, so
  existing exports keep working.
- `oracle_mapping_profiles`: `status` (default `draft`, indexed), `created_by`, `approved_by`, `approved_at`,
  `source_document_type`.
- New table `oracle_mapping_audit_events`: profile id and version, template id, action, actor, workspace, detail
  and time. It is indexed and has no foreign keys, so the history outlives what it describes.

Target attributes live in each template's `columns` JSON, and a template version is its schema version.
Validation results and previews are computed on request, not stored. Document content is never copied into the
mapping tables. Upgrade, downgrade and re-upgrade were checked on a fresh SQLite database.

## 4. Backend services and APIs

| Module | Role |
|---|---|
| `app/oracle_templates/catalog.py` (new) | Applications, integration methods (Import Management only for Sales and Service; FBDI and REST for the ERP and Project applications), statuses, catalog edits (identity changes withdraw verification), verification, required attributes. |
| `app/oracle_templates/discovery.py` (new) | `MetadataProvider` interface: `NotConfigured` and `FusionRestDescribe` (`GET {base}/{root}/resources/{version}/{resource}/describe`, read-only, basic auth, 20 s timeout, 5 MB cap, resource-name validation). Describe parsing and template columns. |
| `app/oracle_templates/parser.py` | Attribute definitions: from a template workbook's own sheet, or an uploaded CSV or XLSX. |
| `app/oracle_templates/mapping.py` | Transformations (`apply_mapping`, `explain`), attribute checks, `column_states`, `contract_numbers` (tables vs fields, solicitation numbers excluded), `clause_records`, configurable aliases. |
| `app/oracle_templates/aliases.json` (new) | Source-side alias groups, such as award amount / contract amount. |

New and changed endpoints:

- Under `/api/oracle`:
  - `GET catalog`, `PUT templates/{id}/catalog`, `POST templates/{id}/verify`, `POST templates/{id}/attributes`;
  - `GET discovery`, `POST discovery/register`;
  - `POST profiles/{id}/duplicate|activate|archive`, `GET profiles/{id}/versions|compare|history`.
- Under `/api/documents/{id}/oracle`: `GET clauses`.
- **Upload:** `POST /api/oracle/templates` now also takes application, method, release, object code, parent object
  and user keys.
- **Preview:** now returns states, transformation explanations, schema status, the parent's records and source values.
- **Export:** CSV export refuses REST targets.

## 5. Frontend mapping workspace

- **Mapping Studio** (`src/app/mapping/page.tsx`):
  - registration with Oracle application and integration method, plus release, object code, parent object and user
    keys in an expandable panel;
  - templates grouped by application, each with its status;
  - a catalog panel: the target's details, **Edit target details**, **Attribute definitions** upload and **Verify**;
  - type, length and lookup columns, and the metadata-discovery card;
  - "Oracle import template not configured" when nothing is registered.
- **Mapping Designer** (`components/mapping/mapping-designer.tsx`):
  - **Target picker:** opened without a template, it lists targets by Oracle application, or shows the not-configured
    message.
  - **Status:** target and profile status badges; a note that only a verified target is import-ready; a newer
    schema version offered, never applied.
  - **Mapping table:** each target attribute's type, length and lookup; a source picker; a transformation menu with a
    settings panel and the transformation in words; the extracted value under the preview value; **Accept / Reject**
    on suggestions; a validation-state badge.
  - **Profile actions:** **Activate**, plus **Versions** (Compare, History, Duplicate, Archive).
  - **Preview tabs:** **Mapped values** (Source value | Target attribute | Preview value | Transformation | Status,
    configured mappings only), Records, **Parent records**, Validation, Unmapped.
  - **Fields panel:** page, review status, and a "check failed" flag.
- **Document page:** **Map to Oracle Fusion** opens the designer's target picker for the document. The verification
  workspace's link is renamed to the same.

## 6. Oracle target catalog

Applications: Enterprise Contracts, Procurement, Financials, Project Management, Sales and Service, and Other.

Integration methods:

- **Import Management:** Sales and Service only.
- **FBDI:** ERP and Project applications.
- **REST:** all.
- **Other:** never supported.

Status rules:

| Status | When | Effect |
|---|---|---|
| Verified | An administrator verified it for its application, method and release | Can be import-ready; profiles can be approved |
| Draft | Registered, application or method not set, or not yet verified (all pre-Phase-B templates) | Mapping and preview work; a warning says it isn't verified; profiles can't be approved |
| Unsupported | The method isn't the application's, or is "Other" | Error: never import-ready; can't be verified |
| Stale | Retired, or a newer version of the object is registered | Retired: error. Newer version: warning; existing profiles stay pinned |

**Production has no Oracle templates yet.** Nothing is pre-populated: no fake objects or attributes. A real FA30 →
Enterprise Contracts profile needs an official template (FBDI "Import Contracts" or a REST `contracts` describe),
registered and verified by an administrator.

## 7. Verified template registration

- **Method A, upload:**
  - the template file is parsed as before;
  - attribute definitions are read from a workbook sheet whose header names an attribute column and at least one
    property column (Data Type, Length, Precision, Scale, Required, Lookup, Description), or uploaded separately;
  - `VARCHAR2(30)`, `NUMBER(18,2)`, `INTEGER`, `DATE` and `TIMESTAMP` are understood;
  - definitions naming no attribute are reported, and a file whose definitions match none is refused;
  - a non-template file is refused with a reason, as before.
- **Method B, discovery:** off unless `oracle_base_url` is a real HTTPS host (not the example host) and both metadata
  credentials are set. It reads one resource's `describe` metadata and registers a Draft REST target: types, lengths,
  precision, required, lists of values, and child resources noted.

## 8. Reusable mapping profiles

Each profile carries:
- id and name;
- source document type and staging profile;
- the target (template id, so application, object, method and release) and schema version (template version);
- its mappings, transformations and options;
- created by, updated by, and approved by and when;
- status and version, with a per-version snapshot.

Lifecycle:
- **Save Draft:** a new version. Saving an **active** profile makes a new draft and clears the approval.
- **Activate:** needs `review.accept`, a verified current target, no unknown attributes and every required
  attribute mapped.
- **Duplicate:** a new draft, version 1.
- **Archive:** kept for history.
- **Compare versions:** each attribute added, removed or changed, plus changed settings.
- **History:** audit events.

A newer target version never changes an existing profile; the profile reports `schema_update_available`.

## 9. Validation and preview

States per attribute:
- **Error:** any error on it.
- **Not Configured:** unmapped.
- **Needs Review:** valid, but its source value still needs review.
- **Warning** and **Valid.**

Mapping validity is never mixed with extraction confidence. Example on the illustrative FA30 values (test template):

| Source value | Target attribute | Preview value | Transformation | Status |
|---|---|---|---|---|
| FA300224C0008 | ContractNumber | FA300224C0008 | Direct | Valid |
| 21 Apr 2023 | EffectiveStartDate | 2023-04-21 | Date conversion to YYYY-MM-DD | Valid |
| USD 24,131,140.28 | EstimatedAmount | 24131140.28 | Currency normalization to 2 decimals | Needs Review (value not yet reviewed) |

The target attributes in this example come from a test template, not from Oracle.

## 10. Automated tests

| Suite | Result |
|---|---|
| Backend: Phase B (`tests/test_oracle_mapping_workspace.py`, new) | **36 passed** |
| Backend: existing Oracle (`test_oracle_templates.py`, `test_rbac_oracle_certification.py`) | **36 passed** |
| Backend: full | _see below_ |
| Frontend: mapping (`mapping-studio.test.tsx` +3, `mapping-designer.test.tsx` new, 6) | **12 passed** |
| Frontend: full | _see below_ |

The acceptance list is covered as follows:

1. **Verified schemas:** a draft until verified; the catalog by application.
2. **Unsupported or malformed:** wrong method for the application, unknown application, user keys that aren't
   attributes, a non-template, bad or unrelated definitions.
3. **Attributes:** definitions from a CSV and from a workbook's own sheet.
4. **Suggestions:** required, needs approval, data-type fit, configurable aliases.
5–7. **Manual mapping and validation:** required, data type, length, precision, lookup, and per-attribute states.
8. **Transformations:** every one, including failures that never guess (17 cases), and concatenation that keeps the
   source value.
9–10. **Parent-child and contracts:**
   - orphan rows;
   - rows of two contracts under one parent;
   - a header over a two-contract table;
   - a solicitation number not taken for a second contract.
11. **Profiles:** draft → approved (an analyst is refused) → changed (back to draft) → compare → duplicate → archive →
    history; approval refused for a draft target or an unmapped required attribute; pinning after a newer version.
12. **Tenant isolation:** another workspace's targets and profiles are invisible (404), and no credential appears.
13. **Preview:** source and target values, transformation text, states, parent records.
14. **Missing template and discovery:** "Oracle import template not configured"; discovery refused without a
    connection; a mocked describe registers a typed Draft REST target, which export refuses; the example host or
    missing credentials keep discovery off; a path-traversal resource name and empty describe responses are refused.
15. **Regression:** the existing Oracle tests, plus the full suites.

## 11. Screenshots

_see below_

## 12. Known limitations

1. **No real Oracle schema is registered.** Production, and local development, have no official Oracle templates, so
   no profile can reach Verified or import-ready yet. The FA30 profile named in the spec needs that template first.
2. **Discovery is untested against a live Oracle environment.** The `describe` parsing follows Oracle's documented
   shape but was exercised only with a mocked response. Import Management's own object catalog and FBDI control files
   aren't called. Listing every available resource isn't implemented: an administrator names the resource.
3. **AI semantic matching isn't implemented.** It is optional in the spec, and suggestions stay deterministic.
4. **Lookups are checked only against values the template or definitions list.** Lookup types from Oracle (a REST
   list of values) are noted, not fetched.
5. **Workspace (anonymous) users can view but not map.** That role has no `oracle.*` permission, so they can see
   their workspace's targets but not create mappings. A signed-in analyst, reviewer or admin is needed; the RBAC
   matrix is unchanged.
6. **Multi-contract detection relies on contract-number columns.** It uses tables with a Contract Number column; a
   multi-contract document whose tables don't name the contract isn't detected. Conflicting label/value contract
   numbers give a warning only.
7. **Clause mapping:** clauses can be mapped like any table columns, but only to a registered target that has clause
   attributes. No Oracle clause object is assumed. Clause recognition and library matching are Phases C and D.
8. **Export is the existing CSV export,** kept for file-based targets. REST targets are preview-only. Final import-file
   generation is out of scope.
9. **The split transformation's part list** in the UI offers the parts Dataomatix splits (date range, address block).
   Other composites need the separator option.

## 13. Phase C readiness

- **Clause source model:** `ClauseRecord` (clause id, title, FAR / DFARS / agency supplement, contract, page,
  evidence, text, also-in tables) and `GET /api/documents/{id}/oracle/clauses`. FA30 gives 205 unique clauses: 129
  FAR, 69 DFARS and 7 agency supplement. Phase C's recognition can replace this source while keeping the shape.
- **Clause attributes in the mapping:** mapping clause tables to a clause-capable target already works through the
  existing repeating-dataset mapping, with parent links and contract isolation.
- **Before Phase C:** register and verify the actual Oracle target that will hold clauses (for example Enterprise
  Contracts' terms or clauses import, from its official template), so clause mapping has a real schema.
