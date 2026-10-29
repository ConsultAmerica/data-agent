"use client";

import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import { Fragment, useState } from "react";

import type { Form, FormField, FormGroup, FormValue } from "@/lib/doc-schemas";

const STATUS_HINT: Record<FormValue["status"], string> = {
  found: "Extracted from the document",
  matched_by_label: "Found by its label in the document",
  calculated: "Calculated",
  default: "Default value (not in the document)",
  not_found: "Not found in the document",
};

export type FormLayout = "form" | "table";

/**
 * A review form generated from a schema: top-level groups as tabs,
 * sections as label / value cards, repeating groups as paginated tables
 * (nested groups expand per row). One renderer for every document type —
 * nothing here is specific to contracts, invoices or transcripts.
 */
export default function SchemaForm({
  form,
  layout = "form",
  onEvidence,
  onSelectField,
  selectedFieldId = null,
}: {
  form: Form;
  layout?: FormLayout;
  /** A value with a source page was clicked. */
  onEvidence?: (value: FormValue, label: string) => void;
  /** A field card was chosen (with or without a source page): its details. */
  onSelectField?: (field: FormField) => void;
  selectedFieldId?: string | null;
}) {
  const [tab, setTab] = useState(0);
  const group = form.groups[Math.min(tab, form.groups.length - 1)];
  const issuesByField = new Map<string, string[]>();
  for (const issue of form.issues) {
    if (issue.field_id) issuesByField.set(issue.field_id, [...(issuesByField.get(issue.field_id) ?? []), issue.message]);
  }
  if (form.groups.length === 0) {
    return <p className="p-6 text-center text-sm text-text-muted">This schema has no groups yet.</p>;
  }
  return (
    <div className="text-sm" data-testid="schema-form">
      <div className="flex flex-wrap items-center gap-1 border-b border-border" role="tablist" aria-label="Form sections">
        {form.groups.map((item, index) => (
          <button
            key={item.group_id}
            type="button"
            role="tab"
            aria-selected={index === tab}
            onClick={() => setTab(index)}
            className={`-mb-px border-b-2 px-3 py-2 text-xs font-medium ${index === tab ? "border-primary text-foreground" : "border-transparent text-text-secondary hover:text-foreground"}`}
          >
            {item.label}
            {item.kind === "repeating" && <span className="ml-1 tabular-nums text-text-muted">{item.total_rows}</span>}
          </button>
        ))}
        <span className="ml-auto pr-1 text-[11px] text-text-muted">
          {form.found} found · {form.not_found} not found
        </span>
      </div>
      {form.issues.length > 0 && (
        <ul className="mt-2 space-y-0.5 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-xs" data-testid="schema-form-issues">
          {form.issues.slice(0, 8).map((issue, index) => (
            <li key={index} className={`flex gap-1.5 ${issue.severity === "error" ? "text-danger" : "text-warning"}`}>
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
              {issue.message}
            </li>
          ))}
        </ul>
      )}
      {group && <GroupView group={group} layout={layout} issues={issuesByField} onEvidence={onEvidence} onSelectField={onSelectField} selectedFieldId={selectedFieldId} />}
    </div>
  );
}

function ValueCell({ value, label, onEvidence }: { value: FormValue; label: string; onEvidence?: (v: FormValue, l: string) => void }) {
  if (!value.value) return <span className="text-text-muted/60" title={STATUS_HINT.not_found}>—</span>;
  const tone = value.status === "default" || value.status === "calculated" ? "italic text-text-secondary" : "text-foreground";
  const review = value.review_status === "Needs Review";
  const content = (
    <>
      {value.value}
      {review && <span className="ml-1 rounded bg-warning/10 px-1 text-[10px] text-warning">review</span>}
    </>
  );
  return value.page && onEvidence ? (
    <button
      type="button"
      onClick={() => onEvidence(value, label)}
      className={`text-left decoration-dotted hover:text-primary hover:underline ${tone}`}
      title={`${STATUS_HINT[value.status]} — page ${value.page}${value.method ? ` · ${value.method}` : ""}`}
    >
      {content}
    </button>
  ) : (
    <span className={tone} title={`${STATUS_HINT[value.status]}${value.method ? ` · ${value.method}` : ""}`}>{content}</span>
  );
}

