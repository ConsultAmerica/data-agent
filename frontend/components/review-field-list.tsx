"use client";

import { useEffect, useRef, useState } from "react";
import {
  CheckCheck,
  Clock,
  ExternalLink,
  FileSearch,
  HelpCircle,
  MoreHorizontal,
  Pencil,
  X,
} from "lucide-react";

import ConfidenceBadge from "@/components/confidence-badge";
import ClickableFieldValue from "@/components/clickable-field-value";
import StatusBadge from "@/components/status-badge";
import { getFieldAuditLog, getFieldAuditLogById } from "@/lib/documents";
import type {
  FieldAuditEntry,
  MetadataField,
  ReviewAction,
} from "@/types/document";

interface ReviewFieldListProps {
  documentId: string;
  fields: MetadataField[];
  activeFieldId: number | null;
  onSelectField: (field: MetadataField) => void;
  onReviewField: (
    field: MetadataField,
    action: ReviewAction,
    value?: string,
  ) => Promise<void> | void;
  onAcceptAll: () => void;
  reviewingFieldId: number | null;
  acceptingAll: boolean;
}

function fieldRowKey(field: MetadataField, index: number): string {
  if (field.id != null) return `meta-${field.id}`;
  return `${field.field_key}-${index}`;
}

function sourceLabel(source: string | undefined): string | null {
  if (!source) return null;
  const labels: Record<string, string> = {
    contract: "Contract analysis",
    target: "Target extraction",
    v3: "All fields (V3)",
  };
  return labels[source] ?? source;
}

const GROUP_ORDER = [
  "Identification",
  "Parties",
  "Dates",
  "Financial",
  "Legal",
  "Commercial",
  "Compliance",
];

const ACTION_LABELS: Record<ReviewAction, string> = {
  accept: "Accepted",
  edit: "Edited",
  reject: "Rejected",
  mark_unknown: "Marked Unknown",
};

