"use client";

import Link from "next/link";
import { useState } from "react";
import { BookmarkPlus, Check } from "lucide-react";

import { createSavedQuery, type SavedQueryKind } from "@/lib/playbook";

/** Saves a question to the team's clause playbook (named after the question;
 * it can be renamed there). */
export default function SaveQueryButton({
  kind,
  query,
  className = "",
}: {
  kind: SavedQueryKind;
  query: string;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");
  const text = query.trim();
  if (!text) return null;

  async function save() {
    setState("saving");
    setError("");
    try {
      const name = text.length > 80 ? `${text.slice(0, 77)}…` : text;
      await createSavedQuery({ name, kind, query: text });
      setState("saved");
    } catch (err) {
      setState("error");
      setError(err instanceof Error ? err.message : "Couldn't save to the playbook.");
    }
  }

  if (state === "saved") {
    return (
      <span className={`inline-flex items-center gap-1 text-xs text-success ${className}`} role="status">
        <Check className="h-3.5 w-3.5" aria-hidden="true" />
        Saved to{" "}
        <Link href="/playbook#saved-queries" className="font-medium underline">
          playbook
        </Link>
      </span>
    );
  }

  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <button
        type="button"
        onClick={() => void save()}
        disabled={state === "saving"}
        className="inline-flex items-center gap-1 text-xs font-medium text-text-secondary hover:text-primary disabled:opacity-50"
        title="Save this query to the clause playbook so your team can reuse it"
      >
        <BookmarkPlus className="h-3.5 w-3.5" aria-hidden="true" />
        {state === "saving" ? "Saving…" : "Save to playbook"}
      </button>
      {state === "error" && <span className="text-xs text-danger">{error}</span>}
    </span>
  );
}
