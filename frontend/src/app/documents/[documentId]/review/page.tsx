"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import {
  Archive as ArchiveIcon,
  ArrowLeft,
  BadgeCheck,
  Loader2,
} from "lucide-react";

import ContractRelationshipsTree from "@/components/contract-relationships-tree";
import ContractTabs, { type ContractTab } from "@/components/contract-tabs";
import DocumentProfileCard from "@/components/document-profile-card";
import ExportMenu from "@/components/export-menu";
import ExtractionWorkspace from "@/components/extraction-workspace";
import { useDocumentChrome } from "@/components/layout/document-chrome-context";
import PdfPageViewer from "@/components/pdf-page-viewer";
import PdfToolbar, { type SearchMatch } from "@/components/pdf-toolbar";
import PipelineStrip from "@/components/pipeline-strip";
import RelationshipCard from "@/components/relationship-card";
import ReviewFieldList from "@/components/review-field-list";
import DocumentAuditTrail from "@/components/review/document-audit-trail";
import ResizableSplit from "@/components/ui/resizable-split";
import { Skeleton, SkeletonTable } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import {
  acceptAllMetadataFields,
  analyzeContract,
  approveDocument,
  confirmRelationship,
  extractClauses,
  extractSignatures,
  extractTables,
  getChildRelationships,
  getClauses,
  getContractAnalysis,
  getDocument,
  getDocumentPages,
  getPageRender,
  getSignatures,
  promoteDocument,
  reviewMetadataField,
  reviewMetadataFieldById,
} from "@/lib/documents";
import type {
  ChildRelationship,
  ClauseResult,
  ContractAnalysisResult,
  ContractClassification,
  DetectedRelationship,
  DocumentPage,
  MetadataField,
  NormalizedTable,
  PageRender,
  RelationshipAction,
  ReviewAction,
  SignatureResult,
  UploadedDocument,
} from "@/types/document";

interface ReviewPageProps {
  params: Promise<{ documentId: string }>;
}

