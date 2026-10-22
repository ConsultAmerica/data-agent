"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Send,
  ShieldAlert,
} from "lucide-react";

import IntegrationAuditTable from "@/components/integrations/integration-audit-table";
import JsonPayloadPreview from "@/components/integrations/json-payload-preview";
import OracleModeBanner from "@/components/integrations/oracle-mode-banner";
import PayloadSchemaTree from "@/components/integrations/payload-schema-tree";
import OracleSendConfirmModal from "@/components/oracle-send-confirm-modal";
import { ApiError } from "@/lib/api";
import { buildOracleChecklist, checklistPasses } from "@/lib/oracle-checklist";
import {
  getOraclePayloadPreview,
  listIntegrationAudit,
  sendOraclePayload,
  type IntegrationAuditEntry,
  type OraclePayloadPreview,
  type OracleSendResult,
} from "@/lib/reviewed-export";
import { getStagingProfile, type ProfileDescriptor } from "@/lib/staging-workbook";

type PanelState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "preview"; preview: OraclePayloadPreview }
  | { kind: "sending" }
  | { kind: "sent"; result: OracleSendResult }
  | { kind: "error"; message: string; code?: number }
  | { kind: "unknown"; message: string };

function explainError(error: unknown): { message: string; code?: number } {
  if (error instanceof ApiError) {
    const detail = error.message || `Request failed (${error.status})`;
    if (error.status === 403) {
      return {
        code: 403,
        message: "You do not have permission for this Oracle operation.",
      };
    }
    if (error.status === 404) {
      return {
        code: 404,
        message: "Document or metadata fields were not found for Oracle.",
      };
    }
    if (error.status === 409) {
      return { code: 409, message: detail };
    }
    if (error.status === 501) {
      return {
        code: 501,
        message:
          detail ||
          "Live Oracle send is not configured. Dry-run remains available when enabled.",
      };
    }
    if (error.status >= 500) {
      return {
        code: error.status,
        message:
          "Backend unavailable or request failed. If a send may have started, reconcile integration history before retrying.",
      };
    }
    return { code: error.status, message: detail };
  }
  if (error instanceof Error && /timeout|aborted|network/i.test(error.message)) {
    return {
      message:
        "Outcome unknown (timeout or network). Check integration history before retrying — do not assume the send failed.",
    };
  }
  return {
    message: error instanceof Error ? error.message : "Oracle operation failed.",
  };
}

