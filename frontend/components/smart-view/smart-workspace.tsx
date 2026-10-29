"use client";

import { Brain, FileText, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import ContractSmartView, { type CategoryId, type SelectedRecord } from "@/components/smart-view/contract-smart-view";
import { MAPPING_LABEL, MAPPING_TONE, useOracleMappings, type CategoryMapping } from "@/components/smart-view/oracle-status";
import { ReviewSignals } from "@/components/smart-view/review-indicators";
import SchemaForm from "@/components/schemas/schema-form";
import SourceVerificationPanel, { type SourceViewRequest } from "@/components/source-verification-panel";
import { getClassification, LEVEL_LABELS, STATUS_LABELS, type ClassificationState } from "@/lib/classification";
import { documentForm, type DocumentForm, type FormValue } from "@/lib/doc-schemas";
import { getStagingRecord, type StagingRecord, type StagingWorkbook } from "@/lib/staging-workbook";

interface Layout {
  source: boolean;
  intel: boolean;
  sourceWidth: number;
  intelWidth: number;
}
const LAYOUT_KEY = "dx-smart-layout";
const DEFAULT_LAYOUT: Layout = { source: true, intel: true, sourceWidth: 420, intelWidth: 320 };

function useLayout(): [Layout, (patch: Partial<Layout>) => void] {
  const [layout, setLayout] = useState<Layout>(DEFAULT_LAYOUT);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(LAYOUT_KEY);
      if (raw) queueMicrotask(() => setLayout({ ...DEFAULT_LAYOUT, ...JSON.parse(raw) }));
    } catch {
      // keep defaults
    }
  }, []);
  const update = useCallback((patch: Partial<Layout>) => {
    setLayout((current) => {
      const next = { ...current, ...patch };
      try {
        window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
      } catch {
        // storage blocked
      }
      return next;
    });
  }, []);
  return [layout, update];
}

function useWide(): boolean {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(min-width: 1280px)");
    const update = () => setWide(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);
  return wide;
}

