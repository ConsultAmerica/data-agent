"use client";

import { Brain, PanelLeftOpen, PanelRightClose, PanelRightOpen, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import ContractSmartView, { NO_DESTINATION, type CategoryId, type SelectedRecord } from "@/components/smart-view/contract-smart-view";
import { MAPPING_LABEL, MAPPING_TONE, useOracleMappings, type CategoryMapping } from "@/components/smart-view/oracle-status";
import DocumentIntelligenceCard from "@/components/document-intelligence/document-intelligence-card";
import FieldDetails from "@/components/smart-view/field-details";
import RecordDetails, { sourceRequestFor } from "@/components/smart-view/record-details";
import SourceFileCard from "@/components/smart-view/source-file-card";
import SchemaForm from "@/components/schemas/schema-form";
import { type SourceViewRequest } from "@/components/source-verification-panel";
import DocumentViewer from "@/components/viewers/document-viewer";
import { documentForm, type DocumentForm, type FormField, type FormValue } from "@/lib/doc-schemas";
import { useReviewMutationsEnabled } from "@/lib/review-gate";
import { getStagingRecord, type StagingRecord, type StagingWorkbook } from "@/lib/staging-workbook";
import type { UploadedDocument } from "@/types/document";

type LayoutMode = "split" | "source" | "data";

interface Layout {
  /** Split view (document beside the data), the document alone, or the
   * data alone. */
  mode: LayoutMode;
  source: boolean;
  intel: boolean;
  sourceWidth: number;
  intelWidth: number;
}
const LAYOUT_KEY = "dx-smart-layout";
const DEFAULT_LAYOUT: Layout = { mode: "split", source: true, intel: true, sourceWidth: 420, intelWidth: 320 };
const MODE_LABEL: Record<LayoutMode, string> = { split: "Split view", source: "Source only", data: "Data only" };

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
  document = null,
}: {
  documentId: string;
  workbook: StagingWorkbook;
  filename: string;
  pageCount: number;
  /** The document record (format, encoding, origin) when loaded. */
  document?: UploadedDocument | null;
}) {
  const [layout, setLayout] = useLayout();
  const wide = useWide();
  const [drawer, setDrawer] = useState<"source" | "intel" | null>(null);
  const [category, setCategory] = useState<CategoryId>("overview");
  const [selected, setSelected] = useState<SelectedRecord | null>(null);
  // A schema field chosen in the form view (invoices, IDs, transcripts…).
  const [selectedField, setSelectedField] = useState<FormField | null>(null);
  const [full, setFull] = useState<StagingRecord | null>(null);
  const [request, setRequest] = useState<SourceViewRequest | null>(null);
  const isContract = workbook.profile.profile_id === "contract_v3";
  const mappings = useOracleMappings(documentId, workbook.profile.profile_id);
  const reviewEnabled = useReviewMutationsEnabled();

  // A selected record: load it in full (evidence, validation) and open its page.
  useEffect(() => {
    if (!selected) return;
    let active = true;
    const fallback = selected.record;
    const open = (record: StagingRecord) => {
      if (!active) return;
      setFull(record);
      const source = sourceRequestFor(selected, record);
      if (source) setRequest(source.request);
    };
    getStagingRecord(documentId, selected.datasetId, selected.record.record_id)
      .then((loaded) => open(loaded ?? fallback))
      .catch(() => open(fallback));
    return () => {
      active = false;
    };
  }, [documentId, selected]);

  // Selecting a record opens its details (the panel on wide screens, the
  // drawer on narrow ones); "View in source" then shows its page.
  const select = (selection: SelectedRecord) => {
    setSelected(selection);
    if (wide) {
      if (!layout.intel) setLayout({ intel: true });
    } else {
      setDrawer("intel");
    }
  };
  const closeDetails = () => {
    setSelected(null);
    setFull(null);
  };
  const viewSource = (next: SourceViewRequest) => {
    setRequest({ ...next });
    if (wide) {
      if (!layout.source || layout.mode === "data") setLayout({ source: true, mode: "split" });
    } else {
      setDrawer("source");
    }
  };
  const loading = selected != null && full?.record_id !== selected.record.record_id;

  // The original document in the viewer its format calls for; the
  // selected record's evidence is passed in as the request.
  const sourcePanel = (
    <div className="h-[78vh] min-h-[520px]" data-testid="smart-source">
      <DocumentViewer documentId={documentId} documentName={filename} pageCount={pageCount} request={request} />
    </div>
  );

  const intelPanel = (
    <IntelligencePanel
      selected={selected}
      full={loading ? null : full}
      loading={loading}
      mappings={mappings}
      category={category}
      documentId={documentId}
      documentName={filename}
      document={document}
      reviewEnabled={reviewEnabled}
      onViewSource={viewSource}
      onClose={closeDetails}
      selectedField={selectedField}
      onCloseField={() => setSelectedField(null)}
      isContract={isContract}
    />
  );

  const center = isContract ? (
    <ContractSmartView documentId={documentId} workbook={workbook} category={category} onCategory={setCategory}
      onSelect={select} selectedId={selected?.record.record_id ?? null} mappings={mappings} />
  ) : (
    <GenericSmartView
      documentId={documentId}
      selectedFieldId={selectedField?.field_id ?? null}
      onEvidence={(value, label) => {
        if (!value.page) return;
        setRequest({ pageNumber: value.page, highlightText: value.highlight, label, value: value.value, anchorText: value.document_label });
        if (!wide) setDrawer("source");
      }}
      onSelectField={(field) => {
        // A field: its details beside the form, and its page in the source.
        setSelectedField(field);
        if (wide) {
          if (!layout.intel) setLayout({ intel: true });
        }
        const value = field.value;
        if (value.page) {
          setRequest({ pageNumber: value.page, highlightText: value.highlight, label: field.label, value: value.value, anchorText: value.document_label });
          if (wide && (!layout.source || layout.mode === "data")) setLayout({ source: true, mode: "split" });
        }
        if (!wide) setDrawer("intel");
      }}
    />
  );

  return (
    <div className="mt-4" data-testid="smart-workspace">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        {wide ? (
          <div className="inline-flex overflow-hidden rounded-md border border-border" role="radiogroup" aria-label="Layout">
            {(["split", "source", "data"] as const).map((mode) => (
              <button key={mode} type="button" role="radio" aria-checked={layout.mode === mode}
                onClick={() => setLayout({ mode, ...(mode === "split" ? { source: true } : {}) })}
                className={`px-2.5 py-1 ${layout.mode === mode ? "bg-primary-soft font-medium text-primary" : "hover:bg-surface-soft"}`}>
                {MODE_LABEL[mode]}
              </button>
            ))}
          </div>
        ) : (
          <button type="button" onClick={() => setDrawer("source")} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 hover:bg-surface-soft">
            <PanelLeftOpen className="h-3.5 w-3.5" />Source
          </button>
        )}
        {(!wide || layout.mode !== "source") && (
          <button type="button" onClick={() => (wide ? setLayout({ intel: !layout.intel }) : setDrawer("intel"))} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 hover:bg-surface-soft" aria-pressed={wide ? layout.intel : undefined}>
            {wide && layout.intel ? <PanelRightClose className="h-3.5 w-3.5" /> : <PanelRightOpen className="h-3.5 w-3.5" />}Intelligence
          </button>
        )}
      </div>

      {wide ? (
        <div className="flex items-start gap-1" data-layout={layout.mode}>
          {layout.mode === "source" ? (
            <aside className="min-w-0 flex-1" aria-label="Source document">{sourcePanel}</aside>
          ) : layout.mode === "split" && layout.source && (
            <>
              <aside className="sticky top-4 shrink-0" style={{ width: layout.sourceWidth }} aria-label="Source document">{sourcePanel}</aside>
              <Resizer label="Resize source panel" onDrag={(dx) => setLayout({ sourceWidth: clamp(layout.sourceWidth + dx, 300, 820) })} />
            </>
          )}
          {layout.mode !== "source" && <main className="min-w-0 flex-1 px-1" aria-label="Extracted data">{center}</main>}
          {layout.mode !== "source" && layout.intel && (
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

function GenericSmartView({ documentId, onEvidence, onSelectField, selectedFieldId }: {
  documentId: string;
  onEvidence: (value: FormValue, label: string) => void;
  onSelectField: (field: FormField) => void;
  selectedFieldId: string | null;
}) {
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
      <SchemaForm form={data.form} onEvidence={onEvidence} onSelectField={onSelectField} selectedFieldId={selectedFieldId} />
    </div>
  );
}

function IntelligencePanel({ selected, full, loading, mappings, category, documentId, documentName, document, reviewEnabled, onViewSource, onClose, selectedField, onCloseField, isContract }: {
  selected: SelectedRecord | null;
  full: StagingRecord | null;
  loading: boolean;
  mappings: CategoryMapping[] | null;
  category: CategoryId;
  documentId: string;
  documentName: string;
  document: UploadedDocument | null;
  reviewEnabled: boolean;
  onViewSource: (request: SourceViewRequest) => void;
  onClose: () => void;
  selectedField: FormField | null;
  onCloseField: () => void;
  isContract: boolean;
}) {
  const relevant = (mappings ?? []).filter((m) => m.category === category);
  return (
    <div className="space-y-4 rounded-xl border border-border bg-surface p-3 text-sm" data-testid="intelligence-panel">
      {selected ? (
        <RecordDetails key={`${selected.datasetId}:${selected.record.record_id}`} selection={selected} record={full} loading={loading} mappings={mappings} documentId={documentId}
          documentName={documentName} reviewEnabled={reviewEnabled} onViewSource={onViewSource} onClose={onClose} />
      ) : selectedField ? (
        <FieldDetails key={selectedField.field_id} field={selectedField} documentId={documentId} onViewSource={onViewSource} onClose={onCloseField} />
      ) : (
        <>
          <section>
            <h3 className="mb-1 flex items-center gap-1.5 text-[13px] font-semibold"><Brain className="h-4 w-4 text-primary" aria-hidden="true" />{isContract ? "No record selected" : "No field selected"}</h3>
            <p className="text-xs text-text-muted">
              {isContract
                ? "Select a record to see its full values, source evidence, validation, review status and Oracle mapping."
                : "Select a field card to see its value, how it was found, and where it is in the document."}
            </p>
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
                {NO_DESTINATION.includes(category)
                  ? "No Verified Oracle Import Destination"
                  : "No saved mapping for this category."}
              </p>
            )}
          </section>
        </>
      )}
      <DocumentIntelligenceCard documentId={documentId} onViewSource={onViewSource} />
      <SourceFileCard document={document} />
    </div>
  );
}
