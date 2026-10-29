"use client";

import { AlertTriangle, Archive, Paperclip } from "lucide-react";
import Link from "next/link";

import { fileTypeLabel } from "@/lib/extraction-workflow";
import type { UploadedDocument } from "@/types/document";

const ENCODING_LABELS: Record<string, string> = {
  "utf-8": "UTF-8",
  "utf-8-sig": "UTF-8 (BOM)",
  "utf-16": "UTF-16",
  "utf-32": "UTF-32",
  cp1252: "Windows-1252",
  "latin-1": "Latin-1",
};

const DELIMITER_LABELS: Record<string, string> = {
  comma: "Comma",
  semicolon: "Semicolon",
  tab: "Tab",
  pipe: "Pipe",
};

export function encodingLabel(encoding: string): string {
  return ENCODING_LABELS[encoding.toLowerCase()] ?? encoding.toUpperCase().replace(/_/g, "-");
}

const text = (value: unknown) => (typeof value === "string" && value ? value : null);

/**
 * How the source file was read: its format, the encoding and delimiter the
 * parser detected (flagged when the encoding was a guess), and where the
 * file came from when it was unpacked from a ZIP or attached to an email.
 */
export default function SourceFileCard({ document }: { document: UploadedDocument | null }) {
  if (!document) return null;
  const provenance = document.ingestion_provenance ?? {};
  const encoding = text(provenance.encoding);
  const guessed = provenance.encoding_guessed === true;
  const delimiter = text(provenance.delimiter);
  const containerSource = text(provenance.container_source);
  const parentId = text(provenance.container_parent_document_id);
  const extension = document.original_filename.includes(".")
    ? document.original_filename.split(".").pop()!.toUpperCase()
    : null;
  const format = fileTypeLabel(document.content_type, document.original_filename);

  return (
    <section data-testid="source-file-card">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Source file</p>
      <div className="flex flex-wrap gap-1.5 text-[11px]">
        <span className="rounded-full bg-surface-soft px-2 py-0.5 text-text-secondary">
          {format}
          {extension && extension !== format.toUpperCase() ? ` · .${extension.toLowerCase()}` : ""}
        </span>
        {encoding && (
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ${
              guessed ? "bg-warning/10 text-warning" : "bg-surface-soft text-text-secondary"
            }`}
            data-testid="source-encoding"
            title={
              guessed
                ? "Guessed from the content (no byte-order mark, not valid UTF-8). Check accented characters and symbols against the original."
                : "Read from the file's byte-order mark or valid UTF-8."
            }
          >
            {guessed && <AlertTriangle className="h-3 w-3" aria-hidden="true" />}
            {encodingLabel(encoding)}
            {guessed && <span className="sr-only"> (guessed)</span>}
          </span>
        )}
        {delimiter && (
          <span className="rounded-full bg-surface-soft px-2 py-0.5 text-text-secondary" data-testid="source-delimiter">
            {DELIMITER_LABELS[delimiter] ?? delimiter}-separated
          </span>
        )}
      </div>
      {guessed && (
        <p className="mt-1 text-[11px] text-warning">
          The encoding was guessed. Check accented characters and symbols against the original.
        </p>
      )}
      {containerSource && (
        <p className="mt-1.5 flex items-start gap-1 text-xs text-text-secondary" data-testid="source-origin">
          {parentId ? (
            <Paperclip className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          ) : (
            <Archive className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          )}
          <span className="min-w-0 break-words">
            {parentId ? "Attached to " : "Unpacked from "}
            {containerSource}
            {parentId && (
              <Link href={`/documents/${parentId}`} className="ml-1 text-primary hover:underline">
                Open email
              </Link>
            )}
          </span>
        </p>
      )}
    </section>
  );
}
