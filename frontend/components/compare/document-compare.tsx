"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeftRight } from "lucide-react";

import { EmptyNote, Panel } from "@/components/portfolio/portfolio-parts";
import {
  compareDocuments,
  type CompareChange,
  type CompareResult,
  type CompareSection,
} from "@/lib/compare";
import { listDocuments } from "@/lib/documents";
import type { DocumentSummary } from "@/types/document";

const CHANGE_LABEL: Record<CompareChange, string> = {
  changed: "Changed",
  added: "Added",
  removed: "Removed",
  unchanged: "Unchanged",
};

const CHANGE_TEXT: Record<CompareChange, string> = {
  changed: "text-warning",
  added: "text-success",
  removed: "text-danger",
  unchanged: "text-text-muted",
};

const CHANGE_ROW: Record<CompareChange, string> = {
  changed: "bg-warning/5",
  added: "bg-success/5",
  removed: "bg-danger/5",
  unchanged: "",
};

/** Two whole documents side by side — a modification against its base
 * award, or any two documents of the same kind. The picked pair lives in
 * the URL (?left=&right=) so a comparison can be shared. */
export default function DocumentCompare() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const left = searchParams.get("left") ?? "";
  const right = searchParams.get("right") ?? "";

  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);
  const [listError, setListError] = useState("");
  // The outcome for one pair; a different pair in the URL means loading.
  const [outcome, setOutcome] = useState<{ pair: string; result: CompareResult | null; error: string } | null>(null);
  const [showUnchanged, setShowUnchanged] = useState(false);
  const pair = `${left}|${right}`;
  const ready = Boolean(left && right && left !== right);
  const current = outcome?.pair === pair ? outcome : null;
  const loading = ready && current === null;
  const result = current?.result ?? null;
  const error = current?.error ?? "";

  useEffect(() => {
    let active = true;
    listDocuments(200)
      .then((docs) => active && setDocuments(docs))
      .catch((err) => active && setListError(err instanceof Error ? err.message : "Unable to load documents."));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!left || !right || left === right) return;
    let active = true;
    const key = `${left}|${right}`;
    compareDocuments(left, right)
      .then((data) => active && setOutcome({ pair: key, result: data, error: "" }))
      .catch((err) => {
        if (!active) return;
        setOutcome({ pair: key, result: null, error: err instanceof Error ? err.message : "Comparison failed." });
      });
    return () => {
      active = false;
    };
  }, [left, right]);

  function select(next: { left?: string; right?: string }) {
    const params = new URLSearchParams();
    const l = next.left ?? left;
    const r = next.right ?? right;
    if (l) params.set("left", l);
    if (r) params.set("right", r);
    const qs = params.toString();
    router.replace(qs ? `/compare?${qs}` : "/compare");
  }

  const sections = useMemo(() => {
    if (!result) return [];
    return result.sections
      .map((section) => ({
        ...section,
        rows: showUnchanged ? section.rows : section.rows.filter((row) => row.change !== "unchanged"),
      }))
      .filter((section) => section.rows.length > 0);
  }, [result, showUnchanged]);

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-border bg-surface p-5">
        <div className="grid items-end gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
          <DocumentPicker
            label="Base document"
            value={left}
            other={right}
            documents={documents}
            onChange={(id) => select({ left: id })}
          />
          <button
            type="button"
            className="btn-secondary inline-flex h-10 items-center justify-center gap-1.5 px-3"
            onClick={() => select({ left: right, right: left })}
            disabled={!left && !right}
            aria-label="Swap documents"
            title="Swap documents"
          >
            <ArrowLeftRight className="h-4 w-4" />
          </button>
          <DocumentPicker
            label="Compared document"
            value={right}
            other={left}
            documents={documents}
            onChange={(id) => select({ right: id })}
          />
        </div>
        {listError && <p className="mt-3 text-sm text-danger">{listError}</p>}
        {documents && documents.length < 2 && (
          <p className="mt-3 text-sm text-text-secondary">
            Upload at least two documents to compare them.{" "}
            <Link href="/extraction/new" className="text-primary hover:underline">
              Start an extraction
            </Link>
          </p>
        )}
      </section>

      {!left || !right ? (
        <EmptyNote>Pick a base document and a document to compare it with — for example a modification and its base award.</EmptyNote>
      ) : left === right ? (
        <EmptyNote>Choose two different documents.</EmptyNote>
      ) : loading ? (
        <p className="text-sm text-text-secondary" role="status">
          Comparing documents…
        </p>
      ) : error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : result ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <ul className="flex flex-wrap gap-2" aria-label="Change summary">
              {(["changed", "added", "removed", "unchanged"] as const).map((change) => (
                <li
                  key={change}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-xs"
                >
                  <span className={`font-semibold tabular-nums ${CHANGE_TEXT[change]}`}>
                    {result.summary[change].toLocaleString()}
                  </span>
                  <span className="text-text-secondary">{CHANGE_LABEL[change]}</span>
                </li>
              ))}
            </ul>
            <label className="inline-flex items-center gap-2 text-sm text-text-secondary">
              <input
                type="checkbox"
                checked={showUnchanged}
                onChange={(event) => setShowUnchanged(event.target.checked)}
              />
              Show unchanged
            </label>
          </div>

          {sections.length === 0 ? (
            <EmptyNote>
              {result.sections.length === 0
                ? "Neither document has extracted data to compare yet."
                : "No differences found. Turn on “Show unchanged” to see every value."}
            </EmptyNote>
          ) : (
            sections.map((section) => (
              <CompareSectionTable key={section.section_id} section={section} result={result} />
            ))
          )}
        </>
      ) : null}
    </div>
  );
}

