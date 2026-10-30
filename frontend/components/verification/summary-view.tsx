"use client";

import { useEffect, useState } from "react";

import ClassificationPanel from "@/components/classification/classification-panel";
import type { SourceViewRequest } from "@/components/source-verification-panel";
import { getClassification, type ClassificationState } from "@/lib/classification";
import type { OriginalStructure } from "@/lib/original-structure";
import { getDocumentDates, type BusinessData, type DocumentDates, type ValidationSummary } from "@/lib/verification";

const STATUS_TONE: Record<string, string> = {
  Active: "bg-success/10 text-success",
  "Expiring Soon": "bg-warning/10 text-warning",
  Expired: "bg-danger/10 text-danger",
  "Not Applicable": "bg-surface-soft text-text-secondary",
  Unknown: "bg-surface-soft text-text-secondary",
};

function Card({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="rounded-xl border border-border bg-surface p-4 text-xs" data-testid={testId}>
      <h3 className="mb-2 text-sm font-semibold text-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-2 py-0.5">
      <dt className="text-text-secondary">{label}</dt>
      <dd className="min-w-0 break-words text-foreground">{children}</dd>
    </div>
  );
}

/** The document at a glance: what it is (and whether a person confirmed
 * that), its dates and expiration status, and what still needs review. */
export default function SummaryView({ documentId, business, structure, validation, onClassificationChanged, onViewSource }: {
  documentId: string;
  business: BusinessData | null;
  structure: OriginalStructure | null;
  validation: ValidationSummary | null;
  onClassificationChanged: () => void;
  onViewSource: (request: SourceViewRequest) => void;
}) {
  const [classification, setClassification] = useState<ClassificationState | null>(null);
  const [dates, setDates] = useState<DocumentDates | null>(null);
  const [warningDays, setWarningDays] = useState<number | undefined>(undefined);
  const [changing, setChanging] = useState(false);

  useEffect(() => {
    let active = true;
    getClassification(documentId).then((state) => active && setClassification(state)).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [documentId, business]);

  useEffect(() => {
    let active = true;
    getDocumentDates(documentId, warningDays).then((result) => active && setDates(result)).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [documentId, warningDays, business]);

  const required = business?.sections.flatMap((s) => s.fields.filter((f) => f.required)) ?? [];

  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-2" data-testid="summary-tab">
      <Card title="Classification" testId="summary-classification">
        {classification ? (
          <dl>
            <Row label="Category">{classification.document_class_label ?? classification.category_label}</Row>
            <Row label="Document type">{classification.family_label}</Row>
            <Row label="Subtype">{classification.subtype ?? <span className="text-text-muted">Not stated in the document</span>}</Row>
            <Row label="Confidence">{classification.confidence != null ? `${Math.round(classification.confidence * 100)}% (${classification.confidence_level})` : "—"}</Row>
            <Row label="Method">{classification.method}</Row>
            <Row label="Evidence">{classification.evidence.slice(0, 3).join("; ") || "—"}</Row>
            <Row label="Review status">
              <span className={classification.review_status === "Confirmed" ? "text-success" : "text-warning"}>
                {classification.review_status ?? (classification.decided ? "Confirmed" : "Not reviewed")}
              </span>
              {classification.decided_by && <span className="text-text-muted"> · {classification.decided_by}</span>}
            </Row>
          </dl>
        ) : (
          <p className="text-text-muted">Loading…</p>
        )}
        <button type="button" className="btn-secondary mt-2 px-2.5 py-1 text-xs" aria-expanded={changing} onClick={() => setChanging((v) => !v)}>
          {changing ? "Close" : "Confirm or change the document type"}
        </button>
        {changing && (
          <div className="mt-3 border-t border-border pt-3">
            <ClassificationPanel documentId={documentId} onChanged={(state) => { setClassification(state); onClassificationChanged(); }} />
          </div>
        )}
      </Card>

      <Card title="Dates and expiration" testId="summary-dates">
        {dates ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_TONE[dates.status]}`} data-testid="expiration-status">{dates.status}</span>
              <span className="text-text-secondary">{dates.reason}</span>
              <label className="ml-auto flex items-center gap-1 text-text-secondary">
                Warn
                <select aria-label="Expiring soon threshold" value={dates.warning_days}
                  onChange={(event) => setWarningDays(Number(event.target.value))}
                  className="rounded-md border border-border bg-surface px-1 py-0.5">
                  {[30, 60, 90, 180].map((days) => <option key={days} value={days}>{days} days</option>)}
                </select>
                ahead
              </label>
            </div>
            {dates.dates.length === 0 ? (
              <p className="mt-2 text-text-muted">No dates were identified.</p>
            ) : (
              <table className="mt-2 w-full">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-text-secondary">
                    <th scope="col" className="py-1 pr-2 font-semibold">Meaning</th>
                    <th scope="col" className="py-1 pr-2 font-semibold">Date</th>
                    <th scope="col" className="py-1 pr-2 font-semibold">Basis</th>
                    <th scope="col" className="py-1 font-semibold">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {dates.dates.map((d, index) => (
                    <tr key={index} className="border-t border-border/60 align-top">
                      <td className="py-1 pr-2 text-text-secondary">{d.role_label}</td>
                      <td className={`py-1 pr-2 ${d.valid ? "text-foreground" : "text-danger"}`}>{d.text}{!d.valid && d.role !== "period" ? " (unreadable)" : ""}</td>
                      <td className="py-1 pr-2">{d.basis === "inferred" ? <span className="text-warning">Inferred{d.inferred_from ? ` from ${d.inferred_from}` : ""}</span> : "Explicit"}</td>
                      <td className="py-1">
                        {d.page ? (
                          <button type="button" className="text-primary hover:underline"
                            onClick={() => onViewSource({ pageNumber: d.page!, highlightText: d.text, label: d.label, value: d.text })}>
                            {d.label} · p. {d.page}
                          </button>
                        ) : d.label}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        ) : (
          <p className="text-text-muted">Loading…</p>
        )}
      </Card>

      <Card title="Review status" testId="summary-review">
        <dl>
          <Row label="Skill">{business?.skill ? `${business.skill.name} v${business.skill.version}` : "None — organized by the document's own sections"}</Row>
          <Row label="Required fields">{required.length ? `${required.filter((f) => f.value).length} of ${required.length} found` : "—"}</Row>
          <Row label="Exceptions">{validation ? `${validation.counts.errors} errors · ${validation.counts.warnings} warnings` : "—"}</Row>
          <Row label="Layout">{structure ? `${structure.stats.sections} sections · ${structure.stats.fields} fields · ${structure.stats.tables} tables (${structure.stats.table_rows} rows)` : "—"}</Row>
        </dl>
      </Card>

      {required.length > 0 && (
        <Card title="Key values">
          <dl>
            {required.map((field) => (
              <Row key={field.key} label={field.label}>
                {field.value ?? <span className="text-danger">Not found</span>}
                {field.review_status && <span className="text-text-muted"> · {field.review_status}</span>}
              </Row>
            ))}
          </dl>
        </Card>
      )}
    </div>
  );
}
