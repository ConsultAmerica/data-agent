"use client";

import Link from "next/link";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, Columns2, RefreshCw } from "lucide-react";

import { useDocumentChrome } from "@/components/layout/document-chrome-context";
import OracleIntegrationPanel from "@/components/oracle-integration-panel";
import RelatedDocumentsSwitcher from "@/components/documents/related-documents-switcher";
import DocumentAuditTrail from "@/components/review/document-audit-trail";
import DocumentViewer from "@/components/viewers/document-viewer";
import FieldToneLegend from "@/components/ui/field-tone-legend";
import { fieldToneClass, toneFromStagingCell } from "@/lib/field-tone";
import { useBrowserPreference } from "@/lib/browser-preference";
import { recordRecentDocument } from "@/lib/recent-documents";
import type { SourceViewRequest } from "@/components/source-verification-panel";
import type { EvidenceTarget } from "@/components/staging/evidence-drawer";
import DocumentActionsMenu from "@/components/actions/document-actions-menu";
import DocumentObligationsPanel from "@/components/obligations/document-obligations-panel";
import ExpiryTag from "@/components/documents/expiry-tag";
import ClassificationTag from "@/components/classification/classification-tag";
import VerificationWorkspace, { type WorkspaceView } from "@/components/verification/verification-workspace";
import { downloadWorkspaceExport } from "@/lib/verification";
import SmartWorkspace from "@/components/smart-view/smart-workspace";
import InvoiceRecognitionPanel from "@/components/documents/invoice-recognition-panel";
import DocumentPlaybookPanel from "@/components/playbook/document-playbook-panel";
import DocumentValidationPanel from "@/components/validation/document-validation-panel";
import FarRecordsView from "@/components/staging/far-records-view";
import PresentationWorkspace from "@/components/staging/presentation-workspace";
import { cellSourceRequest } from "@/components/staging/review-status";
import { withoutBlankColumns } from "@/lib/far-records";
import SourceTranscription from "@/components/staging/source-transcription";
import StagingDatasetTable from "@/components/staging/staging-dataset-table";
import StagingFieldList from "@/components/staging/staging-field-list";
import { getDocument, startProcessingJob } from "@/lib/documents";
import { FAMILY_LABELS } from "@/lib/document-families";
import ResultsView from "@/components/documents/results-view";
import CustomExportDialog from "@/components/documents/custom-export-dialog";
import { presentDocument, statusMark } from "@/lib/document-presentation";
import { downloadJson } from "@/lib/export";
import {
  downloadDocumentExportCsv,
  downloadDocumentExportXlsx,
  getDocumentExport,
} from "@/lib/reviewed-export";
import {
  SELECTED_EXPORT_FORMATS,
  downloadExport,
  downloadSelectedExport,
  getStagingWorkbook,
  type ExportCapability,
  type ProfileView,
  type SelectedExportFormat,
  type StagingDataset,
  type StagingWorkbook,
} from "@/lib/staging-workbook";
import SelectCheckbox from "@/components/staging/select-checkbox";
import SelectionToolbar from "@/components/staging/selection-toolbar";
import {
  SelectionProvider,
  allSelected,
  selectionCounts,
  selectionManifest,
  setCells,
  someSelected,
  toggleBlock,
  useSelectionStore,
  useTableSelection,
} from "@/lib/table-selection";
import type { DocumentStatus, UploadedDocument } from "@/types/document";

/** One metadata tag in the workspace's context bar. */
const TAG = "flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-0.5";
const GENERIC_FAMILY_IDS = new Set(["unknown", "generic_business"]);
const RESULTS_VIEW = { id: "results", label: "Results" } as const;

/** Generic tabs, for profiles that don't declare their own presentation:
 * the staged summary, the overview and the document itself first, then the
 * pipeline's technical stages with Transform last. The "staging" id is kept
 * so existing ?view=staging links still land on Summary. */
const GENERIC_VIEWS = [
  { id: "staging", label: "Summary" },
  { id: "overview", label: "Overview" },
  { id: "source", label: "Source" },
  { id: "canonical", label: "Canonical" },
  { id: "transform", label: "Transform" },
] as const;

/** Still addressable by ?view= (review queue links to QA), listed under More. */
const MORE_VIEWS = [
  { id: "data", label: "Data" },
  { id: "qa", label: "QA" },
] as const;

type GenericViewId = (typeof GENERIC_VIEWS)[number]["id"] | (typeof MORE_VIEWS)[number]["id"];
/** Tabs from here on are the pipeline's technical stages. */
const FIRST_TECHNICAL_VIEW: GenericViewId = "canonical";
const DOCUMENT_MODES = { original: "Original", text: "Extracted Text" };

function laneOf(dataset: StagingDataset): GenericViewId | "advanced" {
  const id = dataset.dataset_id;
  // Recalculated credits/GPA explain why stated totals need review: shown
  // with the summary although they are checks, not extracted values.
  if (id === "academic_checks") return "staging";
  if (dataset.role === "qa" || id.includes("qa")) return "qa";
  if (id.includes("canonical")) return "canonical";
  if (dataset.role === "transform" || id.includes("oracle") || id.includes("map")) return "transform";
  if (id === "all_fields") return "advanced";
  if (dataset.role === "source" || id.includes("source") || id.includes("transcript")) {
    return "source";
  }
  return "staging";
}