export default function OracleIntegrationPanel({
  documentId,
  documentFilename,
  layout = "compact",
}: {
  documentId: string;
  documentFilename?: string;
  /** "hub" (Exports & Oracle page): mode banner, payload schema beside the
   * JSON preview, and the audit ledger as a table. */
  layout?: "compact" | "hub";
}) {
  const hub = layout === "hub";
  const [state, setState] = useState<PanelState>({ kind: "idle" });
  // The mode the server reported on the last preview (null until one loads).
  const [dryRun, setDryRun] = useState<boolean | null>(null);
  const [mapping, setMapping] = useState<ProfileDescriptor["oracle_mapping_capability"] | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [history, setHistory] = useState<IntegrationAuditEntry[] | null>(null);
  const [historyError, setHistoryError] = useState("");

  const loadHistory = useCallback(async () => {
    setHistoryError("");
    try {
      const rows = await listIntegrationAudit(documentId);
      setHistory(rows);
    } catch (error) {
      setHistory([]);
      const explained = explainError(error);
      setHistoryError(
        explained.code === 403
          ? "Integration history requires Oracle preview permission."
          : explained.message,
      );
    }
  }, [documentId]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  // The hub shows the profile's target-mapping status beside the schema.
  useEffect(() => {
    if (!hub) return;
    let active = true;
    getStagingProfile(documentId)
      .then((profile) => {
        if (active) setMapping(profile.oracle_mapping_capability);
      })
      .catch(() => {
        // Unknown mapping status is simply not shown.
      });
    return () => {
      active = false;
    };
  }, [hub, documentId]);

  async function loadPreview() {
    setConfirmOpen(false);
    setState({ kind: "loading" });
    try {
      const preview = await getOraclePayloadPreview(documentId);
      setDryRun(preview.dry_run);
      setState({ kind: "preview", preview });
    } catch (error) {
      const explained = explainError(error);
      if (/timeout|network|unknown/i.test(explained.message)) {
        setState({ kind: "unknown", message: explained.message });
      } else {
        setState({ kind: "error", ...explained });
      }
    }
  }

  async function confirmSend() {
    // The dialog only enables Confirm when every check passes; re-check here.
    if (!preview || !checkPreview(preview)) return;
    setConfirmOpen(false);
    setState({ kind: "sending" });
    try {
      const result = await sendOraclePayload(documentId, true);
      setState({ kind: "sent", result });
      await loadHistory();
    } catch (error) {
      const explained = explainError(error);
      if (
        explained.code == null ||
        explained.code === 0 ||
        /timeout|unknown|network/i.test(explained.message)
      ) {
        setState({ kind: "unknown", message: explained.message });
        await loadHistory();
      } else {
        setState({ kind: "error", ...explained });
        await loadHistory();
      }
    }
  }

  const preview = state.kind === "preview" ? state.preview : null;
  const checklist = preview ? buildOracleChecklist(preview) : [];
  const checklistReady = preview != null && checkPreview(preview);

  return (
    <section
      className="rounded-xl border border-border bg-surface"
      data-testid="oracle-integration-panel"
      aria-labelledby="oracle-panel-title"
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 id="oracle-panel-title" className="text-sm font-semibold text-foreground">
            Oracle integration
          </h2>
          <p className="mt-0.5 text-xs text-text-secondary">
            Preview uses accepted/edited metadata only. Preview is never a send.
            {documentFilename ? (
              <>
                {" "}
                Document: <span className="text-foreground">{documentFilename}</span>
              </>
            ) : null}
          </p>
        </div>
        <button
          type="button"
          className="btn-secondary px-3 py-1.5 text-xs"
          onClick={() => void loadPreview()}
          disabled={state.kind === "loading" || state.kind === "sending"}
        >
          {state.kind === "loading" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          Generate payload preview
        </button>
      </header>

      <div className="space-y-4 px-4 py-4" aria-live="polite">
        {hub && <OracleModeBanner dryRun={dryRun} />}
        {state.kind === "idle" && (
          <p className="text-sm text-text-secondary">
            Generate a payload preview to inspect destination, validation, and
            excluded fields before any confirmation.
          </p>
        )}

        {state.kind === "loading" && (
          <p className="flex items-center gap-2 text-sm text-text-secondary">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Loading Oracle payload preview…
          </p>
        )}

        {state.kind === "error" && (
          <div className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger" role="alert">
            <p className="font-medium">Oracle operation blocked</p>
            <p className="mt-1">{state.message}</p>
          </div>
        )}

        {state.kind === "unknown" && (
          <div
            className="rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-sm text-foreground"
            role="alert"
          >
            <p className="flex items-center gap-2 font-medium text-warning">
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              Outcome unknown
            </p>
            <p className="mt-1 text-text-secondary">{state.message}</p>
            <p className="mt-2 text-xs text-text-muted">
              Do not retry until you reconcile integration history below.
            </p>
          </div>
        )}

        {state.kind === "sent" && (
          <div
            className="rounded-lg border border-success/30 bg-success/5 px-3 py-2 text-sm"
            role="status"
          >
            <p className="flex items-center gap-2 font-medium text-success">
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              {state.result.dry_run ? "Dry-run send audited" : "Send recorded"}
            </p>
            <dl className="mt-2 grid gap-1 text-xs text-text-secondary sm:grid-cols-2">
              <div>
                Status:{" "}
                <span className="font-medium text-foreground">{state.result.status}</span>
              </div>
              <div>
                Audit ID:{" "}
                <span className="font-mono text-foreground">
                  {state.result.integration_audit_id}
                </span>
              </div>
              {state.result.response_snapshot?.code && (
                <div>
                  Code:{" "}
                  <span className="font-mono text-foreground">
                    {state.result.response_snapshot.code}
                  </span>
                </div>
              )}
              {state.result.response_snapshot?.message && (
                <div className="sm:col-span-2">{state.result.response_snapshot.message}</div>
              )}
            </dl>
            <p className="mt-2 text-[11px] text-text-muted">
              No Oracle transaction ID is invented. Dry-run does not deliver to
              Fusion.
            </p>
          </div>
        )}

        {preview && (
          <div className="space-y-3">
            <dl className="grid gap-2 text-xs sm:grid-cols-2">
              <div>
                <dt className="text-text-muted">Destination</dt>
                <dd className="font-medium text-foreground">{preview.erp_target}</dd>
              </div>
              <div>
                <dt className="text-text-muted">Operation</dt>
                <dd className="font-medium text-foreground">
                  {preview.mode}
                  {preview.dry_run ? " · dry-run" : " · live (if configured)"}
                </dd>
              </div>
              <div>
                <dt className="text-text-muted">Authoritative fields</dt>
                <dd className="font-medium text-foreground">{preview.authoritative_count}</dd>
              </div>
              <div>
                <dt className="text-text-muted">Excluded / skipped</dt>
                <dd className="font-medium text-foreground">{preview.skipped_count}</dd>
              </div>
            </dl>

            {preview.skipped_count > 0 && (
              <div className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2">
                <p className="flex items-center gap-2 text-xs font-semibold text-warning">
                  <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
                  Blocked from Oracle payload
                </p>
                <ul className="mt-2 max-h-40 space-y-1 overflow-auto text-xs text-text-secondary">
                  {preview.skipped.map((row, index) => (
                    <li key={`${row.field_key}:${index}`}>
                      <span className="font-medium text-foreground">{row.field}</span>
                      {" · "}
                      {row.review_status}
                      {row.reason ? ` — ${row.reason}` : ""}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[11px] text-text-muted">
                  Send requires a clean review set (no pending/rejected left in
                  the document).
                </p>
              </div>
            )}

            {hub ? (
              <div className="grid gap-3 lg:grid-cols-2">
                <PayloadSchemaTree preview={preview} mapping={mapping} />
                <JsonPayloadPreview preview={preview} />
              </div>
            ) : (
              <details className="rounded-lg border border-border px-3 py-2">
                <summary className="cursor-pointer text-xs font-semibold text-text-secondary">
                  Contract header preview ({Object.keys(preview.contract_header).length} fields)
                </summary>
                <dl className="mt-2 grid gap-1 text-xs sm:grid-cols-2">
                  {Object.entries(preview.contract_header).map(([key, value]) => (
                    <div key={key} className="contents">
                      <dt className="text-text-muted">{key}</dt>
                      <dd className="break-all text-foreground">{value}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            )}

            {state.kind === "sending" ? (
              <p className="flex items-center gap-2 text-sm text-text-secondary">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Submitting confirmed send…
              </p>
            ) : (
              <div className="rounded-lg border border-border bg-surface-soft px-3 py-3">
                <p className="text-xs text-text-secondary">
                  {checklistReady
                    ? "All delivery checks and required header fields pass."
                    : `${checklist.filter((item) => !item.passed).length} of ${checklist.length} pre-send checks fail — review them before sending.`}
                </p>
                {!preview.actor?.can_send && (
                  <p className="mt-2 text-xs text-warning">
                    Your role cannot send to Oracle (preview only).
                  </p>
                )}
                {/* Sending only ever happens from the confirmation dialog. */}
                <button
                  type="button"
                  className="btn-primary mt-3 px-3 py-1.5 text-xs disabled:opacity-50"
                  disabled={!preview.actor?.can_send}
                  onClick={() => setConfirmOpen(true)}
                >
                  <Send className="h-3.5 w-3.5" aria-hidden="true" />
                  Review and send…
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <footer className="border-t border-border px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
            {hub ? "Audit log" : "Integration history"}
          </h3>
          <button
            type="button"
            className="text-xs text-primary hover:underline"
            onClick={() => void loadHistory()}
          >
            Refresh
          </button>
        </div>
        {historyError && (
          <p className="mt-2 text-xs text-danger" role="alert">
            {historyError}
          </p>
        )}
        {history && history.length === 0 && !historyError && (
          <p className="mt-2 text-xs text-text-muted">No Oracle operations recorded yet.</p>
        )}
        {hub && history && history.length > 0 && (
          <div className="mt-2">
            <IntegrationAuditTable rows={history} />
          </div>
        )}
        {!hub && history && history.length > 0 && (
          <ul className="mt-2 max-h-48 space-y-2 overflow-auto text-xs">
            {history.map((row) => (
              <li
                key={row.id}
                className="rounded-md border border-border/80 px-2 py-1.5"
                data-testid="integration-audit-row"
              >
                <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                  <span className="font-medium text-foreground">
                    {row.integration} · {row.action}
                  </span>
                  <span className="text-text-secondary">{row.status}</span>
                  <span className="text-text-muted">
                    {row.created_at
                      ? new Date(row.created_at).toLocaleString()
                      : "—"}
                  </span>
                </div>
                <div className="mt-0.5 text-text-muted">
                  {row.changed_by || row.actor_id || "—"}
                  {row.request_id ? (
                    <>
                      {" · "}
                      <span className="font-mono">corr {row.request_id}</span>
                    </>
                  ) : null}
                  {" · "}
                  audit #{row.id}
                </div>
                {row.detail && (
                  <p className="mt-0.5 text-text-secondary">{row.detail}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </footer>

      {confirmOpen && preview && (
        <OracleSendConfirmModal
          preview={preview}
          documentFilename={documentFilename}
          onConfirm={() => void confirmSend()}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </section>
  );
}

/** Every pre-send check passes, and the backend agrees the set is ready. */
function checkPreview(preview: OraclePayloadPreview): boolean {
  return preview.ready_to_send === true && checklistPasses(buildOracleChecklist(preview));
}
