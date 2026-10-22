"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { FileSearch, ShieldCheck } from "lucide-react";

import ContentSection from "@/components/layout/ContentSection";
import PageHero from "@/components/layout/PageHero";
import EmptyState from "@/components/ui/empty-state";
import { DeviationCounts, PlaybookFindingList } from "@/components/playbook/playbook-findings";
import ClauseLibrary from "@/components/playbook/clause-library";
import SavedQueriesPanel from "@/components/playbook/saved-queries-panel";
import ValidationRulesSection from "@/components/playbook/validation-rules-section";
import { Panel, StatTile } from "@/components/portfolio/portfolio-parts";
import { getPlaybookPortfolio, listPlaybookRules, type PlaybookPortfolio, type PlaybookRule } from "@/lib/playbook";

export default function PlaybookPage() {
  const [rules, setRules] = useState<PlaybookRule[] | null>(null);
  const [portfolio, setPortfolio] = useState<PlaybookPortfolio | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [tick, setTick] = useState(0);

  useEffect(() => {
    let active = true;
    Promise.all([listPlaybookRules(), getPlaybookPortfolio()])
      .then(([nextRules, nextPortfolio]) => {
        if (!active) return;
        setRules(nextRules);
        setPortfolio(nextPortfolio);
      })
      .catch((err: unknown) => active && setError(err instanceof Error ? err.message : "Unable to load the clause playbook."));
    return () => {
      active = false;
    };
  }, [tick]);

  function load() {
    setError("");
    setTick((value) => value + 1);
  }

  async function mutate(task: () => Promise<unknown>, message: string) {
    setNotice("");
    try {
      await task();
      setNotice(message);
      load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "The change could not be saved.");
    }
  }

  return (
    <>
      <PageHero
        compact
        eyebrow="Compliance & Controls"
        title="Clause Playbook & Compliance Rules"
        description="Your clause library: which FAR and DFARS clauses every contract should carry, must not carry, or needs a closer look when present, with verbatim regulation text from ingested sources, your fallback language and extraction rules — plus validation rules, all checked against what each document actually says."
      />
      <ContentSection>
        {error ? (
          <div className="space-y-3">
            <p className="text-sm text-danger">{error}</p>
            <button type="button" onClick={load} className="btn-primary">
              Retry
            </button>
          </div>
        ) : !rules || !portfolio ? (
          <p className="text-sm text-text-secondary">Loading playbook…</p>
        ) : (
          <div className="space-y-6">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile label="Contracts checked" value={portfolio.totals.documents.toLocaleString()} hint="Documents that cite clauses" />
              <StatTile label="With deviations" value={portfolio.totals.with_deviations.toLocaleString()} />
              <StatTile label="High-severity deviations" value={portfolio.totals.high.toLocaleString()} hint="Act now" />
              <StatTile
                label="Active rules"
                value={rules.filter((rule) => rule.enabled).length.toLocaleString()}
                hint={`${rules.length} total`}
              />
            </div>
            {notice && (
              <p className="text-sm text-text-secondary" role="status">
                {notice}
              </p>
            )}
            <ClauseLibrary rules={rules} mutate={mutate} />
            <PortfolioDeviations portfolio={portfolio} />
            <SavedQueriesPanel />
            <ValidationRulesSection />
          </div>
        )}
      </ContentSection>
    </>
  );
}

function PortfolioDeviations({ portfolio }: { portfolio: PlaybookPortfolio }) {
  return (
    <Panel
      title="Portfolio deviations"
      description="Per contract: required clauses missing, prohibited clauses present, and clauses that need review."
    >
      {portfolio.documents.length === 0 ? (
        <EmptyState
          icon={FileSearch}
          title="No contracts to check yet"
          description="The playbook checks documents that cite FAR or DFARS clauses. Process a contract to see its deviations here."
          action={
            <Link href="/extraction/new" className="btn-primary px-4 py-2 text-sm">
              Start an extraction
            </Link>
          }
        />
      ) : portfolio.documents.every((item) => item.summary.deviations === 0) ? (
        <EmptyState
          icon={ShieldCheck}
          tone="success"
          title="No deviations"
          description={`All ${portfolio.documents.length.toLocaleString()} checked ${portfolio.documents.length === 1 ? "contract matches" : "contracts match"} the playbook: required clauses present, none prohibited, nothing flagged for review.`}
        />
      ) : (
        <ul className="divide-y divide-border" role="list">
          {portfolio.documents.map((document) => (
            <li key={document.document_id}>
              <details className="group py-2.5">
                <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-foreground" title={document.filename}>
                      {document.filename || document.document_id}
                    </span>
                    <span className="text-xs text-text-secondary">
                      {document.document_type ?? "Document"} · {document.is_dod ? "DoD" : "Civilian"} ·{" "}
                      {document.summary.satisfied} satisfied
                    </span>
                  </span>
                  <span className="flex items-center gap-3">
                    <DeviationCounts summary={document.summary} />
                    <Link
                      href={`/documents/${document.document_id}?view=overview`}
                      className="text-xs text-text-secondary hover:text-primary"
                      onClick={(event) => event.stopPropagation()}
                    >
                      Open
                    </Link>
                  </span>
                </summary>
                {document.findings.length > 0 && (
                  <div className="mt-2 pl-1">
                    <PlaybookFindingList findings={document.findings} documentId={document.document_id} />
                  </div>
                )}
              </details>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
