"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import LifecycleBadge from "@/components/document-intelligence/lifecycle-badge";
import { formatCalendarDate, LIFECYCLE_FILTERS } from "@/lib/document-intelligence";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FilePlus2,
  FileText,
  FilterX,
  FolderOpen,
  Loader2,
  LayoutGrid,
  List,
  MoreHorizontal,
  Plus,
  Search,
  X,
  XCircle,
} from "lucide-react";

import DocumentPreviewDrawer from "@/components/documents/document-preview-drawer";
import ConsoleHeader from "@/components/layout/ConsoleHeader";
import { ErrorState } from "@/components/layout/StatusState";
import DensityToggle from "@/components/ui/density-toggle";
import SharedEmptyState from "@/components/ui/empty-state";
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
import type { CategoryCount, DocumentStatus, DocumentSummary } from "@/types/document";
import { REVIEW_READ_ONLY_MESSAGE, useReviewMutationsEnabled } from "@/lib/review-gate";

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
  const reviewEnabled = useReviewMutationsEnabled();
  const router = useRouter();
  const [density, setDensity] = useTableDensity("documents");
  const [view, setView] = useBrowserPreference<RepositoryView>("dx-documents-view", REPOSITORY_VIEWS, "table");
  const [previewing, setPreviewing] = useState<DocumentSummary | null>(null);
  const closePreview = useCallback(() => setPreviewing(null), []);
  const params = useSearchParams();
  const urlFilter = params.get("filter");
  const urlFamily = params.get("family") ?? "";
  const urlProfile = params.get("profile") ?? "";
  const urlCategory = params.get("category") ?? "";
  const urlLifecycle = params.get("lifecycle") ?? "";
  const urlQ = params.get("q") ?? "";
  const urlSort = params.get("sort");
  const urlDir = params.get("dir");

  const [filter, setFilter] = useState<StatusFilter>(isStatusFilter(urlFilter) ? urlFilter : "all");
  const [family, setFamily] = useState(urlFamily);
  const [profileId, setProfileId] = useState(urlProfile);
  const [category, setCategory] = useState(urlCategory);
  const [lifecycle, setLifecycle] = useState(urlLifecycle);
  const [categories, setCategories] = useState<CategoryCount[]>([]);
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
    setCategory(urlCategory);
    setLifecycle(urlLifecycle);
    setQuery(urlQ);
    setDebouncedQuery(urlQ.trim());
    // Ignore legacy sort=updated_at deep links (capped scan; not globally accurate).
    setSortBy("uploaded_at");
    setSortDir(isSortDir(urlDir) ? urlDir : "desc");
    const nextOffset = Number(params.get("offset") || 0) || 0;
    setOffset(nextOffset);
  }, [params, urlFilter, urlFamily, urlProfile, urlCategory, urlLifecycle, urlQ, urlSort, urlDir]);

  // Persist filters in the URL so returning from a document keeps the view.
  useEffect(() => {
    const next = new URLSearchParams();
    if (debouncedQuery) next.set("q", debouncedQuery);
    if (filter !== "all") next.set("filter", filter);
    if (family) next.set("family", family);
    if (profileId) next.set("profile", profileId);
    if (category) next.set("category", category);
    if (lifecycle) next.set("lifecycle", lifecycle);
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
  }, [debouncedQuery, filter, family, profileId, category, lifecycle, sortBy, sortDir, offset, router, params]);

  useEffect(() => {
    let active = true;
    getDocumentStatusCounts(family || undefined, category || undefined)
      .then(({ total: all, by_status, categories: byCategory }) => {
        if (!active) return;
        setCategories(byCategory ?? []);
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
  }, [family, category, reloadKey]);

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
          category: category || undefined,
          lifecycle: lifecycle || undefined,
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
  }, [filter, debouncedQuery, offset, reloadKey, family, profileId, category, lifecycle, sortBy, sortDir]);

  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);
  const pageIds = useMemo(() => documents.map((document) => document.document_id), [documents]);
  const allSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const someSelected = pageIds.some((id) => selected.has(id));
  const filtersActive = Boolean(debouncedQuery || filter !== "all" || family || profileId || category || lifecycle || sortBy !== "uploaded_at" || sortDir !== "desc");
  const selectedList = useMemo(() => Array.from(selected.values()), [selected]);
  // "All types" groups this page's rows under their category headings.
  const sections = useMemo(() => groupByCategory(documents, category ? [] : categories, !category), [documents, categories, category]);

  const clearFilters = useCallback(() => {
    setQuery("");
    setDebouncedQuery("");
    setFilter("all");
    setFamily("");
    setProfileId("");
    setCategory("");
    setLifecycle("");
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
    if (category) next.set("category", category);
    if (lifecycle) next.set("lifecycle", lifecycle);
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

  // Agency / contract value are contract facts: shown only when a listed
  // document has one, so invoices, IDs and pay stubs don't get empty columns.
  const showContractColumns = documents.some((document) => document.agency || document.contract_value);

  return (
    <div className="workspace-page w-full" data-testid="documents-home">
      <ConsoleHeader
        icon={FolderOpen}
        title="Documents"
        description="Every uploaded document with its detected type, extraction status and review state."
        actions={
          <Link href="/extraction/new" className="btn-primary h-9 px-3.5 text-[13px] shadow-sm">
            <Plus className="h-4 w-4" aria-hidden="true" />
            Upload document
          </Link>
        }
        tabsLabel="Document status"
        tabs={STATUS_FILTERS.map((item) => ({
          id: item.id,
          label: item.id === "all" ? "All documents" : item.label,
          count: counts?.[item.id],
          active: filter === item.id,
          onSelect: () => {
            setFilter(item.id);
            setOffset(0);
          },
        }))}
      />

      <div className="px-4 py-4 sm:px-6 sm:py-5">
      {notice && (
        <div
          className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-[13px] text-text-secondary shadow-sm"
          role="status"
        >
          {notice}
          <button
            type="button"
            onClick={() => setNotice("")}
            aria-label="Dismiss"
            className="rounded-md p-1 text-text-muted hover:bg-surface-soft hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {error && (
        <div className="mb-3">
          <ErrorState error={error} onRetry={() => setReloadKey((key) => key + 1)} />
        </div>
      )}

      <div className="data-panel overflow-hidden">
      <div
        className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5"
        role="search"
        aria-label="Document filters"
        data-testid="documents-toolbar"
      >
        <label className="relative min-w-0 basis-full sm:min-w-[14rem] sm:flex-1 sm:basis-auto">
          <span className="sr-only">Search documents</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={DOCUMENT_SEARCH_PLACEHOLDER}
            title="Matches file names, contract numbers and titles, supplier / customer names, and extracted page text"
            className="control w-full pl-9"
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
          label="Lifecycle"
          value={lifecycle}
          onChange={(value) => {
            setLifecycle(value);
            setOffset(0);
          }}
          options={LIFECYCLE_FILTERS.map((option) => ({ id: option.id, label: option.label }))}
        />

        <FilterSelect
          label="Sort"
          defaultValue="uploaded_at:desc"
          widthClass="sm:w-[10.5rem]"
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
          <button
            type="button"
            onClick={clearFilters}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-text-secondary hover:bg-surface-soft hover:text-foreground"
          >
            <FilterX className="h-3.5 w-3.5" aria-hidden="true" />
            Clear Filters
          </button>
        )}

        <div className="ml-auto flex items-center gap-2">
          {view === "table" && <DensityToggle value={density} onChange={setDensity} />}
          <ViewToggle value={view} onChange={setView} />
        </div>
      </div>

      {categories.length > 0 && (
        <div className="border-b border-border px-3 py-2">
        <CategoryTabs
          categories={categories}
          value={category}
          onChange={(next) => {
            setCategory(next);
            setOffset(0);
          }}
        />
        </div>
      )}

      {selected.size > 0 && (
        <div
          className="flex flex-wrap items-center gap-2 border-b border-primary/15 bg-primary-soft/60 px-3 py-2 text-sm"
          role="region"
          aria-label="Selection"
        >
          <span className="inline-flex h-6 items-center rounded-md bg-primary px-2 text-xs font-semibold tabular-nums text-white">
            {selected.size} selected
          </span>
          <span className="mx-1 hidden h-4 w-px bg-primary/20 sm:block" aria-hidden="true" />
          <button
            type="button"
            onClick={selectVisible}
            className="h-7 rounded-md border border-border bg-surface px-2.5 text-xs font-medium text-foreground hover:bg-surface-soft"
          >
            Select visible
          </button>
          <button
            type="button"
            disabled={!reviewEnabled || acceptingLowRisk}
            onClick={() => void acceptLowRiskSelected()}
            title={reviewEnabled ? `Accept every unflagged pending value scoring ${Math.round(HIGH_BAND_MIN * 100)}% or higher in the selected documents` : REVIEW_READ_ONLY_MESSAGE}
            className="h-7 rounded-md border border-success/40 bg-surface px-2.5 text-xs font-semibold text-success hover:border-success hover:bg-success/5 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {acceptingLowRisk ? "Accepting…" : "Accept low-risk values"}
          </button>
          <button
            type="button"
            disabled={reprocessing}
            onClick={() => void reprocessSelected()}
            className="h-7 rounded-md border border-border bg-surface px-2.5 text-xs font-medium text-foreground hover:bg-surface-soft disabled:opacity-50"
          >
            {reprocessing ? "Reprocessing…" : "Reprocess selected"}
          </button>
          <button
            type="button"
            onClick={() => setConfirm(selectedList)}
            className="h-7 rounded-md border border-danger/40 bg-surface px-2.5 text-xs font-medium text-danger hover:bg-danger/5"
          >
            Delete selected
          </button>
          <button type="button" onClick={() => setSelected(new Map())} className="ml-auto text-xs font-medium text-text-secondary hover:text-foreground">
            Clear selection
          </button>
        </div>
      )}

      {/* Its own scroller, capped to the screen, so the header stays visible while rows scroll. */}
      <div className="relative max-h-[calc(100vh-15rem)] min-h-[12rem] overflow-auto">
        {loading ? (
          <TableSkeleton />
        ) : documents.length === 0 ? (
          <EmptyState hasFilters={filtersActive} onClear={clearFilters} />
        ) : view === "grid" ? (
          <ul className="grid gap-3 p-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" data-testid="documents-grid">
            {sections.flatMap((section) => [
              section.label ? (
                <li key={`category-${section.key}`} className="col-span-full" data-testid="documents-category">
                  <CategoryHeading label={section.label} count={section.documents.length} />
                </li>
              ) : null,
              ...section.documents.map((document) => (
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
              )),
            ])}
          </ul>
        ) : (
          <table
            className="min-w-full text-sm data-[density=compact]:text-[13px] data-[density=compact]:[&_td]:py-1 data-[density=compact]:[&_td]:whitespace-nowrap data-[density=compact]:[&_th]:py-1.5"
            data-testid="documents-table"
            data-density={density}
          >
            <thead className="sticky top-0 z-10 bg-surface-soft">
              <tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-text-muted">
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
                {showContractColumns && (
                  <>
                    <th className="hidden px-3 py-2.5 lg:table-cell">Agency / contracting activity</th>
                    <th className="hidden px-3 py-2.5 text-right md:table-cell">Total contract value</th>
                  </>
                )}
                <th className="hidden px-3 py-2.5 text-right md:table-cell">Pages</th>
                <th className="hidden px-3 py-2.5 md:table-cell">Format</th>
                <th className="hidden px-3 py-2.5 xl:table-cell">Effective / start</th>
                <th className="hidden px-3 py-2.5 lg:table-cell">Expiration</th>
                <th className="px-3 py-2.5">Lifecycle</th>
                <th className="px-3 py-2.5">Extracted status</th>
                <SortableTh label="Upload date" active={sortBy === "uploaded_at"} dir={sortDir} onClick={() => toggleSort("uploaded_at")} className="hidden sm:table-cell" />
                <th className="w-12 px-3 py-2.5">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sections.flatMap((section) => [
                section.label ? (
                  <tr key={`category-${section.key}`} className="border-b border-border bg-surface-soft/60" data-testid="documents-category">
                    <td colSpan={showContractColumns ? 12 : 10} className="px-3 py-1.5">
                      <CategoryHeading label={section.label} count={section.documents.length} />
                    </td>
                  </tr>
                ) : null,
                ...section.documents.map((document) => {
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
                    className="group/row h-12 cursor-pointer border-b border-border/70 outline-none last:border-0 hover:bg-[var(--color-row-hover)] focus-visible:bg-[var(--color-row-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
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
                      <span className="flex min-w-0 items-center gap-3">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-soft ring-1 ring-border/70">
                          <Icon className={`h-4 w-4 ${iconClass}`} aria-hidden="true" />
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-primary group-hover/row:underline">{document.original_filename}</span>
                          <TypeLine document={document} />
                        </span>
                      </span>
                    </td>
                    {showContractColumns && (
                      <>
                        <td className={`hidden max-w-[16rem] truncate px-3 py-2 lg:table-cell ${document.agency ? "text-text-secondary" : "text-text-muted"}`}>
                          {document.agency || "—"}
                        </td>
                        <td className={`hidden px-3 py-2 text-right tabular-nums md:table-cell ${document.contract_value ? "text-foreground" : "text-text-muted"}`}>
                          {formatContractValue(document.contract_value)}
                        </td>
                      </>
                    )}
                    <td className="hidden px-3 py-2 text-right tabular-nums text-text-secondary md:table-cell">
                      {document.page_count ? document.page_count.toLocaleString() : "—"}
                    </td>
                    <td className="hidden px-3 py-2 text-xs uppercase text-text-secondary md:table-cell">{document.file_format || "—"}</td>
                    <td className="hidden whitespace-nowrap px-3 py-2 tabular-nums text-text-secondary xl:table-cell">
                      {formatCalendarDate(document.lifecycle_start_date)}
                    </td>
                    <td className="hidden whitespace-nowrap px-3 py-2 tabular-nums text-text-secondary lg:table-cell">
                      {formatCalendarDate(document.lifecycle_end_date)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2" data-testid="lifecycle-cell">
                      <LifecycleBadge status={document.lifecycle_status} title={document.lifecycle_review ? "Dates need review" : undefined} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <StatusCell status={row.status} />
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
              }),
              ])}
            </tbody>
          </table>
        )}
      </div>

      {total > 0 && (
        <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2 text-[13px] text-text-secondary">
          <p className="tabular-nums">
            {from}–{to} of {total.toLocaleString()}
          </p>
          <div className="flex gap-1.5">
            <button
              type="button"
              disabled={offset === 0}
              onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}
              className="inline-flex h-8 items-center gap-1 rounded-lg border border-border bg-surface px-2.5 text-xs font-medium text-foreground hover:bg-surface-soft disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Previous
            </button>
            <button
              type="button"
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => setOffset((value) => value + PAGE_SIZE)}
              className="inline-flex h-8 items-center gap-1 rounded-lg border border-border bg-surface px-2.5 text-xs font-medium text-foreground hover:bg-surface-soft disabled:cursor-not-allowed disabled:opacity-40"
            >
              Next
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
      </div>

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
      {document.classification_status === "review_required" && (
        <span className="ml-1.5 rounded bg-danger/10 px-1 text-[10px] font-medium text-danger" title="The document type needs to be confirmed">
          Confirm type
        </span>
      )}
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

/** A toolbar select. Its options name themselves ("All types"), so the
 * label is for screen readers; a non-default value is tinted as applied. */
function FilterSelect({
  label,
  value,
  defaultValue = "",
  widthClass = "sm:w-[9.25rem]",
  onChange,
  options,
}: {
  label: string;
  value: string;
  defaultValue?: string;
  widthClass?: string;
  onChange: (value: string) => void;
  options: { id: string; label: string }[];
}) {
  return (
    <label className="min-w-0 basis-[calc(50%-0.25rem)] sm:basis-auto">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
        title={label}
        data-active={value !== defaultValue}
        className={`control w-full ${widthClass}`}
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
    <div data-testid="documents-empty">
      <SharedEmptyState
        icon={hasFilters ? Search : FilePlus2}
        title={hasFilters ? "No documents match these filters" : "No documents yet"}
        description={
          hasFilters
            ? "Clear the filters or try a different search."
            : "Upload invoices, contracts, IDs or any other document. Dataomatix detects the type, extracts its fields and queues them for review."
        }
        className="py-16"
        action={
          <>
            {hasFilters && (
              <button type="button" onClick={onClear} className="btn-secondary h-9 px-3.5 text-[13px]">
                Clear Filters
              </button>
            )}
            <Link href="/extraction/new" className="btn-primary h-9 px-3.5 text-[13px]">
              <Plus className="h-4 w-4" aria-hidden="true" />
              Upload Document
            </Link>
          </>
        }
      />
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
  const item =
    "block w-full rounded-md px-2.5 py-1.5 text-left text-[13px] hover:bg-surface-soft disabled:cursor-not-allowed disabled:text-text-muted disabled:hover:bg-transparent";
  return (
    <div
      ref={ref}
      role="menu"
      className="animate-fade-in absolute right-3 top-9 z-30 w-44 rounded-lg border border-border bg-surface p-1 shadow-[var(--shadow-elevated)]"
    >
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
      <div className="-mx-1 my-1 border-t border-border" />
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

const STATUS_ICON: Record<keyof typeof EXTRACTED_STATUS_TONE, typeof FileText> = {
  ready: CheckCircle2,
  verified: CheckCircle2,
  review: AlertTriangle,
  failed: XCircle,
  processing: Loader2,
};

/** Console-style status: a coloured icon and the label (Complete, Review needed…). */
function StatusCell({ status }: { status: keyof typeof EXTRACTED_STATUS_TONE }) {
  const Icon = STATUS_ICON[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-[13px] font-medium ${EXTRACTED_STATUS_TONE[status]}`}>
      <Icon className={`h-4 w-4 ${status === "processing" ? "animate-spin" : ""}`} aria-hidden="true" />
      <span className="sr-only">{statusMark(status)} </span>
      {extractedStatusLabel(status)}
    </span>
  );
}

interface CategorySection {
  key: string;
  /** Null when the list isn't grouped (one category is selected). */
  label: string | null;
  documents: DocumentSummary[];
}

/** A page's documents under their categories, in the categories' display
 * order (any not in the counts follow, in page order). */
function groupByCategory(documents: DocumentSummary[], order: CategoryCount[], grouped: boolean): CategorySection[] {
  if (!grouped) return [{ key: "all", label: null, documents }];
  const sections = new Map<string, CategorySection>();
  for (const item of order) sections.set(item.category, { key: item.category, label: item.label, documents: [] });
  for (const document of documents) {
    const key = document.category ?? "unclassified";
    const section = sections.get(key) ?? { key, label: document.category_label ?? key, documents: [] };
    section.documents.push(document);
    sections.set(key, section);
  }
  return [...sections.values()].filter((section) => section.documents.length > 0);
}

function CategoryHeading({ label, count }: { label: string; count: number }) {
  return (
    <span className="flex items-baseline gap-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
      {label}
      <span className="font-normal tabular-nums text-text-muted">{count}</span>
    </span>
  );
}

/** One tab per detected category with its document count. */
function CategoryTabs({
  categories,
  value,
  onChange,
}: {
  categories: CategoryCount[];
  value: string;
  onChange: (category: string) => void;
}) {
  const total = categories.reduce((sum, item) => sum + item.count, 0);
  const options = [{ category: "", label: "All types", count: total }, ...categories];
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label="Document categories" data-testid="category-tabs">
      {options.map((item) => {
        const active = value === item.category;
        return (
          <button
            key={item.category || "all"}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(item.category)}
            className={[
              "h-7 rounded-md px-2.5 text-xs font-medium transition-colors",
              active
                ? "bg-primary text-white shadow-sm"
                : "text-text-secondary hover:bg-surface-soft hover:text-foreground",
            ].join(" ")}
          >
            {item.label} <span className="tabular-nums opacity-70">{item.count.toLocaleString()}</span>
          </button>
        );
      })}
    </div>
  );
}

