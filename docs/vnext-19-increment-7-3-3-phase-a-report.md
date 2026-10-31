# Increment 7.3.3 — Phase A: FA30 field labels and Excel format

Branch `feature/di-02-safety-foundation`. **Not committed, pushed or deployed.** Phases B–E
(Oracle object discovery, clause recognition, clause matching, import files) are not
started.

## What changed

| Requirement | Implementation |
|---|---|
| 1.1 `Item # \| Field Name \| Extracted Value` | The Original File field columns are now these three, in the Excel and CSV exports and in the tab (followed in the tab by Evidence, Review Status, Type, Found By, Source Page). |
| 1.2–1.3 No instructional wording | `form_label()` turns a fillable form box's built-in description into its item number and field name: "2 Enter the Contract Number" → `2` \| Contract Number. It removes only clear instructions: a leading *Enter / Type / Select / Provide…*, *Click here to select "…"*, "(enter 2 digit month…)", "(if applicable)", "for this solicitation, offer, and award", "(To be completed by the Government)", and explanatory notes in parentheses of more than five words. Wording that isn't an instruction is kept word for word ("Code of Federal Regulations", "Entered Date"). |
| Original label kept | The record's `label` keeps the form's own wording. The tab shows it as the field name's tooltip ("Printed: 2 Enter the Contract Number") and in the record details. |
| Values unchanged | Values are exactly as read. A ticked box shows **Selected**; its extracted state (`1`) is kept on the record. |
| 1.4 Hierarchical items | An item with sub-fields opens with its number and name on a row of its own, with a blank value. Its sub-fields follow, set in, with a blank number cell. An item that is one field is one row. Form boxes sharing a number show it once. A split date range writes Start Date and End Date rows under its field. |
| 1.5 Native tables, one worksheet | Unchanged: tables keep their own headers and columns in the same single `Original File` sheet. |

### Filled form boxes are no longer dropped

On FA30's SF33 cover, the structure reader rejected 52 filled boxes because their
descriptions were too long for a printed label. The Original File layout now keeps every
filled box, whatever its description's length, and names it with `form_label()`.

Other changes on form pages:
- **Form order:** boxes printed side by side follow the form's numbering (item 4 before 5).
- **Text read twice:** printed text read from inside a filled box is dropped as a duplicate of the box.

All of this is decided in the layout (`original_layout.py`). The structure reader is unchanged, so
the Advanced Grid, staging and Oracle mapping see exactly what they saw before.

## FA30 — representative output (SF33 cover, page 1)

```
Item # | Field Name                                 | Extracted Value
1      | Rating                                     | DO-C3
       | Page Number                                | 1
       | Total Number of Pages                      | 288
2      | Contract Number                            | FA300224C0008
3      | Solicitation Number                        | FA300223R00090009
4      | Negotiated (RFP) Request for Proposal      | Selected
       | Issued By Code                             | FA3002
5      | Date Issued                                | 21 Apr 2023
       | Issued By                                  | FA3002  338 ESS CC … (full block)
6      | Requisition/Purchase Number                | F2X3C34150A001
10     | Name of the Person                         | Paul Lewis
       | Telephone Number                           | 652-7824
       | Email Address of the Person                | paul.lewis.16@us.af.mil
11     | A - Solicitation/Contract Form             | Selected
       | Page Numbers for Section A                 | 1-2
14     | First Amendment Number                     | 0009
       | Acknowledgment Date for the First Amendment Number | 08 Feb 2024
15A    | Name and Address of the Offeror            | CHUGACH LOGISTICS AND FACILITY SERVICES JV, LLC …
20     | Accepted Dollar Amount                     | USD 24,131,140.28
```

Before this change, items 1, 4, 5 and 9–25 were missing, and item 2 read "2 Enter the
Contract Number".

The workbook is one `Original File` sheet with no merged cells: 4,222 rows for 288 pages.
Item # (column A) is 16 characters wide. Tables share column A, so their long first cells
wrap there instead of widening it to 60.

## Files and functions

| File | Change |
|---|---|
| `backend/app/source_structure/original_layout.py` | `_usable` keeps filled form boxes; `form_label` cleans their descriptions; `_drop_form_echoes` drops text read inside a box; `_order_form_runs` orders boxes by item number; `_field_payload` adds `form_item` and `choice`; `_apply_hierarchy` groups boxes by their own number |
| `backend/app/source_structure/original_export.py` | `FIELD_COLUMNS` = Item # / Field Name / Extracted Value; `original_rows` adds item caption, sub-field and part rows; `field_value` returns Selected for a ticked box; sub-fields indented; column A width capped for table cells |
| `frontend/components/original-structure/original-structure-view.tsx` | `fieldLine` / `shownValue` replace `fieldPlacement`; the field grid prints caption rows, item numbers once, indented sub-fields and the form's wording as a tooltip |
| `frontend/lib/original-structure.ts` | `choice`, `form_item` |
| Tests | `test_original_structure.py`, `test_document_workspace.py`, `original-structure.test.tsx` |

## Tests

| Suite | Result |
|---|---|
| Backend: full | **1,338 passed, 0 failed, 14 skipped** |
| Frontend: full (two workers) | **639 passed, 0 failed** |

New tests:
- `test_form_instructions_are_removed_from_field_names_and_meaningful_names_kept`: your examples, FA30 wordings, and names that must stay unchanged.
- `test_a_filled_form_reads_as_item_number_field_name_and_value`: a generated fillable SF33-style PDF. It checks every box kept, numbers in form order, the original label retained, Selected for a ticked box, no duplicate from printed text, and no instruction left in a field name.
- Frontend: caption rows, numbers once, form boxes sharing a number, and the tooltip with the original wording.

Browser check: the FA30 Original File tab, local frontend against the local API, with no
console errors.

## Remaining limitations

1. **Item numbers come from the form's own descriptions.** Where the PDF's description disagrees with the printed box, the description wins. FA30 numbers the Issued By block "5"; the printed box is item 7.
2. **Boxes without a number** (Page Number, Issued By Code, Code for the Offeror) are separate rows with a blank Item #. They follow the item before them in form order, which can look as if they belong to it.
3. **Unticked checkboxes aren't shown.** The structure reader skips empty and unticked boxes, so "Sealed Bid (IFB): Not selected" can't appear yet. Showing them means changing the structure reader, which the Advanced Grid also uses.
4. **Some long names stay long.** "Number of Copies of Sealed Offers Needed for Furnishing the Supplies…" is the form's wording with the instruction removed. It isn't shortened further, because that would mean inventing a name.
5. **Text-extractor duplicates stay.** Rows such as "TELEPHONE (NO COLLECT CALLS) = 210-652-7824" or "B = SUPPLIES OR SERVICES …" have no position on the page, so they're placed by page under the section. They are kept because they are extraction records; removing them belongs with Phase D's duplicate handling.
6. **Items 11 (table of contents) and 14 (amendments) are rows, not tables.** Phase C/D would build them into native tables.
7. **The Issued By block is one value.** Splitting it into office, address and contact parts was in the earlier recognition spec, not in this phase.
8. **The column change applies to every document,** not only FA30, so the tab and the export stay one format.
