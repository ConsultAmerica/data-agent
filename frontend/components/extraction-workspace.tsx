"use client";

import { useState } from "react";
import { PenLine, ScrollText, Sparkles, Table2 } from "lucide-react";

import ClauseList from "@/components/clause-list";
import RateCardTable from "@/components/rate-card-table";
import SignatureList from "@/components/signature-list";
import type {
  ClauseResult,
  NormalizedTable,
  SignatureResult,
} from "@/types/document";

type WorkspaceTab = "clauses" | "tables" | "signatures";

interface ExtractionWorkspaceProps {
  clauses: ClauseResult[];
  extractingClauses: boolean;
  clausesError: string;
  onExtractClauses: () => void;
  onViewClauseSource: (clause: ClauseResult) => void;

  tables: NormalizedTable[];
  extractingTables: boolean;
  tablesError: string;
  onExtractTables: () => void;

  signatures: SignatureResult[];
  extractingSignatures: boolean;
  signaturesError: string;
  onExtractSignatures: () => void;
  onViewSignatureSource: (signature: SignatureResult) => void;

  /** False for documents with no clauses to find (invoices, IDs…):
   * the Clauses tab is left out. */
  showClauses?: boolean;
}

export default function ExtractionWorkspace({
  clauses,
  extractingClauses,
  clausesError,
  onExtractClauses,
  onViewClauseSource,
  tables,
  extractingTables,
  tablesError,
  onExtractTables,
  signatures,
  extractingSignatures,
  signaturesError,
  onExtractSignatures,
  onViewSignatureSource,
  showClauses = true,
}: ExtractionWorkspaceProps) {
  const [chosenTab, setActiveTab] = useState<WorkspaceTab>(showClauses ? "clauses" : "tables");
  const activeTab: WorkspaceTab = !showClauses && chosenTab === "clauses" ? "tables" : chosenTab;

  const allTabs: {
    key: WorkspaceTab;
    label: string;
    icon: typeof ScrollText;
    count: number;
  }[] = [
    {
      key: "clauses",
      label: "Clauses",
      icon: ScrollText,
      count: clauses.length,
    },
    {
      key: "tables",
      label: "Tables",
      icon: Table2,
      count: tables.length,
    },
    {
      key: "signatures",
      label: "Signatures",
      icon: PenLine,
      count: signatures.length,
    },
  ];
  const tabs = showClauses ? allTabs : allTabs.filter((tab) => tab.key !== "clauses");

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex border-b border-slate-200">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={[
              "flex flex-1 items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-semibold transition",
              activeTab === tab.key
                ? "border-b-2 border-blue-600 text-blue-700"
                : "border-b-2 border-transparent text-slate-500 hover:text-slate-800",
            ].join(" ")}
          >
            <tab.icon className="h-3.5 w-3.5" />
            {tab.label}
            {tab.count > 0 && (
              <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="p-4">
        {activeTab === "clauses" &&
          (clauses.length > 0 ? (
            <ClauseList
              clauses={clauses}
              onViewSource={onViewClauseSource}
            />
          ) : (
            <ExtractPrompt
              label="Clauses"
              extracting={extractingClauses}
              error={clausesError}
              onExtract={onExtractClauses}
            />
          ))}

        {activeTab === "tables" &&
          (tables.length > 0 ? (
            <RateCardTable tables={tables} />
          ) : (
            <ExtractPrompt
              label="Tables"
              extracting={extractingTables}
              error={tablesError}
              onExtract={onExtractTables}
            />
          ))}

        {activeTab === "signatures" &&
          (signatures.length > 0 ? (
            <SignatureList
              signatures={signatures}
              onViewSource={onViewSignatureSource}
            />
          ) : (
            <ExtractPrompt
              label="Signatures"
              extracting={extractingSignatures}
              error={signaturesError}
              onExtract={onExtractSignatures}
            />
          ))}
      </div>
    </div>
  );
}

function ExtractPrompt({
  label,
  extracting,
  error,
  onExtract,
}: {
  label: string;
  extracting: boolean;
  error: string;
  onExtract: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 py-6 text-center">
      <p className="text-xs text-slate-500">
        No {label.toLowerCase()} extracted for this document yet.
      </p>

      <button
        type="button"
        onClick={onExtract}
        disabled={extracting}
        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <Sparkles className="h-3.5 w-3.5" />
        {extracting ? `Extracting ${label}...` : `Extract ${label}`}
      </button>

      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  );
}
