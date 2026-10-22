"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight, Check, FileSearch, Minus, ShieldAlert, ShieldCheck, Sparkles } from "lucide-react";

import { queryTerms, splitCitations, type AskCitation, type AskResponse } from "@/lib/ask";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The passage with the question's words in bold. */
function Highlighted({ text, terms }: { text: string; terms: string[] }) {
  if (terms.length === 0) return <>{text}</>;
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
  return (
    <>
      {text.split(pattern).map((part, index) =>
        index % 2 === 1 ? (
          <strong key={index} className="font-semibold text-foreground">
            {part}
          </strong>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </>
  );
}

/** An inline citation pill: links straight to the cited page (highlighted
 * in the source viewer) and shows the page it points at; hovering or
 * focusing it highlights the citation in the list below. */
function CiteChip({
  n,
  citations,
  onSelect,
}: {
  n: number | null;
  citations: Map<number, AskCitation>;
  onSelect: (n: number) => void;
}) {
  if (n == null) return <span className="text-text-muted">—</span>;
  const citation = citations.get(n);
  const className =
    "mx-0.5 inline-flex h-[1.15rem] min-w-[1.15rem] items-center justify-center gap-0.5 whitespace-nowrap rounded-md bg-primary-soft px-1 align-super text-[10px] font-semibold leading-none text-primary transition hover:bg-primary hover:text-white";
  if (!citation) {
    return (
      <span className={className} aria-label={`Citation ${n}`}>
        {n}
      </span>
    );
  }
  const where = citation.page != null ? `, page ${citation.page}` : "";
  return (
    <Link
      href={citation.href}
      aria-label={`Citation ${n}: ${citation.document_name}${where}`}
      title={`${citation.document_name}${where}${citation.snippet ? ` — “${citation.snippet.slice(0, 160)}”` : ""}`}
      onMouseEnter={() => onSelect(n)}
      onFocus={() => onSelect(n)}
      className={className}
      data-testid="ask-cite-pill"
    >
      {n}
      {citation.page != null && <span className="font-medium opacity-80">· p.{citation.page}</span>}
    </Link>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-secondary">{title}</p>
      <div className="overflow-x-auto rounded-xl border border-border">{children}</div>
    </section>
  );
}

const TH = "px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-text-muted";
const TD = "px-3 py-2 align-top";

export default function AskAnswer({
  turnId,
  response,
  onAsk,
}: {
  turnId: string;
  response: AskResponse;
  onAsk: (question: string) => void;
}) {
  const [activeCitation, setActiveCitation] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const terms = queryTerms(response.question);
  const citeId = (n: number) => `ask-${turnId}-cite-${n}`;
  const citationsByN = new Map(response.citations.map((citation) => [citation.n, citation]));
  // Every answer must be grounded: one with no citations is flagged, not trusted.
  const grounded = response.citations.length > 0;

  function selectCitation(n: number) {
    setActiveCitation(n);
  }

  function toggleSnippet(n: number) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  }

  if (response.answer_type === "none") {
    return (
      <section className="editorial-card p-6" data-testid="ask-empty">
        <div className="flex items-start gap-3">
          <FileSearch className="mt-0.5 h-5 w-5 shrink-0 text-text-muted" strokeWidth={1.75} />
          <div className="min-w-0">
            <p className="font-medium text-foreground">No evidence found for this question</p>
            <p className="mt-1 text-sm leading-6 text-text-secondary">
              {response.answer ||
                "Nothing in the extracted data or source pages answers it. Try a clause number, a field name, or one of these:"}
            </p>
            {response.suggestions.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {response.suggestions.map((item) => (
                  <button key={item} type="button" className="chip" onClick={() => onAsk(item)}>
                    {item}
                  </button>
                ))}
              </div>
            )}
            <Link href="/extraction/new" className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
              Upload a document to ask about
              <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-border bg-surface p-6 shadow-sm" data-testid="ask-answer">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-3">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
          <Sparkles className="h-3.5 w-3.5" />
          Answer
        </p>
        {grounded ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2.5 py-0.5 text-[11px] font-medium text-success">
            <ShieldCheck className="h-3 w-3" />
            Cited from source pages
          </span>
        ) : (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2.5 py-0.5 text-[11px] font-medium text-warning"
            data-testid="ask-ungrounded"
          >
            <ShieldAlert className="h-3 w-3" />
            No source citations — verify before relying on this
          </span>
        )}
      </div>

      <p className="mt-4 whitespace-pre-line text-[15px] leading-7 text-foreground" data-testid="ask-answer-text">
        {splitCitations(response.answer).map((part, index) =>
          part.kind === "text" ? (
            <span key={index}>{part.text}</span>
          ) : (
            <CiteChip key={index} n={part.n} citations={citationsByN} onSelect={selectCitation} />
          ),
        )}
      </p>

      <div className="mt-6 space-y-6">
        {response.facts.length > 0 && (
          <Block title="Facts">
            <table className="w-full text-sm">
              <thead className="bg-surface-soft">
                <tr>
                  <th className={TH}>Document</th>
                  <th className={TH}>Field</th>
                  <th className={TH}>Value</th>
                  <th className={TH}>Source</th>
                </tr>
              </thead>
              <tbody>
                {response.facts.map((fact, index) => (
                  <tr key={`${fact.document_id}:${fact.label}:${index}`} className="border-t border-border">
                    <td className={`${TD} text-text-secondary`}>{fact.document_name}</td>
                    <td className={`${TD} text-text-secondary`}>{fact.label}</td>
                    <td className={`${TD} whitespace-pre-line font-medium text-foreground`}>{fact.value}</td>
                    <td className={TD}>
                      <CiteChip n={fact.citation} citations={citationsByN} onSelect={selectCitation} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Block>
        )}

        {response.clause_matches.length > 0 && (
          <Block title="Clause matches">
            <table className="w-full text-sm">
              <thead className="bg-surface-soft">
                <tr>
                  <th className={TH}>Document</th>
                  <th className={TH}>Clause</th>
                  <th className={TH}>Title</th>
                  <th className={TH}>Status</th>
                  <th className={TH}>Source</th>
                </tr>
              </thead>
              <tbody>
                {response.clause_matches.map((match, index) => (
                  <tr key={`${match.document_id}:${match.clause_number}:${index}`} className="border-t border-border">
                    <td className={`${TD} text-text-secondary`}>{match.document_name}</td>
                    <td className={`${TD} font-id font-medium text-foreground`}>{match.clause_number}</td>
                    <td className={`${TD} text-text-secondary`}>{match.title ?? "—"}</td>
                    <td className={TD}>
                      {match.present ? (
                        <span className="inline-flex items-center gap-1 text-success">
                          <Check className="h-3.5 w-3.5" /> Present
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-text-muted">
                          <Minus className="h-3.5 w-3.5" /> Not found
                        </span>
                      )}
                    </td>
                    <td className={TD}>
                      <CiteChip n={match.citation} citations={citationsByN} onSelect={selectCitation} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Block>
        )}

        {response.obligations.length > 0 && (
          <Block title="Obligations">
            <table className="w-full text-sm">
              <thead className="bg-surface-soft">
                <tr>
                  <th className={TH}>Obligation</th>
                  <th className={TH}>Document</th>
                  <th className={TH}>Due</th>
                  <th className={TH}>Status</th>
                  <th className={TH}>Source</th>
                </tr>
              </thead>
              <tbody>
                {response.obligations.map((item, index) => (
                  <tr key={`${item.document_id}:${item.title}:${index}`} className="border-t border-border">
                    <td className={`${TD} font-medium text-foreground`}>{item.title}</td>
                    <td className={`${TD} text-text-secondary`}>{item.document_name}</td>
                    <td className={`${TD} tabular-nums text-text-secondary`}>{item.due_date ?? "—"}</td>
                    <td className={`${TD} capitalize text-text-secondary`}>{item.status.replace(/_/g, " ")}</td>
                    <td className={TD}>
                      <CiteChip n={item.citation} citations={citationsByN} onSelect={selectCitation} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Block>
        )}

        {response.passages.length > 0 && (
          <section>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-secondary">Supporting passages</p>
            <ul className="space-y-2">
              {response.passages.map((passage) => (
                <li
                  key={`${passage.document_id}:${passage.page}:${passage.citation}`}
                  className="rounded-xl border border-border bg-surface-soft/50 p-3 text-sm"
                  data-testid="ask-passage"
                >
                  <p className="flex items-center gap-1 text-xs text-text-muted">
                    <span className="truncate">{passage.document_name}</span>
                    <CiteChip n={passage.citation} citations={citationsByN} onSelect={selectCitation} />
                  </p>
                  <p className="mt-1 leading-6 text-text-secondary">
                    <Highlighted text={passage.text} terms={terms} />
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {response.citations.length > 0 && (
          <section>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-secondary">Citations</p>
            <ol className="divide-y divide-border rounded-xl border border-border">
              {response.citations.map((citation) => {
                const open = expanded.has(citation.n);
                return (
                  <li
                    key={citation.n}
                    id={citeId(citation.n)}
                    data-testid="ask-citation"
                    data-active={activeCitation === citation.n ? "true" : undefined}
                    className={[
                      "flex items-start gap-3 px-3 py-2.5 text-sm transition-colors",
                      activeCitation === citation.n ? "bg-primary-soft" : "",
                    ].join(" ")}
                  >
                    <span className="mt-0.5 inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md bg-primary-soft px-1 text-[11px] font-semibold text-primary">
                      {citation.n}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-text-muted">
                        <span className="font-medium text-text-secondary">{citation.document_name}</span>
                        {citation.page != null && <> · p. {citation.page}</>}
                      </p>
                      <button
                        type="button"
                        onClick={() => toggleSnippet(citation.n)}
                        aria-expanded={open}
                        aria-label={open ? `Collapse citation ${citation.n}` : `Expand citation ${citation.n}`}
                        className={["mt-0.5 block text-left leading-6 text-foreground", open ? "" : "line-clamp-2"].join(" ")}
                      >
                        {citation.snippet}
                      </button>
                    </div>
                    <Link
                      href={citation.href}
                      className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary hover:underline"
                    >
                      Open page
                      <ArrowUpRight className="h-3.5 w-3.5" />
                    </Link>
                  </li>
                );
              })}
            </ol>
          </section>
        )}
      </div>

      <p className="mt-5 border-t border-border/60 pt-3 text-xs text-text-muted" data-testid="ask-footer">
        Grounded in {response.documents.length} document{response.documents.length === 1 ? "" : "s"}
        {response.scope.document_name ? ` · scoped to ${response.scope.document_name}` : ""} · engine: {response.engine}
      </p>
    </section>
  );
}
