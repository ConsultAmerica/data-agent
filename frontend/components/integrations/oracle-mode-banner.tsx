"use client";

import { FlaskConical, Info, Radio } from "lucide-react";

import { oracleEnvironment } from "@/lib/oracle-payload";

/** The Oracle target environment as the server reports it on a payload
 * preview. Before a preview there is nothing to report, so it says so. */
export default function OracleModeBanner({ dryRun }: { dryRun: boolean | null }) {
  if (dryRun == null) {
    return (
      <div
        className="flex items-start gap-2 rounded-lg border border-border bg-surface-soft px-3 py-2 text-sm text-text-secondary"
        role="status"
        data-testid="oracle-mode-banner"
        data-mode="unknown"
      >
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
        <p>
          <span className="font-medium text-foreground">Oracle mode:</span> shown after you generate a payload preview —
          the server reports whether sends are dry-run (simulated) or live.
        </p>
      </div>
    );
  }
  const environment = oracleEnvironment({ dry_run: dryRun });
  const live = environment.kind === "live";
  const Icon = live ? Radio : FlaskConical;
  return (
    <div
      className={[
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-sm",
        live ? "border-danger/30 bg-danger/5" : "border-primary/25 bg-primary/5",
      ].join(" ")}
      role="status"
      data-testid="oracle-mode-banner"
      data-mode={environment.kind}
    >
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${live ? "text-danger" : "text-primary"}`} aria-hidden="true" />
      <p className="text-text-secondary">
        <span className="font-semibold text-foreground">Oracle mode: {environment.label}.</span> {environment.description}
      </p>
    </div>
  );
}
