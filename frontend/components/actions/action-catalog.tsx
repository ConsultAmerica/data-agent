"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CalendarClock,
  FileText,
  Landmark,
  ListChecks,
  Play,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";

import ActionResultView from "@/components/actions/action-result";
import AgentRun from "@/components/actions/agent-run";
import { listDocuments } from "@/lib/documents";
import {
  actionHref,
  downloadDocumentAction,
  listDocumentActions,
  runDocumentAction,
  type ActionResult,
  type DocumentAction,
} from "@/lib/document-actions";
import type { DocumentSummary } from "@/types/document";

const CATEGORY_ICON: Record<string, LucideIcon> = {
  Summary: FileText,
  Risk: ShieldAlert,
  Compliance: ListChecks,
  Obligations: CalendarClock,
  Financial: Landmark,
};

/** Agent action gallery: pick a document, run a one-click report, read it
 * inline and download it as CSV or Markdown. */
export default function ActionCatalog() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedDocument = searchParams.get("document_id");
  const requestedAction = searchParams.get("action");

  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);
  const [documentsError, setDocumentsError] = useState("");
  const [documentId, setDocumentId] = useState<string>(requestedDocument ?? "");
  // The catalog as loaded for one document; stale once another is picked.
  const [loaded, setLoaded] = useState<{ documentId: string; actions: DocumentAction[] | null; error: string } | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [runError, setRunError] = useState("");
  const [downloading, setDownloading] = useState<"csv" | "md" | null>(null);
  // The latest run, shown as a step checklist beside its results card.
  const [runInfo, setRunInfo] = useState<{ id: number; actionId: string; startedAt: Date } | null>(null);
  const autoRan = useRef<string | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const loadedForDocument = loaded?.documentId === documentId ? loaded : null;
  const actions = loadedForDocument?.actions ?? null;
  const actionsError = loadedForDocument?.error ?? "";

  useEffect(() => {
    let active = true;
    listDocuments(100)
      .then((items) => {
        if (!active) return;
        setDocuments(items);
        setDocumentId((current) => current || items[0]?.document_id || "");
      })
      .catch((err) => {
        if (active) setDocumentsError(err instanceof Error ? err.message : "Unable to load documents.");
      });
    return () => {
      active = false;
    };
  }, []);

  const run = useCallback(
    async (actionId: string) => {
      if (!documentId) return;
      setRunning(actionId);
      setRunError("");
      setResult(null);
      setRunInfo({ id: Date.now(), actionId, startedAt: new Date() });
      requestAnimationFrame(() => resultRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }));
      try {
        const output = await runDocumentAction(documentId, actionId);
        setResult(output);
      } catch (err) {
        setRunError(err instanceof Error ? err.message : "The action failed.");
      } finally {
        setRunning(null);
      }
    },
    [documentId],
  );

  useEffect(() => {
    if (!documentId) return;
    let active = true;
    listDocumentActions(documentId)
      .then((items) => {
        if (!active) return;
        setLoaded({ documentId, actions: items, error: "" });
        // /actions?document_id=…&action=… (from a document's Actions menu) runs once.
        const key = `${documentId}:${requestedAction}`;
        const requested = items.find((item) => item.action_id === requestedAction);
        if (documentId === requestedDocument && requested?.available && autoRan.current !== key) {
          autoRan.current = key;
          void run(requested.action_id);
        }
      })
      .catch((err) => {
        if (active) {
          setLoaded({ documentId, actions: null, error: err instanceof Error ? err.message : "Unable to load actions." });
        }
      });
    return () => {
      active = false;
    };
  }, [documentId, requestedAction, requestedDocument, run]);

  function selectDocument(next: string) {
    setDocumentId(next);
    setResult(null);
    setRunError("");
    setRunInfo(null);
    router.replace(actionHref(next));
  }

  async function download(format: "csv" | "md") {
    if (!result) return;
    setDownloading(format);
    setRunError("");
    try {
      await downloadDocumentAction(result.document_id, result.action_id, format, result.document_name);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Download failed.");
    } finally {
      setDownloading(null);
    }
  }

  if (documentsError) {
    return <p className="text-sm text-danger">{documentsError}</p>;
  }
  if (documents && documents.length === 0) {
    return (
      <p className="rounded-lg bg-surface-soft px-3 py-6 text-center text-sm text-text-secondary">
        No documents yet.{" "}
        <Link href="/extraction/new" className="text-primary hover:underline">
          Upload a document
        </Link>{" "}
        to run agent actions on it.
      </p>
    );
  }

  const selected = documents?.find((item) => item.document_id === documentId);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Document</span>
          <select
            value={documentId}
            onChange={(event) => selectDocument(event.target.value)}
            disabled={!documents}
            className="min-w-[18rem] max-w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground"
            aria-label="Document"
          >
            {!documents && <option value="">Loading documents…</option>}
            {documents && requestedDocument && !selected && <option value={requestedDocument}>{requestedDocument}</option>}
            {documents?.map((item) => (
              <option key={item.document_id} value={item.document_id}>
                {item.original_filename}
                {item.document_type ? ` · ${item.document_type}` : ""}
              </option>
            ))}
          </select>
        </label>
        {documentId && (
          <Link href={`/documents/${documentId}`} className="text-sm text-text-secondary hover:text-foreground">
            Open document
          </Link>
        )}
      </div>

      {actionsError && <p className="text-sm text-danger">{actionsError}</p>}

      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" role="list" aria-label="Agent actions">
        {(actions ?? []).map((action) => {
          const Icon = CATEGORY_ICON[action.category] ?? FileText;
          const isRunning = running === action.action_id;
          const isCurrent = result?.action_id === action.action_id;
          return (
            <li
              key={action.action_id}
              className={[
                "flex flex-col rounded-xl border bg-surface p-5 transition-colors",
                isCurrent ? "border-primary" : "border-border",
                action.available ? "" : "opacity-70",
              ].join(" ")}
            >
              <div className="flex items-start justify-between gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
                  <Icon className="h-4 w-4" strokeWidth={1.75} />
                </span>
                <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-text-secondary">
                  {action.category}
                </span>
              </div>
              <h2 className="mt-3 text-sm font-semibold text-foreground">{action.title}</h2>
              <p className="mt-1 flex-1 text-sm text-text-secondary">{action.description}</p>
              {!action.available && action.reason && (
                <p className="mt-2 text-xs text-text-muted">{action.reason}</p>
              )}
              <button
                type="button"
                disabled={!action.available || running !== null}
                onClick={() => void run(action.action_id)}
                className="btn-secondary mt-4 self-start px-3 py-2 text-sm disabled:opacity-50"
              >
                <Play className="h-3.5 w-3.5" />
                {isRunning ? "Running…" : "Run"}
              </button>
            </li>
          );
        })}
        {!actions && !actionsError &&
          Array.from({ length: 3 }, (_, index) => (
            <li key={index} className="h-44 animate-pulse rounded-xl border border-border bg-surface-soft" aria-hidden="true" />
          ))}
      </ul>

      {runError && !runInfo && <p className="text-sm text-danger" role="alert">{runError}</p>}

      {runInfo && (
        <div ref={resultRef} className="scroll-mt-24 space-y-4">
          <div className="border-t border-border pt-6">
            <p className="section-eyebrow">Agent run</p>
            <h2 className="mt-1 text-xl font-medium tracking-tight text-foreground">
              {actions?.find((item) => item.action_id === runInfo.actionId)?.title ?? result?.title ?? "Action"}
            </h2>
            {result && (
              <p className="mt-1 text-sm text-text-secondary">
                {result.document_name} · generated {new Date(result.generated_at).toLocaleString()}
              </p>
            )}
          </div>
          <AgentRun
            key={runInfo.id}
            actionId={runInfo.actionId}
            title={actions?.find((item) => item.action_id === runInfo.actionId)?.title ?? "Action"}
            documentName={result?.document_name ?? selected?.original_filename ?? "Document"}
            state={running ? "running" : result ? "completed" : runError ? "failed" : "running"}
            result={result}
            error={runError}
            startedAt={runInfo.startedAt}
            downloading={downloading}
            onDownload={(format) => void download(format)}
          />
          {result && <ActionResultView result={result} />}
        </div>
      )}
    </div>
  );
}