export default function ReviewFieldList({
  documentId,
  fields,
  activeFieldId,
  onSelectField,
  onReviewField,
  onAcceptAll,
  reviewingFieldId,
  acceptingAll,
}: ReviewFieldListProps) {
  const groups = new Map<string, MetadataField[]>();

  for (const field of fields) {
    const existing = groups.get(field.field_group) ?? [];
    existing.push(field);
    groups.set(field.field_group, existing);
  }

  const orderedGroups = [
    ...GROUP_ORDER.filter((group) => groups.has(group)),
    ...[...groups.keys()].filter(
      (group) => !GROUP_ORDER.includes(group),
    ),
  ];

  const allReviewed =
    fields.length > 0 &&
    fields.every((field) => field.review_status !== "pending");

  const pendingCount = fields.filter((field) => field.review_status === "pending").length;
  const reviewedCount = fields.length - pendingCount;

  return (
    <div className="flex h-full flex-col" data-testid="metadata-review-list">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border/80 bg-surface px-6 py-4">
        <div>
          <p className="text-sm font-medium text-foreground">Metadata review</p>
          <p className="mt-0.5 text-xs text-text-secondary" aria-live="polite">
            {fields.length === 0
              ? "No metadata fields to review"
              : `${reviewedCount} of ${fields.length} reviewed · ${pendingCount} pending`}
          </p>
          <p className="mt-1 text-[11px] text-text-muted">
            Metadata Accepted is not the same as Staging Verified.
          </p>
        </div>

        <button
          type="button"
          onClick={onAcceptAll}
          disabled={acceptingAll || allReviewed || pendingCount === 0}
          className="btn-primary px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-60"
        >
          <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
          {allReviewed ? "All reviewed" : "Accept all pending"}
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        <table className="w-full min-w-[720px] border-collapse text-left text-sm">
          <thead className="sticky top-0 z-10 bg-surface-soft text-xs font-medium uppercase tracking-wide text-text-secondary">
            <tr>
              <th className="px-4 py-2 font-semibold">Field</th>
              <th className="px-4 py-2 font-semibold">Extracted</th>
              <th className="px-4 py-2 font-semibold">Effective</th>
              <th className="px-4 py-2 font-semibold">Confidence</th>
              <th className="px-4 py-2 font-semibold">Status</th>
              <th className="w-10 px-4 py-2 font-semibold" />
            </tr>
          </thead>

          <tbody>
            {orderedGroups.map((group) => (
              <FieldGroupRows
                key={group}
                documentId={documentId}
                group={group}
                fields={groups.get(group)!}
                activeFieldId={activeFieldId}
                reviewingFieldId={reviewingFieldId}
                onSelectField={onSelectField}
                onReviewField={onReviewField}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FieldGroupRows({
  documentId,
  group,
  fields,
  activeFieldId,
  reviewingFieldId,
  onSelectField,
  onReviewField,
}: {
  documentId: string;
  group: string;
  fields: MetadataField[];
  activeFieldId: number | null;
  reviewingFieldId: number | null;
  onSelectField: (field: MetadataField) => void;
  onReviewField: (
    field: MetadataField,
    action: ReviewAction,
    value?: string,
  ) => Promise<void> | void;
}) {
  return (
    <>
      <tr>
        <th
          colSpan={6}
          className="border-t border-border bg-surface-soft px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-text-secondary"
        >
          {group}
        </th>
      </tr>

      {fields.map((field, index) => (
        <FieldRow
          key={fieldRowKey(field, index)}
          documentId={documentId}
          field={field}
          active={field.id != null && field.id === activeFieldId}
          busy={field.id != null && field.id === reviewingFieldId}
          onSelect={() => onSelectField(field)}
          onReview={onReviewField}
        />
      ))}
    </>
  );
}

function FieldRow({
  documentId,
  field,
  active,
  busy,
  onSelect,
  onReview,
}: {
  documentId: string;
  field: MetadataField;
  active: boolean;
  busy: boolean;
  onSelect: () => void;
  onReview: (
    field: MetadataField,
    action: ReviewAction,
    value?: string,
  ) => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftValue, setDraftValue] = useState(field.value);
  const [saveError, setSaveError] = useState("");
  const [saveNotice, setSaveNotice] = useState("");
  const editInputRef = useRef<HTMLInputElement | null>(null);

  const [showSource, setShowSource] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<
    FieldAuditEntry[] | null
  >(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const extracted =
    (field.extracted_value && String(field.extracted_value)) ||
    field.original_value ||
    field.value;
  const hasEvidence = Boolean(
    field.evidence?.source_text?.trim() ||
      (field.evidence?.page_number != null && field.evidence.page_number > 0),
  );

  useEffect(() => {
    if (!editing) return;
    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [editing]);

  async function toggleHistory() {
    if (showHistory) {
      setShowHistory(false);
      return;
    }

    setShowHistory(true);

    if (history === null) {
      setHistoryLoading(true);

      try {
        const entries =
          field.id != null
            ? await getFieldAuditLogById(documentId, field.id)
            : await getFieldAuditLog(documentId, field.field_key);
        setHistory(entries);
      } catch {
        setHistory([]);
      } finally {
        setHistoryLoading(false);
      }
    }
  }

  async function submitEdit() {
    if (!draftValue.trim()) {
      setSaveError("A corrected value is required.");
      return;
    }
    setSaveError("");
    try {
      await onReview(field, "edit", draftValue.trim());
      setEditing(false);
      setHistory(null);
      setSaveNotice("Correction saved");
      window.setTimeout(() => setSaveNotice(""), 2500);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Could not save correction.");
    }
  }

  async function runAction(action: ReviewAction) {
    setSaveError("");
    try {
      await onReview(field, action);
      setHistory(null);
      setSaveNotice(ACTION_LABELS[action]);
      window.setTimeout(() => setSaveNotice(""), 2500);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Review action failed.");
    }
  }

  const extractionLabel = sourceLabel(field.extraction_source);

  return (
    <>
      <tr
        onClick={onSelect}
        className={[
          "cursor-pointer border-t border-border/70 align-top transition duration-200",
          active ? "field-row-selected" : "bg-surface hover:bg-[var(--row-hover)]",
        ].join(" ")}
      >
        <td className="px-5 py-4 text-sm text-text-secondary">
          <span className="font-medium text-foreground">{field.label}</span>
          {extractionLabel && (
            <span className="mt-0.5 block text-[11px] text-text-muted">
              Source: {extractionLabel}
              {field.id != null ? ` · #${field.id}` : ""}
            </span>
          )}
          {!extractionLabel && field.id != null && (
            <span className="mt-0.5 block text-[11px] text-text-muted">
              Field #{field.id}
            </span>
          )}
          {saveNotice && (
            <span className="mt-1 block text-[11px] font-medium text-success" role="status">
              {saveNotice}
            </span>
          )}
          {saveError && (
            <span className="mt-1 block text-[11px] font-medium text-danger" role="alert">
              {saveError}
            </span>
          )}
        </td>

        <td className="px-5 py-4 text-sm text-text-secondary">
          <span className="line-clamp-3 whitespace-pre-wrap break-words">{extracted || "—"}</span>
        </td>

        <td className="px-5 py-4">
          {editing ? (
            <div
              onClick={(event) => event.stopPropagation()}
              className="flex flex-wrap items-center gap-1.5"
            >
              <input
                ref={editInputRef}
                type="text"
                value={draftValue}
                onChange={(event) => setDraftValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submitEdit();
                  if (event.key === "Escape") {
                    setEditing(false);
                    setDraftValue(field.value);
                    setSaveError("");
                  }
                }}
                aria-label={`Corrected value for ${field.label}`}
                className="min-w-0 flex-1 rounded-lg border border-border px-2 py-1 text-xs outline-none focus:border-primary/30"
                autoFocus
              />

              <button
                type="button"
                onClick={() => void submitEdit()}
                disabled={busy}
                className="rounded-lg bg-primary px-2 py-1 text-xs font-medium text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
              >
                Save
              </button>

              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setDraftValue(field.value);
                  setSaveError("");
                }}
                className="rounded-lg border border-border px-2 py-1 text-xs text-text-secondary hover:bg-surface-soft"
              >
                Cancel
              </button>
            </div>
          ) : (
            <ClickableFieldValue
              fieldKey={field.field_key}
              fieldLabel={field.label}
              value={field.value}
            />
          )}
        </td>

        <td className="px-4 py-2.5">
          {typeof field.confidence === "number" && field.confidence > 0 ? (
            <ConfidenceBadge confidence={field.confidence} />
          ) : (
            <span className="text-xs text-text-muted">—</span>
          )}
        </td>

        <td className="px-4 py-2.5">
          <StatusBadge kind="field" status={field.review_status} size="sm" />
        </td>

        <td className="px-4 py-2.5">
          {!editing && (
            <div
              onClick={(event) => event.stopPropagation()}
              className="flex items-center justify-end gap-2"
            >
              {field.review_status === "pending" && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void runAction("accept")}
                  className="rounded-md bg-primary px-2 py-1 text-[11px] font-semibold text-white hover:bg-primary-hover disabled:opacity-60"
                >
                  Accept
                </button>
              )}
              <FieldActionsMenu
                busy={busy}
                onEdit={() => {
                  setEditing(true);
                  setDraftValue(field.value);
                  setSaveError("");
                  requestAnimationFrame(() => editInputRef.current?.focus());
                }}
                onReject={() => void runAction("reject")}
                onMarkUnknown={() => void runAction("mark_unknown")}
                onToggleSource={() => setShowSource((current) => !current)}
                onToggleHistory={toggleHistory}
              />
            </div>
          )}
        </td>
      </tr>

      {showSource && (
        <tr className="border-t border-border bg-surface-soft/60">
          <td colSpan={6} className="px-4 py-2.5">
            <div className="space-y-2 rounded-lg border border-border bg-surface p-2.5 text-xs">
              {hasEvidence ? (
                <>
                  <div className="flex flex-wrap items-center gap-3 text-text-secondary">
                    {field.evidence.page_number > 0 && (
                      <span>
                        Page{" "}
                        <span className="font-medium text-foreground">{field.evidence.page_number}</span>
                      </span>
                    )}
                    {field.evidence.section && (
                      <span>
                        Section{" "}
                        <span className="font-medium text-foreground">{field.evidence.section}</span>
                      </span>
                    )}
                    {field.evidence.source_reference && (
                      <span className="text-text-muted">{field.evidence.source_reference}</span>
                    )}
                  </div>
                  {field.evidence.source_text?.trim() ? (
                    <p className="rounded-md bg-surface-soft p-2 italic text-foreground">
                      &ldquo;{field.evidence.source_text}&rdquo;
                    </p>
                  ) : (
                    <p className="text-text-muted">No source text snippet is available for this field.</p>
                  )}
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelect();
                    }}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
                  >
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    Open source evidence
                  </button>
                </>
              ) : (
                <p className="text-text-muted">
                  Source evidence is unavailable for this field. The extracted value is still shown above.
                </p>
              )}
            </div>
          </td>
        </tr>
      )}

      {showHistory && (
        <tr className="border-t border-border bg-surface-soft/60">
          <td colSpan={6} className="px-4 py-2.5">
            <div className="space-y-2 rounded-lg border border-border bg-surface p-2.5 text-xs">
              <div>
                <span className="text-text-muted">Machine extracted</span>
                <p className="font-medium text-foreground">{extracted || "—"}</p>
              </div>

              {historyLoading && (
                <p className="text-text-muted">Loading history…</p>
              )}

              {!historyLoading &&
                history !== null &&
                history.length === 0 && (
                  <p className="text-text-muted">
                    No reviewer actions yet.
                  </p>
                )}

              {!historyLoading &&
                history?.map((entry, index) => (
                  <div
                    key={index}
                    className="border-t border-border pt-2"
                  >
                    <span className="text-text-muted">
                      Reviewer{" "}
                      {ACTION_LABELS[entry.action].toLowerCase()}
                      {entry.new_value &&
                      entry.new_value !== entry.previous_value
                        ? ":"
                        : ""}
                    </span>

                    {entry.new_value &&
                      entry.new_value !== entry.previous_value && (
                        <p className="font-medium text-foreground">
                          {entry.new_value}
                        </p>
                      )}

                    <p className="mt-1 text-text-secondary">
                      Changed by: {entry.changed_by}
                    </p>
                    <p className="text-text-muted">
                      {new Date(entry.changed_at).toLocaleString()}
                    </p>
                  </div>
                ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function FieldActionsMenu({
  busy,
  onEdit,
  onReject,
  onMarkUnknown,
  onToggleSource,
  onToggleHistory,
}: {
  busy: boolean;
  onEdit: () => void;
  onReject: () => void;
  onMarkUnknown: () => void;
  onToggleSource: () => void;
  onToggleHistory: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function handleClick(event: MouseEvent) {
      if (
        menuRef.current &&
        !menuRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }

    window.addEventListener("mousedown", handleClick);
    return () => window.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        aria-label="Field actions"
        onClick={() => setOpen((current) => !current)}
        className="rounded-md p-1 text-text-secondary hover:bg-background hover:text-foreground"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-40 rounded-lg border border-border bg-surface py-1 shadow-lg">
          <MenuItem
            icon={<Pencil className="h-3.5 w-3.5" />}
            label="Edit"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              onEdit();
            }}
          />
          <MenuItem
            icon={<X className="h-3.5 w-3.5" />}
            label="Reject"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              onReject();
            }}
          />
          <MenuItem
            icon={<HelpCircle className="h-3.5 w-3.5" />}
            label="Mark Unknown"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              onMarkUnknown();
            }}
          />
          <MenuItem
            icon={<FileSearch className="h-3.5 w-3.5" />}
            label="View Source"
            onClick={() => {
              setOpen(false);
              onToggleSource();
            }}
          />
          <MenuItem
            icon={<Clock className="h-3.5 w-3.5" />}
            label="View History"
            onClick={() => {
              setOpen(false);
              onToggleHistory();
            }}
          />
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  disabled = false,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground transition hover:bg-background disabled:opacity-50"
    >
      {icon}
      {label}
    </button>
  );
}