export default function DocumentWorkspace({ documentId }: { documentId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setDocumentTitle } = useDocumentChrome();
  const requestedView = searchParams.get("view");
  const returnQs = searchParams.get("return");
  const documentsHref = returnQs ? `/documents?${returnQs}` : "/documents";
  const [workbook, setWorkbook] = useState<StagingWorkbook | null>(null);
  const [documentMeta, setDocumentMeta] = useState<UploadedDocument | null>(null);
  const [filename, setFilename] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [exportOpen, setExportOpen] = useState(false);
  // Export menu tab, and the custom export builder.
  const [exportMode, setExportMode] = useState<"default" | "custom">("default");
  const [customExportOpen, setCustomExportOpen] = useState(false);
  const [exportError, setExportError] = useState("");
  const [exportBusy, setExportBusy] = useState(false);
  const [exportNotice, setExportNotice] = useState("");
  const [showOracle, setShowOracle] = useState(false);
  const [notice, setNotice] = useState("");
  const [reprocessing, setReprocessing] = useState(false);
  const [activeDataset, setActiveDataset] = useState("");
  // A value opened from the Data tab ("View in document"), shown in Source.
  // A link can open the same way: ?view=source&page=12&hl=quoted%20text
  // (DataoAI citations land on the cited page, highlighted).
  const linkedPage = Number(searchParams.get("page"));
  const linkedHighlight = searchParams.get("hl");
  const [sourceFocus, setSourceFocus] = useState<SourceViewRequest | null>(() =>
    Number.isInteger(linkedPage) && linkedPage > 0
      ? { id: `link:${linkedPage}`, pageNumber: linkedPage, highlightText: linkedHighlight, label: `Page ${linkedPage}` }
      : null,
  );
  // Grid selections (per dataset) live here, so they survive tab switches,
  // filters and pagination, and the Export menu can export them.
  // Split view: the original document stays open on the left while the
  // structured data is read on the right; a value's source jumps it there.
  const [splitPref, setSplitPref] = useBrowserPreference<"on" | "off">("dx-workspace-split", ["on", "off"], "off");
  // The verification tabs (Original Structure first, Summary last), and
  // two more views on the same records: Smart View and Advanced Grid.
  const [viewMode, setViewMode] = useBrowserPreference<WorkspaceView>(
    "dx-workspace-mode",
    ["original", "business", "advanced", "tables", "validation", "oracle", "history", "summary", "smart"],
    "original",
  );
  const split = splitPref === "on";
  const [historyOpen, setHistoryOpen] = useState(false);
  const selectionStore = useSelectionStore();
  const selected = selectionStore.active;
  const exportMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([getDocument(documentId), getStagingWorkbook(documentId)])
      .then(([document, staging]) => {
        if (!active) return;
        setDocumentMeta(document);
        setFilename(document.original_filename || staging.document_filename);
        setWorkbook(staging);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : "Unable to open this document.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [documentId, reloadKey]);

  useEffect(() => {
    const title = filename || workbook?.document_filename || null;
    setDocumentTitle(title);
    if (title) recordRecentDocument(documentId, title);
    return () => setDocumentTitle(null);
  }, [documentId, filename, workbook?.document_filename, setDocumentTitle]);

  useEffect(() => {
    if (searchParams.get("panel") === "oracle") {
      setShowOracle(true);
    }
  }, [searchParams]);

  useEffect(() => {
    if (!exportOpen) return;
    function onDown(event: MouseEvent) {
      if (!exportMenuRef.current?.contains(event.target as Node)) setExportOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setExportOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [exportOpen]);

  const datasets = workbook?.datasets ?? [];
  const profileViews = workbook?.profile.views ?? [];
  const profileView: ProfileView | undefined = profileViews.length
    ? (profileViews.find((item) => item.view_id === requestedView) ?? profileViews[0])
    : undefined;
  // Documents open on their staged summary.
  const genericView = ([...GENERIC_VIEWS, ...MORE_VIEWS].find((item) => item.id === requestedView)?.id ??
    "staging") as GenericViewId;

  const laneDatasets = useMemo(() => {
    if (profileView) {
      return profileView.dataset_ids
        .map((id) => datasets.find((dataset) => dataset.dataset_id === id))
        .filter((dataset): dataset is StagingDataset => Boolean(dataset));
    }
    return datasets.filter((dataset) => laneOf(dataset) === genericView);
  }, [datasets, profileView, genericView]);
  const advanced = profileView ? [] : datasets.filter((dataset) => laneOf(dataset) === "advanced");

  useEffect(() => {
    if (laneDatasets.length === 0) return;
    // Check the current selection, not this render's copy: a dataset tab
    // clicked before this effect ran must not be reset to the first one.
    setActiveDataset((current) =>
      laneDatasets.some((dataset) => dataset.dataset_id === current) ? current : laneDatasets[0].dataset_id,
    );
  }, [laneDatasets, activeDataset]);

  function openView(next: string) {
    const params = new URLSearchParams();
    params.set("view", next);
    if (returnQs) params.set("return", returnQs);
    router.replace(`/documents/${documentId}?${params.toString()}`);
  }

  async function reprocess() {
    if (documentMeta?.status === "processing") {
      setNotice("This document is already processing.");
      return;
    }
    setReprocessing(true);
    setNotice("");
    try {
      await startProcessingJob(documentId);
      setNotice("Reprocess started. Staging will refresh when the job completes.");
      setReloadKey((key) => key + 1);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Reprocess failed.");
    } finally {
      setReprocessing(false);
    }
  }

  /** Show a value's source: in the split pane when it is open, else on
   * the Source tab. */
  function openSource(request: SourceViewRequest) {
    setSourceFocus(request);
    if (!split) openView("source");
  }

  function viewInDocument(target: EvidenceTarget) {
    const request = cellSourceRequest(target.cell, `${target.fieldId ?? target.cell.canonical_field}:${Date.now()}`);
    if (!request) return;
    openSource({ ...request, label: target.field });
  }

  if (loading) {
    return <WorkspaceSkeleton />;
  }
  if (error || !workbook) {
    return <p className="px-6 py-10 text-sm text-danger">{error || "Unable to open this document."}</p>;
  }

  const profile = workbook.profile;
  const outcome = workbook.outcome;
  const qa = workbook.qa_summary;
  const current = laneDatasets.find((dataset) => dataset.dataset_id === activeDataset) ?? laneDatasets[0];
  const ready = outcome.status === "populated" || outcome.status === "special_source";
  const verified = qa.needs_review === 0 && qa.record_count > 0;
  const oracle = profile.oracle_mapping_capability;
  // A records tab holding one dataset is named after it, so a document can
  // name its own table ("FAR Data" for a FAR Part, "FAR Clauses &
  // Provisions" for Part 52).
  const tabs = profileViews.length
    ? profileViews.map((item) => {
        // Only a tab that IS its dataset (same id) takes the dataset's name.
        const only = item.kind !== "source" && item.dataset_ids.length === 1 && item.dataset_ids[0] === item.view_id
          ? datasets.find((dataset) => dataset.dataset_id === item.view_id)
          : undefined;
        return { id: item.view_id, label: only?.display_name ?? item.label };
      })
    : GENERIC_VIEWS.map((item) => ({ id: item.id, label: item.label }));
  // Results (fields, key-value pairs, tables, OCR text) is the first tab
  // for every document and where a document opens.
  const showResults = !requestedView || requestedView === RESULTS_VIEW.id;
  const allTabs = [{ id: RESULTS_VIEW.id, label: RESULTS_VIEW.label }, ...tabs];
  const activeTab = showResults ? RESULTS_VIEW.id : (profileView?.view_id ?? genericView);

  async function runExport(task: () => Promise<void>, successMessage: string) {
    setExportOpen(false);
    setExportError("");
    setExportNotice("");
    setExportBusy(true);
    try {
      await task();
      setExportNotice(successMessage);
      window.setTimeout(() => setExportNotice(""), 3500);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setExportBusy(false);
    }
  }

  async function exportSelected(format: SelectedExportFormat) {
    if (!selected) {
      setExportError("Select cells, rows, or columns in a table before Export Selected.");
      return;
    }
    const base = filename || workbook?.document_filename || "export";
    await runExport(
      () =>
        downloadSelectedExport(
          documentId,
          selected.datasetId,
          format,
          selectionManifest(selected.selection),
          base,
        ),
      `Selected ${format.toUpperCase()} download started.`,
    );
  }

  async function exportAllCapability(capability: ExportCapability) {
    const base = filename || workbook?.document_filename || "export";
    await runExport(
      () => downloadExport(capability, base),
      `${capability.label} download started.`,
    );
  }

  async function exportDocumentStructure(kind: "original" | "all_fields" | "json") {
    const labels = { original: "Original File Excel", all_fields: "Original File CSV", json: "Structured JSON" };
    await runExport(
      () => downloadWorkspaceExport(documentId, kind, filename || workbook?.document_filename || "export"),
      `${labels[kind]} download started.`,
    );
  }

  async function exportMetadata(
    format: "json" | "csv" | "xlsx",
    authoritativeOnly: boolean,
  ) {
    const base = (filename || workbook?.document_filename || "export").replace(
      /\.[^.]+$/,
      "",
    );
    const suffix = authoritativeOnly ? "-authoritative" : "-metadata";
    await runExport(async () => {
      if (format === "json") {
        const body = await getDocumentExport(documentId, { authoritativeOnly });
        downloadJson(`${base}${suffix}.json`, body);
        return;
      }
      if (format === "csv") {
        await downloadDocumentExportCsv(
          documentId,
          `${base}${suffix}.csv`,
          { authoritativeOnly },
        );
        return;
      }
      await downloadDocumentExportXlsx(
        documentId,
        `${base}${suffix}.xlsx`,
        { authoritativeOnly },
      );
    }, `Metadata ${format.toUpperCase()} download started.`);
  }

  const selectedCounts = selected ? selectionCounts(selected.selection) : null;
  // In split view a value's source opens in the left pane; otherwise the
  // grids keep their own evidence drawer.
  const splitSource = split ? openSource : undefined;

  const docStatus = (documentMeta?.status ?? "completed") as DocumentStatus;
  // The family this document was detected as (a pay stub staged with the
  // generic profile is still a pay stub); the profile's own family only
  // when no resolution was recorded.
  const resolved = workbook.processing_metadata?.document_family;
  const resolvedLabel = workbook.processing_metadata?.document_family_label;
  const familyId = resolved ?? profile.document_families?.[0] ?? "";
  const typeLabel =
    (resolved && !GENERIC_FAMILY_IDS.has(resolved) && (resolvedLabel || FAMILY_LABELS[resolved])) ||
    (familyId && FAMILY_LABELS[familyId]) ||
    profile.display_name;
  const presentation = presentDocument({
    document_id: documentId,
    original_filename: filename || workbook.document_filename,
    document_type: null,
    status: docStatus,
    confidence: null,
    uploaded_at: documentMeta?.uploaded_at ?? "",
    page_count: documentMeta?.page_count ?? 0,
    fields_extracted: qa.record_count,
    last_updated: documentMeta?.uploaded_at ?? "",
    profile_id: profile.profile_id,
    profile_label: profile.display_name,
    type_label: typeLabel,
    staging_status: "staged",
  });
  // Intake agency given at upload (null when none was).
  const agency = documentMeta?.agency ?? null;
  const processingLabel =
    docStatus === "processing"
      ? "Processing"
      : docStatus === "failed"
        ? "Failed"
        : ready
          ? "Complete"
          : outcome.title;
  const reviewLabel =
    presentation.status === "review"
      ? "Needs Review"
      : presentation.status === "failed"
        ? "—"
        : qa.needs_review > 0
          ? "Needs Review"
          : "Staging Verified";

  return (
    <SelectionProvider store={selectionStore}>
    <div className="workspace-page w-full px-4 py-4 sm:px-6" data-testid="document-workspace">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            href={documentsHref}
            className="text-sm text-text-secondary hover:text-foreground"
            data-testid="return-to-documents"
          >
            ← Documents
          </Link>
          <h1 className="mt-2 truncate text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
            {filename || workbook.document_filename}
          </h1>
          <p className="mt-1 text-sm text-text-secondary">
            <span className="text-foreground">{profile.display_name}</span>
            <span className="mx-1.5 text-text-muted">·</span>
            {recordSummary(workbook)}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <dl className="flex flex-wrap items-center gap-1.5 text-xs" data-testid="workspace-status">
              <div className={TAG}>
                <dt className="text-text-muted">Type</dt>
                <dd className="font-medium text-foreground" data-testid="workspace-type">
                  {typeLabel}
                </dd>
              </div>
              <div className={TAG}>
                <dt className="text-text-muted">Profile</dt>
                <dd className="font-medium text-foreground" data-testid="workspace-profile">
                  {profile.display_name}
                </dd>
              </div>
              <div className={TAG}>
                <dt className="text-text-muted">Agency</dt>
                <dd className={agency ? "font-medium text-foreground" : "text-text-muted"} data-testid="workspace-agency">
                  {agency || "—"}
                </dd>
              </div>
              <div className={TAG}>
                <dt className="text-text-muted">Processing</dt>
                <dd className={`font-medium ${docStatus === "failed" ? "text-danger" : "text-foreground"}`}>
                  {processingLabel}
                </dd>
              </div>
              <div className={TAG}>
                <dt className="text-text-muted">Review</dt>
                <dd className={`font-medium ${qa.needs_review > 0 || presentation.status === "review" ? "text-warning" : "text-success"}`}>
                  {statusMark(qa.needs_review > 0 ? "review" : presentation.status)} {reviewLabel}
                  {qa.needs_review > 0 && (
                    <span className="ml-1 font-normal text-text-secondary">
                      · {qa.needs_review.toLocaleString()} of {qa.record_count.toLocaleString()} records
                    </span>
                  )}
                </dd>
              </div>
              <ExpiryTag documentId={documentId} className={TAG} />
              <ClassificationTag
                documentId={documentId}
                className={TAG}
                // A decision re-stages the document: show its new schema.
                onChanged={() => setReloadKey((key) => key + 1)}
              />
            </dl>
            <RelatedDocumentsSwitcher documentId={documentId} returnQs={returnQs} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-secondary px-3 py-2 text-sm"
            aria-pressed={split}
            onClick={() => setSplitPref(split ? "off" : "on")}
            title="Keep the original document open beside the structured data"
            data-testid="toggle-split-view"
          >
            <Columns2 className="h-3.5 w-3.5" aria-hidden="true" />
            Split view
          </button>
          <DocumentActionsMenu documentId={documentId} />
          <Link
            href={`/documents/${documentId}/review`}
            className="btn-secondary px-3 py-2 text-sm"
            data-testid="open-metadata-review"
          >
            Metadata review
          </Link>
          <Link
            href={`/documents/${documentId}/form`}
            className="btn-secondary px-3 py-2 text-sm"
            data-testid="open-review-form"
            title="The review form generated from this document's schema"
          >
            Review form
          </Link>
          <button
            type="button"
            disabled={reprocessing || docStatus === "processing"}
            onClick={() => void reprocess()}
            className="btn-secondary px-3 py-2 text-sm disabled:opacity-50"
            aria-label="Reprocess document"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${reprocessing || docStatus === "processing" ? "animate-spin" : ""}`} />
            {docStatus === "processing" ? "Processing…" : reprocessing ? "Starting…" : "Reprocess"}
          </button>
          <button
            type="button"
            className="btn-secondary px-3 py-2 text-sm"
            aria-pressed={showOracle}
            onClick={() => setShowOracle((open) => !open)}
            data-testid="toggle-oracle-panel"
          >
            Oracle
          </button>
          <div className="relative" ref={exportMenuRef}>
            <button
              type="button"
              onClick={() => setExportOpen((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={exportOpen}
              disabled={exportBusy}
              className="btn-secondary text-sm disabled:opacity-60"
              data-testid="export-menu-trigger"
            >
              {exportBusy ? "Exporting…" : "Export"}
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
            {exportOpen && (
              <div
                className="absolute right-0 z-50 mt-1 w-80 rounded-lg border border-border bg-surface py-1 shadow-sm"
                role="menu"
                data-testid="export-menu"
              >
                <div className="flex gap-1 border-b border-border px-2 pt-1" role="tablist" aria-label="Export type">
                  {(
                    [
                      ["default", "Default"],
                      ["custom", "Custom"],
                    ] as const
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      role="tab"
                      aria-selected={exportMode === mode}
                      onClick={() => setExportMode(mode)}
                      className={[
                        "-mb-px flex-1 border-b-2 px-3 py-2 text-sm",
                        exportMode === mode
                          ? "border-primary font-semibold text-primary"
                          : "border-transparent text-text-secondary hover:text-foreground",
                      ].join(" ")}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {exportMode === "custom" ? (
                  <div className="space-y-3 px-3 py-3 text-sm" data-testid="export-custom-tab">
                    <p className="text-text-secondary">
                      Build your own file for importing elsewhere: pick fields, rename them to your system&apos;s
                      headers, combine fields into one column and set the order. Save the mapping as a template to
                      reuse it for every {profile.display_name} document.
                    </p>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setExportOpen(false);
                        setCustomExportOpen(true);
                      }}
                      className="btn-primary w-full justify-center py-2 text-sm"
                    >
                      Open custom export…
                    </button>
                  </div>
                ) : (
                <>
                <div className="border-b border-border px-3 py-2 text-[11px] text-text-secondary">
                  <p className="font-semibold uppercase tracking-wide text-text-muted">Export scope</p>
                  <p className="mt-1 text-foreground">
                    {filename || workbook.document_filename}
                  </p>
                  <p className="mt-0.5">
                    Profile {profile.display_name}
                    {current ? ` · Dataset ${current.display_name}` : ""}
                  </p>
                  {selected && selectedCounts ? (
                    <p className="mt-0.5">
                      Selection: {selected.datasetName} ·{" "}
                      {selectedCounts.cells.toLocaleString()} cell
                      {selectedCounts.cells === 1 ? "" : "s"} ·{" "}
                      {selectedCounts.records.toLocaleString()} record
                      {selectedCounts.records === 1 ? "" : "s"}
                    </p>
                  ) : (
                    <p className="mt-0.5 text-text-muted">No staging cells selected</p>
                  )}
                </div>
                <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
                  Original File
                </p>
                {(
                  [
                    ["original", "Excel → Original File"],
                    ["all_fields", "CSV → Original File"],
                    ["json", "Structured JSON"],
                  ] as const
                ).map(([kind, label]) => (
                  <button
                    key={kind}
                    type="button"
                    role="menuitem"
                    className="block w-full px-3 py-1.5 pl-5 text-left text-sm hover:bg-surface-soft"
                    onClick={() => void exportDocumentStructure(kind)}
                  >
                    {label}
                  </button>
                ))}
                <div className="my-1 border-t border-border" />
                <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
                  Advanced Grid data — Export All
                </p>
                {profile.export_capabilities.length === 0 && (
                  <p className="px-3 py-1.5 pl-5 text-xs text-text-muted">
                    No staging export formats available for this profile.
                  </p>
                )}
                {profile.export_capabilities.map((capability) => (
                  <button
                    // One dataset_csv capability per dataset, so the id alone repeats.
                    key={`${capability.capability_id}:${capability.dataset_id ?? ""}`}
                    type="button"
                    role="menuitem"
                    className="block w-full px-3 py-1.5 pl-5 text-left text-sm hover:bg-surface-soft"
                    onClick={() => void exportAllCapability(capability)}
                  >
                    {capability.label}
                  </button>
                ))}
                <div className="my-1 border-t border-border" />
                <p className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
                  Advanced Grid data — Export Selected
                </p>
                {SELECTED_EXPORT_FORMATS.map((item) => (
                  <button
                    key={item.format}
                    type="button"
                    role="menuitem"
                    disabled={!selected}
                    title={
                      selected
                        ? undefined
                        : "Select cells, rows or columns in a table first"
                    }
                    className="block w-full px-3 py-1.5 pl-5 text-left text-sm hover:bg-surface-soft disabled:cursor-not-allowed disabled:text-text-muted disabled:hover:bg-transparent"
                    onClick={() => void exportSelected(item.format)}
                  >
                    {item.label}
                  </button>
                ))}
                <div className="my-1 border-t border-border" />
                <p className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
                  Metadata export
                </p>
                <p className="px-3 pb-1 text-[11px] text-text-muted">
                  Uses DocumentMetadataField values — not staging cell QA.
                </p>
                {(
                  [
                    ["json", "JSON"],
                    ["csv", "CSV"],
                    ["xlsx", "Excel"],
                  ] as const
                ).map(([format, label]) => (
                  <button
                    key={format}
                    type="button"
                    role="menuitem"
                    className="block w-full px-3 py-1.5 pl-5 text-left text-sm hover:bg-surface-soft"
                    onClick={() => void exportMetadata(format, false)}
                  >
                    {label} (all review statuses)
                  </button>
                ))}
                <button
                  type="button"
                  role="menuitem"
                  className="block w-full px-3 py-1.5 pl-5 text-left text-sm hover:bg-surface-soft"
                  onClick={() => void exportMetadata("json", true)}
                >
                  JSON (accepted / edited only)
                </button>
                <div className="my-1 border-t border-border" />
                <button
                  type="button"
                  role="menuitem"
                  className="block w-full px-3 py-1.5 text-left text-sm hover:bg-surface-soft"
                  onClick={() => {
                    setExportOpen(false);
                    setShowOracle(true);
                  }}
                >
                  Open Oracle preview / send…
                </button>
                </>
                )}
              </div>
            )}
            <div className="mt-1 max-w-xs text-right text-xs" aria-live="polite">
              {exportBusy && <p className="text-text-secondary">Preparing download…</p>}
              {exportNotice && (
                <p className="text-success" role="status">
                  {exportNotice}
                </p>
              )}
              {exportError && (
                <p className="text-danger" role="alert">
                  {exportError}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      {notice && (
        <div className="mt-3 rounded-lg border border-border bg-surface-soft px-3 py-2 text-sm text-text-secondary" role="status">
          {notice}
        </div>
      )}

      {profile.profile_id === "invoice" && (
        <div className="mt-4">
          <InvoiceRecognitionPanel
            documentId={documentId}
            workbook={workbook}
            onChanged={(message) => {
              setNotice(message);
              setReloadKey((key) => key + 1);
            }}
          />
        </div>
      )}

      {showOracle && (
        <div className="mt-4" data-testid="workspace-oracle-section">
          <OracleIntegrationPanel
            documentId={documentId}
            documentFilename={filename || workbook.document_filename}
          />
        </div>
      )}


      {/* The Export menu opens this in both views (Smart View and Advanced
          Grid), so it lives outside them. */}
      {customExportOpen && (
        <CustomExportDialog
          documentId={documentId}
          workbook={workbook}
          filename={filename || workbook.document_filename}
          onClose={() => setCustomExportOpen(false)}
          onDownloaded={(message) => {
            setCustomExportOpen(false);
            setExportNotice(message);
            window.setTimeout(() => setExportNotice(""), 3500);
          }}
        />
      )}

      <VerificationWorkspace
        documentId={documentId}
        documentName={filename || workbook.document_filename}
        pageCount={Math.max(1, documentMeta?.page_count ?? 1)}
        stagingProfileId={workbook.profile.profile_id}
        view={viewMode}
        onViewChange={setViewMode}
        workbook={workbook}
        gridSelection={selectionStore}
        // A classification decision re-stages the document: show its new schema.
        onClassificationChanged={() => setReloadKey((key) => key + 1)}
      >
      {viewMode === "smart" ? (
        <SmartWorkspace
          documentId={documentId}
          workbook={workbook}
          filename={filename || workbook.document_filename}
          pageCount={Math.max(1, documentMeta?.page_count ?? 1)}
          document={documentMeta}
        />
      ) : viewMode === "advanced" ? (
      <div
        className={split ? "mt-4 grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]" : ""}
        data-split={split ? "on" : "off"}
      >
        {split && (
          <aside
            className="h-[70vh] lg:sticky lg:top-4 lg:h-[calc(100vh-6rem)]"
            aria-label="Original document"
            data-testid="workspace-split-viewer"
          >
            <DocumentViewer
              documentId={documentId}
              documentName={filename || workbook.document_filename}
              pageCount={Math.max(1, documentMeta?.page_count ?? 1)}
              request={sourceFocus}
            />
          </aside>
        )}
        <div className="min-w-0">
        <div className="mt-4 flex items-end gap-1 border-b border-border">
          {/* One row that scrolls sideways on narrow screens, never wraps. */}
          <div className="scrollbar-none -mb-px flex min-w-0 flex-1 items-end gap-1 overflow-x-auto" role="tablist" aria-label="Document views">
            {allTabs.map((item) => (
              <Fragment key={item.id}>
                {!profileView && item.id === FIRST_TECHNICAL_VIEW && (
                  <span className="mx-1 mb-2.5 h-4 w-px shrink-0 bg-border" aria-hidden="true" />
                )}
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === item.id}
                  onClick={() => openView(item.id)}
                  className={[
                    "shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors",
                    activeTab === item.id
                      ? "border-primary font-medium text-foreground"
                      : "border-transparent text-text-secondary hover:text-foreground",
                  ].join(" ")}
                >
                  {item.label}
                </button>
              </Fragment>
            ))}
          </div>
          {!profileView && (
            <details className="relative shrink-0">
              <summary
                className={[
                  "-mb-px cursor-pointer list-none border-b-2 px-3 py-2 text-sm",
                  MORE_VIEWS.some((item) => item.id === activeTab)
                    ? "border-primary font-medium text-foreground"
                    : "border-transparent text-text-secondary hover:text-foreground",
                ].join(" ")}
              >
                {MORE_VIEWS.find((item) => item.id === activeTab)?.label ?? "More"}
              </summary>
              <div className="absolute right-0 z-20 mt-1 min-w-[12rem] rounded-lg border border-border bg-surface py-1 shadow-sm">
                {MORE_VIEWS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="block w-full px-3 py-1.5 text-left text-sm hover:bg-surface-soft"
                    onClick={(event) => {
                      event.currentTarget.closest("details")?.removeAttribute("open");
                      openView(item.id);
                    }}
                  >
                    {item.label}
                  </button>
                ))}
                {advanced.length > 0 && <div className="my-1 border-t border-border" />}
                {advanced.map((dataset) => (
                  <button
                    key={dataset.dataset_id}
                    type="button"
                    className="block w-full px-3 py-1.5 text-left text-sm hover:bg-surface-soft"
                    onClick={() => {
                      openView("source");
                      setActiveDataset(dataset.dataset_id);
                    }}
                  >
                    {dataset.display_name}
                  </button>
                ))}
              </div>
            </details>
          )}
        </div>

        <div className="mt-5">
          {showResults ? (
            <ResultsView
              documentId={documentId}
              workbook={workbook}
              typeLabel={typeLabel}
              pageCount={Math.max(1, documentMeta?.page_count ?? 1)}
            />
          ) : profileView ? (
            <ProfileViewBody
              documentId={documentId}
              filename={filename || workbook.document_filename}
              view={profileView}
              datasets={laneDatasets}
              allDatasets={datasets}
              focus={sourceFocus}
              onOpenSource={splitSource}
            />
          ) : (
            <>
              {genericView === "data" && (
                <PresentationWorkspace
                  workbook={workbook}
                  documentId={documentId}
                  onViewInDocument={viewInDocument}
                  showHeading={false}
                  showTechnical={false}
                />
              )}
              {genericView === "overview" && (
                <div className="space-y-8">
                  <Overview workbook={workbook} verified={verified} oracle={oracle} />
                  <div className="grid gap-6 xl:grid-cols-2">
                    <DocumentObligationsPanel documentId={documentId} />
                    <DocumentPlaybookPanel documentId={documentId} />
                    <DocumentValidationPanel documentId={documentId} />
                  </div>
                </div>
              )}
              {genericView === "source" && (
                <div className="space-y-4">
                  <SourceTranscription
                    documentId={documentId}
                    documentName={filename}
                    modes
                    modeLabels={DOCUMENT_MODES}
                    focus={sourceFocus}
                  />
                  {current && laneOf(current) === "source" && (
                    <DatasetBody documentId={documentId} dataset={current} onOpenSource={splitSource} />
                  )}
                </div>
              )}
              {genericView === "staging" && (
                <DatasetWorkspace
                  documentId={documentId}
                  datasets={laneDatasets}
                  active={current?.dataset_id ?? ""}
                  onSelect={setActiveDataset}
                  onOpenSource={splitSource}
                />
              )}
              {(genericView === "canonical" || genericView === "transform" || genericView === "qa") && (
                <div className="space-y-4">
                  {genericView === "transform" && (
                    <p className="text-sm text-text-secondary">
                      Source → {profile.display_name} canonical → destination adapter.{" "}
                      {oracle === "none"
                        ? "No destination adapter is configured."
                        : oracle === "planned"
                          ? "Adapter mapping is partially configured. This is not a final import file."
                          : "Adapter mapping is available."}
                    </p>
                  )}
                  {current ? (
                    <DatasetWorkspace
                      documentId={documentId}
                      datasets={laneDatasets}
                      active={current.dataset_id}
                      onSelect={setActiveDataset}
                      onOpenSource={splitSource}
                    />
                  ) : (
                    <p className="text-sm text-text-secondary">This profile has no records in this stage yet.</p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        </div>
      </div>
      ) : null}
      </VerificationWorkspace>

      {(viewMode === "smart" || viewMode === "advanced") && (
      <details
        className="mt-6 rounded-xl border border-border bg-surface"
        onToggle={(event) => setHistoryOpen((event.currentTarget as HTMLDetailsElement).open)}
        data-testid="workspace-review-history"
      >
        <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium text-foreground">
          Review history
          <span className="ml-2 text-xs font-normal text-text-muted">Who accepted, corrected or rejected values, and when</span>
        </summary>
        {historyOpen && (
          <div className="max-h-96 overflow-y-auto border-t border-border">
            <DocumentAuditTrail documentId={documentId} />
          </div>
        )}
      </details>
      )}

      <ol className="mt-6 flex flex-wrap gap-6 border-t border-border pt-3 text-xs text-text-secondary">
        <Readiness label="Extracted" ok={outcome.record_count > 0} />
        <Readiness label="Staging Verified" ok={verified} />
        {!profileView && (
          <Readiness label="Canonical" ok={datasets.some((dataset) => laneOf(dataset) === "canonical")} />
        )}
        <Readiness
          label="Downstream"
          ok={oracle === "available"}
          note={oracle === "planned" ? "Adapter template still required" : undefined}
        />
      </ol>
    </div>
    </SelectionProvider>
  );
}

/** A profile-declared tab: its datasets in order. Record datasets get a
 * search and, when the records have a type column, type filters; a source
 * tab leads with the document's own transcription. */
function ProfileViewBody({
  documentId,
  filename,
  view,
  datasets,
  allDatasets,
  focus = null,
  onOpenSource,
}: {
  documentId: string;
  filename: string;
  view: ProfileView;
  datasets: StagingDataset[];
  allDatasets: StagingDataset[];
  focus?: SourceViewRequest | null;
  onOpenSource?: (request: SourceViewRequest) => void;
}) {
  if (view.kind === "source") {
    const transcription = (
      <section>
        <h2 className="mb-2 text-sm font-medium text-foreground">Source Text</h2>
        <SourceTranscription documentId={documentId} documentName={filename} focus={focus} />
      </section>
    );
    return (
      <div className="space-y-6">
        {/* A linked page (a citation) leads with the document itself. */}
        {focus && transcription}
        {datasets.map((dataset) => (
          <section key={dataset.dataset_id}>
            <h2 className="mb-2 text-sm font-medium text-foreground">{dataset.display_name}</h2>
            <DatasetBody documentId={documentId} dataset={dataset} onOpenSource={onOpenSource} />
          </section>
        ))}
        {!focus && transcription}
      </div>
    );
  }
  return (
    <div className="space-y-6">
      {datasets.map((dataset) =>
        dataset.dataset_id === "far_records" ? (
          // FAR Part 52: a compact data grid with a record drawer.
          <FarRecordsView
            key={dataset.dataset_id}
            documentId={documentId}
            dataset={dataset}
            filename={filename}
            partHeading={farPartHeading(allDatasets)}
          />
        ) : (
        <section key={dataset.dataset_id}>
          {datasets.length > 1 && <h2 className="mb-2 text-sm font-medium text-foreground">{dataset.display_name}</h2>}
          {dataset.description && <p className="mb-3 max-w-3xl text-xs text-text-secondary">{dataset.description}</p>}
          {dataset.dataset_id.startsWith("far_") ? (
            <FilteredRecords documentId={documentId} dataset={withoutBlankColumns(dataset)} dense onOpenSource={onOpenSource} />
          ) : (
            <FilteredRecords documentId={documentId} dataset={dataset} onOpenSource={onOpenSource} />
          )}
        </section>
        ),
      )}
    </div>
  );
}

/** The Part heading the FAR source states ("Part 52 - Solicitation …"). */
function farPartHeading(datasets: StagingDataset[]): string | null {
  const source = datasets.find((dataset) => dataset.dataset_id === "far_source");
  const part = source?.records.find((record) => record.cells["far.source.item"]?.value === "Part");
  const value = part?.cells["far.source.detail"]?.value;
  return value == null ? null : String(value);
}

function FilteredRecords({
  documentId,
  dataset,
  dense = false,
  onOpenSource,
}: {
  documentId: string;
  dataset: StagingDataset;
  dense?: boolean;
  onOpenSource?: (request: SourceViewRequest) => void;
}) {
  const [query, setQuery] = useState("");
  const [type, setType] = useState("all");
  const [section, setSection] = useState("all");
  const typeField = dataset.columns.find((column) => column.canonical_field.endsWith(".record_type"))?.canonical_field;
  const sectionField = dataset.columns.find((column) => column.canonical_field.endsWith(".section"))?.canonical_field;
  // Sections in the order the records give them.
  const sections = useMemo(() => {
    if (!sectionField) return [];
    const counts = new Map<string, number>();
    for (const record of dataset.records) {
      const value = record.cells[sectionField]?.value;
      if (value != null && value !== "") counts.set(String(value), (counts.get(String(value)) ?? 0) + 1);
    }
    return [...counts.entries()];
  }, [dataset, sectionField]);
  const alternateField = dataset.columns.find((column) => column.canonical_field.endsWith(".alternate"))?.canonical_field;

  const types = useMemo(() => {
    if (!typeField) return [];
    const counts = new Map<string, number>();
    for (const record of dataset.records) {
      const value = record.cells[typeField]?.value;
      if (value != null && value !== "") counts.set(String(value), (counts.get(String(value)) ?? 0) + 1);
    }
    const alternates = alternateField
      ? dataset.records.filter((record) => record.cells[alternateField]?.value).length
      : 0;
    // Most common type first; alternates last.
    const items = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, count]) => ({ id: label, label, count }));
    if (alternates) items.push({ id: "__alternate", label: "Alternate", count: alternates });
    return items;
  }, [dataset, typeField, alternateField]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle && type === "all" && section === "all") return dataset;
    const records = dataset.records.filter((record) => {
      if (section !== "all" && sectionField && String(record.cells[sectionField]?.value ?? "") !== section) return false;
      if (type === "__alternate" && !(alternateField && record.cells[alternateField]?.value)) return false;
      if (type !== "all" && type !== "__alternate" && typeField && String(record.cells[typeField]?.value ?? "") !== type) {
        return false;
      }
      if (!needle) return true;
      return Object.values(record.cells).some((cell) => String(cell.value ?? "").toLowerCase().includes(needle));
    });
    return { ...dataset, records };
  }, [dataset, query, type, section, typeField, sectionField, alternateField]);

  if (dataset.cardinality === "single") return <DatasetBody documentId={documentId} dataset={dataset} onOpenSource={onOpenSource} />;
  const summaryFields = summaryColumns(dataset);
  if (summaryFields) return <SummaryCards documentId={documentId} dataset={dataset} fields={summaryFields} />;
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`Search ${dataset.display_name}…`}
          aria-label={`Search ${dataset.display_name}`}
          className="w-full max-w-xs rounded-lg border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-primary/40"
        />
        {sections.length > 1 && (
          <select
            value={section}
            onChange={(event) => setSection(event.target.value)}
            aria-label="Filter by section"
            className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-foreground"
          >
            <option value="all">All sections ({dataset.records.length.toLocaleString()})</option>
            {sections.map(([name, count]) => (
              <option key={name} value={name}>
                {name} ({count.toLocaleString()})
              </option>
            ))}
          </select>
        )}
        {types.length > 1 && (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by record type">
            {[{ id: "all", label: "All", count: dataset.records.length }, ...types].map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={type === item.id}
                onClick={() => setType(item.id)}
                className={[
                  "rounded-full px-3 py-1 text-xs",
                  type === item.id ? "bg-primary text-white" : "border border-border text-text-secondary hover:bg-surface-soft",
                ].join(" ")}
              >
                {item.label} <span className="tabular-nums opacity-70">{item.count.toLocaleString()}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <DatasetBody documentId={documentId} dataset={filtered} dense={dense} onOpenSource={onOpenSource} />
    </div>
  );
}

/** A Category | Field | Value dataset (e.g. Contract Summary) reads as a
 * dashboard: one card per category. */
function summaryColumns(dataset: StagingDataset): { group: string; label: string; value: string } | null {
  const find = (suffix: string) =>
    dataset.columns.find((column) => column.canonical_field.endsWith(suffix))?.canonical_field;
  const group = find(".group");
  const label = find(".label");
  const value = find(".value");
  return group && label && value && dataset.columns.length === 3 ? { group, label, value } : null;
}

function SummaryCards({
  documentId,
  dataset,
  fields,
}: {
  documentId: string;
  dataset: StagingDataset;
  fields: { group: string; label: string; value: string };
}) {
  // Each card line is one record (Category | Field | Value); its checkbox
  // selects that record for Export Selected.
  const [selection, setSelection] = useTableSelection(documentId, dataset.dataset_id, dataset.display_name);
  const lineFields = [fields.group, fields.label, fields.value];
  const allIds = dataset.records.map((record) => record.record_id);
  const groups = new Map<string, StagingDataset["records"]>();
  for (const record of dataset.records) {
    const name = String(record.cells[fields.group]?.value ?? "");
    groups.set(name, [...(groups.get(name) ?? []), record]);
  }
  return (
    <div className="space-y-2">
    <SelectionToolbar
      documentId={documentId}
      datasetId={dataset.dataset_id}
      filename="export"
      selection={selection}
      onClear={() => setSelection(new Map())}
      onSelectVisible={() => setSelection((current) => setCells(current, allIds, lineFields, true))}
    />
    <FieldToneLegend />
    <div className="grid gap-4 md:grid-cols-2">
      {[...groups.entries()].map(([name, records]) => (
        <section key={name} className="rounded-xl border border-border bg-surface p-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-text-teal">{name}</h2>
          <dl className="mt-3 space-y-2.5">
            {records.map((record) => {
              const cell = record.cells[fields.value];
              const review = cell?.review_status === "Needs Review";
              const picked = allSelected(selection, [record.record_id], lineFields);
              return (
                <div
                  key={record.record_id}
                  className={`group grid grid-cols-[minmax(8rem,40%)_1fr] gap-3 rounded text-sm ${picked ? "cell-selected" : ""}`}
                >
                  <dt className="flex items-start gap-1.5 text-text-secondary">
                    <SelectCheckbox
                      small
                      className="cell-check mt-1"
                      checked={picked}
                      indeterminate={someSelected(selection, [record.record_id], lineFields)}
                      onChange={() => setSelection((current) => toggleBlock(current, [record.record_id], lineFields))}
                      label={`Select ${String(record.cells[fields.label]?.value ?? "field")}`}
                    />
                    <span>{String(record.cells[fields.label]?.value ?? "")}</span>
                  </dt>
                  <dd className="whitespace-pre-wrap break-words font-medium text-foreground">
                    <span className={fieldToneClass(toneFromStagingCell(cell))}>{String(cell?.value ?? "—")}</span>
                    {review && <span className="ml-2 text-xs font-normal text-warning">Needs review</span>}
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>
      ))}
    </div>
    </div>
  );
}

function Overview({
  workbook,
  verified,
  oracle,
}: {
  workbook: StagingWorkbook;
  verified: boolean;
  oracle: StagingWorkbook["profile"]["oracle_mapping_capability"];
}) {
  const qa = workbook.qa_summary;
  const quality = qa.record_count === 0 ? 0 : Math.round((qa.verified / qa.record_count) * 100);
  // Each document counts its own repeating records, under the names the
  // document gives them.
  const counted = workbook.datasets
    .filter((dataset) => dataset.role === "business" && dataset.cardinality === "repeating" && dataset.records.length > 0)
    .slice(0, 4)
    .map((dataset) => ({ label: dataset.display_name, value: dataset.records.length }));
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-8">
        <Stat label="Source records" value={workbook.outcome.record_count} />
        {counted.map((stat) => (
          <Stat key={stat.label} label={stat.label} value={stat.value} />
        ))}
        <Stat label="Need review" value={qa.needs_review} />
      </div>
      <div>
        <p className="text-xs uppercase tracking-wide text-text-muted">Quality</p>
        <div className="mt-2 h-2 max-w-md overflow-hidden rounded-full bg-surface-soft">
          <div className="h-full bg-success" style={{ width: `${quality}%` }} />
        </div>
        <p className="mt-2 text-sm text-text-secondary">
          {qa.needs_review === 0 ? "No validation issues detected." : `${qa.needs_review} items need review.`}
          {verified ? " Staging verification is complete." : ""}
        </p>
      </div>
      <div>
        <p className="text-xs uppercase tracking-wide text-text-muted">Transformation readiness</p>
        <p className="mt-2 text-sm text-foreground">
          Destination adapter{" "}
          <span className="text-text-secondary">
            {oracle === "available" ? "configured" : oracle === "planned" ? "partially configured" : "not configured"}
          </span>
        </p>
      </div>
    </div>
  );
}

/** "Clauses.xml · 259 clause records": the primary dataset names what the
 * records are when its name is a plain plural ("Clauses"). */
function recordSummary(workbook: StagingWorkbook): string {
  const primary = workbook.datasets.find(
    (dataset) => dataset.role === "business" && dataset.cardinality === "repeating" && dataset.records.length > 0,
  );
  const name = primary?.display_name.trim() ?? "";
  if (primary && /^[A-Za-z]+s$/.test(name)) {
    const noun = name.replace(/ies$/, "y").replace(/(ch|sh|x|ss)es$/, "$1").replace(/s$/, "").toLowerCase();
    return `${primary.records.length.toLocaleString()} ${noun} records`;
  }
  const count = workbook.outcome.record_count;
  return `${count.toLocaleString()} record${count === 1 ? "" : "s"}`;
}

// A dataset this small (or a single record's field list) shares one tab
// with the other small ones instead of taking a tab of its own.
const SMALL_DATASET_RECORDS = 5;
const COMBINED_TAB = "__combined";

function isSmall(dataset: StagingDataset): boolean {
  return dataset.cardinality === "single" || dataset.records.length <= SMALL_DATASET_RECORDS;
}

type DatasetTab = { id: string; label: string; count: number; datasets: StagingDataset[] };

/** One tab per dataset, except that two or more small datasets are
 * combined into one tab (placed where the first of them was), each shown
 * as its own section. */
export function datasetTabs(datasets: StagingDataset[]): DatasetTab[] {
  const small = datasets.filter(isSmall);
  const combine = small.length >= 2;
  const tabs: DatasetTab[] = [];
  for (const dataset of datasets) {
    if (combine && isSmall(dataset)) {
      if (dataset === small[0]) {
        tabs.push({
          id: COMBINED_TAB,
          label: small.length === 2 ? `${small[0].display_name} & ${small[1].display_name}` : "Details",
          count: small.reduce((sum, item) => sum + item.records.length, 0),
          datasets: small,
        });
      }
      continue;
    }
    tabs.push({ id: dataset.dataset_id, label: dataset.display_name, count: dataset.records.length, datasets: [dataset] });
  }
  return tabs;
}

function searchRecords(dataset: StagingDataset, needle: string): StagingDataset {
  if (!needle || dataset.cardinality !== "repeating") return dataset;
  return {
    ...dataset,
    records: dataset.records.filter((record) =>
      Object.values(record.cells).some((cell) => String(cell.value ?? "").toLowerCase().includes(needle)),
    ),
  };
}

/** Compact dataset tabs (only datasets with records, with counts; small
 * ones combined) and the search on one toolbar above a full-width grid. */
function DatasetWorkspace({
  documentId,
  datasets,
  active,
  onSelect,
  onOpenSource,
}: {
  documentId: string;
  datasets: StagingDataset[];
  active: string;
  onSelect: (id: string) => void;
  onOpenSource?: (request: SourceViewRequest) => void;
}) {
  const [query, setQuery] = useState("");
  const useful = datasets.filter((dataset) => dataset.records.length > 0);
  const shown = useful.length > 0 ? useful : datasets.slice(0, 1);
  const tabs = datasetTabs(shown);
  const current = tabs.find((tab) => tab.datasets.some((dataset) => dataset.dataset_id === active)) ?? tabs[0];
  const needle = query.trim().toLowerCase();
  if (!current) return null;
  const searchable = current.datasets.some((dataset) => dataset.cardinality === "repeating");
  const combined = current.datasets.length > 1;
  const sections = current.datasets
    .map((dataset) => searchRecords(dataset, needle))
    .filter((dataset) => !needle || !combined || dataset.cardinality === "single" || dataset.records.length > 0);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border">
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Datasets">
          {tabs.map((tab) => {
            const selected = tab.id === current.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                title={tab.datasets.length > 1 ? tab.datasets.map((dataset) => dataset.display_name).join(" · ") : undefined}
                onClick={() => {
                  onSelect(tab.datasets[0].dataset_id);
                  setQuery("");
                }}
                className={[
                  "-mb-px border-b-2 px-3 py-2 text-sm",
                  selected ? "border-primary font-medium text-foreground" : "border-transparent text-text-secondary hover:text-foreground",
                ].join(" ")}
              >
                {tab.label}
                <span className="ml-1.5 text-xs tabular-nums text-text-muted">{tab.count.toLocaleString()}</span>
              </button>
            );
          })}
        </div>
        {searchable && (
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search records…"
            aria-label={`Search ${current.label}`}
            className="mb-1.5 h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm outline-none focus:border-primary/50 sm:w-72"
          />
        )}
      </div>
      {combined ? (
        <div className="space-y-6">
          {sections.map((dataset) => (
            <section key={dataset.dataset_id} aria-label={dataset.display_name}>
              <h2 className="mb-2 text-sm font-medium text-foreground">
                {dataset.display_name}
                <span className="ml-1.5 text-xs font-normal tabular-nums text-text-muted">
                  {dataset.records.length.toLocaleString()}
                </span>
              </h2>
              <DatasetBody documentId={documentId} dataset={dataset} onOpenSource={onOpenSource} />
            </section>
          ))}
          {sections.length === 0 && <p className="text-sm text-text-secondary">No records match this search.</p>}
        </div>
      ) : (
        <DatasetBody documentId={documentId} dataset={sections[0] ?? current.datasets[0]} onOpenSource={onOpenSource} />
      )}
    </div>
  );
}

function DatasetBody({
  documentId,
  dataset,
  dense = true,
  onOpenSource,
}: {
  documentId: string;
  dataset: StagingDataset;
  dense?: boolean;
  onOpenSource?: (request: SourceViewRequest) => void;
}) {
  if (dataset.cardinality === "single") {
    return <StagingFieldList dataset={dataset} documentId={documentId} onOpenSource={onOpenSource} />;
  }
  return <StagingDatasetTable documentId={documentId} dataset={dataset} dense={dense} onOpenSource={onOpenSource} />;
}

/** The page's shape while the document loads: header, tabs, a table. */
function WorkspaceSkeleton() {
  const bar = "animate-pulse rounded bg-surface-soft";
  return (
    <div className="workspace-page w-full px-4 py-4 sm:px-6" aria-busy="true" aria-label="Opening document" data-testid="workspace-skeleton">
      <div className={`${bar} h-4 w-24`} />
      <div className={`${bar} mt-3 h-7 w-72 max-w-full`} />
      <div className={`${bar} mt-2 h-4 w-96 max-w-full`} />
      <div className="mt-3 flex gap-4">
        {[56, 64, 72, 80].map((width, index) => (
          <div key={index} className={`${bar} h-3`} style={{ width }} />
        ))}
      </div>
      <div className="mt-5 flex gap-4 border-b border-border pb-2">
        {[48, 56, 64, 56].map((width, index) => (
          <div key={index} className={`${bar} h-4`} style={{ width }} />
        ))}
      </div>
      <div className="mt-4 space-y-2">
        {Array.from({ length: 8 }, (_, index) => (
          <div key={index} className={`${bar} h-8`} />
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-2xl font-semibold tabular-nums text-foreground">{value.toLocaleString()}</p>
      <p className="text-xs text-text-muted">{label}</p>
    </div>
  );
}

function Readiness({ label, ok, note }: { label: string; ok: boolean; note?: string }) {
  return (
    <li>
      <span className={ok ? "text-success" : "text-warning"}>{ok ? "✓" : "!"}</span> {label}
      {note && <span className="mt-0.5 block text-text-muted">{note}</span>}
    </li>
  );
}
