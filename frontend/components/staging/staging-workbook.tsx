"use client";

import { ChevronDown, Download } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { SourceViewRequest } from "@/components/source-verification-panel";
import OutcomeBanner from "@/components/staging/outcome-banner";
import ContractSummaryPanel from "@/components/staging/contract-summary-panel";
import type { EvidenceTarget } from "@/components/staging/evidence-drawer";
import { cellSourceRequest } from "@/components/staging/review-status";
import SourceTranscription from "@/components/staging/source-transcription";
import StagingDatasetTable from "@/components/staging/staging-dataset-table";
import StagingFieldList from "@/components/staging/staging-field-list";
import TranscriptPanes from "@/components/staging/transcript-workbook";
import PresentationWorkspace, { type MoreAction } from "@/components/staging/presentation-workspace";
import { ApiError, COLD_START_RETRY_DELAYS_MS } from "@/lib/api";
import { storeAccessToken } from "@/lib/entra-auth";
import {
  downloadExport,
  getStagingWorkbook,
  type StagingDataset,
  type StagingWorkbook as Workbook,
} from "@/lib/staging-workbook";
import { contractTabs, initialContractTab, isContractProfile } from "@/lib/contract-workbook-nav";
import { isTranscriptProfile } from "@/lib/transcript-workbook";

// The document itself, as opposed to the data staged from it.
const DOCUMENT_MODES = { original: "Original", text: "Extracted Text" };

interface StagingWorkbookProps {
  documentId: string;
  documentName?: string;
  onOpenSource?: (request: SourceViewRequest) => void;
  selectedSourceId?: string | null;
  /** Changes whenever a new extraction job completes for this document in
   * the same page session, so a workbook fetched mid-job is refetched. */
  refreshKey?: string | number;
  /** Reviewer/developer views the host page offers under "More". */
  moreActions?: MoreAction[];
  /** Source Verification, shown under the Staging Workbook / Source tabs
   * (Staging Workbook view only — the Source view has its own viewer). */
  sourceVerification?: ReactNode;
}

type View = "workbook" | "source" | "qa";

// The staging stage runs last in the extraction job; a fetch landing just
// before it finishes reports outcome "pending". Retry briefly before
// showing the pending explanation.
const PENDING_RETRY_DELAYS_MS = [2500, 4000, 6000];

function hasValues(dataset: StagingDataset): boolean {
  return dataset.records.some((record) =>
    Object.values(record.cells).some((cell) => cell.value != null),
  );
}

/** Presentation only — the profile's datasets and exports are unchanged.
 * The generic profile reads as Overview | Key Fields | Tables | All Fields,
 * showing Contacts / Line Items only when they hold something. */
const PRESENTATION: Record<string, { labels: Record<string, string>; hideWhenEmpty: string[] }> = {
  generic_business_document: {
    labels: { document_summary: "Overview", other_tables: "Tables" },
    hideWhenEmpty: ["contacts", "line_items"],
  },
};

function presentationFor(workbook: Workbook) {
  return PRESENTATION[workbook.profile.profile_id] ?? { labels: {}, hideWhenEmpty: [] };
}

function isShown(workbook: Workbook, dataset: StagingDataset): boolean {
  return !(presentationFor(workbook).hideWhenEmpty.includes(dataset.dataset_id) && !hasValues(dataset));
}

function tabLabel(workbook: Workbook, dataset: StagingDataset): string {
  return presentationFor(workbook).labels[dataset.dataset_id] ?? dataset.display_name;
}

function initialDataset(workbook: Workbook): string {
  if (isContractProfile(workbook)) return initialContractTab(workbook);
  const business = workbook.datasets.find((d) => d.role === "business" && hasValues(d));
  const fallback =
    workbook.datasets.find((d) => d.role === "source") ??
    workbook.datasets.find((d) => d.role === "qa") ??
    workbook.datasets[0];
  return (business ?? fallback)?.dataset_id ?? "";
}

function datasetCount(dataset: StagingDataset): string {
  if (dataset.cardinality === "single") {
    const cells = Object.values(dataset.records[0]?.cells ?? {});
    const found = cells.filter((cell) => cell.value != null).length;
    return `${found}/${cells.length}`;
  }
  return String(dataset.records.length);
}

/** The Professional Staging Workbook — the primary Results experience for
 * every staging profile. */
