# Increment 7.3.3 — Phase A.1: SF33 form accuracy

Branch `feature/di-02-safety-foundation`. **Not committed, pushed or deployed.** Builds on
Phase A (also uncommitted). Oracle mapping (Phase B onwards) is not started.

The three columns are unchanged: **Item # | Field Name | Extracted Value**.

## What changed

| Requirement | Implementation |
|---|---|
| 1. Printed item numbers | A new reader, `form_geometry.py`, reads a form page as printed: its ruled cells, its numbered captions ("7. ISSUED BY") and every form box. A box takes the number of the one numbered caption in its own ruled cell. On FA30, Issued By is now **7** (its description says 5); the description's number is kept on the record (`described_as`). |
| 1. Documented fallback | When the page shows no caption in the box's cell, the box's own description gives the number (`number_source: "form_field"`). When neither does, it has none (`"none"`). The tab's tooltip says which. Nothing is specific to FA30. |
| 2. Unnumbered boxes | A box with no number takes one only from the page: the caption of the cell it's drawn inside (Issued By Code → 7, the payment Code → 25), or the label column printed beside that cell (Offeror Code → 15A). Page Number and Total Number of Pages print their own label and no number, so they stand alone. They're never put under the item before them. |
| 2. Item captions | When several boxes share a number, their printed caption names the item, on a row of its own ("4 · Type of Solicitation", "10 · For Information Call"), with the boxes set in under it. This applies only to a caption printed as a label; a sentence caption such as item 9's isn't used as a name. |
| 3. Checkbox states | Every choice box is read, ticked or not: **Selected** / **Not Selected**. The form's raw value and its "on" value are kept (`form_state`). A value the box doesn't define is "Unreadable source value", never Selected or Not Selected. A box whose "on" value is "0" (FA30 page 258) is read as ticked. |
| 3. Advanced Grid | Unchanged. The structure reader isn't touched: unticked boxes exist only in the Original File layout. A test checks the reader still has no candidate for them. |
| 4. Duplicates | A row the text extractor read from a form page is marked `form_duplicate` when every word of it is the form's printed wording or a box's value, for example `TELEPHONE NUMBER = 208-999-8966` or `B = SUPPLIES OR SERVICES … 3-80 …`. Such rows are not shown in the tab or the Excel; the tab counts them ("12 repeated form readings hidden"). They stay in the layout, so review and Smart Review still see every record. A row with any word of its own stays. A grid the reader built over a form's ruled cells is treated the same way. |
| 5. Source tables | When an item's boxes sit under a header band with the same ruled columns, they're read as a table: printed headers, cells as the page or box holds them. Item 11 is printed in two halves with their own rows, so it's read as one table, left half then right: `(X) \| SECTION \| DESCRIPTION \| PAGE(S)`, 17 rows including the Part rows. Item 14's halves share rows, so its printed columns are kept: `AMENDMENT NUMBER \| DATE \| AMENDMENT NUMBER \| DATE`. Empty cells stay empty; no cell is invented. |
| 6. Composite blocks | A form box holding an address block is split into its parts: Code, Office, Telephone, Street Address, City, State, ZIP Code, Country, and each contact's name, email and telephone. It's split only when it has a "City, ST 12345" line and every line is recognised; otherwise it stays whole. The full text stays on the record, in the tab ("Printed as …") and in an Excel note. |
| 7. Export | One `Original File` sheet, no merged cells: 4,250 rows for FA30. The tab and the Excel are built from the same layout: same numbers, hierarchy, tables, values, and the same rows hidden. A form table's title row carries its item number. |
| 8. Regression | Oracle mapping, staging, review history and stored values are untouched. Form tables use new record keys (`form-table:…`), so existing table keys don't shift. Without the source file, the layout falls back to Phase A behaviour. |

## FA30 SF33 cover, page 1 (Excel rows)

