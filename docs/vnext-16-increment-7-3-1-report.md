# Increment 7.3.1 — Unified Verification Workspace & Intelligent Field Cards

Branch `feature/di-02-safety-foundation`. Nothing is committed, pushed or deployed.

## Phase 1 — Audit (what existed, what was reused)

| Area | Existing component / API | Gap before 7.3.1 |
|---|---|---|
| Source & PDF viewing | `components/viewers/document-viewer.tsx`, `source-verification-panel.tsx`, `pdf-page-viewer.tsx`: page navigation, zoom, fit, rotate, search, region highlight, next-page prefetch | Source was a top section, not a side panel. No reverse selection from the page |
| Extracted fields | `original-structure-view.tsx` (layout grid), `business-data-view.tsx` (7.3 cards), `ucf-field-review.tsx` (`/extraction/new`) | Cards weren't reusable; no density; no expand, history or view-source on a card |
| Staging Workbook / Advanced Grid | `document-workspace.tsx` Advanced Grid; `lib/table-selection.ts` cell selection store | Grid selection was separate from the record selection |
| Record details | 7.3 `RecordPanel` inside Original Structure only | No shared drawer; no correction history |
| Validation | `/validation-summary`, `ValidationView`, `DocumentValidationPanel` | Counts were one total |
| Review & approval | `/original-structure/review` (7.3), metadata review state machine | No bulk approve; no per-record history read |
| Classification | `ClassificationPanel`, `/classification` | — (reused in Summary and History) |
| Oracle mapping | `useOracleMappings`, `OracleIntegrationPanel`, Mapping Studio | — (reused in drawer and tab) |
| Export | Export menu, `/original-structure/export*.xlsx`, `/all-fields.csv`, `/structured.json`, custom export, Oracle templates | — (reused; selection export kept) |
| Selection | `lib/record-selection.tsx` (shared, link-aware) | Not linked to the Advanced Grid |

No component was duplicated: 7.3's views, panels and APIs are extended in place.

## What was built

### Workspace layout (Phase 2)
- **Tabs, in order:** Original Structure, Smart Review, Advanced Grid, Tables, Validation,
  Oracle / Mapping, History, Summary. Summary stays last.
  - Tables is hidden when the document has no tables. Oracle / Mapping is hidden for
    identity and academic documents.
  - The earlier Smart View remains under "More views".
- **Three panels on desktop:** source document (left) | extracted information (centre) |
  record details (right).
  - Both side panels have drag handles. Keyboard arrows also work on the handles.
  - Widths are remembered per browser.
  - The source panel can be hidden and reopened, and the details drawer closes.
  - The source panel is sticky, so it stays readable while the centre scrolls.
- **Below the `lg` breakpoint** the panels stack: source, then data, then details. There
  is no horizontal scroll at 390 px.
- **Above the panels:**
  - separate review counts: Missing values · Validation failures · Conflicting candidates
    · Pending review;
  - a debounced (250 ms) search over fields, values and table rows;
  - a Compact / Comfortable density switch, remembered per browser.
- **Advanced Grid** is unchanged and keeps its own split viewer. Smart Review complements
  it rather than replacing it.

### Intelligent field cards (Phase 3)
`components/verification/field-card.tsx` is reusable and memoised. Each card shows:
- selection checkbox, human-readable label and required marker;
- the effective value, which opens its source when clicked;
- three separate chips: **confidence %** (or "Printed" when read from the layout),
  **validation** and **review**;
- the source page.

Actions:
- expand / collapse (evidence, issues, every competing candidate);
- view source;
- inline correction (the printed value is kept);
- approve, reject, review history.

Compact density renders each card as one dense, wrapping row, for documents with hundreds
of fields.

### Document-aware sections (Phase 4)
Smart Review uses the 7.3 document skills.
- **Contracts:** Contractor Information, Contract Information, Contract Values, Contract
  Dates, Period of Performance, Contacts, Contract Lines, Clauses, Deliveries,
  Modifications.
- **Invoices:** Invoice Summary, Supplier, Customer, Purchase Order Reference, Invoice
  Lines, Taxes, Totals, Payment Terms.
- **Other types** come from their skill, or show the document's own sections when no skill
  applies.

Original Structure keeps the printed headings and their order. No section is invented:
- values no category claims stay under "Other Extracted Data";
- unplaced values stay "placed by page".

### Source synchronization (Phase 5)
Selecting a field or row in any tab:
1. opens its page in the source panel;
2. highlights the exact region when the layout recorded coordinates; otherwise the page is
   searched for the text, and the header says which;
3. opens the record details drawer with original and reviewed values.

**Reverse selection:** clicking the page finds the field printed there, using only
recorded boxes (the smallest box containing the point). The click opens that field's
details and scrolls it into view. A spot with no recorded field says so; no coordinates
are generated.

### Record details drawer (Phase 2, right)
`components/verification/record-details.tsx` shows:
- original label (with its numbered item) and display label (business field and
  category);
