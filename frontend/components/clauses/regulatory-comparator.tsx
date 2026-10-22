"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, GitCompareArrows } from "lucide-react";

import EmptyState from "@/components/ui/empty-state";
import {
  getIngestedClauseTexts,
  listIngestedClauses,
  type IngestedClause,
  type IngestedClauseRecord,
} from "@/lib/playbook";
import { diffStats, wordDiff } from "@/lib/text-diff";

const FIELD = "w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-foreground";

type Mode = "versions" | "counterpart";

/** "52.204-21" → "204": the FAR subpart a DFARS counterpart shares
 * (252.204-7012 supplements FAR subpart 204). */
function section(number: string): string {
  return number.replace(/^2?52\./, "").split("-")[0];
}

function recordFor(records: IngestedClauseRecord[] | undefined, version: string): IngestedClauseRecord | null {
  if (!records?.length) return null;
  return records.find((record) => (record.version_date ?? "") === version) ?? records[0];
}

/** Compare two regulation texts that exist in ingested FAR / DFARS records:
 * two version dates of one clause, or a FAR clause and a DFARS clause. The
 * text is never generated — no records, no comparison. */
export default function RegulatoryComparator({ initialClause = "" }: { initialClause?: string }) {
  const [index, setIndex] = useState<IngestedClause[] | null>(null);
  const [indexError, setIndexError] = useState("");
  const [mode, setMode] = useState<Mode>("versions");
  const [leftNumber, setLeftNumber] = useState(initialClause);
  const [rightNumber, setRightNumber] = useState("");
  const [leftVersion, setLeftVersion] = useState("");
  const [rightVersion, setRightVersion] = useState("");
  const [texts, setTexts] = useState<Record<string, IngestedClauseRecord[]>>({});
  const [textError, setTextError] = useState("");

  useEffect(() => {
    let active = true;
    listIngestedClauses()
      .then((items) => active && setIndex(items))
      .catch((err: unknown) => active && setIndexError(err instanceof Error ? err.message : "Unable to load ingested clauses."));
    return () => {
      active = false;
    };
  }, []);

  const far = useMemo(() => (index ?? []).filter((item) => item.family === "FAR"), [index]);
  const dfars = useMemo(() => (index ?? []).filter((item) => item.family === "DFARS"), [index]);
  const withVersions = useMemo(() => (index ?? []).filter((item) => item.versions.length > 1), [index]);

  // Selections fall back to sensible defaults until the user picks.
  const leftOptions = mode === "versions" ? withVersions : far;
  const left = leftOptions.find((item) => item.clause_number === leftNumber) ?? leftOptions[0] ?? null;
  const counterparts = useMemo(() => {
    if (!left) return dfars;
    const same = dfars.filter((item) => section(item.clause_number) === section(left.clause_number));
    return [...same, ...dfars.filter((item) => !same.includes(item))];
  }, [dfars, left]);
  const right =
    mode === "versions"
      ? left
      : counterparts.find((item) => item.clause_number === rightNumber) ?? counterparts[0] ?? null;

  const leftVersionValue = left?.versions.includes(leftVersion)
    ? leftVersion
    : mode === "versions"
      ? (left?.versions[1] ?? left?.versions[0] ?? "")
      : (left?.versions[0] ?? "");
  const rightVersionValue = right?.versions.includes(rightVersion) ? rightVersion : (right?.versions[0] ?? "");

  // Texts are fetched only once both sides of a comparison exist.
  const numbersKey = left && right ? `${left.clause_number}|${right.clause_number}` : "";
  useEffect(() => {
    if (!numbersKey) return;
    let active = true;
    for (const number of new Set(numbersKey.split("|"))) {
      getIngestedClauseTexts(number)
        .then((result) => active && setTexts((current) => ({ ...current, [number]: result.records })))
        .catch((err: unknown) => active && setTextError(err instanceof Error ? err.message : "Unable to load clause text."));
    }
    return () => {
      active = false;
    };
  }, [numbersKey]);

  const before = left ? recordFor(texts[left.clause_number], leftVersionValue) : null;
  const after = right ? recordFor(texts[right.clause_number], rightVersionValue) : null;
  const segments = useMemo(
    () => (before?.source_text != null && after?.source_text != null ? wordDiff(before.source_text, after.source_text) : null),
    [before, after],
  );
  const stats = segments ? diffStats(segments) : null;

  let body;
  if (indexError) {
    body = <p className="text-sm text-danger">{indexError}</p>;
  } else if (!index) {
    body = <p className="text-sm text-text-secondary">Loading ingested regulation records…</p>;
  } else if (index.length === 0) {
    body = (
      <EmptyState
        icon={GitCompareArrows}
        title="No FAR or DFARS regulation text ingested yet"
        description="The comparator only compares text that exists in your ingested records. Upload the FAR Part 52 regulation source (and the DFARS XML for DFARS counterparts, or a second FAR release to compare versions)."
        action={
          <Link href="/extraction/new" className="btn-primary px-4 py-2 text-sm">
            Upload a regulation source
          </Link>
        }
      />
    );
  } else if (mode === "versions" && withVersions.length === 0) {
    body = (
      <p className="rounded-lg bg-surface-soft px-3 py-6 text-center text-sm text-text-secondary">
        Every ingested clause has a single version date. Ingest another FAR or DFARS release to compare versions of a
        clause.
      </p>
    );
  } else if (mode === "counterpart" && (far.length === 0 || dfars.length === 0)) {
    body = (
      <p className="rounded-lg bg-surface-soft px-3 py-6 text-center text-sm text-text-secondary">
        {far.length === 0
          ? "No FAR clauses are ingested. Ingest FAR Part 52 to compare a FAR clause with its DFARS counterpart."
          : "No DFARS clauses are ingested. Ingest the DFARS XML to compare a FAR clause with its DFARS counterpart."}
      </p>
    );
  } else {
    body = (
      <div className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          <fieldset className="space-y-2">
            <legend className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
              {mode === "versions" ? "Clause and earlier version" : "FAR clause"}
            </legend>
            <select
              aria-label={mode === "versions" ? "Clause" : "FAR clause"}
              value={left?.clause_number ?? ""}
              onChange={(event) => {
                setLeftNumber(event.target.value);
                setLeftVersion("");
                setRightVersion("");
                setRightNumber("");
              }}
              className={FIELD}
            >
              {leftOptions.map((item) => (
                <option key={item.clause_number} value={item.clause_number}>
                  {item.clause_number} {item.title}
                </option>
              ))}
            </select>
            <select
              aria-label="Left version"
              value={leftVersionValue}
              onChange={(event) => setLeftVersion(event.target.value)}
              className={FIELD}
            >
              {(left?.versions.length ? left.versions : [""]).map((version) => (
                <option key={version} value={version}>
                  {version || "Undated"}
                </option>
              ))}
            </select>
          </fieldset>
          <fieldset className="space-y-2">
            <legend className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
              {mode === "versions" ? "Later version" : "DFARS counterpart"}
            </legend>
            {mode === "counterpart" && (
              <select
                aria-label="DFARS clause"
                value={right?.clause_number ?? ""}
                onChange={(event) => {
                  setRightNumber(event.target.value);
                  setRightVersion("");
                }}
                className={FIELD}
              >
                {counterparts.map((item) => (
                  <option key={item.clause_number} value={item.clause_number}>
                    {item.clause_number} {item.title}
                  </option>
                ))}
              </select>
            )}
            <select
              aria-label="Right version"
              value={rightVersionValue}
              onChange={(event) => setRightVersion(event.target.value)}
              className={FIELD}
            >
              {(right?.versions.length ? right.versions : [""]).map((version) => (
                <option key={version} value={version}>
                  {version || "Undated"}
                </option>
              ))}
            </select>
          </fieldset>
        </div>

        {textError ? (
          <p className="text-sm text-danger">{textError}</p>
        ) : !segments || !before || !after ? (
          <p className="text-sm text-text-secondary">Loading clause text…</p>
        ) : (
          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-text-secondary">
              <span className="flex flex-wrap items-center gap-3">
                <SourceLink record={before} />
                <span aria-hidden="true">→</span>
                <SourceLink record={after} />
              </span>
              {stats && (
                <span className="flex items-center gap-2" data-testid="diff-stats">
                  <span className="rounded bg-success/10 px-1.5 py-0.5 text-success">+{stats.inserted} words</span>
                  <span className="rounded bg-danger/10 px-1.5 py-0.5 text-danger">−{stats.deleted} words</span>
                </span>
              )}
            </div>
            {stats && stats.inserted === 0 && stats.deleted === 0 ? (
              <p className="rounded-lg bg-surface-soft px-3 py-4 text-center text-sm text-success">
                The two texts are identical word for word.
              </p>
            ) : null}
            <div
              className="max-h-[32rem] overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-surface-soft px-4 py-3 text-[13px] leading-6 text-foreground"
              data-testid="regulatory-diff"
            >
              {segments.map((segment, position) =>
                segment.op === "equal" ? (
                  <span key={position}>{segment.text}</span>
                ) : segment.op === "insert" ? (
                  <ins key={position} className="rounded-sm bg-success/15 text-success no-underline">
                    {segment.text}
                  </ins>
                ) : (
                  <del key={position} className="rounded-sm bg-danger/10 text-danger">
                    {segment.text}
                  </del>
                ),
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <section className="rounded-xl border border-border bg-surface p-5" aria-label="Regulatory comparator">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Regulatory comparator</h2>
          <p className="mt-0.5 text-xs text-text-secondary">
            Word-level differences between ingested regulation texts — removed words struck through, added words
            highlighted.
          </p>
        </div>
        <div className="flex gap-1 rounded-lg border border-border p-0.5" role="group" aria-label="Comparison mode">
          {(
            [
              ["versions", "Two versions of a clause"],
              ["counterpart", "FAR vs DFARS counterpart"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={mode === id}
              onClick={() => {
                setMode(id);
                setLeftVersion("");
                setRightVersion("");
              }}
              className={[
                "rounded-md px-2.5 py-1 text-xs font-medium",
                mode === id ? "bg-primary-soft text-primary" : "text-text-secondary hover:text-foreground",
              ].join(" ")}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {body}
    </section>
  );
}

function SourceLink({ record }: { record: IngestedClauseRecord }) {
  return (
    <Link href={`/documents/${record.document_id}`} className="inline-flex items-center gap-1 hover:text-primary">
      <span className="font-id text-foreground">{record.clause_number}</span>
      {record.version_date && <span>{record.version_date}</span>}
      <span className="text-text-muted">· {record.filename || "ingested source"}</span>
      <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
    </Link>
  );
}