function Resizer({ onDrag, label }: { onDrag: (dx: number) => void; label: string }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") onDrag(-24);
        if (e.key === "ArrowRight") onDrag(24);
      }}
      onPointerDown={(e) => {
        e.preventDefault();
        let last = e.clientX;
        const move = (ev: PointerEvent) => {
          onDrag(ev.clientX - last);
          last = ev.clientX;
        };
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
      className="w-1.5 shrink-0 cursor-col-resize rounded bg-transparent hover:bg-primary/30 focus-visible:bg-primary/40 focus-visible:outline-none"
    />
  );
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/**
 * Smart View: the right layout for the document type — source on the
 * left, the organised data in the middle, review signals and Oracle
 * mapping on the right. Contracts get the Contract Intelligence Workspace;
 * every other type gets the review form its schema defines.
 */
export default function SmartWorkspace({
  documentId,
  workbook,
  filename,
  pageCount,
}: {
  documentId: string;
  workbook: StagingWorkbook;
  filename: string;
  pageCount: number;
}) {
  const [layout, setLayout] = useLayout();
  const wide = useWide();
  const [drawer, setDrawer] = useState<"source" | "intel" | null>(null);
  const [category, setCategory] = useState<CategoryId>("overview");
  const [selected, setSelected] = useState<SelectedRecord | null>(null);
  const [full, setFull] = useState<StagingRecord | null>(null);
  const [request, setRequest] = useState<SourceViewRequest | null>(null);
  const [classification, setClassification] = useState<ClassificationState | null>(null);
  const isContract = workbook.profile.profile_id === "contract_v3";
  const mappings = useOracleMappings(documentId, workbook.profile.profile_id);

  useEffect(() => {
    let active = true;
    getClassification(documentId).then((c) => active && setClassification(c)).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [documentId]);

  // A selected record: load it in full (evidence, validation) and open its page.
  useEffect(() => {
    if (!selected) return;
    let active = true;
    const fallback = selected.record;
    const open = (record: StagingRecord) => {
      if (!active) return;
      setFull(record);
      const cell = Object.values(record.cells).find((c) => c.provenance?.source_page && c.provenance.source_page > 0 && c.value != null);
      const provenance = cell?.provenance;
      if (provenance?.source_page) {
        setRequest({
          id: `${selected.datasetId}:${record.record_id}`,
          pageNumber: provenance.source_page,
          highlightText: provenance.highlight_text ?? (cell?.value != null ? String(cell.value) : null),
          anchorText: provenance.anchor_text ?? null,
          label: selected.title,
          value: cell?.value != null ? String(cell.value) : undefined,
          reviewStatus: record.record_status,
          extractionMethod: provenance.extraction_method ?? null,
        });
      }
    };
    getStagingRecord(documentId, selected.datasetId, selected.record.record_id)
      .then((loaded) => open(loaded ?? fallback))
      .catch(() => open(fallback));
    return () => {
      active = false;
    };
  }, [documentId, selected]);

  const select = (selection: SelectedRecord) => {
    setSelected(selection);
    if (!wide) setDrawer("source");
  };

  const sourcePanel = (
    <div className="h-full min-h-[520px]" data-testid="smart-source">
      {request ? (
        <SourceVerificationPanel documentId={documentId} documentName={filename} pageCount={pageCount} request={request} />
      ) : (
        <div className="flex h-full min-h-[520px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border px-6 text-center text-sm text-text-muted">
          <FileText className="h-6 w-6" aria-hidden="true" />
          Select a record to see where it is in the document.
        </div>
      )}
    </div>
  );

  const intelPanel = (
    <IntelligencePanel
      selected={selected}
      full={full}
      classification={classification}
      mappings={mappings}
      category={category}
      documentId={documentId}
    />
  );

  const center = isContract ? (
    <ContractSmartView documentId={documentId} workbook={workbook} category={category} onCategory={setCategory}
      onSelect={select} selectedId={selected?.record.record_id ?? null} mappings={mappings} />
  ) : (
    <GenericSmartView documentId={documentId} onEvidence={(value, label) => {
      if (!value.page) return;
      setRequest({ pageNumber: value.page, highlightText: value.highlight, label, value: value.value, anchorText: value.document_label });
      if (!wide) setDrawer("source");
    }} />
  );

  return (
    <div className="mt-4" data-testid="smart-workspace">
      <div className="mb-3 flex items-center gap-2 text-xs">
        <button type="button" onClick={() => (wide ? setLayout({ source: !layout.source }) : setDrawer("source"))} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 hover:bg-surface-soft" aria-pressed={wide ? layout.source : undefined}>
          {wide && layout.source ? <PanelLeftClose className="h-3.5 w-3.5" /> : <PanelLeftOpen className="h-3.5 w-3.5" />}Source
        </button>
        <button type="button" onClick={() => (wide ? setLayout({ intel: !layout.intel }) : setDrawer("intel"))} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 hover:bg-surface-soft" aria-pressed={wide ? layout.intel : undefined}>
          {wide && layout.intel ? <PanelRightClose className="h-3.5 w-3.5" /> : <PanelRightOpen className="h-3.5 w-3.5" />}Intelligence
        </button>
      </div>

      {wide ? (
        <div className="flex items-start gap-1">
          {layout.source && (
            <>
              <aside className="sticky top-4 shrink-0" style={{ width: layout.sourceWidth }} aria-label="Source document">{sourcePanel}</aside>
              <Resizer label="Resize source panel" onDrag={(dx) => setLayout({ sourceWidth: clamp(layout.sourceWidth + dx, 300, 820) })} />
            </>
          )}
          <main className="min-w-0 flex-1 px-1" aria-label="Extracted data">{center}</main>
          {layout.intel && (
            <>
              <Resizer label="Resize intelligence panel" onDrag={(dx) => setLayout({ intelWidth: clamp(layout.intelWidth - dx, 260, 520) })} />
              <aside className="sticky top-4 shrink-0" style={{ width: layout.intelWidth }} aria-label="Intelligence and mapping">{intelPanel}</aside>
            </>
          )}
        </div>
      ) : (
        <>
          <main aria-label="Extracted data">{center}</main>
          {drawer && (
            <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={drawer === "source" ? "Source document" : "Intelligence"}>
              <button type="button" aria-label="Close" tabIndex={-1} className="flex-1 bg-black/25" onClick={() => setDrawer(null)} />
              <aside className="flex h-full w-full max-w-xl flex-col bg-surface shadow-xl">
                <div className="flex border-b border-border" role="tablist">
                  {(["source", "intel"] as const).map((id) => (
                    <button key={id} type="button" role="tab" aria-selected={drawer === id} onClick={() => setDrawer(id)}
                      className={`flex-1 border-b-2 py-2 text-xs font-medium ${drawer === id ? "border-primary" : "border-transparent text-text-secondary"}`}>
                      {id === "source" ? "Source" : "Intelligence"}
                    </button>
                  ))}
                  <button type="button" aria-label="Close panel" onClick={() => setDrawer(null)} className="px-3 text-text-secondary"><X className="h-4 w-4" /></button>
                </div>
                <div className="flex-1 overflow-y-auto p-3">{drawer === "source" ? sourcePanel : intelPanel}</div>
              </aside>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function GenericSmartView({ documentId, onEvidence }: { documentId: string; onEvidence: (value: FormValue, label: string) => void }) {
  const [data, setData] = useState<DocumentForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    documentForm(documentId).then((d) => active && setData(d)).catch((e) => active && setError(e instanceof Error ? e.message : "Unable to build the view."));
    return () => {
      active = false;
    };
  }, [documentId]);
  if (error) return <p className="text-sm text-danger" role="alert">{error}</p>;
  if (!data) return <p className="text-sm text-text-muted">Organising the document…</p>;
  return (
    <div data-testid="generic-smart-view">
      <p className="mb-2 text-xs text-text-secondary">
        Organised by the <Link href={`/schemas/${data.schema_id}?version=${data.version_id}`} className="text-primary hover:underline">{data.schema_name} v{data.version}</Link> schema.
      </p>
      <SchemaForm form={data.form} onEvidence={onEvidence} />
    </div>
  );
}

function IntelligencePanel({ selected, full, classification, mappings, category, documentId }: {
  selected: SelectedRecord | null;
  full: StagingRecord | null;
  classification: ClassificationState | null;
  mappings: CategoryMapping[] | null;
  category: CategoryId;
  documentId: string;
}) {
  const relevant = (mappings ?? []).filter((m) => m.category === (selected?.category ?? category));
  const fields = full ? Object.values(full.cells).filter((c) => c.value != null && String(c.value).trim()) : [];
  return (
    <div className="space-y-4 rounded-xl border border-border bg-surface p-3 text-sm" data-testid="intelligence-panel">
      <section>
        <h3 className="mb-1 flex items-center gap-1.5 text-[13px] font-semibold"><Brain className="h-4 w-4 text-primary" aria-hidden="true" />{selected ? selected.title : "No record selected"}</h3>
        {full ? <ReviewSignals record={full} /> : <p className="text-xs text-text-muted">Select a record to see its evidence, validation and review status.</p>}
      </section>
      {full && fields.length > 0 && (
        <section>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Extracted values</p>
          <dl className="max-h-64 space-y-1 overflow-y-auto text-xs" data-testid="record-values">
            {fields.map((c) => (
              <div key={c.canonical_field}>
                <dt className="text-text-secondary">{c.display_label}</dt>
                <dd className="whitespace-pre-wrap break-words text-foreground">{String(c.value)}</dd>
              </div>
            ))}
          </dl>
          <Link href={`/documents/${documentId}/review`} className="mt-1 inline-block text-xs text-primary hover:underline">Correct a value in Metadata review</Link>
        </section>
      )}
      <section>
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Classification</p>
        {classification ? (
          <p className="text-xs">
            {classification.family_label}{classification.subtype ? ` — ${classification.subtype}` : ""}
            <span className="block text-text-secondary">{STATUS_LABELS[classification.status]} · confidence {LEVEL_LABELS[classification.confidence_level]}</span>
          </p>
        ) : <p className="text-xs text-text-muted">—</p>}
      </section>
      <section>
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Oracle mapping</p>
        {relevant.length ? relevant.map((m) => (
          <p key={m.profile.id} className="text-xs">
            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${MAPPING_TONE[m.state]}`}>{MAPPING_LABEL[m.state]}</span>{" "}
            {m.template.object_name} · {m.mapped}/{m.columns} columns
            <Link href={`/mapping/designer?template=${m.template.id}&document=${documentId}`} className="ml-1 text-primary hover:underline">Open</Link>
          </p>
        )) : (
          <p className="text-xs text-text-muted">
            {["clauses", "deliveries", "attachments", "sections"].includes(selected?.category ?? category)
              ? "No Verified Oracle Import Destination"
              : "No saved mapping for this category."}
          </p>
        )}
      </section>
    </div>
  );
}
