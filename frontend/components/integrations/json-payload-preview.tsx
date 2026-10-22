"use client";

import { useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";

import { formatKb, payloadBytes, payloadJson, tokenizeJson, type JsonTokenKind } from "@/lib/oracle-payload";
import type { OraclePayloadPreview } from "@/lib/reviewed-export";

const TOKEN_CLASS: Record<JsonTokenKind, string> = {
  key: "text-primary",
  string: "text-success",
  number: "text-warning",
  boolean: "text-accent",
  null: "text-text-muted italic",
  punctuation: "text-text-muted",
  space: "",
};

/** The preview payload exactly as the server returned it, highlighted,
 * with its size and a copy button. */
export default function JsonPayloadPreview({ preview }: { preview: OraclePayloadPreview }) {
  const json = useMemo(() => payloadJson(preview), [preview]);
  const tokens = useMemo(() => tokenizeJson(json), [json]);
  const size = useMemo(() => formatKb(payloadBytes(preview)), [preview]);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(json);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
    window.setTimeout(() => setCopied("idle"), 2000);
  }

  return (
    <section className="flex min-h-0 flex-col rounded-lg border border-border" aria-labelledby="oracle-json-title" data-testid="oracle-json-preview">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div>
          <h3 id="oracle-json-title" className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
            Live JSON payload preview
          </h3>
          <p className="text-[11px] text-text-muted">
            As returned by the preview endpoint · <span data-testid="oracle-payload-size">{size}</span>
          </p>
        </div>
        <button type="button" onClick={() => void copy()} className="btn-secondary px-2.5 py-1 text-xs" aria-live="polite">
          {copied === "copied" ? <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
          {copied === "copied" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy JSON"}
        </button>
      </header>
      <pre className="max-h-[32rem] min-h-0 flex-1 overflow-auto bg-surface-soft px-3 py-2 font-mono text-[12px] leading-5">
        <code>
          {tokens.map((token, index) =>
            token.kind === "space" ? (
              token.text
            ) : (
              <span key={index} className={TOKEN_CLASS[token.kind]}>
                {token.text}
              </span>
            ),
          )}
        </code>
      </pre>
    </section>
  );
}
