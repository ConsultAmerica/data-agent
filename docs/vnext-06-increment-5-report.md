# VNext Increment 5 — Format Coverage

> **Superseded in part (Increment 6B.0, 2026-10-29):** ZIP and EML ingestion described below was removed, and so was the gate that switched them on or off. ZIP, EML and MSG uploads are now refused, including renamed archives and email messages detected by their content. See `vnext-09-increment-6b0-zip-eml-removal.md`. JSON, TSV/CSV, XLSM and ODS support is unchanged.

Date: 2026-10-29 · Branch: `feature/di-02-safety-foundation`
Scope: the gap report's "Format coverage" item. It adds JSON, TSV, CSV delimiter and encoding detection, XLSM, ODS, ZIP and EML.

## What was added

| Format | Handling |
|---|---|
| **JSON** | Validated at upload; invalid or very deeply nested JSON is refused. Read as one `path: value` line per value (e.g. `invoice.lines[2].amount: 12.00`). Each array of objects becomes a table. |
| **TSV / CSV** | Encoding detected: byte-order mark, then strict UTF-8, then charset-normalizer, then Windows-1252. Delimiter (comma, semicolon, tab or pipe) sniffed from the content. Both are recorded in `ingestion_provenance`. Quoted delimiters and leading zeros are kept. |
| **XLSM** | Read like XLSX. The VBA project is never loaded or run. |
| **ODS** | `content.xml` read with the hardened XML parser (no entities, DTD or network). The `mimetype` member must say spreadsheet. One page per sheet. Repeated content is expanded; padding (empty repeated rows and columns) is not. Size and cell caps apply. |
| **ZIP** | Not stored as a document. Each supported file in it becomes its own document, tagged with the batch and queued for background processing. The response (`status: "container_expanded"`) lists every file as created, duplicate, skipped or failed. |
| **EML** | The email becomes a document: From, To, Cc, Date and Subject, the attachment names, then the body (an HTML body is read as text). Each attachment becomes a document linked to the email (`parent_relationship_type = "email_attachment"`, confirmed). Contract parent detection no longer overrides that link. |

### Container limits (`app/services/containers.py`, `Settings.container_*`)
- **Counts:** at most 2,000 entries and 200 imported files per archive.
- **Size:** each file is held to `max_upload_mb`; at most 500 MB in total. Sizes are counted on bytes actually read, not on what the archive declares.
- **Zip bombs:** a compression ratio over 100:1 (on files over 1 MB) is skipped as a possible zip bomb.
- **Skipped and reported:** password-protected entries, unsupported types, archives inside archives, and emails attached to emails.
- **Ignored:** system files (`__MACOSX`, `.DS_Store`, `~$` lock files) and inline email images.
- **Nesting:** an email inside a ZIP is imported and its attachments are unpacked; nothing deeper.
- **Names:** never used as storage paths; files are stored under generated ids.

### Frontend
- The batch intake accepts the new extensions.
- A ZIP's row is replaced by one row per unpacked file ("From batch.zip"). An email's attachments appear after it ("Attached to award.eml").
- Duplicates reuse the existing document. Skipped files show the reason.
- Job polling for unpacked files is limited to 2 at a time.

## Tests
- New `backend/tests/test_format_coverage.py`, 20 tests: decoding, dialects, JSON, ODS padding and mimetype, ZIP skip rules and limits, email attachments, and upload API cases for every format, ZIP fan-out and email linking.
- Two new BatchQueue tests: ZIP fan-out and email attachments.
- Frontend full suite: 82 files, 507 passed. `tsc` clean.
- Backend full suite, excluding the stress test: 1,187 passed, 13 skipped.

## Follow-up: review-pane and queue transparency

| Recommendation | Status |
|---|---|
| JSON shown as a collapsible tree with breadcrumbs | **Built.** The JSON source panel has Tree and Page text views. The tree is built from the file itself (new `GET /api/documents/{id}/source-json`: access-checked, JSON documents only, 5 MB cap; larger files fall back to page text). Nodes below the top level start collapsed, and large arrays show 200 items at a time. A selected value opens its branch, is marked, and its path is shown (`invoice › lines › [1] › amount`). |
| Origin badge on every unpacked file; attachments indented under their email | **Built.** Badges read "From batch.zip" and "Attachment". Attachments are listed under their email's row whatever their own category. |
| Clear skip and duplicate feedback | **Built.** New neutral **Skipped** status in a "Not imported" group, with the reason, no error styling and no Retry. Duplicates carry a **Reused existing** badge. Skipped files don't hold up batch progress. |
| Encoding and delimiter pills, with a warning when guessed | **Built.** A "Source file" card in the Intelligence panel shows format, encoding and delimiter. `encoding_guessed` is recorded at ingest and is true unless a byte-order mark or valid UTF-8 settled the encoding. Guessed encodings are amber with a note to check accented characters. The card also shows "Unpacked from batch.zip › path" or "Attached to …" with an **Open email** link. |
| Cell-level highlighting and inline editing of the spreadsheet | **Not built as described.** The uploaded file is evidence and is never edited. Corrections are made to extracted values in Metadata review, where they are audited. Validation results for extracted values are already shown in the review UI. |
| Row-to-source anchoring for spreadsheets and JSON | **Partly built.** It works for JSON (the tree opens on the selected value). Spreadsheet anchoring needs sheet/row/column coordinates in cell provenance, a backend change planned as its own increment (it was already a known limitation). |
| Selective export and export targets | **Already present.** Smart View grids export filtered or selected rows as CSV. The staging workbook exports XLSX and per-dataset CSV, and the Oracle template export is available. Approving part of a batch is a separate product decision. |

## Release gate: ZIP and EML are off by default

The files a ZIP or email unpacks into are not malware-scanned, so both formats are refused unless `CONTAINER_UPLOADS_ENABLED=true`. The default is false, and no deployment sets it.

- The upload API returns 400 with the reason.
- `GET /api/intake/config` reports `container_uploads_enabled`.
- The batch portal rejects `.zip` and `.eml` files with an explanation instead of queuing them.

Turn it on only once scanning (quarantine → scan → release, attachments and archive members scanned individually) is in place and verified.

## Known limitations
- MSG (Outlook) files are not supported. 7z and RAR archives are not supported.
- No formula/value split or cell-level evidence for spreadsheets (unchanged).
- Malware scanning is still the separate "security hardening" item and is required before customers upload ZIP or email files at scale.
