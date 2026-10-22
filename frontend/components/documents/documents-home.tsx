"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  FileText,
  LayoutGrid,
  List,
  MoreHorizontal,
  Plus,
  Search,
  X,
} from "lucide-react";

import DocumentPreviewDrawer from "@/components/documents/document-preview-drawer";
import PageHeader from "@/components/layout/PageHeader";
import { ErrorState } from "@/components/layout/StatusState";
import DensityToggle from "@/components/ui/density-toggle";
import { HIGH_BAND_MIN } from "@/lib/confidence-policy";
import {
  acceptReviewQueueFields,
  deleteDocuments,
  getDocumentStatusCounts,
  getReviewQueueFields,
  isLowRiskQueueField,
  searchDocuments,
  startProcessingJob,
  type DocumentSortBy,
  type DocumentSortDir,
} from "@/lib/documents";
import { FAMILY_LABELS } from "@/lib/document-families";
import { useBrowserPreference } from "@/lib/browser-preference";
import {
  DOCUMENT_SEARCH_PLACEHOLDER,
  EXTRACTED_STATUS_TONE,
  extractedStatusLabel,
  formatContractValue,
  formatDocumentDate,
} from "@/lib/document-repository";
import { getDocumentTypeAppearance } from "@/lib/document-type-icon";
import { useTableDensity } from "@/lib/table-density";
import { presentDocument, statusMark } from "@/lib/document-presentation";
import { downloadExport, getStagingProfile } from "@/lib/staging-workbook";
import type { DocumentStatus, DocumentSummary } from "@/types/document";

export { FAMILY_LABELS };

const PAGE_SIZE = 25;

type StatusFilter = "all" | "review" | "ready" | "failed" | "processing";

const STATUS_FILTERS: { id: StatusFilter; label: string; status?: DocumentStatus }[] = [
  { id: "all", label: "All statuses" },
  { id: "review", label: "Needs review", status: "review_required" },
  { id: "ready", label: "Ready", status: "completed" },
  { id: "processing", label: "Processing", status: "processing" },
  { id: "failed", label: "Failed", status: "failed" },
];

const PROFILE_OPTIONS: { id: string; label: string }[] = [
  { id: "", label: "All profiles" },
  { id: "contract_v3", label: "Government Contract" },
  { id: "invoice", label: "Invoice" },
  { id: "far_part_52", label: "FAR Regulation" },
  { id: "far_regulatory_change", label: "FAR Final Rule" },
  { id: "xml_document", label: "FAR Clause XML" },
  { id: "academic_transcript", label: "Academic Transcript" },
  { id: "generic_business_document", label: "Generic Document" },
];

function isStatusFilter(value: string | null): value is StatusFilter {
  return STATUS_FILTERS.some((item) => item.id === value);
}

function isSortBy(value: string | null): value is DocumentSortBy {
  return value === "uploaded_at" || value === "updated_at";
}

function isSortDir(value: string | null): value is DocumentSortDir {
  return value === "asc" || value === "desc";
}

type RepositoryView = "table" | "grid";
const REPOSITORY_VIEWS: readonly RepositoryView[] = ["table", "grid"];