- printed value, original extracted value and effective value;
- source evidence;
- source page, noting when no coordinates exist;
- extraction method, confidence, and validation with every issue;
- all candidates;
- review actions: Approve, Correct, Reject, and Add row for tables;
- **correction history**, loaded on demand from the new
  `GET /api/documents/{id}/original-structure/history?record_key=`. Extracted fields read
  the extraction row's audit log; other records read the layout review and its earlier
  decisions;
- Oracle mapping status.

### Validation and review (Phase 6)
- Confidence, validation and review are separate fields and separate chips everywhere.
- Field- and row-level approve, reject and correct all use the 7.3 review endpoint.
  Extracted fields go through the existing metadata review state machine, with the same
  permissions, validation gate, approved-document lock and audit log.
- **Bulk approve:** "Approve selected…" asks for confirmation first. It then approves
  each record on its own, so values that fail validation or lack permission stay
  unapproved, and the result is reported, e.g. "1 approved; 1 not approved (This value
  failed validation)".

### Selection (Phase 7)
- Individual field, section, table and row checkboxes, plus select all. Section and table
  checkboxes show a mixed (indeterminate) state. Clear selection and a selected-record
  count are in the toolbar.
- Records are selected by stable `layout:<record key>` ids.
- **The Advanced Grid is synchronized both ways** (`GridSelectionBridge`).
  - A grid cell and a layout record are linked only when page and value match uniquely on
    both sides.
  - Selecting either selects the other.
  - Links that arrive after a selection (data still loading, a reload) bring the linked
    half in.
- Selecting never approves.

### Export integration (Phase 9)
- **Selected records** export as Excel (original layout), CSV (the All Extracted Fields
  columns) or JSON.
- **The Export menu** keeps:
  - Original Structure Excel;
  - Organized Business Data Excel (staging export);
  - All Extracted Fields CSV;
  - Structured JSON;
  - Oracle templates (configured technical columns only);
  - Custom Export.
- No existing export contract changed.

### Performance
- **Windowed rendering** (`lib/use-windowed-rows.ts`) for field grids, table rows and
  value lists above 150 rows. Only the rows in view render, with spacer heights from the
  measured average row height. FA30's 1,882-field section renders 55 rows.
- **Record history** is loaded only when a drawer or card asks for it.
- **The PDF** renders one page at a time, as before.
- **Tab switching:** a tab stays mounted once opened (hidden when inactive). Switching
  back makes no request and keeps its state.
- **Data loading:** the layout, business data and validation load once per document and
  reload only after a review decision. Changing density or tab never reprocesses the
  document.

### Also fixed
- **Access log:** the log redaction hook replaced a record's arguments with None when it
  masked something (for example a highlight query), which broke uvicorn's access-log
  formatter ("Logging error … cannot unpack"). It now redacts each argument in place;
  test `test_log_redaction_args.py`.

## Tests

| Suite | Result |
|---|---|
| Frontend: `verification-workspace.test.tsx` | 13 passed |
| Frontend: workspace, Original Structure and document page together | 41 passed |
| Frontend: full suite | 629 passed |
| Backend: `test_original_structure.py` (incl. record history) | 17 passed |
| Backend: log redaction | 13 passed |
| Backend: full suite | see below |

The workspace tests cover:
- tab order, with Summary last;
- shared selection across tabs, and export of the selection;
- exact-region source, and Approve & Next;
- separate confidence / validation / review chips, and inline correction;
- find not-found, validation order, and the dates status;
- the details drawer: original, display and effective values, and history;
- the separate counts;
- density, and search filtering;
- bulk approve with confirmation and a partial-failure report;
- reverse selection only from recorded coordinates;
- Advanced Grid ↔ record selection, both ways.

**Browser walkthrough** on FA30 (288 pages), 1600×1000 and 390×844. It passed with no
console errors. It checked:
- the tabs and the separate counts;
- the three panels: source 480 px, then 600 px after dragging the handle;
- the exact region, and the drawer's contents;
- reverse selection by clicking the highlight;
- Smart Review cards, compact density and search;
- the Advanced Grid tab's existing tabs;
- windowed rows: 55 of 1,882 rendered;
- the mobile stack, with no overflow.

## Remaining gaps
1. **Grid links need unique evidence.** Advanced Grid ↔ record selection links only cells
   whose page and value identify a single record on each side. Repeated values (e.g. many
   "$0.00" cells) stay unlinked by design.
2. **Reverse selection covers fields only.** Table rows have no stored row boxes, and
   reverse selection works on unrotated page images only.
3. **Approximate scrollbar length.** Windowed rows estimate the hidden rows' height from
   the measured average, so the scrollbar length is approximate when row heights vary a
   lot.
4. **No Save Draft button.** A correction is already saved as pending (a draft) until
   approved.
5. **The aa.pdf documents used earlier were deleted from the Documents page during this
   session.** Re-upload aa.pdf to see its layout in the new workspace. Walkthroughs used
   FA30.
6. **The local backend stopped twice without a traceback during long sessions.** It now
   runs with `-X faulthandler` and logs its exit code, so a recurrence leaves evidence. It
   did not recur during this increment's checks.
