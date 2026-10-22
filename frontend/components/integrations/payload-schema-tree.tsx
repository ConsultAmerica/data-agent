"use client";

import { ArrowRight } from "lucide-react";

import { payloadSchema } from "@/lib/oracle-payload";
import type { OraclePayloadPreview } from "@/lib/reviewed-export";
import type { ProfileDescriptor } from "@/lib/staging-workbook";

type MappingCapability = ProfileDescriptor["oracle_mapping_capability"];

const MAPPING_STATUS: Record<MappingCapability, { label: string; detail: string; tone: string }> = {
  available: {
    label: "Adapter mapping available",
    detail: "This profile's destination adapter mapping is configured.",
    tone: "border-success/30 bg-success/5 text-success",
  },
  planned: {
    label: "Target template pending",
    detail:
      "Payload keys are the export keys below. Exact Oracle Fusion field names are bound when the target import template / schema is supplied.",
    tone: "border-warning/30 bg-warning/5 text-warning",
  },
  none: {
    label: "No destination adapter",
    detail: "This document's profile has no Oracle adapter mapping; the payload carries export keys only.",
    tone: "border-border bg-surface-soft text-text-secondary",
  },
};

/** What the payload is made of: each source field and the payload key it
 * lands under, grouped as the payload is. Read-only — mappings are not
 * edited here. */
export default function PayloadSchemaTree({
  preview,
  mapping,
}: {
  preview: OraclePayloadPreview;
  /** The profile's target-mapping status, when known. */
  mapping?: MappingCapability | null;
}) {
  const groups = payloadSchema(preview);
  const status = mapping ? MAPPING_STATUS[mapping] : null;
  return (
    <section className="flex min-h-0 flex-col rounded-lg border border-border" aria-labelledby="oracle-schema-title" data-testid="oracle-payload-schema">
      <header className="border-b border-border px-3 py-2">
        <h3 id="oracle-schema-title" className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
          Payload schema
        </h3>
        <p className="text-[11px] text-text-muted">Source field → payload key</p>
      </header>
      {status && (
        <div className={`mx-3 mt-3 rounded-md border px-2.5 py-1.5 text-xs ${status.tone}`} data-testid="oracle-mapping-status">
          <p className="font-semibold">Target mapping: {status.label}</p>
          <p className="mt-0.5 text-text-secondary">{status.detail}</p>
        </div>
      )}
      <div className="max-h-[32rem] min-h-0 flex-1 overflow-auto px-3 py-2">
        <ul className="space-y-2 text-xs" aria-label="Payload schema">
          {groups.map((group) => (
            <li key={group.id}>
              <details open className="group">
                <summary className="cursor-pointer select-none py-1 font-semibold text-foreground">
                  <span className="font-mono">{group.id}</span>
                  <span className="ml-1.5 font-normal text-text-muted">
                    {group.label} · {group.entries.length.toLocaleString()}
                  </span>
                </summary>
                <p className="mb-1 ml-4 text-[11px] text-text-muted">{group.description}</p>
                {group.entries.length === 0 ? (
                  <p className="ml-4 py-1 text-text-muted">No accepted / edited fields yet.</p>
                ) : (
                  <ul className="ml-2 border-l border-border pl-3">
                    {group.entries.map((entry) => (
                      <li
                        key={entry.payloadKey}
                        className="flex flex-wrap items-center gap-x-1.5 py-0.5"
                      >
                        <span className="text-foreground">{entry.source}</span>
                        <ArrowRight className="h-3 w-3 shrink-0 text-text-muted" aria-label="maps to" />
                        <code className="font-mono text-primary">{entry.payloadKey}</code>
                        {entry.detail && <span className="font-mono text-[11px] text-text-muted">({entry.detail})</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </details>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
