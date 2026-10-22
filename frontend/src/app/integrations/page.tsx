"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import OracleModeBanner from "@/components/integrations/oracle-mode-banner";
import OracleIntegrationPanel from "@/components/oracle-integration-panel";
import ContentSection from "@/components/layout/ContentSection";
import PageHero from "@/components/layout/PageHero";
import { useDocumentChrome } from "@/components/layout/document-chrome-context";
import { searchDocuments } from "@/lib/documents";
import { recordRecentDocument, useRecentDocuments } from "@/lib/recent-documents";

interface PickableDocument {
  id: string;
  name: string;
}

/**
 * Exports & Oracle hub — document-scoped Oracle preview/send uses the
 * existing backend APIs. Staging Export All / Selected live on the
 * document workspace (no second export engine).
 */
export default function IntegrationsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setDocumentTitle } = useDocumentChrome();
  const initialId = searchParams.get("documentId")?.trim() || "";
  const [documentId, setDocumentId] = useState(initialId);
  const [appliedId, setAppliedId] = useState(initialId);
  // Quick-pick: documents opened recently in this browser, then the latest uploads.
  const recent: PickableDocument[] = useRecentDocuments();
  const [latest, setLatest] = useState<PickableDocument[]>([]);

  useEffect(() => {
    let active = true;
    searchDocuments({ limit: 8 })
      .then((result) => {
        if (active) setLatest(result.documents.map((doc) => ({ id: doc.document_id, name: doc.original_filename })));
      })
      .catch(() => {
        /* The quick-pick is optional; the ID field still works. */
      });
    return () => {
      active = false;
    };
  }, []);

  const latestOnly = useMemo(
    () => latest.filter((doc) => !recent.some((item) => item.id === doc.id)),
    [latest, recent],
  );
  const appliedName = useMemo(
    () => [...recent, ...latest].find((doc) => doc.id === appliedId)?.name ?? null,
    [recent, latest, appliedId],
  );

  // Names the document in the breadcrumb (Exports & Oracle › file name).
  useEffect(() => {
    setDocumentTitle(appliedName);
    return () => setDocumentTitle(null);
  }, [appliedName, setDocumentTitle]);

  function apply(id: string) {
    const next = id.trim();
    setDocumentId(next);
    setAppliedId(next);
    const name = [...recent, ...latest].find((doc) => doc.id === next)?.name;
    if (next && name) recordRecentDocument(next, name);
    router.replace(next ? `/integrations?documentId=${encodeURIComponent(next)}` : "/integrations", { scroll: false });
  }

  const workspaceHref = useMemo(() => {
    if (!appliedId) return "/documents";
    return `/documents/${appliedId}?panel=oracle`;
  }, [appliedId]);

  return (
    <div className="pb-16">
      <PageHero
        eyebrow="Compliance & Controls"
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
            Pick a recent document or paste a document ID you can access, or open
            Oracle from a workspace Export menu. Requires oracle.preview (and
            oracle.send to confirm).
          </p>
          <form
            className="mt-3 flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              apply(documentId);
            }}
          >
            {(recent.length > 0 || latestOnly.length > 0) && (
              <label className="block min-w-[14rem] flex-1 text-xs text-text-secondary">
                Recent documents
                <select
                  value=""
                  onChange={(event) => {
                    if (event.target.value) apply(event.target.value);
                  }}
                  className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                  data-testid="oracle-recent-documents"
                >
                  <option value="">Choose a document…</option>
                  {recent.length > 0 && (
                    <optgroup label="Recently opened">
                      {recent.map((doc) => (
                        <option key={doc.id} value={doc.id}>
                          {doc.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {latestOnly.length > 0 && (
                    <optgroup label="Latest uploads">
                      {latestOnly.map((doc) => (
                        <option key={doc.id} value={doc.id}>
                          {doc.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </label>
            )}
            <label className="block min-w-[16rem] flex-1 text-xs text-text-secondary">
              Document ID
              <input
                type="text"
                value={documentId}
                onChange={(event) => setDocumentId(event.target.value)}
                className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground"
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
          <OracleIntegrationPanel
            key={appliedId}
            documentId={appliedId}
            documentFilename={appliedName ?? undefined}
            layout="hub"
          />
        ) : (
          <div className="space-y-3">
            <OracleModeBanner dryRun={null} />
            <p className="text-sm text-text-muted">
              Choose a document to see its payload schema, JSON payload
              preview and integration audit log.
            </p>
          </div>
        )}
      </ContentSection>
    </div>
  );
}
