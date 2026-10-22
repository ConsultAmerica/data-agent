"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, ArrowRight, Loader2, RotateCcw, Sparkles } from "lucide-react";

import AskAnswer from "@/components/ask/ask-answer";
import SaveQueryButton from "@/components/playbook/save-query-button";
import { askQuestion, type AskResponse } from "@/lib/ask";
import { listDocuments } from "@/lib/documents";
import { listSavedQueries, type SavedQuery } from "@/lib/playbook";
import type { DocumentSummary } from "@/types/document";

/** Federal-contracting starting points; each one is answerable from
 * extracted fields, clause references, obligations or page text. */
export const PROMPT_TEMPLATES = [
  "Which contracts include DFARS 252.204-7012?",
  "Who is the contractor and what is the award amount?",
  "What obligations are due in the next 90 days?",
  "Summarize termination clauses",
  "Extract key payment and invoicing requirements",
  "Does this contract include FAR 52.204-21?",
  "When does the period of performance end?",
  "List DFARS clauses",
];

interface Turn {
  id: string;
  question: string;
  documentId: string | null;
  status: "loading" | "done" | "error";
  response?: AskResponse;
  error?: string;
}

let turnCounter = 0;

export default function AskWorkspace() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialQuery = searchParams.get("q") ?? "";
  const initialDocument = searchParams.get("document_id");

  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<string>(initialDocument ?? "");
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  // The team's saved Ask prompts from the clause playbook.
  const [teamPrompts, setTeamPrompts] = useState<SavedQuery[]>([]);
  const autoRan = useRef(false);
  const threadEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    listDocuments(200)
      .then((items) => {
        if (active) setDocuments(items);
      })
      .catch(() => {
        // The scope picker falls back to "All documents".
      });
    listSavedQueries("ask")
      .then((items) => {
        if (active) setTeamPrompts(items);
      })
      .catch(() => {
        // Saved prompts are optional; the built-in templates still show.
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (autoRan.current || !initialQuery.trim()) return;
    autoRan.current = true;
    void ask(initialQuery, initialDocument);
    // Runs once for the ?q= the page was opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    threadEnd.current?.scrollIntoView?.({ behavior: "smooth", block: "end" });
  }, [turns.length]);

  async function run(turn: Turn) {
    try {
      const response = await askQuestion(turn.question, turn.documentId);
      setTurns((current) =>
        current.map((item) => (item.id === turn.id ? { ...item, status: "done", response, error: undefined } : item)),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to answer this question.";
      setTurns((current) =>
        current.map((item) => (item.id === turn.id ? { ...item, status: "error", error: message } : item)),
      );
    }
  }

  async function ask(value: string, documentId: string | null = scope || null) {
    const question = value.trim();
    if (!question) return;
    turnCounter += 1;
    const turn: Turn = { id: `t${turnCounter}`, question, documentId, status: "loading" };
    setTurns((current) => [...current, turn]);
    setQuery("");
    const params = new URLSearchParams({ q: question });
    if (documentId) params.set("document_id", documentId);
    router.replace(`/ask?${params.toString()}`);
    await run(turn);
  }

  function retry(turn: Turn) {
    setTurns((current) => current.map((item) => (item.id === turn.id ? { ...item, status: "loading", error: undefined } : item)));
    void run(turn);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void ask(query);
  }

  const busy = turns.some((turn) => turn.status === "loading");
  const started = turns.length > 0;

  const form = (
    <form onSubmit={handleSubmit} aria-label="Ask a question">
      <div className="ai-surface rounded-[20px] p-2">
        <div className="flex flex-col gap-2 rounded-2xl bg-surface px-4 py-3 sm:flex-row sm:items-center">
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Ask about contractors, amounts, clauses, obligations, dates…"
            aria-label="Question"
            className="min-w-0 flex-1 bg-transparent py-1 text-[15px] outline-none placeholder:text-text-secondary"
          />
          <div className="flex items-center gap-2">
            <select
              value={scope}
              onChange={(event) => setScope(event.target.value)}
              aria-label="Question scope"
              className="max-w-[14rem] truncate rounded-full border border-border bg-surface-soft px-3 py-1.5 text-xs text-text-secondary"
            >
              <option value="">All documents</option>
              {initialDocument && !documents.some((doc) => doc.document_id === initialDocument) && (
                <option value={initialDocument}>This document</option>
              )}
              {documents.map((doc) => (
                <option key={doc.document_id} value={doc.document_id}>
                  {doc.original_filename}
                  {doc.status === "processing" ? " (not processed yet)" : doc.status === "failed" ? " (failed)" : ""}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={busy || !query.trim()}
              aria-label="Ask"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-white transition duration-200 hover:bg-primary-hover disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </div>
    </form>
  );

  const chips = (templates: string[], compact = false) => (
    <div className={["flex flex-wrap gap-2", compact ? "" : "justify-center"].join(" ")}>
      {templates.map((item) => (
        <button key={item} type="button" className="chip" disabled={busy} onClick={() => void ask(item)}>
          {item}
        </button>
      ))}
    </div>
  );

  const teamChips = teamPrompts.length > 0 && (
    <div data-testid="ask-team-prompts">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-secondary">
        Team prompts <span className="font-normal normal-case tracking-normal text-text-muted">· from the clause playbook</span>
      </p>
      <div className="flex flex-wrap gap-2">
        {teamPrompts.map((item) => (
          <button
            key={item.id}
            type="button"
            className="chip"
            disabled={busy}
            title={item.query}
            onClick={() => void ask(item.query)}
          >
            {item.name}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="page-container">
      <div className="mx-auto max-w-4xl">
        <div className="text-center">
          <p className="inline-flex items-center gap-2 text-sm font-medium text-primary-deep">
            <Sparkles className="h-4 w-4" />
            Ask Dataomatix
          </p>
          <h1 className="headline-editorial mt-3">What would you like to know?</h1>
          {!started && (
            <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-text-secondary">
              Answers come from your extracted fields, clause references, obligations and source pages,
              and every one cites the page it came from.
            </p>
          )}
        </div>

        {!started && (
          <div className="mt-10 space-y-5">
            {form}
            {teamChips}
            {chips(PROMPT_TEMPLATES)}
          </div>
        )}

        {started && (
          <div className="mt-10 space-y-8" aria-live="polite">
            {turns.map((turn, index) => {
              const isLast = index === turns.length - 1;
              return (
                <div key={turn.id} className="space-y-4" data-testid="ask-turn">
                  <div className="flex flex-col items-end gap-1">
                    <p className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm text-white">
                      {turn.question}
                    </p>
                    {turn.status === "done" && <SaveQueryButton kind="ask" query={turn.question} />}
                  </div>
                  {turn.status === "loading" && (
                    <div className="flex items-center gap-2 text-sm text-text-secondary" role="status">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Searching extracted data and source pages…
                    </div>
                  )}
                  {turn.status === "error" && (
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-danger/20 bg-danger/5 p-4 text-sm text-danger">
                      <span className="flex items-center gap-2">
                        <AlertCircle className="h-4 w-4 shrink-0" />
                        {turn.error}
                      </span>
                      <button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={() => retry(turn)}>
                        <RotateCcw className="h-3.5 w-3.5" />
                        Retry
                      </button>
                    </div>
                  )}
                  {turn.status === "done" && turn.response && (
                    <>
                      <AskAnswer turnId={turn.id} response={turn.response} onAsk={(item) => void ask(item)} />
                      {isLast && turn.response.answer_type !== "none" && turn.response.suggestions.length > 0 && (
                        <div>
                          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-secondary">Follow up</p>
                          {chips(turn.response.suggestions, true)}
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })}
            {teamChips}
            {chips(PROMPT_TEMPLATES.slice(0, 4), true)}
            <div ref={threadEnd} />

            {/* Only the input stays pinned; a solid bar so the thread never shows through it. */}
            <div className="sticky bottom-0 z-10 -mx-2 bg-[var(--color-page)] px-2 pb-4 pt-3">
              <div className="pointer-events-none absolute inset-x-0 -top-6 h-6 bg-gradient-to-t from-[var(--color-page)] to-transparent" aria-hidden="true" />
              {form}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
