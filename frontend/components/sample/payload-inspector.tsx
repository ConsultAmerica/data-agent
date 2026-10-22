"use client";

import { useMemo, useState } from "react";
import { Check, ChevronRight, Copy } from "lucide-react";

export interface PayloadField {
  id: string;
  label: string;
  value: string | null;
  confidence: number;
  page: number;
  bbox: { x0: number; y0: number; x1: number; y1: number } | null;
  status: "pending" | "accepted" | "edited" | "rejected";
}

type Format = "json" | "xml";

const SKIP_REASON: Record<"pending" | "rejected", string> = {
  pending: "awaiting reviewer decision",
  rejected: "rejected by reviewer",
};

/** The staging payload a dry run would hand to the export adapter: reviewed
 * values with their source page, and every skipped value with the reason. */
export function buildPayload(documentName: string, fields: PayloadField[]) {
  const staged = fields.filter((field) => field.status === "accepted" || field.status === "edited");
  const skipped = fields.filter((field) => field.status === "pending" || field.status === "rejected");
  return {
    document: documentName,
    mode: "dry_run",
    staged: staged.map((field) => ({
      field_id: field.id,
      label: field.label,
      value: field.value,
      review_status: field.status,
      confidence: field.confidence,
      source: { page: field.page, bbox: field.bbox ? [field.bbox.x0, field.bbox.y0, field.bbox.x1, field.bbox.y1] : null },
    })),
    skipped: skipped.map((field) => ({
      field_id: field.id,
      label: field.label,
      reason: SKIP_REASON[field.status as "pending" | "rejected"],
    })),
  };
}

function escapeXml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function payloadXml(payload: ReturnType<typeof buildPayload>) {
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<StagingPayload document="${escapeXml(payload.document)}" mode="${payload.mode}">`,
    `  <Staged count="${payload.staged.length}">`,
    ...payload.staged.map((field) =>
      [
        `    <Field id="${field.field_id}" status="${field.review_status}" confidence="${field.confidence}">`,
        `      <Label>${escapeXml(field.label)}</Label>`,
        `      <Value>${escapeXml(field.value ?? "")}</Value>`,
        `      <Source page="${field.source.page}"${field.source.bbox ? ` bbox="${field.source.bbox.join(",")}"` : ""}/>`,
        `    </Field>`,
      ].join("\n"),
    ),
    `  </Staged>`,
    `  <Skipped count="${payload.skipped.length}">`,
    ...payload.skipped.map(
      (field) => `    <Field id="${field.field_id}" reason="${escapeXml(field.reason)}">${escapeXml(field.label)}</Field>`,
    ),
    `  </Skipped>`,
    `</StagingPayload>`,
  ];
  return lines.join("\n");
}

export default function PayloadInspector({
  documentName,
  fields,
  open,
  onToggle,
}: {
  documentName: string;
  fields: PayloadField[];
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const [format, setFormat] = useState<Format>("json");
  const [copied, setCopied] = useState(false);
  const payload = useMemo(() => buildPayload(documentName, fields), [documentName, fields]);
  const text = format === "json" ? JSON.stringify(payload, null, 2) : payloadXml(payload);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="mt-4 rounded-lg border border-border">
      <button
        type="button"
        onClick={() => onToggle(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-foreground hover:bg-surface-soft"
      >
        <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
        Inspect staging payload
        <span className="ml-auto font-normal text-text-muted">
          {payload.staged.length} staged · {payload.skipped.length} skipped
        </span>
      </button>
      {open && (
        <div className="border-t border-border">
          <div className="flex items-center gap-1 px-3 py-2">
            {(["json", "xml"] as const).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setFormat(item)}
                aria-pressed={format === item}
                className={[
                  "rounded-md px-2 py-1 text-[11px] font-semibold uppercase",
                  format === item ? "bg-primary/10 text-primary" : "text-text-secondary hover:text-foreground",
                ].join(" ")}
              >
                {item}
              </button>
            ))}
            <button
              type="button"
              onClick={() => void copy()}
              className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-text-secondary hover:text-foreground"
            >
              {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <pre
            aria-label={`Staging payload as ${format.toUpperCase()}`}
            className="max-h-72 overflow-auto bg-surface-soft px-3 py-2 font-mono text-[11px] leading-5 text-foreground"
          >
            {text}
          </pre>
          <p className="px-3 py-2 text-[11px] text-text-muted">
            Dataomatix&apos;s own staging structure. The Oracle import file is built from your Fusion
            interface template at send time, not from this shape.
          </p>
        </div>
      )}
    </div>
  );
}
