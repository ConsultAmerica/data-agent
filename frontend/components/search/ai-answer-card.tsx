"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ChevronDown, Loader2, Sparkles } from "lucide-react";

import { askQuestion, splitCitations, type AskResponse } from "@/lib/ask";

/** Ask Dataomatix's cited answer for the same query, above the results. */
export default function AiAnswerCard({ query }: { query: string }) {
  const [outcome, setOutcome] = useState<{ query: string; response: AskResponse | null; error: string }>({
    query: "",
    response: null,
    error: "",
  });
  const [open, setOpen] = useState(true);
  const loading = outcome.query !== query;
  const response = loading ? null : outcome.response;
  const error = loading ? "" : outcome.error;

  useEffect(() => {
    let active = true;
    askQuestion(query)
      .then((result) => active && setOutcome({ query, response: result, error: "" }))
      .catch(
        (err: unknown) =>
          active && setOutcome({ query, response: null, error: err instanceof Error ? err.message : "No answer available." }),
      );
    return () => {
      active = false;
    };
  }, [query]);

  if (!loading && (error || !response || response.answer_type === "none")) return null;

  const citations = new Map((response?.citations ?? []).map((citation) => [citation.n, citation]));

  return (
    <section className="editorial-card overflow-hidden" aria-label="AI answer">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-5 py-3 text-left"
      >
        <Sparkles className="h-4 w-4 text-primary" />
        <span className="text-xs font-semibold uppercase tracking-wider text-primary">
          Answer from Ask Dataomatix · cited
        </span>
        <ChevronDown className={`ml-auto h-4 w-4 text-text-muted transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && (
        <div className="border-t border-border px-5 py-4">
          {loading ? (
            <p className="flex items-center gap-2 text-sm text-text-secondary">
              <Loader2 className="h-4 w-4 animate-spin" />
              Reading the extracted data and page text…
            </p>
          ) : (
            response && (
              <>
                <p className="text-[15px] leading-7 text-foreground">
                  {splitCitations(response.answer).map((part, index) => {
                    if (part.kind === "text") return <span key={index}>{part.text}</span>;
                    const citation = citations.get(part.n);
                    return citation ? (
                      <Link
                        key={index}
                        href={citation.href}
                        aria-label={`Citation ${part.n}`}
                        title={`${citation.document_name}${citation.page ? ` · p. ${citation.page}` : ""}`}
                        className="mx-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-md bg-primary/10 px-1 align-super text-[10px] font-semibold text-primary hover:bg-primary/20"
                      >
                        {part.n}
                      </Link>
                    ) : null;
                  })}
                </p>
                <Link href={`/ask?q=${encodeURIComponent(query)}`} className="mt-3 inline-block text-xs font-medium text-primary hover:underline">
                  Continue in Ask Dataomatix →
                </Link>
              </>
            )
          )}
        </div>
      )}
    </section>
  );
}
