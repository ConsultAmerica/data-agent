"use client";

import { ArrowRight, Check, Pencil, Search, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import {
  displayGroupLabel,
  filterTargets,
  groupTargets,
} from "@/lib/target-groups";
import type { DocumentTarget, TargetType } from "@/types/document";
import { humanizeExample, humanizeMethod } from "@/lib/method-labels";

export interface CustomQuickPick {
  key: string;
  label: string;
  prompt: string;
}

interface TargetPickerProps {
  targets: DocumentTarget[];
  customQuickPicks: CustomQuickPick[];
  selectedIds: Set<string>;
  disabled?: boolean;
  onToggle: (targetId: string) => void;
  onToggleGroup: (targetIds: string[]) => void;
  onSelectAll: (targetType: TargetType) => void;
  onSelectAllVisible: (targetIds: string[]) => void;
  onClear: () => void;
  onSelectCustom: (pick: CustomQuickPick) => void;
  onAddCustomField?: (label: string) => Promise<DocumentTarget | undefined>;
  onRenameCustomField?: (targetKey: string, label: string) => Promise<void>;
  onDeleteCustomField?: (targetKey: string) => Promise<void>;
  /** The document's page: its text, section by section, when nothing here
   * is pickable (a letter, a résumé without fields or tables). */
  documentHref?: string;
}

function confidenceLabel(target: DocumentTarget): string {
  const pct = Math.round(target.confidence * 100);
  const page = target.page_numbers[0];
  const method = target.discovery_method ? ` · ${humanizeMethod(target.discovery_method)}` : "";
  const pagePart = page ? ` · page ${page}` : "";
  return `${pct}% confidence${pagePart}${method}`;
}

export default function TargetPicker({
  targets,
  customQuickPicks,
  selectedIds,
  disabled = false,
  onToggle,
  onToggleGroup,
  onSelectAll,
  onSelectAllVisible,
  onClear,
  onSelectCustom,
  onAddCustomField,
  onRenameCustomField,
  onDeleteCustomField,
  documentHref,
}: TargetPickerProps) {
  const [query, setQuery] = useState("");
  const [newFieldLabel, setNewFieldLabel] = useState("");
  const [addingField, setAddingField] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState("");

  async function submitNewField() {
    if (!newFieldLabel.trim() || !onAddCustomField) return;
    setAddingField(true);
    try {
      await onAddCustomField(newFieldLabel.trim());
      setNewFieldLabel("");
    } finally {
      setAddingField(false);
    }
  }

  function startEditing(target: DocumentTarget) {
    setEditingKey(target.key);
    setEditingLabel(target.label);
  }

  async function submitRename(targetKey: string) {
    if (!editingLabel.trim() || !onRenameCustomField) return;
    await onRenameCustomField(targetKey, editingLabel.trim());
    setEditingKey(null);
  }

  const visibleTargets = useMemo(
    () =>
      targets.filter((target) => {
        const isInternal = (name: string) => {
          if (!name.trim()) return true;
          const stripped = name.trim();
          if (stripped.startsWith("#")) return true;
          if (
            /^(TextField|CheckBox|RadioButton|Page\d+|PG\d+[A-Z]*)$/i.test(
              stripped,
            )
          ) {
            return true;
          }
          let signals = 0;
          if (/topmostSubform|\bsubform\b|\bxfa\b|\bform\d+\b/i.test(stripped)) {
            signals += 2;
          }
          if (/\bPage\d+\b|\bPG\d+[A-Z]*\b/i.test(stripped)) signals += 1;
          if (/\[\d+\]/.test(stripped)) signals += 1;
          if (/TextField\d*|CheckBox\d*|RadioButton\d*/i.test(stripped)) {
            signals += 1;
          }
          return signals >= 2;
        };
        return !isInternal(target.label) && !isInternal(target.key);
      }),
    [targets],
  );

  const filtered = useMemo(
    () => filterTargets(visibleTargets, query),
    [visibleTargets, query],
  );
  const grouped = useMemo(() => groupTargets(filtered), [filtered]);
  const hasAnyDetected = visibleTargets.length > 0;
  const fieldCount = visibleTargets.filter((t) => t.target_type === "field").length;
  const tableCount = visibleTargets.filter((t) => t.target_type === "table").length;

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border bg-surface-soft px-3">
        <Search className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
        <input
          type="search"
          value={query}
          disabled={disabled}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search this document’s schema..."
          aria-label="Search schema fields"
          className="flex-1 bg-transparent py-3 text-sm text-foreground outline-none placeholder:text-text-muted disabled:opacity-50"
        />
        {hasAnyDetected && (
          <span className="shrink-0 text-[11px] font-medium text-text-muted">
            {visibleTargets.length} detected
          </span>
        )}
      </div>

      <div className="max-h-80 overflow-y-auto p-2">
        {hasAnyDetected &&
          Array.from(grouped.entries()).map(([groupKey, groupTargetsList]) => {
            const groupIds = groupTargetsList.map((target) => target.id);
            const allGroupSelected = groupIds.every((id) =>
              selectedIds.has(id),
            );
            return (
            <section key={groupKey} className="mb-1">
              <div className="flex items-center justify-between px-2 py-1.5">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                  {displayGroupLabel(groupKey)}
                </p>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onToggleGroup(groupIds)}
                  className="text-[11px] font-medium text-primary transition hover:underline disabled:opacity-40"
                >
                  {allGroupSelected ? "Deselect all" : "Select all"}
                </button>
              </div>
              {groupTargetsList.map((target) => {
                const selected = selectedIds.has(target.id);
                const isCustom = target.source === "custom";
                const isEditing = editingKey === target.key;

                if (isEditing) {
                  return (
                    <div
                      key={target.id}
                      className="flex items-center gap-2 rounded-lg px-2 py-2"
                    >
                      <input
                        type="text"
                        autoFocus
                        value={editingLabel}
                        onChange={(event) =>
                          setEditingLabel(event.target.value)
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            void submitRename(target.key);
                          }
                          if (event.key === "Escape") {
                            setEditingKey(null);
                          }
                        }}
                        className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-foreground outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => void submitRename(target.key)}
                        className="rounded-lg p-1.5 text-primary hover:bg-primary/8"
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingKey(null)}
                        className="rounded-lg p-1.5 text-text-muted hover:bg-surface-soft"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  );
                }

                return (
                  <div
                    key={target.id}
                    className={[
                      "group flex w-full items-center gap-1 rounded-lg transition",
                      selected
                        ? "bg-primary/8 hover:bg-primary/12"
                        : "hover:bg-surface-soft",
                    ].join(" ")}
                  >
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={selected}
                      aria-label={target.label}
                      disabled={disabled}
                      onClick={() => onToggle(target.id)}
                      className="flex min-w-0 flex-1 items-center gap-3 px-2 py-2 text-left disabled:opacity-50"
                    >
                      <span
                        className={[
                          "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                          selected
                            ? "border-primary bg-primary"
                            : "border-border bg-surface",
                        ].join(" ")}
                        aria-hidden="true"
                      >
                        {selected && <Check className="h-3 w-3 text-white" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">
                          {target.label}
                        </span>
                        <span className="flex items-center gap-1 text-xs text-text-secondary">
                          <span className="inline-block h-1.5 w-1.5 rounded-full bg-success" />
                          {confidenceLabel(target)}
                        </span>
                        {target.source_examples[0] && (
                          <span className="mt-0.5 line-clamp-1 text-[11px] text-text-muted">
                            {humanizeExample(target.source_examples[0])}
                          </span>
                        )}
                      </span>
                    </button>
                    {isCustom && onRenameCustomField && (
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => startEditing(target)}
                        className="shrink-0 rounded-lg p-1.5 text-text-muted opacity-0 transition hover:bg-surface-soft hover:text-foreground group-hover:opacity-100 disabled:opacity-0"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {isCustom && onDeleteCustomField && (
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => onDeleteCustomField(target.key)}
                        className="mr-1 shrink-0 rounded-lg p-1.5 text-text-muted opacity-0 transition hover:bg-danger/8 hover:text-danger group-hover:opacity-100 disabled:opacity-0"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </section>
            );
          })}

        {!hasAnyDetected && (
          <div className="px-2 py-6 text-center text-sm text-text-secondary">
            <p>
              No fields or tables were found to pick — this document is mostly running text.
              {documentHref ? " Its text is ready to read and export, section by section." : ""} You can also
              describe what you need as a custom instruction below.
            </p>
            {documentHref && (
              <Link
                href={documentHref}
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-foreground hover:border-primary/40 hover:text-primary"
              >
                Open document text
                <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            )}
          </div>
        )}

        {hasAnyDetected && filtered.length === 0 && (
          <p className="px-2 py-6 text-center text-sm text-text-secondary">
            No detected items match &ldquo;{query}&rdquo;.
          </p>
        )}

        <section className="mt-1 border-t border-border pt-2">
          <p className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Custom
          </p>
          <div className="flex flex-wrap gap-2 px-2 pb-1">
            {customQuickPicks.map((pick) => (
              <button
                key={pick.key}
                type="button"
                disabled={disabled}
                onClick={() => onSelectCustom(pick)}
                className="rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-medium text-text-secondary transition hover:border-accent/40 hover:bg-accent/5 hover:text-accent disabled:opacity-50"
              >
                {pick.label}
              </button>
            ))}
          </div>
          {onAddCustomField && (
            <div className="mt-1 flex items-center gap-2 px-2 pb-1">
              <input
                type="text"
                value={newFieldLabel}
                disabled={disabled || addingField}
                onChange={(event) => setNewFieldLabel(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submitNewField();
                }}
                placeholder="Add a custom field (e.g. Renewal Option Date)"
                className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-foreground outline-none placeholder:text-text-muted disabled:opacity-50"
              />
              <button
                type="button"
                disabled={disabled || addingField || !newFieldLabel.trim()}
                onClick={() => void submitNewField()}
                className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-surface-soft disabled:cursor-not-allowed disabled:opacity-40"
              >
                {addingField ? "Adding…" : "Add"}
              </button>
            </div>
          )}
        </section>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border p-3" role="toolbar" aria-label="Schema selection">
        <button
          type="button"
          disabled={disabled || selectedIds.size === 0}
          onClick={onClear}
          className="rounded-lg px-3 py-1.5 text-xs font-medium text-text-muted transition hover:text-foreground disabled:opacity-40"
        >
          Clear selection
        </button>
        <button
          type="button"
          disabled={disabled || filtered.length === 0}
          onClick={() => onSelectAllVisible(filtered.map((t) => t.id))}
          className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-surface-soft disabled:opacity-40"
        >
          {selectedIds.size === filtered.length && filtered.length > 0
            ? `All ${filtered.length} selected`
            : `Select all ${filtered.length || ""}`.trim()}
        </button>
        <div className="flex-1" />
        <span className="text-xs text-text-muted" aria-live="polite">
          {selectedIds.size} selected
        </span>
      </div>
    </div>
  );
}