export default function ReviewWorkspacePage({
  params,
}: ReviewPageProps) {
  const { documentId } = use(params);
  const { setDocumentTitle } = useDocumentChrome();

  const [document, setDocument] =
    useState<UploadedDocument | null>(null);
  const [analysis, setAnalysis] =
    useState<ContractAnalysisResult | null>(null);
  const [children, setChildren] = useState<ChildRelationship[]>([]);
  const [loadError, setLoadError] = useState("");
  const [notAnalyzed, setNotAnalyzed] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState("");

  const [reviewerName, setReviewerName] = useState("Dataomatix");

  const [activeFieldId, setActiveFieldId] = useState<number | null>(null);
  // Bumped on every field pick so the viewer re-scrolls and pulses its box.
  const [focusNonce, setFocusNonce] = useState(0);
  // Why the page shows no box for the picked value (none recorded / not found).
  const [locateHint, setLocateHint] = useState<string | null>(null);

  const [currentPage, setCurrentPage] = useState(1);
  const [highlightText, setHighlightText] = useState<string | null>(
    null,
  );
  const [pageRender, setPageRender] =
    useState<PageRender | null>(null);
  const [renderLoading, setRenderLoading] = useState(false);
  const [renderError, setRenderError] = useState("");

  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState<0 | 90 | 180 | 270>(0);

  const [documentPages, setDocumentPages] = useState<
    DocumentPage[] | null
  >(null);
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<
    SearchMatch[] | null
  >(null);
  const [lastQuery, setLastQuery] = useState("");

  const [reviewingFieldId, setReviewingFieldId] = useState<number | null>(
    null,
  );
  const [acceptingAll, setAcceptingAll] = useState(false);

  const [relationshipBusy, setRelationshipBusy] = useState(false);

  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState("");

  const [promoting, setPromoting] = useState(false);
  const [promoteError, setPromoteError] = useState("");

  const [clauses, setClauses] = useState<ClauseResult[]>([]);
  const [extractingClauses, setExtractingClauses] =
    useState(false);
  const [clausesError, setClausesError] = useState("");

  const [tables, setTables] = useState<NormalizedTable[]>([]);
  const [extractingTables, setExtractingTables] =
    useState(false);
  const [tablesError, setTablesError] = useState("");

  const [signatures, setSignatures] = useState<
    SignatureResult[]
  >([]);
  const [extractingSignatures, setExtractingSignatures] =
    useState(false);
  const [signaturesError, setSignaturesError] = useState("");

  const [activeTab, setActiveTab] = useState<ContractTab>("Data");
  const [mobilePanel, setMobilePanel] = useState<"document" | "data">(
    "document",
  );

  useEffect(() => {
    setDocumentTitle(document?.original_filename ?? null);
    return () => setDocumentTitle(null);
  }, [document?.original_filename, setDocumentTitle]);

  useEffect(() => {
    let active = true;

    async function load() {
      let documentResult: UploadedDocument;

      try {
        documentResult = await getDocument(documentId);
      } catch (error) {
        if (!active) return;

        setLoadError(
          error instanceof Error
            ? error.message
            : "Unable to load this document.",
        );
        return;
      }

      if (!active) return;

      setDocument(documentResult);

      const [analysisResult, clausesResult, signaturesResult, childrenResult] =
        await Promise.all([
          getContractAnalysis(documentId)
            .then((result) => ({ ok: true as const, result }))
            .catch((error) => ({ ok: false as const, error })),
          getClauses(documentId).catch(() => null),
          getSignatures(documentId).catch(() => null),
          getChildRelationships(documentId).catch(() => null),
        ]);

      if (!active) return;

      if (clausesResult) {
        setClauses(clausesResult.clauses);
      }

      if (signaturesResult) {
        setSignatures(signaturesResult.signatures);
      }

      if (childrenResult) {
        setChildren(childrenResult.children);
      }

      if (analysisResult.ok) {
        applyAnalysis(analysisResult.result);
        return;
      }

      const { error } = analysisResult;

      if (error instanceof ApiError && error.status === 404) {
        setNotAnalyzed(true);
        return;
      }

      setLoadError(
        error instanceof Error
          ? error.message
          : "Unable to load this document's analysis.",
      );
    }

    function applyAnalysis(analysisResult: ContractAnalysisResult) {
      setAnalysis(analysisResult);
      setNotAnalyzed(false);

      const firstField = analysisResult.metadata_fields[0];

      if (firstField) {
        setActiveFieldId(firstField.id ?? null);
        setCurrentPage(firstField.evidence.page_number);
        setHighlightText(firstField.evidence.source_text);
      }
    }

    load();

    return () => {
      active = false;
    };
  }, [documentId]);

  useEffect(() => {
    let active = true;

    async function loadPage() {
      setRenderLoading(true);
      setRenderError("");

      try {
        const render = await getPageRender(
          documentId,
          currentPage,
          highlightText ?? undefined,
        );

        if (active) {
          setPageRender(render);
          if (highlightText && !render.highlight) {
            setLocateHint(`This value couldn't be boxed on page ${render.page_number}; the whole page is shown.`);
          }
        }
      } catch (error) {
        if (active) {
          setRenderError(
            error instanceof Error
              ? error.message
              : "Unable to render this page.",
          );
        }
      } finally {
        if (active) {
          setRenderLoading(false);
        }
      }
    }

    loadPage();

    return () => {
      active = false;
    };
  }, [currentPage, highlightText, documentId]);

  function handleSelectField(field: MetadataField) {
    setActiveFieldId(field.id ?? null);
    setFocusNonce((value) => value + 1);
    const page = field.evidence?.page_number;
    if (!page) {
      // Missing values (and some derived ones) were never located on a page.
      setLocateHint(`No location on the page is recorded for ${field.label}.`);
      setHighlightText(null);
      return;
    }
    setLocateHint(null);
    setCurrentPage(page);
    setHighlightText(field.evidence.source_text);
  }

  /** The reviewer clicked the box on the page: bring its field into view. */
  function revealActiveField() {
    const row = window.document.querySelector<HTMLElement>(
      "[data-testid='metadata-review-list'] .field-row-selected",
    );
    row?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function handleViewClauseSource(clause: ClauseResult) {
    setActiveFieldId(null);
    setCurrentPage(clause.evidence.page_number);
    setHighlightText(clause.evidence.source_text);
  }

  function handleViewSignatureSource(signature: SignatureResult) {
    setActiveFieldId(null);
    setCurrentPage(signature.evidence.page_number);
    setHighlightText(signature.evidence.source_text);
  }

  function handlePageChange(page: number) {
    if (!document || page < 1 || page > document.page_count) {
      return;
    }

    setActiveFieldId(null);
    setHighlightText(null);
    setLocateHint(null);
    setCurrentPage(page);
  }

  function handleRotate() {
    setRotation((current) =>
      current === 270 ? 0 : ((current + 90) as 0 | 90 | 180 | 270),
    );
  }

  async function handleSearch(query: string) {
    setSearching(true);
    setLastQuery(query);

    try {
      let pages = documentPages;

      if (!pages) {
        pages = await getDocumentPages(documentId);
        setDocumentPages(pages);
      }

      const needle = query.toLowerCase();

      const results: SearchMatch[] = pages
        .map((page) => {
          const haystack = page.final_text.toLowerCase();
          let count = 0;
          let index = haystack.indexOf(needle);

          while (index !== -1) {
            count += 1;
            index = haystack.indexOf(needle, index + needle.length);
          }

          return { pageNumber: page.page_number, matches: count };
        })
        .filter((result) => result.matches > 0);

      setSearchResults(results);
    } catch {
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }

  function handleJumpToResult(pageNumber: number) {
    setActiveFieldId(null);
    setCurrentPage(pageNumber);
    setHighlightText(lastQuery);
  }

  async function handleReviewField(
    field: MetadataField,
    action: ReviewAction,
    value?: string,
  ) {
    if (!reviewerName.trim()) {
      return;
    }

    setReviewingFieldId(field.id ?? null);

    try {
      const updated =
        field.id != null
          ? await reviewMetadataFieldById(
              documentId,
              field.id,
              action,
              reviewerName.trim(),
              value,
            )
          : await reviewMetadataField(
              documentId,
              field.field_key,
              action,
              reviewerName.trim(),
              value,
            );

      setAnalysis((current) => {
        if (!current) return current;

        return {
          ...current,
          metadata_fields: current.metadata_fields.map((row) => {
            if (updated.id != null && row.id === updated.id) return updated;
            if (updated.id == null && row.field_key === field.field_key) {
              return updated;
            }
            return row;
          }),
        };
      });
    } catch (error) {
      throw error instanceof Error
        ? error
        : new Error("Review action failed.");
    } finally {
      setReviewingFieldId(null);
    }
  }

  async function handleAcceptAll() {
    if (!reviewerName.trim()) {
      return;
    }

    setAcceptingAll(true);

    try {
      const updated = await acceptAllMetadataFields(
        documentId,
        reviewerName.trim(),
      );
      const byId = new Map(
        updated
          .filter((field) => field.id != null)
          .map((field) => [field.id as number, field]),
      );

      setAnalysis((current) => {
        if (!current) return current;

        return {
          ...current,
          metadata_fields: current.metadata_fields.map(
            (field) =>
              (field.id != null ? byId.get(field.id) : undefined) ?? field,
          ),
        };
      });
    } catch {
      // Non-fatal.
    } finally {
      setAcceptingAll(false);
    }
  }

  async function handleRelationshipAction(
    action: RelationshipAction,
  ) {
    if (!analysis?.relationship) {
      return;
    }

    setRelationshipBusy(true);

    try {
      const result = await confirmRelationship(
        documentId,
        action,
        reviewerName,
      );

      setAnalysis((current) => {
        if (!current) return current;

        return {
          ...current,
          relationship: result.relationship,
        };
      });
    } catch {
      // Non-fatal; the card simply stays actionable for retry.
    } finally {
      setRelationshipBusy(false);
    }
  }

  function handleChildrenChanged(updated: ChildRelationship[]) {
    setChildren(updated);
  }

  function handleRelationshipChange(
    relationship: DetectedRelationship | null,
  ) {
    setAnalysis((current) =>
      current ? { ...current, relationship } : current,
    );
  }

  function handleClassificationChange(
    updated: ContractClassification,
  ) {
    setAnalysis((current) =>
      current ? { ...current, classification: updated } : current,
    );
  }

  async function handleApprove() {
    if (!reviewerName.trim()) {
      return;
    }

    setApproving(true);
    setApproveError("");

    try {
      const result = await approveDocument(
        documentId,
        reviewerName.trim(),
      );

      setDocument((current) =>
        current
          ? {
              ...current,
              approved_by: result.approved_by,
              approved_at: result.approved_at,
            }
          : current,
      );
    } catch (error) {
      setApproveError(
        error instanceof Error
          ? error.message
          : "Unable to approve this document.",
      );
    } finally {
      setApproving(false);
    }
  }

  async function handlePromote() {
    if (!reviewerName.trim()) {
      return;
    }

    setPromoting(true);
    setPromoteError("");

    try {
      const result = await promoteDocument(
        documentId,
        reviewerName.trim(),
      );

      setDocument((current) =>
        current
          ? {
              ...current,
              promoted_by: result.promoted_by,
              promoted_at: result.promoted_at,
            }
          : current,
      );
    } catch (error) {
      setPromoteError(
        error instanceof Error
          ? error.message
          : "Unable to promote this document to the repository.",
      );
    } finally {
      setPromoting(false);
    }
  }

  async function handleAnalyze() {
    setAnalyzing(true);
    setAnalyzeError("");

    try {
      const result = await analyzeContract(documentId);
      setAnalysis(result);
      setNotAnalyzed(false);

      const firstField = result.metadata_fields[0];

      if (firstField) {
        setActiveFieldId(firstField.id ?? null);
        setCurrentPage(firstField.evidence.page_number);
        setHighlightText(firstField.evidence.source_text);
      }
    } catch (error) {
      setAnalyzeError(
        error instanceof Error
          ? error.message
          : "Unable to analyze this document.",
      );
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleExtractClauses() {
    setExtractingClauses(true);
    setClausesError("");

    try {
      const result = await extractClauses(documentId);
      setClauses(result.clauses);
    } catch (error) {
      setClausesError(
        error instanceof Error
          ? error.message
          : "Clause extraction failed.",
      );
    } finally {
      setExtractingClauses(false);
    }
  }

  async function handleExtractTables() {
    setExtractingTables(true);
    setTablesError("");

    try {
      const result = await extractTables(documentId);
      setTables(result.tables);
    } catch (error) {
      setTablesError(
        error instanceof Error
          ? error.message
          : "Table extraction failed.",
      );
    } finally {
      setExtractingTables(false);
    }
  }

  async function handleExtractSignatures() {
    setExtractingSignatures(true);
    setSignaturesError("");

    try {
      const result = await extractSignatures(documentId);
      setSignatures(result.signatures);
    } catch (error) {
      setSignaturesError(
        error instanceof Error
          ? error.message
          : "Signature extraction failed.",
      );
    } finally {
      setExtractingSignatures(false);
    }
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16 text-center">
        <p className="text-sm font-medium text-red-700">
          {loadError}
        </p>

        <Link
          href="/"
          className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to dashboard
        </Link>
      </div>
    );
  }

  if (document && notAnalyzed) {
    return (
      <div className="mx-auto flex max-w-lg flex-col items-center gap-4 px-6 py-24 text-center">
        <p className="text-sm font-medium text-foreground">
          This document has not been analyzed yet.
        </p>
        <p className="text-sm text-text-secondary">
          Run contract analysis to extract metadata fields, classify the
          document, and detect relationships.
        </p>
        {analyzeError && (
          <p className="text-xs text-red-700">{analyzeError}</p>
        )}
        <button
          type="button"
          onClick={handleAnalyze}
          disabled={analyzing}
          className="btn-primary px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40"
        >
          {analyzing && <Loader2 className="h-4 w-4 animate-spin" />}
          {analyzing ? "Analyzing..." : "Analyze Document"}
        </button>
        <Link
          href="/repository"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to repository
        </Link>
      </div>
    );
  }

  if (!document || !analysis) {
    return (
      <div className="flex h-[calc(100vh-4rem)] flex-col" role="status" aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading review workspace…</span>
        <div className="space-y-2 border-b border-border px-6 py-4">
          <Skeleton className="h-5 w-72 max-w-full" />
          <Skeleton className="h-3 w-48" />
        </div>
        <div className="grid min-h-0 flex-1 gap-4 p-4 lg:grid-cols-2">
          <div className="hidden rounded-xl border border-border bg-surface-soft p-6 lg:block">
            <Skeleton className="h-full min-h-[24rem] w-full rounded-lg" />
          </div>
          <SkeletonTable rows={8} columns={4} />
        </div>
      </div>
    );
  }

  // The reviewable values first; the staging workbook (what the document
  // page shows) when they don't carry the identity.
  const contractNumber =
    analysis.metadata_fields.find((field) => field.field_key === "contract_number")?.value ??
    analysis.staged_contract_number ??
    undefined;

  const contractTitle = analysis.metadata_fields.find(
    (field) => field.field_key === "contract_title",
  )?.value;

  const counterparty =
    analysis.metadata_fields.find(
      (field) =>
        field.field_key === "counterparty" || field.field_key === "supplier",
    )?.value ??
    analysis.staged_contractor ??
    undefined;

  const effectiveDate = analysis.metadata_fields.find(
    (field) => field.field_key === "effective_date",
  )?.value;

  const expirationDate = analysis.metadata_fields.find(
    (field) => field.field_key === "expiration_date",
  )?.value;

  const contractValue = analysis.metadata_fields.find(
    (field) => field.field_key === "contract_value",
  )?.value;

  const avgConfidence =
    analysis.metadata_fields.length > 0
      ? analysis.metadata_fields.reduce(
          (sum, field) => sum + field.confidence,
          0,
        ) / analysis.metadata_fields.length
      : null;

  const fieldsExtracted = analysis.metadata_fields.length > 0;
  const humanReviewComplete =
    fieldsExtracted &&
    analysis.metadata_fields.every(
      (field) => field.review_status !== "pending",
    );
  const approved = Boolean(document.approved_at);
  const promoted = Boolean(document.promoted_at);

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col">
      <div className="shrink-0 border-b border-border bg-surface px-6 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <Link
              href="/repository"
              className="mt-1 text-text-secondary hover:text-foreground"
              aria-label="Back to repository"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div>
              <h1 className="text-lg font-semibold text-foreground">
                {contractTitle ??
                  document.original_filename.replace(/\.[^.]+$/, "")}
              </h1>
              <p className="mt-0.5 text-sm text-text-secondary">
                {contractNumber ?? "—"}
                {counterparty ? ` · ${counterparty}` : ""}
              </p>
              <div className="mt-2 flex flex-wrap gap-4 text-xs text-text-secondary">
                {effectiveDate && (
                  <span>
                    Effective{" "}
                    <strong className="text-foreground">{effectiveDate}</strong>
                  </span>
                )}
                {expirationDate && (
                  <span>
                    Expires{" "}
                    <strong className="text-foreground">{expirationDate}</strong>
                  </span>
                )}
                {contractValue && (
                  <span>
                    Value{" "}
                    <strong className="text-foreground">{contractValue}</strong>
                  </span>
                )}
                {avgConfidence !== null && (
                  <span>
                    Confidence{" "}
                    <strong className="text-foreground">
                      {Math.round(avgConfidence * 100)}%
                    </strong>
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <PipelineStrip
              classified={Boolean(analysis.classification?.document_type)}
              fieldsExtracted={fieldsExtracted}
              humanReviewComplete={humanReviewComplete}
              approved={approved}
              promoted={promoted}
            />
            <ExportMenu
              documentId={documentId}
              filename={document.original_filename.replace(/\.[^.]+$/, "")}
              fields={analysis.metadata_fields}
            />
            <label className="flex items-center gap-2 text-xs text-text-secondary">
              Reviewed by
              <input
                type="text"
                value={reviewerName}
                onChange={(event) => setReviewerName(event.target.value)}
                className="w-36 rounded-lg border border-border px-2 py-1 text-xs text-foreground"
              />
            </label>
            {!approved && (
              <button
                type="button"
                onClick={handleApprove}
                disabled={!humanReviewComplete || approving}
                className="btn-primary px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-40"
              >
                <BadgeCheck className="h-3.5 w-3.5" />
                {approving ? "Approving..." : "Approve"}
              </button>
            )}
            {approved && !promoted && (
              <button
                type="button"
                onClick={handlePromote}
                disabled={promoting}
                className="btn-secondary px-3 py-1.5 text-xs disabled:opacity-40"
              >
                <ArchiveIcon className="h-3.5 w-3.5" />
                {promoting ? "Promoting..." : "Promote to Repository"}
              </button>
            )}
          </div>
        </div>
      </div>

      <ContractTabs active={activeTab} onChange={setActiveTab} />

      <div className="flex shrink-0 gap-1 border-b border-border bg-background px-4 py-2 lg:hidden">
        <button
          type="button"
          onClick={() => setMobilePanel("document")}
          className={[
            "rounded-md px-3 py-1.5 text-xs font-semibold",
            mobilePanel === "document"
              ? "bg-surface text-brand-blue"
              : "text-text-secondary",
          ].join(" ")}
        >
          Document
        </button>
        <button
          type="button"
          onClick={() => setMobilePanel("data")}
          className={[
            "rounded-md px-3 py-1.5 text-xs font-semibold",
            mobilePanel === "data"
              ? "bg-surface text-brand-blue"
              : "text-text-secondary",
          ].join(" ")}
        >
          Extracted intelligence
        </button>
      </div>

      {approveError && (
        <p className="shrink-0 border-b border-red-100 bg-red-50 px-6 py-1.5 text-xs text-red-700">
          {approveError}
        </p>
      )}

      {promoteError && (
        <p className="shrink-0 border-b border-red-100 bg-red-50 px-6 py-1.5 text-xs text-red-700">
          {promoteError}
        </p>
      )}

      <ResizableSplit
        storageKey="dataomatix-review-split"
        label="Resize document and data panels"
        leftClassName={[
          "flex-col overflow-hidden",
          mobilePanel === "document" ? "flex" : "hidden lg:flex",
        ].join(" ")}
        rightClassName={[
          "h-full flex-col overflow-hidden",
          mobilePanel === "data" ? "flex" : "hidden lg:flex",
        ].join(" ")}
        left={
        <>
          <PdfToolbar
            currentPage={currentPage}
            pageCount={document.page_count}
            onPageChange={handlePageChange}
            zoom={zoom}
            onZoomChange={setZoom}
            onRotate={handleRotate}
            onSearch={handleSearch}
            searching={searching}
            searchResults={searchResults}
            onJumpToResult={handleJumpToResult}
          />

          {locateHint && (
            <p className="shrink-0 border-b border-warning/30 bg-warning/10 px-4 py-1.5 text-xs text-text-secondary" role="status">
              {locateHint}
            </p>
          )}

          <div className="flex-1 overflow-hidden">
            <PdfPageViewer
              render={pageRender}
              loading={renderLoading}
              error={renderError}
              zoom={zoom}
              rotation={rotation}
              focusKey={focusNonce}
              onHighlightClick={activeFieldId != null ? revealActiveField : undefined}
            />
          </div>

          {(activeTab === "Clauses" || activeTab === "Documents") && (
            <div className="shrink-0 max-h-[45vh] overflow-y-auto border-t border-border bg-background p-4">
              <ExtractionWorkspace
                clauses={clauses}
                extractingClauses={extractingClauses}
                clausesError={clausesError}
                onExtractClauses={handleExtractClauses}
                onViewClauseSource={handleViewClauseSource}
                tables={tables}
                extractingTables={extractingTables}
                tablesError={tablesError}
                onExtractTables={handleExtractTables}
                signatures={signatures}
                extractingSignatures={extractingSignatures}
                signaturesError={signaturesError}
                onExtractSignatures={handleExtractSignatures}
                onViewSignatureSource={handleViewSignatureSource}
              />
            </div>
          )}
        </>
        }
        right={
        <>
          {activeTab === "Overview" && (
            <div className="space-y-4 overflow-y-auto p-4">
              <DocumentProfileCard
                documentId={documentId}
                classification={analysis.classification}
                reviewerName={reviewerName}
                onClassificationChange={handleClassificationChange}
              />
              <RelationshipCard
                documentId={documentId}
                relationship={analysis.relationship}
                reviewerName={reviewerName}
                onConfirm={() => handleRelationshipAction("confirm")}
                onReject={() => handleRelationshipAction("reject")}
                onRelationshipChange={handleRelationshipChange}
                busy={relationshipBusy}
              />
              {children.length > 0 && (
                <ContractRelationshipsTree
                  rootLabel={
                    contractNumber ?? document.original_filename
                  }
                  childRelationships={children}
                  onChanged={handleChildrenChanged}
                  reviewerName={reviewerName}
                />
              )}
            </div>
          )}

          {(activeTab === "Data" || activeTab === "Documents") && (
            <div className="min-h-0 flex-1">
              <ReviewFieldList
                documentId={documentId}
                fields={analysis.metadata_fields}
                activeFieldId={activeFieldId}
                onSelectField={handleSelectField}
                onReviewField={handleReviewField}
                onAcceptAll={handleAcceptAll}
                reviewingFieldId={reviewingFieldId}
                acceptingAll={acceptingAll}
              />
            </div>
          )}

          {activeTab === "Relationships" && (
            <div className="space-y-4 overflow-y-auto p-4">
              <RelationshipCard
                documentId={documentId}
                relationship={analysis.relationship}
                reviewerName={reviewerName}
                onConfirm={() => handleRelationshipAction("confirm")}
                onReject={() => handleRelationshipAction("reject")}
                onRelationshipChange={handleRelationshipChange}
                busy={relationshipBusy}
              />
              {children.length > 0 ? (
                <ContractRelationshipsTree
                  rootLabel={
                    contractNumber ?? document.original_filename
                  }
                  childRelationships={children}
                  onChanged={handleChildrenChanged}
                  reviewerName={reviewerName}
                />
              ) : (
                <p className="text-sm text-text-secondary">
                  No related documents detected yet.
                </p>
              )}
            </div>
          )}

          {activeTab === "Clauses" && (
            <div className="overflow-y-auto p-4">
              <ExtractionWorkspace
                clauses={clauses}
                extractingClauses={extractingClauses}
                clausesError={clausesError}
                onExtractClauses={handleExtractClauses}
                onViewClauseSource={handleViewClauseSource}
                tables={tables}
                extractingTables={extractingTables}
                tablesError={tablesError}
                onExtractTables={handleExtractTables}
                signatures={signatures}
                extractingSignatures={extractingSignatures}
                signaturesError={signaturesError}
                onExtractSignatures={handleExtractSignatures}
                onViewSignatureSource={handleViewSignatureSource}
              />
            </div>
          )}

          {activeTab === "Activity" && (
            <div className="min-h-0 flex-1">
              <DocumentAuditTrail documentId={documentId} refreshKey={analysis.metadata_fields.filter((field) => field.review_status !== "pending").length} />
            </div>
          )}
        </>
        }
      />
    </div>
  );
}
