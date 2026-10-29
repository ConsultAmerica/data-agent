"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";

import SchemaForm, { type FormLayout } from "@/components/schemas/schema-form";
import SourceVerificationPanel, { type SourceViewRequest } from "@/components/source-verification-panel";
import { getDocument } from "@/lib/documents";
import {
  STATUS_LABEL,
  assignSchema,
  assignmentDiff,
  documentForm,
  listSchemas,
  type DocumentForm,
  type SchemaDiff,
  type SchemaSummary,
} from "@/lib/doc-schemas";

/** The document's review form, generated from its assigned schema version.
 * Moving to another version is explicit and shows what changes. */
export default function DocumentFormPage({ params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = use(params);
  const [data, setData] = useState<DocumentForm | null>(null);
  const [name, setName] = useState("");
  const [pages, setPages] = useState(1);
  const [layout, setLayout] = useState<FormLayout>("form");
  const [request, setRequest] = useState<SourceViewRequest | null>(null);
  const [schemas, setSchemas] = useState<SchemaSummary[]>([]);
  const [target, setTarget] = useState<number | "">("");
  const [diff, setDiff] = useState<SchemaDiff | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([documentForm(documentId), getDocument(documentId), listSchemas({ status: "published" })])
      .then(([form, document, list]) => {
        if (!active) return;
        setData(form);
        setName(document.original_filename);
        setPages(document.page_count || 1);
        setSchemas(list);
      })
      .catch((err) => active && setError(err instanceof Error ? err.message : "Unable to build the form."));
    return () => {
      active = false;
    };
  }, [documentId]);

  useEffect(() => {
    if (!target) return;
    let active = true;
    assignmentDiff(documentId, target)
      .then((result) => active && setDiff(result))
      .catch(() => active && setDiff(null));
    return () => {
      active = false;
    };
  }, [documentId, target]);

  if (error) return <p className="p-6 text-sm text-danger" role="alert">{error}</p>;
  if (!data) return <p className="p-6 text-sm text-text-muted">Building the review form…</p>;

  return (
    <div className="workspace-page w-full px-4 py-4 sm:px-6" data-testid="document-form-page">
      <Link href={`/documents/${documentId}`} className="text-sm text-text-secondary hover:text-foreground">← {name || "Document"}</Link>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold text-foreground">Review form</h1>
        <span className="rounded-full bg-surface-soft px-2 py-0.5 text-xs text-text-secondary" data-testid="form-schema">
          {data.schema_name} v{data.version} · {STATUS_LABEL[data.version_status]} · {data.assignment_kind}
        </span>
        <Link href={`/schemas/${data.schema_id}?version=${data.version_id}`} className="text-xs text-primary hover:underline">Open schema</Link>
        <div className="ml-auto flex items-center gap-1 text-xs" role="radiogroup" aria-label="Layout">
          {(["form", "table"] as const).map((id) => (
            <button key={id} type="button" role="radio" aria-checked={layout === id} onClick={() => setLayout(id)}
              className={`rounded-md px-2 py-1 ${layout === id ? "bg-primary/10 text-foreground" : "text-text-secondary"}`}>{id === "form" ? "Form" : "Table"}</button>
          ))}
        </div>
      </div>
      {data.newer_version && (
        <p className="mt-2 rounded-lg border border-border bg-surface-soft px-3 py-2 text-xs text-text-secondary">
          Version {data.newer_version.version} of this schema is published. This document keeps v{data.version} until you move it.
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <label className="text-text-secondary">Use another schema version</label>
        <select value={target} onChange={(e) => setTarget(e.target.value ? Number(e.target.value) : "")} aria-label="Schema version"
          className="h-8 rounded-lg border border-border bg-background px-2 text-xs">
          <option value="">Choose…</option>
          {schemas.filter((s) => s.published).map((s) => (
            <option key={s.id} value={s.published!.id}>{s.name} v{s.published!.version}</option>
          ))}
        </select>
        {target && diff && (
          <>
            <span className="text-text-secondary" data-testid="migration-diff">
              {diff.changes.length} field changes{diff.breaking.length ? `, ${diff.breaking.length} breaking` : ""}
              {diff.mappings_to_review.length ? ` · ${diff.mappings_to_review.length} Oracle mappings to review` : ""}
            </span>
            <button
              type="button"
              onClick={async () => {
                try {
                  setData(await assignSchema(documentId, Number(target), "Moved from the review form"));
                  setTarget("");
                  setDiff(null);
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Migration failed.");
                }
              }}
              className="btn-primary px-2.5 py-1 text-xs"
            >
              Move document
            </button>
            <span className="text-text-muted">Extracted and approved values are not changed.</span>
          </>
        )}
      </div>
      <div className={`mt-4 grid gap-4 ${request ? "xl:grid-cols-[minmax(0,1.3fr)_minmax(360px,1fr)]" : ""}`}>
        <section className="rounded-xl border border-border bg-surface p-4">
          <SchemaForm
            form={data.form}
            layout={layout}
            onEvidence={(value, label) =>
              value.page && setRequest({ pageNumber: value.page, highlightText: value.highlight, label, value: value.value, anchorText: value.document_label })
            }
          />
        </section>
        {request && (
          <section className="min-h-[480px] overflow-hidden rounded-xl border border-border bg-surface">
            <SourceVerificationPanel documentId={documentId} documentName={name} pageCount={pages} request={request} />
          </section>
        )}
      </div>
    </div>
  );
}