function DocumentPicker({
  label,
  value,
  other,
  documents,
  onChange,
}: {
  label: string;
  value: string;
  other: string;
  documents: DocumentSummary[] | null;
  onChange: (id: string) => void;
}) {
  return (
    <label className="block min-w-0 text-sm">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-text-secondary">{label}</span>
      <select
        className="h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={documents === null}
      >
        <option value="">{documents === null ? "Loading documents…" : "Select a document"}</option>
        {documents?.map((doc) => (
          <option key={doc.document_id} value={doc.document_id} disabled={doc.document_id === other}>
            {doc.original_filename}
            {doc.document_type ? ` — ${doc.document_type}` : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

function CompareSectionTable({ section, result }: { section: CompareSection; result: CompareResult }) {
  const counts = (["changed", "added", "removed"] as const)
    .filter((change) => section.counts[change] > 0)
    .map((change) => `${section.counts[change]} ${CHANGE_LABEL[change].toLowerCase()}`)
    .join(" · ");
  return (
    <Panel title={section.label} description={counts || "No differences"}>
      <div className="overflow-x-auto">
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col className="w-[22%]" />
            <col className="w-[30%]" />
            <col className="w-[30%]" />
            <col className="w-[18%]" />
          </colgroup>
          <thead>
            <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
              <th className="py-2 pr-4">Field</th>
              <th className="py-2 pr-4">
                <Link href={`/documents/${result.left.document_id}`} className="normal-case hover:text-primary">
                  {result.left.name}
                </Link>
              </th>
              <th className="py-2 pr-4">
                <Link href={`/documents/${result.right.document_id}`} className="normal-case hover:text-primary">
                  {result.right.name}
                </Link>
              </th>
              <th className="py-2">Change</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {section.rows.map((row) => (
              <tr key={row.key} className={CHANGE_ROW[row.change]} data-change={row.change}>
                <td className="break-words py-2 pr-4 align-top font-medium text-foreground">{row.label}</td>
                <td className="break-words py-2 pr-4 align-top text-text-secondary">
                  {row.left ?? <span className="text-text-muted">—</span>}
                </td>
                <td className="break-words py-2 pr-4 align-top text-foreground">
                  {row.right ?? <span className="text-text-muted">—</span>}
                </td>
                <td className="py-2 align-top">
                  <span className={`font-medium ${CHANGE_TEXT[row.change]}`}>{CHANGE_LABEL[row.change]}</span>
                  {row.detail && <span className="ml-1.5 tabular-nums text-text-secondary">{row.detail}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