```
Item # | Field Name                                   | Extracted Value
1      | Rating                                       | DO-C3
       | Page Number                                  | 1
       | Total Number of Pages                        | 288
2      | Contract Number                              | FA300224C0008
3      | Solicitation Number                          | FA300223R00090009
4      | Type of Solicitation                         |
       |   Sealed Bid (IFB) Invitation for Bid        | Not Selected
       |   Negotiated (RFP) Request for Proposal      | Selected
5      | Date Issued                                  | 21 Apr 2023
6      | Requisition/Purchase Number                  | F2X3C34150A001
7      | Issued By                                    |
       |   Issued By Code                             | FA3002
       |   Issued By                                  |   (printed text in a note)
       |     Code / Office                            | FA3002 / 338 ESS CC
       |     Telephone (CP) / Street Address          | 210-652-6903 / 2021 FIRST STREET WEST BLDG 853
       |     City / State / ZIP Code / Country        | JBSA RANDOLPH / TX / 78150-4300 / UNITED STATES
       |     Contracting Officer (+ Email, Telephone) | KEVIN SARGENT / kevin.sargent.7@us.af.mil / 487-8228
       |     Contract Specialist (+ Email, Telephone) | Paul Lewis / paul.lewis.16@us.af.mil / 210-652-7824
9      | Number of Copies of Sealed Offers …          | 1
       |   Hour … / Date … No Longer Be Accepted      | 12:00 PM / 12 Feb 2024
10     | For Information Call                         |
       |   Name / Area Code / Telephone / Email       | Paul Lewis / 210 / 652-7824 / paul.lewis.16@us.af.mil
11     | Table of Contents                            | Source: page 1
  (X) | SECTION | DESCRIPTION                                   | PAGE(S)
      |         | PART I - THE SCHEDULE                         |
  Selected | A  | SOLICITATION/CONTRACT FORM                    | 1-2
  …  (B–H Selected, I and J Selected, each with its pages) …
  Not Selected | K | REPRESENTATIONS, CERTIFICATIONS AND OTHER STATEMENTS OF OFFERORS |
  Not Selected | L | INSTRUCTIONS, CONDITIONS, AND NOTICES TO OFFERORS               |
  Not Selected | M | EVALUATION FACTORS FOR AWARD                                    |
14     | Acknowledgment of Amendments                 | Source: page 1
  AMENDMENT NUMBER | DATE        | AMENDMENT NUMBER | DATE
  0009             | 08 Feb 2024 | 0007             | 16 Jan 2024
  0001             | 19 May 2023 | 0002             | 05 Jun 2023
15A    | Name and Address of Offeror                  |
       |   Code for the Offeror                       | 98S99
       |   Name and Address of the Offeror            |   (Name, Street, City, State, ZIP, Country, Contact …)
15B    | Telephone Number                             |   Area Code 208, Number 999-8966
15C    | Check if Remittance Address is different …   | Not Selected
19–21  | …                                            | See Schedule / USD 24,131,140.28 / See Section G …
22     | Authority for Using Other Than Full Open Competition Under the United States Code At
       |   10 U S C 3204(a)                           | Selected
       |   41 U S C 3304(a)                           | Not Selected
23–25  | …                                            | 25 / SCD: PAS: / Code F87700, payment office split
```

Before this change: Issued By was under 5. Unticked boxes didn't appear. Items 11 and 14
were 18 and 8 loose rows. 12 text-extractor repeats were listed after item 25.

## Files

| File | Change |
|---|---|
| `backend/app/source_structure/form_geometry.py` (new) | Reads a form page's rules, captions and boxes (`read_form_pages`, cached per file version). `FormPage.printed_number`, `box_cells`, `text_beside` and `table`; `FormBox.state`; `is_label_caption`. |
| `backend/app/source_structure/original_layout.py` | `_form_boxes` (joins candidates to boxes, adds unticked choices, numbers boxes, reads form tables); `_FormInfo`; `caption_name`; `block_parts`; `_form_repeat`; `_form_table_payload`. Also: printed caption items in `_apply_hierarchy`; `form_state` quality; `_form_pages`. |
| `backend/app/source_structure/original_export.py` | Skips `form_duplicate` items; a form table's title row has its item number. |
| `frontend/lib/original-structure.ts` | `FormItem`, `form_state`, `form_duplicate`, the table's `item` and `form_table`, and `stats.form_duplicates_hidden`. |
| `frontend/components/original-structure/original-structure-view.tsx` | Hides `form_duplicate` items; adds the "repeated form readings hidden" count, the number-source tooltip (`numberNote`), and a form table's item number. |
| Tests | `backend/tests/test_original_structure.py` (8 new tests, with a generated ruled SF33-style form); `original-structure.test.tsx` (1 new). |

## Tests

| Suite | Result |
|---|---|
| Backend: full | **1,344 passed, 2 failed, 14 skipped** (see the two failures below) |
| Backend: layout, export and workspace files | **75 passed** |
| Frontend: full (two workers) | **640 passed, 0 failed** |
| FA30 tab vs Excel (browser, local) | **90 of 90 SF33 rows identical**; no console errors |

Neither backend failure involves the Original File:
- `test_key_dates::test_expired_and_expiring_documents_in_the_portfolio` expects 30 days but gets 29. The test counts from the machine's local date (30 Oct, evening) and the app from UTC (already 31 Oct), so it fails in that window whatever the code.
- `test_dashboard::test_review_queue_buckets_rejected_and_unknown_first` failed in one full run only. It passed in the other full run and on its own (5 of 5).

## Unresolved ambiguities

1. **Pages with only empty or unticked boxes:** geometry is read only for pages where the reader found at least one filled box. A form page with only empty or unticked boxes falls back to Phase A, and its unticked boxes don't appear.
2. **No caption in the cell:** a box's description wins when its cell holds no printed caption, for example item 10's and 11's boxes, which sit in a different cell from their caption. On FA30 every such description agrees with the page. A wrong one would go unnoticed, and the tooltip then says the number comes from the description.
3. **Item 9's caption is a sentence**, so item 9 has no caption row: its number is on its first box and the other two boxes are set in under it.
4. **Inherited box names:** box names inherit the form's wording, which can stay long ("Number of Copies of Sealed Offers Needed for Furnishing …") or odd ("10 U S C 3204(a)", the reader's spelling of 10 U.S.C.). They aren't rewritten further.
5. **The CP tag:** "Telephone (CP)" keeps the block's own "CP" tag, whose meaning the page doesn't print.
6. **Hidden repeats need the form's own words:** a text-extractor row is hidden only when all its words come from the form. A row that mixes in one stray word (an OCR error, say) stays visible.
7. **Address splitting is US-shaped:** it needs a "City, ST 12345" line. Other countries' blocks stay whole.
8. **Two-half tables:** a table printed in two halves is read left then right when the halves' rows differ. That suits a table of contents, but a form meant to be read across would be read in the wrong order.
