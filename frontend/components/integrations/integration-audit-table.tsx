"use client";

import type { IntegrationAuditEntry } from "@/lib/reviewed-export";

function statusCode(row: IntegrationAuditEntry): string | null {
  const code = row.response_snapshot?.code;
  return typeof code === "string" || typeof code === "number" ? String(code) : null;
}

function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

const STATUS_TONE: Record<string, string> = {
  simulated: "text-text-secondary",
  sent: "text-success",
  success: "text-success",
  rejected: "text-danger",
  failed: "text-danger",
  error: "text-danger",
};

/** This document's integration ledger, oldest first. */
export default function IntegrationAuditTable({ rows }: { rows: IntegrationAuditEntry[] }) {
  const ordered = [...rows].sort((a, b) => {
    const at = new Date(a.created_at).getTime();
    const bt = new Date(b.created_at).getTime();
    if (Number.isNaN(at) || Number.isNaN(bt) || at === bt) return a.id - b.id;
    return at - bt;
  });
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="min-w-full text-xs" data-testid="integration-audit-table">
        <caption className="sr-only">Integration audit log, oldest first</caption>
        <thead className="bg-surface-soft text-left text-[11px] font-semibold uppercase tracking-wide text-text-muted">
          <tr>
            <th scope="col" className="px-3 py-2">Timestamp</th>
            <th scope="col" className="px-3 py-2">Audit ID / payload ID</th>
            <th scope="col" className="px-3 py-2">Action</th>
            <th scope="col" className="px-3 py-2">Status</th>
            <th scope="col" className="px-3 py-2">Status code</th>
            <th scope="col" className="px-3 py-2">Initiated by</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((row) => {
            const code = statusCode(row);
            return (
              <tr key={row.id} className="border-t border-border/70 align-top" data-testid="integration-audit-row">
                <td className="whitespace-nowrap px-3 py-2 tabular-nums text-text-secondary">{when(row.created_at)}</td>
                <td className="px-3 py-2">
                  <span className="font-mono text-foreground">#{row.id}</span>
                  {row.request_id && (
                    <span className="block font-mono text-[11px] text-text-muted" title="Correlation / request ID">
                      {row.request_id}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-foreground">
                  {row.integration} · {row.action}
                  {row.detail && <span className="block text-[11px] text-text-muted">{row.detail}</span>}
                </td>
                <td className={`px-3 py-2 font-medium ${STATUS_TONE[row.status] ?? "text-foreground"}`}>{row.status}</td>
                <td className="px-3 py-2 font-mono text-text-secondary">{code ?? <span className="text-text-muted">—</span>}</td>
                <td className="px-3 py-2 text-text-secondary">
                  {row.changed_by || row.actor_id || "—"}
                  {row.actor_role && <span className="block text-[11px] text-text-muted">{row.actor_role}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
