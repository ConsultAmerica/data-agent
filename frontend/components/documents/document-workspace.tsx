"use client";

import Link from "next/link";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, RefreshCw } from "lucide-react";

import { useDocumentChrome } from "@/components/layout/document-chrome-context";
import OracleIntegrationPanel from "@/components/oracle-integration-panel";
import type { SourceViewRequest } from "@/components/source-verification-panel";
import type { EvidenceTarget } from "@/components/staging/evidence-drawer";
import FarRecordsView from "@/components/staging/far-records-view";
import PresentationWorkspace from "@/components/staging/presentation-workspace";
import { cellSourceRequest } from "@/components/staging/review-status";
import { withoutBlankColumns } from "@/lib/far-records";
import SourceTranscription from "@/components/staging/source-transcription";
import StagingDatasetTable from "@/components/staging/staging-dataset-table";
import StagingFieldList from "@/components/staging/staging-field-list";
import { getDocument, startProcessingJob } from "@/lib/documents";
import { FAMILY_LABELS } from "@/lib/document-families";
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

/** Generic tabs, for profiles that don't declare their own presentation:
 * the business view (Data) and the document itself first, then the
 * pipeline's technical stages. */
const GENERIC_VIEWS = [
  { id: "data", label: "Data" },
  { id: "source", label: "Source" },
  { id: "overview", label: "Overview" },
  { id: "staging", label: "Staging" },
  { id: "canonical", label: "Canonical" },
  { id: "transform", label: "Transform" },
  { id: "qa", label: "QA" },
] as const;

type GenericViewId = (typeof GENERIC_VIEWS)[number]["id"];
/** Tabs from here on are the pipeline's technical stages. */
const FIRST_TECHNICAL_VIEW: GenericViewId = "staging";
const DOCUMENT_MODES = { original: "Original", text: "Extracted Text" };

