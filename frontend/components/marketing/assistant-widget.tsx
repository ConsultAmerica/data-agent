"use client";

import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { ArrowRight, FileSearch, MessageSquareText, Sparkles, X } from "lucide-react";

const DISMISSED_KEY = "da-assistant-dismissed";

const QUICK_QUESTIONS = [
  "Which contracts include DFARS 252.204-7012?",
  "What obligations are due in the next 90 days?",
];

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function subscribeToStorage(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

/** Floating "Ask Dataomatix" helper on marketing pages: a pill that opens a
 * small card; questions go to /ask. Dismissal is remembered per browser. */
export default function AssistantWidget() {
  const router = useRouter();
  // Hidden on the server render; the browser's stored choice decides after hydration.
  const storedDismissed = useSyncExternalStore(subscribeToStorage, readDismissed, () => true);
  const [dismissedNow, setDismissedNow] = useState(false);
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const dismissed = storedDismissed || dismissedNow;

  function dismiss() {
    setDismissedNow(true);
    try {
      window.localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // blocked storage: hidden for this visit only
    }
  }

  function ask(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    router.push(`/ask?q=${encodeURIComponent(trimmed)}`);
  }

  if (dismissed) return null;

  if (!open) {
    return (
      <div className="assistant-widget">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="assistant-pill"
          aria-expanded={false}
          aria-label="Ask Dataomatix"
        >
          <Sparkles className="h-4 w-4" />
          <span className="hidden sm:inline">Ask Dataomatix</span>
        </button>
      </div>
    );
  }

  return (
    <div className="assistant-widget">
      <section className="assistant-card" aria-label="Ask Dataomatix">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-[var(--text-dark)]">Ask Dataomatix</p>
            <p className="text-xs text-[var(--text-muted)]">Answers cite the source page</p>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md px-1.5 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-soft)] hover:text-[var(--text-dark)]"
              aria-label="Minimize assistant"
            >
              —
            </button>
            <button
              type="button"
              onClick={dismiss}
              className="rounded-md p-1 text-[var(--text-muted)] hover:bg-[var(--surface-soft)] hover:text-[var(--text-dark)]"
              aria-label="Close assistant"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <p className="mt-3 text-[13px] leading-5 text-[var(--text-secondary)]">
          Ask about contractors, clauses, obligations or dates in the documents you&apos;ve
          processed, or start with the sample contract.
        </p>

        <div className="mt-3 space-y-1.5">
          <button type="button" onClick={() => router.push("/sample")} className="assistant-quick">
            <FileSearch className="h-3.5 w-3.5 shrink-0" />
            Open the sample contract
          </button>
          {QUICK_QUESTIONS.map((item) => (
            <button key={item} type="button" onClick={() => ask(item)} className="assistant-quick">
              <MessageSquareText className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{item}</span>
            </button>
          ))}
        </div>

        <form
          className="mt-3 flex items-center gap-2 rounded-xl border border-[var(--border)] bg-white px-3 py-2"
          onSubmit={(event) => {
            event.preventDefault();
            ask(question);
          }}
        >
          <input
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Ask a question"
            aria-label="Ask Dataomatix a question"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--text-muted)]"
          />
          <button
            type="submit"
            aria-label="Ask"
            disabled={!question.trim()}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--primary)] text-white disabled:opacity-40"
          >
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </form>
      </section>
    </div>
  );
}
