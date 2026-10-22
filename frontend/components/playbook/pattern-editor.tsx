"use client";

import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import { patternError, type PlaybookPattern, type PlaybookPatternKind } from "@/lib/playbook";

const FIELD = "w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-foreground";
const MAX_PATTERNS = 10;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether a pattern matches sample text, the way the backend matches page
 * text: phrases as whole words ignoring case and spacing, regexes ignoring
 * case. */
function matchesSample(pattern: PlaybookPattern, sample: string): boolean {
  if (!sample.trim() || patternError(pattern)) return false;
  try {
    if (pattern.kind === "regex") return new RegExp(pattern.pattern.trim(), "i").test(sample);
    const words = pattern.pattern.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
    return new RegExp(`(?<!\\w)${words}(?!\\w)`, "i").test(sample);
  } catch {
    return false;
  }
}

/** The rule's AI extraction patterns: phrases or regexes looked for in page
 * text when the clause is not cited. Each row validates as you type; the
 * sample box shows which patterns would fire. */
export default function PatternEditor({
  patterns,
  onSave,
}: {
  patterns: PlaybookPattern[];
  onSave: (patterns: PlaybookPattern[]) => Promise<void>;
}) {
  const [draft, setDraft] = useState<PlaybookPattern[]>(patterns);
  const [sample, setSample] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const errors = useMemo(() => draft.map((item) => patternError(item)), [draft]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(patterns);
  const invalid = errors.some(Boolean);

  function update(index: number, changes: Partial<PlaybookPattern>) {
    setSaved(false);
    setDraft((current) => current.map((item, position) => (position === index ? { ...item, ...changes } : item)));
  }

  async function save() {
    setBusy(true);
    setError("");
    try {
      await onSave(draft.map((item) => ({ ...item, pattern: item.pattern.trim(), note: item.note.trim() })));
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The patterns could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4" data-testid="pattern-editor">
      <p className="text-xs leading-5 text-text-secondary">
        When a document does not cite this clause, Dataomatix looks for these phrases or regular expressions in its page
        text. A match is reported as “Text match — confirm citation”, never as satisfied.
      </p>
      {draft.length === 0 ? (
        <p className="rounded-lg bg-surface-soft px-3 py-4 text-center text-sm text-text-secondary">
          No extraction patterns. Only cited clause numbers are checked.
        </p>
      ) : (
        <ul className="space-y-3" role="list">
          {draft.map((item, index) => {
            const problem = errors[index];
            const hit = matchesSample(item, sample);
            return (
              <li key={index} className="rounded-lg border border-border p-3">
                <div className="grid gap-2 sm:grid-cols-[7rem_1fr_auto]">
                  <select
                    value={item.kind}
                    aria-label={`Pattern ${index + 1} kind`}
                    onChange={(event) => update(index, { kind: event.target.value as PlaybookPatternKind })}
                    className={FIELD}
                  >
                    <option value="phrase">Phrase</option>
                    <option value="regex">Regex</option>
                  </select>
                  <input
                    value={item.pattern}
                    aria-label={`Pattern ${index + 1}`}
                    aria-invalid={problem ? true : undefined}
                    onChange={(event) => update(index, { pattern: event.target.value })}
                    placeholder={item.kind === "regex" ? "subcontracting\\s+plan" : "Small Business Subcontracting Plan"}
                    className={`${FIELD} font-id ${problem ? "border-danger" : ""}`}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setSaved(false);
                      setDraft((current) => current.filter((_, position) => position !== index));
                    }}
                    aria-label={`Remove pattern ${index + 1}`}
                    className="inline-flex items-center justify-center rounded-lg border border-border px-2 text-text-secondary hover:text-danger"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
                <input
                  value={item.note}
                  aria-label={`Pattern ${index + 1} note`}
                  onChange={(event) => update(index, { note: event.target.value })}
                  placeholder="Note (why this pattern indicates the clause)"
                  maxLength={300}
                  className={`${FIELD} mt-2 text-xs`}
                />
                <p className={`mt-1.5 text-xs ${problem ? "text-danger" : "text-success"}`} role={problem ? "alert" : undefined}>
                  {problem ?? (item.kind === "regex" ? "Valid regular expression." : "Valid phrase.")}
                  {!problem && sample.trim() && (
                    <span className={hit ? "ml-1.5 font-medium text-primary" : "ml-1.5 text-text-muted"}>
                      {hit ? "Matches the sample." : "No match in the sample."}
                    </span>
                  )}
                </p>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={draft.length >= MAX_PATTERNS}
          onClick={() => {
            setSaved(false);
            setDraft((current) => [...current, { kind: "phrase", pattern: "", note: "" }]);
          }}
          className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-sm text-text-secondary hover:text-foreground disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Add pattern
        </button>
        <button type="button" disabled={!dirty || invalid || busy} onClick={save} className="btn-primary disabled:opacity-50">
          {busy ? "Saving…" : "Save patterns"}
        </button>
        {saved && !dirty && <span className="text-xs text-success">Saved.</span>}
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      <label className="block text-xs text-text-secondary">
        Test against sample text
        <textarea
          value={sample}
          onChange={(event) => setSample(event.target.value)}
          rows={3}
          placeholder="Paste a passage from a contract to see which patterns match."
          className={`${FIELD} mt-1`}
        />
      </label>
    </div>
  );
}