export default function StagingWorkbook({
  documentId,
  documentName,
  onOpenSource,
  selectedSourceId,
  refreshKey,
  moreActions = [],
  sourceVerification,
}: StagingWorkbookProps) {
  const [workbook, setWorkbook] = useState<Workbook | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savedKeyRejected, setSavedKeyRejected] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const [view, setView] = useState<View>("workbook");
  const [activeDataset, setActiveDataset] = useState("");
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [documentFocus, setDocumentFocus] = useState<SourceViewRequest | null>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    // Render's free tier sleeps when idle and answers 502/503 (or fails
    // outright) while waking — transient, so retry through the cold-start
    // window. Real 4xx errors fail fast.
    function isTransient(err: unknown): boolean {
      return !(err instanceof ApiError) || err.status >= 500;
    }

    async function load() {
      setLoading(true);
      setError(null);
      setSavedKeyRejected(false);
      let pendingAttempts = 0;
      let failedAttempts = 0;
      while (true) {
        let delay: number;
        try {
          const data = await getStagingWorkbook(documentId);
          if (cancelled) return;
          if (
            data.outcome.status !== "pending" ||
            pendingAttempts === PENDING_RETRY_DELAYS_MS.length
          ) {
            setWorkbook(data);
            setActiveDataset(initialDataset(data));
            setLoading(false);
            return;
          }
          delay = PENDING_RETRY_DELAYS_MS[pendingAttempts];
          pendingAttempts += 1;
        } catch (err) {
          if (cancelled) return;
          if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
            // No key is needed to view a workbook, so a 401/403 here means
            // an access key saved in this browser is invalid or too narrow.
            setError(
              err.status === 401
                ? "The access key saved in this browser is no longer valid."
                : "The access key saved in this browser can't open this workbook.",
            );
            setSavedKeyRejected(true);
            setLoading(false);
            return;
          }
          if (!isTransient(err) || failedAttempts === COLD_START_RETRY_DELAYS_MS.length) {
            setError("Unable to load the staging workbook.");
            setLoading(false);
            return;
          }
          delay = COLD_START_RETRY_DELAYS_MS[failedAttempts];
          failedAttempts += 1;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (cancelled) return;
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [documentId, refreshKey, retryTick]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (exportMenuRef.current && !exportMenuRef.current.contains(event.target as Node)) {
        setExportMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const businessDatasets = useMemo(
    () => workbook?.datasets.filter((d) => d.role === "business" && isShown(workbook, d)) ?? [],
    [workbook],
  );

  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-surface-soft p-6 text-sm text-text-secondary">
        Preparing staging workbook...
      </div>
    );
  }

  if (error || !workbook) {
    return (
      <div className="space-y-3 rounded-xl border border-border bg-surface-soft p-6 text-sm">
        <p className="text-danger">{error ?? "Unable to load the staging workbook."}</p>
        <button
          type="button"
          onClick={() => {
            if (savedKeyRejected) {
              storeAccessToken(null);
              setSavedKeyRejected(false);
            }
            setRetryTick((tick) => tick + 1);
          }}
          className="btn-secondary text-xs"
        >
          {savedKeyRejected ? "Remove saved key and retry" : "Retry"}
        </button>
      </div>
    );
  }

  const { profile, outcome } = workbook;

  function viewInDocument(target: EvidenceTarget) {
    const request = cellSourceRequest(target.cell, `${target.fieldId ?? target.cell.canonical_field}:${Date.now()}`);
    if (!request) return;
    setDocumentFocus({ ...request, label: target.field });
    setView("source");
  }
  const baseName = (documentName ?? workbook.document_filename).replace(/\.[^.]+$/, "");
  const wholeExports = profile.export_capabilities.filter((c) => !c.dataset_id);
  const datasetExports = profile.export_capabilities.filter((c) => c.dataset_id);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-end gap-3">
        {profile.export_capabilities.length > 0 && (
          <div className="relative" ref={exportMenuRef}>
            <button
              type="button"
              onClick={() => setExportMenuOpen((open) => !open)}
              className="btn-primary text-sm"
            >
              <Download className="h-4 w-4" />
              Export
              <ChevronDown className="h-4 w-4" />
            </button>
            {exportMenuOpen && (
              <div className="absolute right-0 top-full z-10 mt-1 w-72 rounded-lg border border-border bg-surface p-1 shadow-lg">
                {[...wholeExports, ...datasetExports].map((capability, index) => (
                  <div key={capability.href}>
                    {index === wholeExports.length && wholeExports.length > 0 && (
                      <div className="my-1 border-t border-border" />
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setExportMenuOpen(false);
                        setExportError(null);
                        downloadExport(capability, baseName).catch((err: unknown) =>
                          setExportError(err instanceof Error ? err.message : "Export failed."),
                        );
                      }}
                      className={`block w-full rounded-md px-3 py-2 text-left text-xs text-foreground hover:bg-surface-soft ${capability.dataset_id ? "" : "font-semibold"}`}
                    >
                      {capability.label}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {exportError && <p className="text-xs text-danger">{exportError}</p>}

      {outcome.status !== "populated" && <OutcomeBanner outcome={outcome} />}

      <div role="tablist" aria-label="Workbook views" className="flex gap-4 border-b border-border text-sm">
        {(
          [
            ["workbook", "Staging Workbook"],
            ["source", "Source"],
          ] as [View, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={view === id}
            onClick={() => setView(id)}
            className={[
              "-mb-px border-b-2 px-1 py-2 font-medium transition",
              view === id
                ? "border-primary text-foreground"
                : "border-transparent text-text-secondary hover:text-foreground",
            ].join(" ")}
          >
            {label}
          </button>
        ))}
      </div>

      {view === "source" ? (
        <SourceTranscription
          documentId={documentId}
          documentName={documentName ?? workbook.document_filename}
          modes
          modeLabels={DOCUMENT_MODES}
          focus={documentFocus}
        />
      ) : (
        <>
          {sourceVerification}
          <PresentationWorkspace
            workbook={workbook}
            documentId={documentId}
            onOpenSource={onOpenSource}
            onViewInDocument={viewInDocument}
            moreActions={[...moreActions, { label: "Source structure", onSelect: () => setView("source") }]}
          />
        </>
      )}
    </div>
  );
}

function QaPane({
  workbook,
  onOpenDataset,
}: {
  workbook: Workbook;
  onOpenDataset: (datasetId: string) => void;
}) {
  const qa = workbook.datasets.find((dataset) => dataset.dataset_id === "qa_review");
  if (!qa) {
    return <p className="text-sm text-text-secondary">No QA review rows for this document.</p>;
  }
  return (
    <StagingDatasetTable dataset={qa} onOpenDataset={onOpenDataset} />
  );
}

function ContractPanes({
  workbook,
  documentId,
  active,
  onSelect,
  onOpenSource,
  selectedSourceId,
}: {
  workbook: Workbook;
  documentId: string;
  active: string;
  onSelect: (id: string) => void;
  onOpenSource?: (request: import("@/components/source-verification-panel").SourceViewRequest) => void;
  selectedSourceId?: string | null;
}) {
  const tabs = contractTabs(workbook.datasets);
  const current = tabs.find((tab) => tab.id === active) ?? tabs[0];
  const datasets = (current?.datasetIds ?? [])
    .map((id) => workbook.datasets.find((dataset) => dataset.dataset_id === id))
    .filter((dataset): dataset is StagingDataset => Boolean(dataset));

  return (
    <>
      <div role="tablist" aria-label="Datasets" className="flex flex-wrap gap-1.5">
        {tabs.map((tab) => {
          const count = tab.datasetIds.reduce((sum, id) => {
            const dataset = workbook.datasets.find((item) => item.dataset_id === id);
            return sum + (dataset?.records.length ?? 0);
          }, 0);
          const selected = current?.id === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-label={tab.label}
              onClick={() => onSelect(tab.id)}
              className={[
                "rounded-md border px-2.5 py-1 text-[13px]",
                selected
                  ? "border-primary bg-primary text-white"
                  : "border-border bg-surface text-text-secondary hover:bg-surface-soft",
              ].join(" ")}
            >
              {tab.label}
              {tab.id !== "summary" && <span className={selected ? "text-white/75" : "text-text-muted"}> {count}</span>}
            </button>
          );
        })}
      </div>
      {datasets.map((dataset) => (
        <section key={dataset.dataset_id} className="space-y-2">
          {datasets.length > 1 && (
            <h4 className="text-sm font-medium text-foreground">{dataset.display_name}</h4>
          )}
          {dataset.dataset_id === "contract_summary" ? (
            <ContractSummaryPanel dataset={dataset} onOpenSource={onOpenSource} />
          ) : dataset.cardinality === "single" ? (
            <StagingFieldList dataset={dataset} onOpenSource={onOpenSource} selectedId={selectedSourceId} />
          ) : (
            <StagingDatasetTable
              key={dataset.dataset_id}
              dataset={dataset}
              documentId={documentId}
              onOpenSource={onOpenSource}
              onOpenDataset={onSelect}
              selectedId={selectedSourceId}
              dense
            />
          )}
        </section>
      ))}
    </>
  );
}