function GroupView({
  group,
  layout,
  issues,
  onEvidence,
  onSelectField,
  selectedFieldId = null,
  nested = false,
}: {
  group: FormGroup;
  layout: FormLayout;
  issues: Map<string, string[]>;
  onEvidence?: (v: FormValue, l: string) => void;
  onSelectField?: (field: FormField) => void;
  selectedFieldId?: string | null;
  nested?: boolean;
}) {
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<Set<string>>(new Set());
  if (group.kind === "repeating") {
    const size = group.page_size || 25;
    const pages = Math.max(1, Math.ceil(group.rows.length / size));
    const rows = group.rows.slice(page * size, page * size + size);
    const hasChildren = group.rows.some((row) => row.children.length > 0);
    return (
      <section className={nested ? "mt-1" : "mt-3"} aria-label={group.label}>
        {nested && <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">{group.label}</p>}
        {group.rows.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-text-muted">No rows found in this document.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="min-w-full text-xs">
              <thead className="bg-surface-soft text-left text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                <tr>
                  {hasChildren && <th className="w-6" />}
                  {group.columns.map((column) => (
                    <th key={column.field_id} className="whitespace-nowrap px-2.5 py-1.5" title={column.field_id}>
                      {column.label}
                      {column.required && <span className="text-danger">*</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <Fragment key={row.row_id}>
                    <tr className="border-t border-border/60 align-top">
                      {hasChildren && (
                        <td className="px-1 py-1.5">
                          {row.children.length > 0 && (
                            <button
                              type="button"
                              aria-label={open.has(row.row_id) ? "Collapse row" : "Expand row"}
                              aria-expanded={open.has(row.row_id)}
                              onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(row.row_id)) n.delete(row.row_id); else n.add(row.row_id); return n; })}
                              className="text-text-muted hover:text-foreground"
                            >
                              {open.has(row.row_id) ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                            </button>
                          )}
                        </td>
                      )}
                      {group.columns.map((column) => (
                        <td key={column.field_id} className="max-w-[18rem] truncate px-2.5 py-1.5">
                          <ValueCell value={row.cells[column.field_id] ?? { value: "", status: "not_found" } as FormValue} label={column.label} onEvidence={onEvidence} />
                        </td>
                      ))}
                    </tr>
                    {open.has(row.row_id) && (
                      <tr className="bg-surface-soft/40">
                        <td colSpan={group.columns.length + 1} className="px-6 py-2">
                          {row.children.map((child) => (
                            <GroupView key={child.group_id} group={child} layout={layout} issues={issues} onEvidence={onEvidence} onSelectField={onSelectField} selectedFieldId={selectedFieldId} nested />
                          ))}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 && (
          <div className="mt-1.5 flex items-center justify-end gap-2 text-[11px] text-text-secondary">
            <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)} className="rounded border border-border px-2 py-0.5 disabled:opacity-40">Previous</button>
            {page + 1} / {pages} · {group.total_rows} rows
            <button type="button" disabled={page >= pages - 1} onClick={() => setPage(page + 1)} className="rounded border border-border px-2 py-0.5 disabled:opacity-40">Next</button>
          </div>
        )}
      </section>
    );
  }

  return (
    <section className={nested ? "mt-2" : "mt-3"} aria-label={group.label}>
      {nested && <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">{group.label}</p>}
      {layout === "table" ? (
        <table className="min-w-full overflow-hidden rounded-lg border border-border text-xs">
          <tbody>
            {group.fields.map((field) => (
              <tr key={field.field_id} className="border-t border-border/60 first:border-t-0">
                <th className="w-1/3 bg-surface-soft px-2.5 py-1.5 text-left font-medium text-text-secondary">{field.label}</th>
                <td className="px-2.5 py-1.5"><ValueCell value={field.value} label={field.label} onEvidence={onEvidence} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <dl className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(14rem,1fr))]">
          {group.fields.map((field) => {
            const fieldIssues = issues.get(field.field_id);
            return (
              <div
                key={field.field_id}
                className={`rounded-lg border px-3 py-2 ${fieldIssues ? "border-danger/40 bg-danger/5" : selectedFieldId === field.field_id ? "border-primary/60 bg-primary/[0.05] ring-1 ring-primary/30" : "border-border bg-surface"} ${
                  onSelectField ? "cursor-pointer transition hover:border-primary/40 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50" : ""
                }`}
                title={field.description ?? field.instructions ?? field.field_id}
                data-testid="schema-field-card"
                {...(onSelectField
                  ? {
                      role: "button",
                      tabIndex: 0,
                      "aria-pressed": selectedFieldId === field.field_id,
                      "aria-label": `${field.label}: ${field.value.value || "not found"}${field.value.page ? `, page ${field.value.page}` : ""}. Show details and source.`,
                      onClick: () => onSelectField(field),
                      onKeyDown: (event: React.KeyboardEvent) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onSelectField(field);
                        }
                      },
                    }
                  : {})}
              >
                <dt className="flex items-baseline justify-between gap-2 text-[11px] font-medium text-text-secondary">
                  <span>
                    {field.label}
                    {field.required && <span className="text-danger"> *</span>}
                  </span>
                  {onSelectField && field.value.page && (
                    <span className="shrink-0 text-[10px] font-normal text-primary" aria-hidden="true">p. {field.value.page} ›</span>
                  )}
                </dt>
                <dd className="mt-0.5 break-words text-[13px]">
                  {/* The whole card is the control; the value itself isn't a nested button. */}
                  <ValueCell value={field.value} label={field.label} onEvidence={onSelectField ? undefined : onEvidence} />
                </dd>
                {fieldIssues && <p className="mt-0.5 text-[10px] text-danger">{fieldIssues[0]}</p>}
              </div>
            );
          })}
        </dl>
      )}
      {group.children.map((child) => (
        <GroupView key={child.group_id} group={child} layout={layout} issues={issues} onEvidence={onEvidence} onSelectField={onSelectField} selectedFieldId={selectedFieldId} nested />
      ))}
    </section>
  );
}