export default function DocumentsHome() {
  const router = useRouter();
  const [density, setDensity] = useTableDensity("documents");
  const [view, setView] = useBrowserPreference<RepositoryView>("dx-documents-view", REPOSITORY_VIEWS, "table");
  const [previewing, setPreviewing] = useState<DocumentSummary | null>(null);
  const closePreview = useCallback(() => setPreviewing(null), []);
  const params = useSearchParams();
  const urlFilter = params.get("filter");
  const urlFamily = params.get("family") ?? "";
  const urlProfile = params.get("profile") ?? "";
  const urlQ = params.get("q") ?? "";
  const urlSort = params.get("sort");
  const urlDir = params.get("dir");

  const [filter, setFilter] = useState<StatusFilter>(isStatusFilter(urlFilter) ? urlFilter : "all");
  const [family, setFamily] = useState(urlFamily);
  const [profileId, setProfileId] = useState(urlProfile);
  const [query, setQuery] = useState(urlQ);
  const [debouncedQuery, setDebouncedQuery] = useState(urlQ.trim());
  // RC2-08: updated_at sort uses a capped scan window and is not globally
  // correct under pagination — only uploaded_at is offered as accurate.
  const [sortBy, setSortBy] = useState<DocumentSortBy>("uploaded_at");
  const [sortDir, setSortDir] = useState<DocumentSortDir>(isSortDir(urlDir) ? urlDir : "desc");
  const [reloadKey, setReloadKey] = useState(0);
  const [offset, setOffset] = useState(Number(params.get("offset") || 0) || 0);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Record<"all" | "review" | "ready" | "failed" | "processing", number> | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Map<string, DocumentSummary>>(new Map());
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<DocumentSummary[] | null>(null);
  const [notice, setNotice] = useState("");
  const [reprocessing, setReprocessing] = useState(false);
  const [acceptingLowRisk, setAcceptingLowRisk] = useState(false);
  const lastWrittenUrl = useRef("");

  // Follow deep links from the sidebar / type tiles (external URL changes).
  useEffect(() => {
    const incoming = params.toString();
    if (incoming === lastWrittenUrl.current) return;
    setFilter(isStatusFilter(urlFilter) ? urlFilter : "all");
    setFamily(urlFamily);
    setProfileId(urlProfile);
    setQuery(urlQ);
    setDebouncedQuery(urlQ.trim());
    // Ignore legacy sort=updated_at deep links (capped scan; not globally accurate).
    setSortBy("uploaded_at");
    setSortDir(isSortDir(urlDir) ? urlDir : "desc");
    const nextOffset = Number(params.get("offset") || 0) || 0;
    setOffset(nextOffset);
  }, [params, urlFilter, urlFamily, urlProfile, urlQ, urlSort, urlDir]);

  // Persist filters in the URL so returning from a document keeps the view.
  useEffect(() => {
    const next = new URLSearchParams();
    if (debouncedQuery) next.set("q", debouncedQuery);
    if (filter !== "all") next.set("filter", filter);
    if (family) next.set("family", family);
    if (profileId) next.set("profile", profileId);
    if (sortBy !== "uploaded_at") next.set("sort", sortBy);
    if (sortDir !== "desc") next.set("dir", sortDir);
    if (offset > 0) next.set("offset", String(offset));
    const qs = next.toString();
    if (qs === lastWrittenUrl.current || qs === params.toString()) {
      lastWrittenUrl.current = qs;
      return;
    }
    lastWrittenUrl.current = qs;
    router.replace(qs ? `/documents?${qs}` : "/documents", { scroll: false });
  }, [debouncedQuery, filter, family, profileId, sortBy, sortDir, offset, router, params]);

  useEffect(() => {
    let active = true;
    getDocumentStatusCounts(family || undefined)
      .then(({ total: all, by_status }) => {
        if (!active) return;
        setCounts({
          all,
          review: by_status.review_required ?? 0,
          ready: by_status.completed ?? 0,
          failed: by_status.failed ?? 0,
          processing: by_status.processing ?? 0,
        });
      })
      .catch(() => {
        /* Table error covers outages. */
      });
    return () => {
      active = false;
    };
  }, [family, reloadKey]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query.trim());
      setOffset(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let active = true;
    const status = STATUS_FILTERS.find((item) => item.id === filter)?.status;

    async function load() {
      setLoading(true);
      setError("");
      try {
        const result = await searchDocuments({
          q: debouncedQuery || undefined,
          status,
          family: family || undefined,
          profileId: profileId || undefined,
          sortBy,
          sortDir,
          limit: PAGE_SIZE,
          offset,
        });
        if (!active) return;
        setDocuments(result.documents);
        setTotal(result.total);
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : "Unable to load documents.");
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    load();
    return () => {
      active = false;
    };
  }, [filter, debouncedQuery, offset, reloadKey, family, profileId, sortBy, sortDir]);

  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);
  const pageIds = useMemo(() => documents.map((document) => document.document_id), [documents]);
  const allSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const someSelected = pageIds.some((id) => selected.has(id));
  const filtersActive = Boolean(debouncedQuery || filter !== "all" || family || profileId || sortBy !== "uploaded_at" || sortDir !== "desc");
  const selectedList = useMemo(() => Array.from(selected.values()), [selected]);

  const clearFilters = useCallback(() => {
    setQuery("");
    setDebouncedQuery("");
    setFilter("all");
    setFamily("");
    setProfileId("");
    setSortBy("uploaded_at");
    setSortDir("desc");
    setOffset(0);
  }, []);

  function documentHref(documentId: string, suffix = "") {
    const next = new URLSearchParams();
    if (debouncedQuery) next.set("q", debouncedQuery);
    if (filter !== "all") next.set("filter", filter);
    if (family) next.set("family", family);
    if (profileId) next.set("profile", profileId);
    if (sortBy !== "uploaded_at") next.set("sort", sortBy);
    if (sortDir !== "desc") next.set("dir", sortDir);
    if (offset > 0) next.set("offset", String(offset));
    const base = `/documents/${documentId}${suffix ? `/${suffix}` : ""}`;
    const qs = next.toString();
    return qs ? `${base}?return=${encodeURIComponent(qs)}` : base;
  }

  /** The … menu of one row or card. */
  function rowMenu(document: DocumentSummary) {
    return (
      <RowMenu
        staged={presentDocument(document).staged}
        processing={document.status === "processing"}
        onClose={() => setMenuFor(null)}
        onOpen={() => {
          setMenuFor(null);
          router.push(documentHref(document.document_id));
        }}
        onReview={() => {
          setMenuFor(null);
          router.push(documentHref(document.document_id, "review"));
        }}
        onExport={() => void exportDocument(document)}
        onReprocess={() => void reprocessOne(document)}
        onDelete={() => {
          setMenuFor(null);
          setConfirm([document]);
        }}
      />
    );
  }

  function toggle(document: DocumentSummary) {
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(document.document_id)) next.delete(document.document_id);
      else next.set(document.document_id, document);
      return next;
    });
  }

  function selectVisible() {
    setSelected((current) => {
      const next = new Map(current);
      for (const document of documents) next.set(document.document_id, document);
      return next;
    });
  }

  function toggleSort(column: DocumentSortBy) {
    // Only persisted uploaded_at ordering is globally accurate under pagination.
    if (column !== "uploaded_at") return;
    setOffset(0);
    if (sortBy === column) {
      setSortDir((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortBy(column);
    setSortDir("desc");
  }

  async function exportDocument(document: DocumentSummary) {
    setMenuFor(null);
    try {
      const profile = await getStagingProfile(document.document_id);
      const capability = profile.export_capabilities.find((item) => item.format === "xlsx");
      if (!capability) throw new Error("This document has no Excel export.");
      await downloadExport(capability, document.original_filename.replace(/\.[^.]+$/, ""));
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Export failed.");
    }
  }

  async function reprocessOne(document: DocumentSummary) {
    if (document.status === "processing") {
      setNotice(`${document.original_filename} is already processing.`);
      return;
    }
    setMenuFor(null);
    try {
      await startProcessingJob(document.document_id);
      setNotice(`Reprocessing ${document.original_filename}…`);
      setReloadKey((key) => key + 1);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Reprocess failed.");
    }
  }

  async function reprocessSelected() {
    const targets = selectedList.filter((document) => document.status !== "processing");
    const skipped = selectedList.length - targets.length;
    if (targets.length === 0) {
      setNotice(skipped ? "Selected documents are already processing." : "No documents selected.");
      return;
    }
    setReprocessing(true);
    const ok: string[] = [];
    const failed: string[] = [];
    for (const document of targets) {
      try {
        await startProcessingJob(document.document_id);
        ok.push(document.document_id);
      } catch {
        failed.push(document.original_filename);
      }
    }
    setReprocessing(false);
    setNotice(
      `Reprocess started for ${ok.length} document${ok.length === 1 ? "" : "s"}` +
        (failed.length ? ` · ${failed.length} failed: ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? "…" : ""}` : "") +
        (skipped ? ` · ${skipped} already processing` : "") +
        ".",
    );
    setReloadKey((key) => key + 1);
  }

  async function acceptLowRiskSelected() {
    setAcceptingLowRisk(true);
    try {
      const ids = new Set(selectedList.map((document) => document.document_id));
      const candidates = (await getReviewQueueFields()).filter(
        (item) => ids.has(item.document_id) && isLowRiskQueueField(item),
      );
      if (candidates.length === 0) {
        setNotice("No unflagged high-confidence values are pending in the selected documents.");
        return;
      }
      const { accepted, failed } = await acceptReviewQueueFields(candidates, "Dataomatix");
      const touched = new Set(accepted.map((item) => item.document_id)).size;
      setNotice(
        `Accepted ${accepted.length} low-risk value${accepted.length === 1 ? "" : "s"} in ${touched} document${touched === 1 ? "" : "s"}` +
          (failed.length ? ` · ${failed.length} could not be saved` : "") +
          ". Flagged and lower-confidence values stay in the review queue.",
      );
      setReloadKey((key) => key + 1);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Batch accept failed.");
    } finally {
      setAcceptingLowRisk(false);
    }
  }

  async function confirmDelete() {
    if (!confirm) return;
    const ids = confirm.map((document) => document.document_id);
    try {
      const result = await deleteDocuments(ids);
      const refused = result.not_found.length + result.forbidden.length;
      setNotice(
        `${result.deleted.length} document${result.deleted.length === 1 ? "" : "s"} deleted` +
          (refused ? ` · ${refused} could not be deleted (not yours or already gone)` : "") +
          (result.storage_errors.length ? ` · ${result.storage_errors.length} stored file(s) need cleanup` : "") +
          ".",
      );
      setSelected((current) => {
        const next = new Map(current);
        for (const id of result.deleted) next.delete(id);
        return next;
      });
      setConfirm(null);
      setReloadKey((key) => key + 1);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Delete failed.");
      setConfirm(null);
    }
  }

  return (
    <div className="workspace-page w-full px-4 py-5 sm:px-6" data-testid="documents-home">
      <PageHeader
        title="Documents"
        description="Manage, review and export documents"
      />

      <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="documents-summary">
        <Metric label="Total Documents" value={counts?.all} />
        <Metric label="Documents to review" value={counts?.review} tone="text-warning" />
        <Metric label="Ready" value={counts?.ready} tone="text-success" />
        <Metric label="Failed" value={counts?.failed} tone="text-danger" />
      </dl>

      <div
        className="mt-5 flex flex-wrap items-end gap-2 rounded-xl border border-border bg-surface p-3"
        role="search"
        aria-label="Document filters"
        data-testid="documents-toolbar"
      >
        <label className="relative min-w-[12rem] flex-1">
          <span className="sr-only">Search documents</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={DOCUMENT_SEARCH_PLACEHOLDER}
            title="Matches file names, contract numbers and titles, supplier / customer names, and extracted page text"
            className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm outline-none focus:border-primary/40"
          />
        </label>

        <FilterSelect
          label="Document Type"
          value={family}
          onChange={(value) => {
            setFamily(value);
            setOffset(0);
          }}
          options={[
            { id: "", label: "All types" },
            ...Object.entries(FAMILY_LABELS)
              .filter(([id]) => !["unknown", "generic_business"].includes(id))
              .map(([id, label]) => ({ id, label })),
            { id: "generic_business", label: "Generic Document" },
          ]}
        />

        <FilterSelect
          label="Profile"
          value={profileId}
          onChange={(value) => {
            setProfileId(value);
            setOffset(0);
          }}
          options={PROFILE_OPTIONS}
        />

        <FilterSelect
          label="Status"
          value={filter}
          onChange={(value) => {
            setFilter(value as StatusFilter);
            setOffset(0);
          }}
          options={STATUS_FILTERS.map((item) => ({ id: item.id, label: item.label }))}
        />

        <FilterSelect
          label="Sort"
          value={`${sortBy}:${sortDir}`}
          onChange={(value) => {
            const [by, dir] = value.split(":") as [DocumentSortBy, DocumentSortDir];
            setSortBy(by);
            setSortDir(dir);
            setOffset(0);
          }}
          options={[
            { id: "uploaded_at:desc", label: "Uploaded (newest)" },
            { id: "uploaded_at:asc", label: "Uploaded (oldest)" },
          ]}
        />

        {filtersActive && (
          <button type="button" onClick={clearFilters} className="btn-secondary px-3 py-2 text-xs">
            Clear Filters
          </button>
        )}

        <div className="ml-auto flex items-center gap-2 self-end">
          {view === "table" && <DensityToggle value={density} onChange={setDensity} />}
          <ViewToggle value={view} onChange={setView} />
          <Link href="/extraction/new" className="btn-hero-primary !w-auto h-8 px-3 text-xs">
            <Plus className="h-4 w-4" />
            Upload document
          </Link>
        </div>
      </div>

      {notice && (
        <div
          className="mt-4 flex items-center justify-between rounded-lg border border-border bg-surface-soft px-3 py-2 text-sm text-text-secondary"
          role="status"
        >
          {notice}
          <button type="button" onClick={() => setNotice("")} aria-label="Dismiss" className="text-text-muted hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {selected.size > 0 && (
        <div
          className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm"
          role="region"
          aria-label="Selection"
        >
          <span className="font-medium text-foreground">{selected.size} selected</span>
          <button
            type="button"
            onClick={selectVisible}
            className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-surface-soft"
          >
            Select visible
          </button>
          <button
            type="button"
            disabled={acceptingLowRisk}
            onClick={() => void acceptLowRiskSelected()}
            title={`Accept every unflagged pending value scoring ${Math.round(HIGH_BAND_MIN * 100)}% or higher in the selected documents`}
            className="rounded-md border border-success/40 bg-success/10 px-2.5 py-1 text-xs font-semibold text-success hover:border-success disabled:opacity-50"
          >
            {acceptingLowRisk ? "Accepting…" : "Accept low-risk values"}
          </button>
          <button
            type="button"
            disabled={reprocessing}
            onClick={() => void reprocessSelected()}
            className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-surface-soft disabled:opacity-50"
          >
            {reprocessing ? "Reprocessing…" : "Reprocess selected"}
          </button>
          <button
            type="button"
            onClick={() => setConfirm(selectedList)}
            className="rounded-md border border-danger/40 px-2.5 py-1 text-xs font-medium text-danger hover:bg-danger/5"
          >
            Delete selected
          </button>
          <button type="button" onClick={() => setSelected(new Map())} className="text-xs text-text-secondary hover:text-foreground">
            Clear selection
          </button>
        </div>
      )}

      {error && (
        <div className="mt-6">
          <ErrorState error={error} onRetry={() => setReloadKey((key) => key + 1)} />
        </div>
      )}

      {/* Its own scroller, capped to the screen, so the header stays visible while rows scroll. */}
      <div className="relative mt-4 max-h-[calc(100vh-14rem)] min-h-[12rem] overflow-auto rounded-xl border border-border bg-surface">
        {loading ? (
          <TableSkeleton />
        ) : documents.length === 0 ? (
          <EmptyState hasFilters={filtersActive} onClear={clearFilters} />
        ) : view === "grid" ? (
          <ul className="grid gap-3 p-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" data-testid="documents-grid">
            {documents.map((document) => (
              <li key={document.document_id}>
                <DocumentCard
                  document={document}
                  selected={selected.has(document.document_id)}
                  onToggle={() => toggle(document)}
                  onPreview={() => setPreviewing(document)}
                  menuOpen={menuFor === document.document_id}
                  onMenu={() =>
                    setMenuFor((current) => (current === document.document_id ? null : document.document_id))
                  }
                  menu={rowMenu(document)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <table
            className="min-w-full text-sm data-[density=compact]:text-[13px] data-[density=compact]:[&_td]:py-1 data-[density=compact]:[&_td]:whitespace-nowrap data-[density=compact]:[&_th]:py-1.5"
            data-testid="documents-table"
            data-density={density}
          >
            <thead className="sticky top-0 z-10 bg-surface-soft">
              <tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                <th className="w-10 px-3 py-2.5">
                  <input
                    type="checkbox"
                    aria-label="Select all on this page"
                    checked={allSelected}
                    ref={(element) => {
                      if (element) element.indeterminate = someSelected && !allSelected;
                    }}
                    onChange={() => {
                      if (allSelected) {
                        setSelected((current) => {
                          const next = new Map(current);
                          for (const id of pageIds) next.delete(id);
                          return next;
                        });
                      } else {
                        selectVisible();
                      }
                    }}
                  />
                </th>
                <th className="px-3 py-2.5">File name</th>
                <th className="hidden px-3 py-2.5 lg:table-cell">Agency / contracting activity</th>
                <th className="hidden px-3 py-2.5 text-right md:table-cell">Total contract value</th>
                <th className="px-3 py-2.5">Extracted status</th>
                <SortableTh label="Upload date" active={sortBy === "uploaded_at"} dir={sortDir} onClick={() => toggleSort("uploaded_at")} className="hidden sm:table-cell" />
                <th className="w-12 px-3 py-2.5">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {documents.map((document) => {
                const row = presentDocument(document);
                const { Icon, iconClass } = getDocumentTypeAppearance(document.original_filename, document.document_type);
                return (
                  <tr
                    key={document.document_id}
                    onClick={() => setPreviewing(document)}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setPreviewing(document);
                      }
                    }}
                    tabIndex={0}
                    aria-label={`Preview ${document.original_filename}`}
                    className="h-11 cursor-pointer border-b border-border/70 outline-none last:border-0 hover:bg-[var(--color-row-hover)] focus-visible:bg-[var(--color-row-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
                  >
                    <td className="px-3 py-2" onClick={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${document.original_filename}`}
                        checked={selected.has(document.document_id)}
                        onChange={() => toggle(document)}
                      />
                    </td>
                    <td className="max-w-[24rem] px-3 py-2" title={document.original_filename}>
                      <span className="flex min-w-0 items-center gap-2">
                        <Icon className={`h-4 w-4 shrink-0 ${iconClass}`} aria-hidden="true" />
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-foreground">{document.original_filename}</span>
                          <TypeLine document={document} />
                        </span>
                      </span>
                    </td>
                    <td className={`hidden max-w-[16rem] truncate px-3 py-2 lg:table-cell ${document.agency ? "text-text-secondary" : "text-text-muted"}`}>
                      {document.agency || "—"}
                    </td>
                    <td className={`hidden px-3 py-2 text-right tabular-nums md:table-cell ${document.contract_value ? "text-foreground" : "text-text-muted"}`}>
                      {formatContractValue(document.contract_value)}
                    </td>
                    <td className={`whitespace-nowrap px-3 py-2 font-medium ${EXTRACTED_STATUS_TONE[row.status]}`}>
                      {statusMark(row.status)} {extractedStatusLabel(row.status)}
                    </td>
                    <td className="hidden whitespace-nowrap px-3 py-2 tabular-nums text-text-secondary sm:table-cell">
                      {formatDocumentDate(document.uploaded_at)}
                    </td>
                    <td
                      className="relative px-3 py-2 text-right"
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => event.stopPropagation()}
                    >
                      <button
                        type="button"
                        aria-label={`Actions for ${document.original_filename}`}
                        aria-haspopup="menu"
                        aria-expanded={menuFor === document.document_id}
                        onClick={() =>
                          setMenuFor((current) => (current === document.document_id ? null : document.document_id))
                        }
                        className="rounded-md p-1 text-text-secondary hover:bg-surface-soft hover:text-foreground"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                      {menuFor === document.document_id && rowMenu(document)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {total > 0 && (
        <div className="mt-4 flex items-center justify-between text-sm text-text-secondary">
          <p>
            {from}–{to} of {total.toLocaleString()}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={offset === 0}
              onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}
              className="btn-secondary px-3 py-1.5 text-xs disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Previous
            </button>
            <button
              type="button"
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => setOffset((value) => value + PAGE_SIZE)}
              className="btn-secondary px-3 py-1.5 text-xs disabled:opacity-40"
            >
              Next
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {confirm && <DeleteDialog documents={confirm} onCancel={() => setConfirm(null)} onConfirm={confirmDelete} />}

      {previewing && (
        <DocumentPreviewDrawer
          document={previewing}
          workspaceHref={documentHref(previewing.document_id)}
          reviewHref={documentHref(previewing.document_id, "review")}
          onClose={closePreview}
        />
      )}
    </div>
  );
}

/** "SF 1442 Contract Award · Government Contract", or "Not staged". */
function TypeLine({ document }: { document: DocumentSummary }) {
  const row = presentDocument(document);
  return (
    <span className={`block truncate text-xs ${row.staged ? "text-text-secondary" : "text-text-muted"}`}>
      {row.staged
        ? `${row.typeLabel}${row.profileLabel && row.profileLabel !== row.typeLabel ? ` · ${row.profileLabel}` : ""}`
        : row.profileLabel}
    </span>
  );
}

function ViewToggle({ value, onChange }: { value: RepositoryView; onChange: (next: RepositoryView) => void }) {
  const options = [
    { value: "table" as const, label: "Detailed table", icon: List },
    { value: "grid" as const, label: "Grid", icon: LayoutGrid },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Repository view"
      className="inline-flex h-8 shrink-0 items-center rounded-lg border border-border bg-surface p-0.5"
    >
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={option.label}
            title={option.label}
            onClick={() => onChange(option.value)}
            className={[
              "inline-flex h-full items-center rounded-md px-2 transition-colors",
              active ? "bg-primary/10 text-foreground" : "text-text-secondary hover:text-foreground",
            ].join(" ")}
          >
            <option.icon className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}

/** Grid view: one card per document, same facts and click behavior as a row. */
function DocumentCard({
  document,
  selected,
  onToggle,
  onPreview,
  menuOpen,
  onMenu,
  menu,
}: {
  document: DocumentSummary;
  selected: boolean;
  onToggle: () => void;
  onPreview: () => void;
  menuOpen: boolean;
  onMenu: () => void;
  menu: ReactNode;
}) {
  const row = presentDocument(document);
  const { Icon, bgClass, iconClass } = getDocumentTypeAppearance(document.original_filename, document.document_type);
  return (
    <article
      className={`relative flex h-full flex-col rounded-xl border bg-surface p-3 transition-colors hover:border-primary/40 ${selected ? "border-primary/50" : "border-border"}`}
      data-testid="document-card"
    >
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          className="relative z-10 mt-1"
          aria-label={`Select ${document.original_filename}`}
          checked={selected}
          onChange={onToggle}
        />
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${bgClass}`}>
          <Icon className={`h-4 w-4 ${iconClass}`} aria-hidden="true" />
        </span>
        <button
          type="button"
          onClick={onPreview}
          aria-label={`Preview ${document.original_filename}`}
          className="min-w-0 flex-1 text-left after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-primary/40"
        >
          <span className="block truncate text-sm font-medium text-foreground" title={document.original_filename}>
            {document.original_filename}
          </span>
          <TypeLine document={document} />
        </button>
        <div className="relative z-10">
          <button
            type="button"
            aria-label={`Actions for ${document.original_filename}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={onMenu}
            className="rounded-md p-1 text-text-secondary hover:bg-surface-soft hover:text-foreground"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {menuOpen && menu}
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
        <div className="col-span-2 min-w-0">
          <dt className="text-text-muted">Agency / contracting activity</dt>
          <dd className={`truncate ${document.agency ? "text-foreground" : "text-text-muted"}`}>{document.agency || "—"}</dd>
        </div>
        <div>
          <dt className="text-text-muted">Total contract value</dt>
          <dd className={`tabular-nums ${document.contract_value ? "text-foreground" : "text-text-muted"}`}>
            {formatContractValue(document.contract_value)}
          </dd>
        </div>
        <div>
          <dt className="text-text-muted">Uploaded</dt>
          <dd className="tabular-nums text-foreground">{formatDocumentDate(document.uploaded_at)}</dd>
        </div>
      </dl>
      <p className={`mt-auto pt-3 text-xs font-medium ${EXTRACTED_STATUS_TONE[row.status]}`}>
        {statusMark(row.status)} {extractedStatusLabel(row.status)}
        <span className="ml-2 font-normal text-text-muted">{document.fields_extracted.toLocaleString()} fields</span>
      </p>
    </article>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { id: string; label: string }[];
}) {
  return (
    <label className="flex min-w-[9rem] flex-col gap-1 text-[11px] font-medium text-text-muted">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
        className="rounded-lg border border-border bg-background px-2.5 py-2 text-sm text-foreground outline-none focus:border-primary/40"
      >
        {options.map((option) => (
          <option key={option.id || "all"} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function SortableTh({
  label,
  active,
  dir,
  onClick,
  className = "",
}: {
  label: string;
  active: boolean;
  dir: DocumentSortDir;
  onClick: () => void;
  className?: string;
}) {
  const Icon = !active ? null : dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th className={`px-3 py-2.5 ${className}`}>
      <button
        type="button"
        onClick={onClick}
        className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-foreground"
        aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      >
        {label}
        {Icon && <Icon className="h-3 w-3 text-primary" aria-hidden="true" />}
      </button>
    </th>
  );
}

function TableSkeleton() {
  return (
    <div className="space-y-0 p-2" data-testid="documents-skeleton" aria-busy="true" aria-label="Loading documents">
      {Array.from({ length: 8 }).map((_, index) => (
        <div key={index} className="flex h-11 items-center gap-3 border-b border-border/50 px-2 last:border-0">
          <div className="h-4 w-4 animate-pulse rounded bg-surface-soft" />
          <div className="h-3 flex-1 animate-pulse rounded bg-surface-soft" />
          <div className="hidden h-3 w-24 animate-pulse rounded bg-surface-soft sm:block" />
          <div className="hidden h-3 w-20 animate-pulse rounded bg-surface-soft md:block" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({ hasFilters, onClear }: { hasFilters: boolean; onClear: () => void }) {
  return (
    <div className="px-6 py-14 text-center" data-testid="documents-empty">
      <FileText className="mx-auto h-8 w-8 text-text-muted" aria-hidden="true" />
      <p className="mt-3 text-sm font-medium text-foreground">
        {hasFilters ? "No documents match these filters" : "No documents yet"}
      </p>
      <p className="mt-1 text-sm text-text-secondary">
        {hasFilters
          ? "Clear filters or try a different search."
          : "Upload a document to begin extraction and review."}
      </p>
      <div className="mt-4 flex justify-center gap-2">
        {hasFilters && (
          <button type="button" onClick={onClear} className="btn-secondary px-3 py-1.5 text-xs">
            Clear Filters
          </button>
        )}
        <Link href="/extraction/new" className="btn-hero-primary !w-auto px-4 py-1.5 text-xs">
          Upload Document
        </Link>
      </div>
    </div>
  );
}

function RowMenu({
  staged,
  processing,
  onClose,
  onOpen,
  onReview,
  onExport,
  onReprocess,
  onDelete,
}: {
  staged: boolean;
  processing: boolean;
  onClose: () => void;
  onOpen: () => void;
  onReview: () => void;
  onExport: () => void;
  onReprocess: () => void;
  onDelete: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDocument(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDocument);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocument);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const item = "block w-full px-3 py-1.5 text-left text-sm hover:bg-surface-soft disabled:text-text-muted";
  return (
    <div ref={ref} role="menu" className="absolute right-3 top-9 z-30 w-44 rounded-lg border border-border bg-surface py-1 shadow-md">
      <button type="button" role="menuitem" className={item} onClick={onOpen}>
        Open
      </button>
      <button type="button" role="menuitem" className={item} onClick={onReview}>
        Review
      </button>
      <button type="button" role="menuitem" className={item} onClick={onExport} disabled={!staged}>
        Export
      </button>
      <button type="button" role="menuitem" className={item} onClick={onReprocess} disabled={processing}>
        Reprocess
      </button>
      <div className="my-1 border-t border-border" />
      <button type="button" role="menuitem" className={`${item} text-danger`} onClick={onDelete}>
        Delete
      </button>
    </div>
  );
}

function DeleteDialog({
  documents,
  onCancel,
  onConfirm,
}: {
  documents: DocumentSummary[];
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel, busy]);
  const many = documents.length > 1;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-title"
    >
      <div className="w-full max-w-md rounded-xl border border-border bg-surface p-5 shadow-xl">
        <h2 id="delete-title" className="text-base font-semibold text-foreground">
          {many ? `Delete ${documents.length} documents?` : "Delete document?"}
        </h2>
        <ul className="mt-2 max-h-40 space-y-0.5 overflow-y-auto text-sm font-medium text-foreground">
          {documents.map((document) => (
            <li key={document.document_id} className="truncate">
              {document.original_filename}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-sm leading-6 text-text-secondary">
          This will permanently delete the source document{many ? "s" : ""}, extracted data, staging data, review
          information, and generated artifacts. Shared regulatory reference data is not removed. Backend authorization
          and workspace ownership are enforced per document.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button ref={cancelRef} type="button" onClick={onCancel} disabled={busy} className="btn-secondary px-3 py-1.5 text-sm">
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onConfirm();
              setBusy(false);
            }}
            className="rounded-lg bg-danger px-3 py-1.5 text-sm font-medium text-white hover:bg-danger/90 disabled:opacity-60"
          >
            {busy ? "Deleting…" : many ? `Delete ${documents.length} Documents` : "Delete Document"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  tone = "text-foreground",
}: {
  label: string;
  value: number | undefined;
  tone?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2.5">
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className={`text-lg font-semibold tabular-nums ${tone}`}>
        {value === undefined ? <span className="text-text-muted">—</span> : value.toLocaleString()}
      </dd>
    </div>
  );
}
