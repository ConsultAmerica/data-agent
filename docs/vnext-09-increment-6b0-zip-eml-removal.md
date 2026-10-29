# VNext Increment 6B.0 — ZIP and EML Ingestion Removed

Status: implemented locally and tested; **not committed, pushed or deployed**.
Date: 2026-10-29 · Branch: `feature/di-02-safety-foundation` (working tree)

## 1. Summary

ZIP and email ingestion (Increment 5) is removed, not hidden. Archive expansion, email parsing and attachment creation no longer exist, so nothing in an active workflow can reach them. The interim release gate (`CONTAINER_UPLOADS_ENABLED`) is gone too.

**Refused**
- `.zip`, `.eml` and `.msg` uploads are refused at the API boundary with a specific message, e.g. "ZIP archives aren't supported. Upload the documents they contain individually."
- Refusal is decided by content, not the file name:
  - a ZIP renamed to `.txt/.csv/.json/.xml/.pdf` fails the signature check (`PK` is rejected for text formats);
  - a ZIP renamed to `.docx/.xlsx/.ods` fails the package-structure check;
  - an email message renamed to `.txt/.csv/.html` is detected by its RFC 822 header block (a sender plus a transport header such as MIME-Version, Message-ID or Received) and refused. A note that merely begins "From: …" is still accepted as text.

**Unchanged**
- Every other format: PDF, Word, DOC, Excel/XLSM/XLS, ODS, PowerPoint, CSV/TSV, JSON, XML, HTML, RTF, TXT and images.
- Shared utilities: Python's `zipfile` (Office packages, ODS), the hardened XML parser, and text decoding / delimiter detection.
- No third-party dependency was added for ZIP/EML (they used the standard library), so none is removed.

**Existing documents are preserved**
- Documents imported from ZIP archives are ordinary documents and stay as they are.
- Email documents and their attachment links (`parent_relationship_type = "email_attachment"`) stay readable, and contract parent detection still won't overwrite those links.
- Historical provenance (e.g. "Unpacked from …") is still shown in the Source file card.
- An existing `.eml` record can't be re-read. `.eml` has no processor any more, so a queued or requested re-processing job fails with "file type not supported" instead of running. The viewer shows it as "can't be previewed", with its stored page text available.

## 2. Files changed

| Area | Change |
|---|---|
| `backend/app/services/security_validation.py` | `.zip` / `.eml` specs removed; `UNSUPPORTED_CONTAINERS` refusal messages (`.zip`, `.eml`, `.msg`); `looks_like_email_message()` content check for every text-family upload; supported-types label updated; `CONTAINER_KINDS` and the `email` native kind removed |
| `backend/app/api/documents.py` | ZIP expansion branch, `_container_member_document`, `_email_attachment_documents`, `_member_log_line`, email metadata validation, email handling in upload and duplicate resolution, gate check removed |
| `backend/app/services/containers.py` | **deleted** |
| `backend/app/parsers/data_file_parsers.py` | EML parsing removed (JSON and ODS readers kept) |
| `backend/app/services/native_ingest.py`, `file_processors/__init__.py`, `ingestion_provenance.py`, `staging/provenance.py` | `.eml` / `email` registrations removed |
| `backend/app/schemas/document.py` | `ContainerMemberSummary` and `container_members` removed |
| `backend/app/core/config.py`, `api/intake.py`, `services/upload_processing.py` | Container limits, the gate setting, its config field and its check removed |
| `backend/app/api/contract_analysis.py` | Keeps the `email_attachment` guard for existing links (constant now local) |
| `backend/tests/test_format_coverage.py` | ZIP/EML tests removed; refusal, renamed-payload, false-positive, all-formats and historical-document tests added |
| `frontend/components/document-uploader.tsx` | `.zip` / `.eml` and their MIME types removed from the accepted list; `container_expanded` handling removed |
| `frontend/components/intake/batch-intake-portal.tsx` | Specific refusal reasons for `.zip`, `.eml` and `.msg` (dropped files are listed with the reason, the rest are queued) |
| `frontend/components/intake/batch-queue.ts` | Container expansion, attachment rows, `origin` / `reused` / `skipped` removed |
| `frontend/components/intake/processing-queue.tsx`, `src/app/extraction/new/page.tsx` | Restored to the committed versions (origin badges, attachment nesting and the Skipped group removed) |
| `frontend/lib/intake.ts`, `frontend/types/document.ts` | Gate flag and container types removed |
| `frontend/components/intake/__tests__/intake.test.tsx` | ZIP/email queue, gate and nesting tests replaced by a refusal test |
| `docs/vnext-06-increment-5-report.md` | Marked as superseded for ZIP/EML |

## 3. Tests

- **New backend tests** (`test_format_coverage.py`, 28 tests):
  - `.zip`, `.eml` and `.msg` refused, with their message;
  - a ZIP renamed to 8 other types refused, and an email renamed to `.txt/.csv/.html` refused;
  - a note starting "From:" and a "Name: value" text file still accepted;
  - PDF, DOCX, XLSX, ODS, CSV, TSV, JSON, XML and PNG all still upload;
  - an existing `.eml` document stays readable (record, pages, viewer shows "unsupported"), and its processor refuses to run;
  - all JSON, CSV/TSV, XLSM and ODS tests retained.
- **New frontend test:** ZIP and EML dropped together with a PDF and CSV. The PDF and CSV are queued; the ZIP and EML are listed with their reasons.
- **Full suites:** backend **1,221 passed, 13 skipped** (stress test excluded); frontend **86 files, 563 tests passed**; TypeScript clean; ESLint clean on the changed files.

## 4. Format-aware viewers (6B.1–6B.7)

Built and verified before this removal; see `vnext-08-increment-6b-report.md`:
- the router and evidence model;
- PDF/image, spreadsheet, CSV/TSV, JSON, XML and Word viewers;
- Split / Source only / Data only;
- record-to-source navigation;
- the spreadsheet/CSV workspace fix;
- the browser walkthrough and screenshots (`shots/6b-*`).

The removal touches none of the viewer code; the regression suites cover both.

## 5. Known limitations

- **Old email documents** can't be re-processed; their stored pages remain.
- **The `.msg` refusal is by name.** An Outlook `.msg` renamed to another type is refused only where its OLE signature contradicts the claimed type (e.g. renamed to `.txt` or `.pdf`); renamed to `.doc`, it would reach LibreOffice conversion and fail there.
- **Email detection** reads the first 16 KB header block. A message whose headers are preceded by other text isn't detected as an email, and would be ingested as plain text, with attachments left as inert base64 text that is never unpacked.

## 6. Deployment readiness

Not ready to deploy as-is; it needs your decisions.

- **The removal itself:** low risk. No migrations, no data changes, and existing documents are untouched.
- **Production is on backend `821a2a3`,** because Render builds fail on Python 3.14 (`rapidocr-onnxruntime==1.4.4` needs ≤ 3.12). Set `PYTHON_VERSION=3.12.10` on Render, or commit a `.python-version`.
- **`main` currently has Increments 1–5 with ZIP/EML ingestion enabled** and 3 pending migrations. Once Render builds again, a deploy of today's `main` would turn ZIP/EML on. This removal should land on `main` first.
- **`main` also has a separate CORS commit (`d942fbc`)** that duplicates a local uncommitted change in `config.py`, which needs reconciling when committing.
- **Uncommitted alongside this removal:**
  - 6A and its review fixes;
  - 6B viewers;
  - the spreadsheet/CSV workspace fix;
  - the hidden "Preview · API Ready" badge;
  - the CORS domain fix.