function laneOf(dataset: StagingDataset): GenericViewId | "advanced" {
  const id = dataset.dataset_id;
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
  const [exportError, setExportError] = useState("");
  const [exportBusy, setExportBusy] = useState(false);
  const [exportNotice, setExportNotice] = useState("");
  const [showOracle, setShowOracle] = useState(false);
  const [notice, setNotice] = useState("");
  const [reprocessing, setReprocessing] = useState(false);
  const [activeDataset, setActiveDataset] = useState("");
  // A value opened from the Data tab ("View in document"), shown in Source.
  const [sourceFocus, setSourceFocus] = useState<SourceViewRequest | null>(null);
  // Grid selections (per dataset) live here, so they survive tab switches,
  // filters and pagination, and the Export menu can export them.
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
    return () => setDocumentTitle(null);
  }, [filename, workbook?.document_filename, setDocumentTitle]);

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
  // Documents open on their business data; the staged records are a tab away.
  const genericView = (GENERIC_VIEWS.find((item) => item.id === requestedView)?.id ?? "data") as GenericViewId;

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
    if (!laneDatasets.some((dataset) => dataset.dataset_id === activeDataset)) {
      setActiveDataset(laneDatasets[0].dataset_id);
    }
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

  function viewInDocument(target: EvidenceTarget) {
    const request = cellSourceRequest(target.cell, `${target.fieldId ?? target.cell.canonical_field}:${Date.now()}`);
    if (!request) return;
    setSourceFocus({ ...request, label: target.field });
    openView("source");
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
  const activeTab = profileView?.view_id ?? genericView;

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

  const docStatus = (documentMeta?.status ?? "completed") as DocumentStatus;
  const familyId = profile.document_families?.[0] ?? "";
  const typeLabel = (familyId && FAMILY_LABELS[familyId]) || profile.display_name;
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
          <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs" data-testid="workspace-status">
            <div className="flex items-center gap-1.5">
              <dt className="text-text-muted">Type</dt>
              <dd className="font-medium text-foreground" data-testid="workspace-type">
                {typeLabel}
              </dd>
            </div>
            <div className="flex items-center gap-1.5">
              <dt className="text-text-muted">Profile</dt>
              <dd className="font-medium text-foreground" data-testid="workspace-profile">
                {profile.display_name}
              </dd>
            </div>
            <div className="flex items-center gap-1.5">
              <dt className="text-text-muted">Processing</dt>
              <dd className={`font-medium ${docStatus === "failed" ? "text-danger" : "text-foreground"}`}>
                {processingLabel}
              </dd>
            </div>
            <div className="flex items-center gap-1.5">
              <dt className="text-text-muted">Review</dt>
              <dd className={`font-medium ${qa.needs_review > 0 || presentation.status === "review" ? "text-warning" : "text-success"}`}>
                {statusMark(qa.needs_review > 0 ? "review" : presentation.status)} {reviewLabel}
                {qa.needs_review > 0 && (
                  <span className="ml-1 font-normal text-text-secondary">
                    ({qa.needs_review.toLocaleString()})
                  </span>
                )}
              </dd>
            </div>
          </dl>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/documents/${documentId}/review`}
            className="btn-secondary px-3 py-2 text-sm"
            data-testid="open-metadata-review"
          >
            Metadata review
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
                  Staging — Export All
                </p>
                {profile.export_capabilities.length === 0 && (
                  <p className="px-3 py-1.5 pl-5 text-xs text-text-muted">
                    No staging export formats available for this profile.
                  </p>
                )}
                {profile.export_capabilities.map((capability) => (
                  <button
                    key={capability.capability_id}
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
                  Staging — Export Selected
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

      {showOracle && (
        <div className="mt-4" data-testid="workspace-oracle-section">
          <OracleIntegrationPanel
            documentId={documentId}
            documentFilename={filename || workbook.document_filename}
          />
        </div>
      )}

      <div className="mt-4 flex items-end gap-1 border-b border-border">
        {/* One row that scrolls sideways on narrow screens, never wraps. */}
        <div className="scrollbar-none -mb-px flex min-w-0 flex-1 items-end gap-1 overflow-x-auto" role="tablist" aria-label="Document views">
          {tabs.map((item) => (
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
        {advanced.length > 0 && (
          <details className="relative shrink-0">
            <summary className="cursor-pointer list-none px-3 py-2 text-sm text-text-secondary hover:text-foreground">
              More
            </summary>
            <div className="absolute right-0 z-20 mt-1 min-w-[12rem] rounded-lg border border-border bg-surface py-1 shadow-sm">
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
        {profileView ? (
          <ProfileViewBody
            documentId={documentId}
            filename={filename || workbook.document_filename}
            view={profileView}
            datasets={laneDatasets}
            allDatasets={datasets}
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
            {genericView === "overview" && <Overview workbook={workbook} verified={verified} oracle={oracle} />}
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
                  <DatasetBody documentId={documentId} dataset={current} />
                )}
              </div>
            )}
            {genericView === "staging" && (
              <DatasetWorkspace
                documentId={documentId}
                datasets={laneDatasets}
                active={current?.dataset_id ?? ""}
                onSelect={setActiveDataset}
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
                  />
                ) : (
                  <p className="text-sm text-text-secondary">This profile has no records in this stage yet.</p>
                )}
              </div>
            )}
          </>
        )}
      </div>

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
}: {
  documentId: string;
  filename: string;
  view: ProfileView;
  datasets: StagingDataset[];
  allDatasets: StagingDataset[];
}) {
  if (view.kind === "source") {
    return (
      <div className="space-y-6">
        {datasets.map((dataset) => (
          <section key={dataset.dataset_id}>
            <h2 className="mb-2 text-sm font-medium text-foreground">{dataset.display_name}</h2>
            <DatasetBody documentId={documentId} dataset={dataset} />
          </section>
        ))}
        <section>
          <h2 className="mb-2 text-sm font-medium text-foreground">Source Text</h2>
          <SourceTranscription documentId={documentId} documentName={filename} />
        </section>
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
            <FilteredRecords documentId={documentId} dataset={withoutBlankColumns(dataset)} dense />
          ) : (
            <FilteredRecords documentId={documentId} dataset={dataset} />
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
}: {
  documentId: string;
  dataset: StagingDataset;
  dense?: boolean;
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

  if (dataset.cardinality === "single") return <DatasetBody documentId={documentId} dataset={dataset} />;
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
      <DatasetBody documentId={documentId} dataset={filtered} dense={dense} />
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
                    {String(cell?.value ?? "—")}
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
}: {
  documentId: string;
  datasets: StagingDataset[];
  active: string;
  onSelect: (id: string) => void;
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
              <DatasetBody documentId={documentId} dataset={dataset} />
            </section>
          ))}
          {sections.length === 0 && <p className="text-sm text-text-secondary">No records match this search.</p>}
        </div>
      ) : (
        <DatasetBody documentId={documentId} dataset={sections[0] ?? current.datasets[0]} />
      )}
    </div>
  );
}

function DatasetBody({
  documentId,
  dataset,
  dense = true,
}: {
  documentId: string;
  dataset: StagingDataset;
  dense?: boolean;
}) {
  if (dataset.cardinality === "single") {
    return <StagingFieldList dataset={dataset} documentId={documentId} />;
  }
  return <StagingDatasetTable documentId={documentId} dataset={dataset} dense={dense} />;
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
