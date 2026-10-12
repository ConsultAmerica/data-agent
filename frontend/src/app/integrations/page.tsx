"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

import OracleIntegrationPanel from "@/components/oracle-integration-panel";
import ContentSection from "@/components/layout/ContentSection";
import PageHero from "@/components/layout/PageHero";

/**
 * Exports & Oracle hub — document-scoped Oracle preview/send uses the
 * existing backend APIs. Staging Export All / Selected live on the
 * document workspace (no second export engine).
 */
export default function IntegrationsPage() {
  const searchParams = useSearchParams();
  const initialId = searchParams.get("documentId")?.trim() || "";
  const [documentId, setDocumentId] = useState(initialId);
  const [appliedId, setAppliedId] = useState(initialId);

  const workspaceHref = useMemo(() => {
    if (!appliedId) return "/documents";
    return `/documents/${appliedId}?panel=oracle`;
  }, [appliedId]);

  return (
    <div className="pb-16">
      <PageHero
        eyebrow="Integrations"
        title="Exports & Oracle"
        description="Staging exports use the document workbook. Oracle preview and send use accepted/edited metadata only — never treat a preview as a delivery."
      />

      <ContentSection className="space-y-8">
        <section className="rounded-xl border border-border bg-surface px-4 py-4">
          <h2 className="text-sm font-semibold text-foreground">Staging exports</h2>
          <p className="mt-1 text-sm text-text-secondary">
            Open a document workspace for Export All, Export Selected (Excel /
            CSV / JSON), and selection counts. Values come from persisted
            staging cells — the server resolves IDs from the selection
            manifest.
          </p>
          <Link href="/documents" className="btn-secondary mt-3 inline-flex text-sm">
            Open documents repository
          </Link>
        </section>

        <section className="rounded-xl border border-border bg-surface px-4 py-4">
          <h2 className="text-sm font-semibold text-foreground">Oracle document</h2>
          <p className="mt-1 text-sm text-text-secondary">
            Enter a document ID you can access, or open Oracle from a workspace
            Export menu. Requires oracle.preview (and oracle.send to confirm).
          </p>
          <form
            className="mt-3 flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setAppliedId(documentId.trim());
            }}
          >
            <label className="block min-w-[16rem] flex-1 text-xs text-text-secondary">
              Document ID
              <input
                type="text"
                value={documentId}
                onChange={(event) => setDocumentId(event.target.value)}
                className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                placeholder="Paste document UUID"
                autoComplete="off"
              />
            </label>
            <button type="submit" className="btn-primary px-3 py-2 text-sm">
              Load Oracle panel
            </button>
            {appliedId && (
              <Link href={workspaceHref} className="btn-secondary px-3 py-2 text-sm">
                Open in workspace
              </Link>
            )}
          </form>
        </section>

        {appliedId ? (
          <OracleIntegrationPanel documentId={appliedId} />
        ) : (
          <p className="text-sm text-text-muted">
            No document selected. Oracle history and preview stay empty until a
            document ID is loaded — records are never invented.
          </p>
        )}
      </ContentSection>
    </div>
  );
}
