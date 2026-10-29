"use client";

import { ExternalLink, FileText, Layers, ListOrdered, ScrollText, Truck, Users } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import SmartDataGrid, { type GridColumn, type GridRow } from "@/components/smart-view/smart-data-grid";
import { EvidenceBadge } from "@/components/smart-view/review-indicators";
import { MAPPING_LABEL, MAPPING_TONE, type CategoryMapping } from "@/components/smart-view/oracle-status";
import type { StagingDataset, StagingRecord, StagingWorkbook } from "@/lib/staging-workbook";

/**
 * Contract Intelligence Workspace: the contract's records, by category,
 * each with only the columns that category needs. Every record stays
 * reachable (All Records). Values are shown as extracted — derived
 * displays (regulation from the section, a line's performance period from
 * its delivery records) are labelled as such and never stored.
 */

export type CategoryId = "overview" | "header" | "lines" | "parties" | "deliveries" | "clauses" | "sections" | "attachments" | "all" | "oracle";

export interface SelectedRecord {
  datasetId: string;
  record: StagingRecord;
  category: CategoryId;
  title: string;
}

const CATEGORY_LABEL: Record<CategoryId, string> = {
  overview: "Overview",
  header: "Contract Header",
  lines: "Contract Lines",
  parties: "Parties & Contacts",
  deliveries: "Deliveries & Performance",
  clauses: "FAR/DFARS Clauses",
  sections: "Sections A–J",
  attachments: "Attachments",
  all: "All Records",
  oracle: "Oracle Mapping",
};
const NO_DESTINATION: CategoryId[] = ["clauses", "deliveries", "attachments", "sections"];

const DATA = "contract_data";
const slot = (key: string) => `contract.data.${key}`;

function value(record: StagingRecord, key: string): string {
  const v = record.cells[slot(key)]?.value;
  return v == null ? "" : String(v);
}

/** Which category a Contract Data record belongs to (section first). */
export function categoryOf(record: StagingRecord): CategoryId | null {
  const section = value(record, "section");
  const kind = value(record, "record_type");
  if (kind === "Field") return section === "Parties" || /contact/i.test(section) ? "parties" : "header";
  if (section === "CLINs" || kind === "CLIN") return "lines";
  if (/claus/i.test(section) || kind === "Clause" || kind === "Alternate") return "clauses";
  if (section === "FAR References") return "clauses";
  if (section === "Delivery" || section === "Performance" || kind === "Delivery") return "deliveries";
  if (section === "Contract Sections") return "sections";
  if (section === "Attachments" || kind === "Attachment") return "attachments";
  if (section === "Pricing & Funding") return "header";
  return null;
}

function rowOf(record: StagingRecord, extra: Record<string, string> = {}): GridRow {
  const values: Record<string, string> = {};
  for (const [field, cell] of Object.entries(record.cells)) {
    if (cell?.value != null) values[field.replace("contract.data.", "")] = String(cell.value);
  }
  return { id: record.record_id, values: { ...values, ...extra }, status: record.record_status };
}

/** Columns from the slots the dataset has, labelled as the dataset labels them. */
function columnsFor(dataset: StagingDataset, spec: (Omit<GridColumn, "label"> & { label?: string; any?: string[] })[]): GridColumn[] {
  const labels = new Map(dataset.columns.map((c) => [c.key, c.display_label]));
  const out: GridColumn[] = [];
  for (const item of spec) {
    const key = [item.key, ...(item.any ?? [])].find((k) => labels.has(k) || k.startsWith("__"));
    if (!key || out.some((c) => c.key === key)) continue;
    out.push({ ...item, key, label: item.label ?? labels.get(key) ?? key });
  }
  return out;
}

function regulationFromSection(section: string): string {
  if (/dfars/i.test(section)) return "DFARS";
  if (/far/i.test(section)) return "FAR";
  return section ? "Other" : "";
}

export default function ContractSmartView({
  documentId,
  workbook,
  category,
  onCategory,
  onSelect,
  selectedId,
  mappings,
}: {
  documentId: string;
  workbook: StagingWorkbook;
  category: CategoryId;
  onCategory: (id: CategoryId) => void;
  onSelect: (selection: SelectedRecord) => void;
  selectedId: string | null;
  mappings: CategoryMapping[] | null;
}) {
  const data = workbook.datasets.find((d) => d.dataset_id === DATA);
  const overview = workbook.datasets.find((d) => d.dataset_id === "contract_overview");
  const clinDetails = workbook.datasets.find((d) => d.dataset_id === "clins");
  const records = useMemo(() => data?.records ?? [], [data]);

  const groups = useMemo(() => {
    const map = new Map<CategoryId, StagingRecord[]>();
    for (const record of records) {
      const id = categoryOf(record);
      if (id) map.set(id, [...(map.get(id) ?? []), record]);
    }
    return map;
  }, [records]);

  const deliveriesByClin = useMemo(() => {
    const map = new Map<string, StagingRecord[]>();
    for (const record of groups.get("deliveries") ?? []) {
      const clin = value(record, "record_id") || value(record, "clin");
      if (clin) map.set(clin, [...(map.get(clin) ?? []), record]);
    }
    return map;
  }, [groups]);

  if (!data) return <p className="text-sm text-text-muted">This contract has no Contract Data to organise.</p>;

  const count = (id: CategoryId) => (id === "all" ? records.length : id === "header" ? (groups.get("header")?.length ?? 0) + (overview?.records.length ?? 0) : groups.get(id)?.length ?? 0);
  const clauses = (groups.get("clauses") ?? []).filter((r) => value(r, "section") !== "FAR References");
  const regulationCount = (name: string) => clauses.filter((r) => (value(r, "regulation") || regulationFromSection(value(r, "section"))) === name).length;
  const needsReview = records.filter((r) => r.record_status === "Needs Review").length;
  const select = (category: CategoryId) => (row: GridRow) => {
    const record = records.find((r) => r.record_id === row.id) ?? null;
    if (record) onSelect({ datasetId: DATA, record, category, title: row.values.record_id || row.values.title || row.id });
  };
  const status = (s: string | null | undefined) => <EvidenceBadge status={s} />;
  const nav: CategoryId[] = ["overview", "header", "lines", "parties", "deliveries", "clauses", "sections", "attachments", "all", "oracle"];

  return (
    <div className="min-w-0" data-testid="contract-smart-view">
      <nav className="scrollbar-none -mx-1 mb-4 flex gap-1 overflow-x-auto border-b border-border px-1" aria-label="Contract categories" role="tablist">
        {nav.map((id) => {
          const n = count(id);
          const empty = n === 0 && !["overview", "oracle", "all"].includes(id);
          return (
            <button key={id} type="button" role="tab" aria-selected={category === id} onClick={() => onCategory(id)}
              className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-[13px] font-medium ${category === id ? "border-primary text-foreground" : "border-transparent text-text-secondary hover:text-foreground"} ${empty ? "opacity-60" : ""}`}
              title={empty ? "None found in this document" : undefined}>
              {CATEGORY_LABEL[id]}
              {!["overview", "oracle"].includes(id) && <span className="ml-1.5 tabular-nums text-text-muted">{n.toLocaleString()}</span>}
            </button>
          );
        })}
      </nav>

      {category === "overview" && (
        <div className="space-y-5" data-testid="contract-overview">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <MetricCard icon={Layers} label="Contract data records" value={records.length} onClick={() => onCategory("all")} />
            <MetricCard icon={ListOrdered} label="Contract lines" value={count("lines")} onClick={() => onCategory("lines")} />
            <MetricCard icon={ScrollText} label="FAR / DFARS clauses" value={clauses.length} detail={`${regulationCount("FAR")} FAR · ${regulationCount("DFARS")} DFARS · ${clauses.length - regulationCount("FAR") - regulationCount("DFARS")} other`} onClick={() => onCategory("clauses")} />
            <MetricCard icon={Truck} label="Delivery & performance records" value={count("deliveries")} onClick={() => onCategory("deliveries")} />
            <MetricCard icon={Users} label="Parties & contacts" value={count("parties")} onClick={() => onCategory("parties")} />
            <MetricCard icon={FileText} label="Records needing review" value={needsReview} tone={needsReview ? "warning" : "success"} onClick={() => onCategory("all")} />
          </div>
          <p className="text-xs text-text-muted">Counts are from this document&apos;s extracted records. Categories with nothing found are dimmed but still open.</p>
        </div>
      )}

      {category === "header" && (
        <HeaderCards overview={overview} fields={groups.get("header") ?? []} documentId={documentId}
          onSelect={(record, title, datasetId) => onSelect({ datasetId, record, category: "header", title })} selectedId={selectedId} />
      )}

      {category === "parties" && (
        <SmartDataGrid tableKey="contract:parties" exportName="parties" renderStatus={status} statusLabel="Evidence" onOpen={select("parties")} selectedId={selectedId}
          emptyMessage="No parties or contacts were found in this document."
          columns={columnsFor(data, [
            { key: "title", label: "Field", width: 240, pinned: true },
            { key: "value", label: "Value", width: 360 },
            { key: "party", width: 220 },
            { key: "source_section", width: 200, filter: "options" },
            { key: "source_reference", width: 220, optional: true },
          ])}
          rows={(groups.get("parties") ?? []).map((r) => rowOf(r))} />
      )}

      {category === "lines" && (
        <SmartDataGrid tableKey="contract:lines" exportName="contract-lines" renderStatus={status} statusLabel="Evidence" onOpen={select("lines")} selectedId={selectedId}
          emptyMessage="No contract lines (CLINs) were found in this document."
          columns={columnsFor(data, [
            { key: "record_id", label: "CLIN", width: 100, pinned: true, any: ["clin"] },
            { key: "title", label: "Line Description", width: 300 },
            { key: "quantity", width: 100 },
            { key: "quantity_period", label: "Quantity / Period", width: 130 },
            { key: "unit", label: "Unit", width: 90 },
            { key: "unit_price", width: 140 },
            { key: "pricing", label: "Unit Price / Pricing", width: 200 },
            { key: "amount", label: "Amount", width: 150 },
            { key: "pricing_type", width: 160, filter: "options" },
            { key: "labor_rate", width: 180 },
            { key: "__period", label: "Performance Period (from delivery records)", width: 230 },
            { key: "value", label: "Full description", width: 320, optional: true },
            { key: "source_reference", width: 220, optional: true },
          ])}
          rows={(groups.get("lines") ?? []).map((r) => {
            const clin = value(r, "record_id") || value(r, "clin");
            const delivery = (deliveriesByClin.get(clin) ?? []).find((d) => value(d, "period_from") || value(d, "period_to"));
            return rowOf(r, delivery ? { __period: `${value(delivery, "period_from")} – ${value(delivery, "period_to")}` } : {});
          })}
          renderExpanded={(row) => (
            <LineDetails clin={row.values.record_id || row.values.clin || ""} row={row} deliveries={deliveriesByClin.get(row.values.record_id || row.values.clin || "") ?? []}
              clinDetails={clinDetails} mappings={(mappings ?? []).filter((m) => m.category === "lines")} />
          )} />
      )}

      {category === "deliveries" && (
        <DeliveriesView data={data} records={groups.get("deliveries") ?? []} clinDetails={clinDetails} onOpen={select("deliveries")} selectedId={selectedId} status={status} />
      )}

      {category === "clauses" && <ClausesView data={data} records={groups.get("clauses") ?? []} onOpen={select("clauses")} selectedId={selectedId} status={status} />}

      {category === "sections" && (
        <SmartDataGrid tableKey="contract:sections" exportName="sections" renderStatus={status} statusLabel="Evidence" onOpen={select("sections")} selectedId={selectedId}
          emptyMessage="No contract sections were captured for this document."
          columns={columnsFor(data, [
            { key: "record_id", label: "ID", width: 120, pinned: true },
            { key: "record_type", label: "Kind", width: 130, filter: "options" },
            { key: "title", width: 260 },
            { key: "value", label: "Text", width: 420 },
            { key: "reference", width: 160 },
            { key: "source_section", width: 220, filter: "options" },
          ])}
          rows={(groups.get("sections") ?? []).map((r) => rowOf(r))} />
      )}

      {category === "attachments" && (
        <SmartDataGrid tableKey="contract:attachments" exportName="attachments" renderStatus={status} statusLabel="Evidence" onOpen={select("attachments")} selectedId={selectedId}
          emptyMessage="No attachments were listed in this document."
          columns={columnsFor(data, [
            { key: "record_id", label: "Attachment", width: 130, pinned: true },
            { key: "title", width: 300 },
            { key: "value", label: "Description", width: 320 },
            { key: "attachment", width: 200 },
            { key: "source_reference", width: 220 },
          ])}
          rows={(groups.get("attachments") ?? []).map((r) => rowOf(r))} />
      )}

      {category === "all" && (
        <SmartDataGrid tableKey="contract:all" exportName="all-records" renderStatus={status} statusLabel="Evidence" onOpen={select("all")} selectedId={selectedId}
          columns={data.columns.map((c) => ({
            key: c.key, label: c.display_label, width: c.key === "value" ? 320 : c.key === "title" ? 260 : 150,
            pinned: c.key === "record_id", filter: ["section", "record_type", "regulation", "incorporation_type"].includes(c.key) ? "options" : "text",
          }))}
          rows={records.map((r) => rowOf(r))} />
      )}

      {category === "oracle" && <OracleView documentId={documentId} mappings={mappings} counts={count} />}
    </div>
  );
}

// ---------------------------------------------------------------- pieces

function MetricCard({ icon: Icon, label, value: n, detail, tone, onClick }: {
  icon: typeof Layers; label: string; value: number; detail?: string; tone?: "warning" | "success"; onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} className="flex items-start gap-3 rounded-xl border border-border bg-surface p-4 text-left hover:border-primary/40" data-testid="metric-card">
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-soft text-primary"><Icon className="h-4 w-4" aria-hidden="true" /></span>
      <span>
        <span className="block text-xs text-text-secondary">{label}</span>
        <span className={`block text-2xl font-semibold tabular-nums ${tone === "warning" ? "text-warning" : "text-foreground"}`}>{n.toLocaleString()}</span>
        {detail && <span className="block text-[11px] text-text-muted">{detail}</span>}
      </span>
    </button>
  );
}

function HeaderCards({ overview, fields, documentId, onSelect, selectedId }: {
  overview: StagingDataset | undefined;
  fields: StagingRecord[];
  documentId: string;
  onSelect: (record: StagingRecord, title: string, datasetId: string) => void;
  selectedId: string | null;
}) {
  const groups = new Map<string, { record: StagingRecord; label: string; text: string; datasetId: string }[]>();
  for (const record of overview?.records ?? []) {
    const group = String(record.cells["contract.overview.group"]?.value ?? "Other");
    groups.set(group, [...(groups.get(group) ?? []), {
      record, datasetId: overview!.dataset_id,
      label: String(record.cells["contract.overview.label"]?.value ?? ""), text: String(record.cells["contract.overview.value"]?.value ?? ""),
    }]);
  }
  for (const record of fields) {
    const group = `Printed fields — ${value(record, "section") || "Other"}`;
    groups.set(group, [...(groups.get(group) ?? []), { record, datasetId: DATA, label: value(record, "title") || value(record, "record_id"), text: value(record, "value") }]);
  }
  return (
    <div className="space-y-5" data-testid="contract-header-cards">
      {[...groups.entries()].map(([group, items]) => (
        <section key={group} aria-label={group}>
          <h3 className="mb-2 text-[13px] font-semibold text-foreground">{group}</h3>
          <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(15rem,1fr))]">
            {items.map(({ record, label, text, datasetId }) => (
              <button key={`${datasetId}:${record.record_id}`} type="button" onClick={() => onSelect(record, label, datasetId)}
                className={`rounded-lg border px-3 py-2 text-left hover:border-primary/40 ${selectedId === record.record_id ? "border-primary/50 bg-primary/[0.04]" : "border-border bg-surface"}`}>
                <span className="block text-[11px] font-medium text-text-secondary">{label}</span>
                <span className={`mt-0.5 block break-words text-[13px] ${text ? "text-foreground" : "text-text-muted"}`}>{text || "Not found in the document"}</span>
                <span className="mt-1.5 flex items-center justify-between gap-2">
                  <EvidenceBadge status={record.record_status} />
                  <Link href={`/documents/${documentId}/review`} onClick={(e) => e.stopPropagation()} className="text-[11px] text-primary hover:underline">Correct</Link>
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
      <p className="text-[11px] text-text-muted">Each figure is its own field — award amount, ceiling and minimum guarantee are never combined.</p>
    </div>
  );
}

function LineDetails({ clin, row, deliveries, clinDetails, mappings }: {
  clin: string; row: GridRow; deliveries: StagingRecord[]; clinDetails: StagingDataset | undefined; mappings: CategoryMapping[];
}) {
  const detail = clinDetails?.records.find((r) => String(r.cells["contract.clin.clin"]?.value ?? "") === clin);
  const get = (field: string) => (detail?.cells[field]?.value == null ? "" : String(detail.cells[field]!.value));
  return (
    <div className="grid gap-4 text-xs md:grid-cols-2 xl:grid-cols-4" data-testid="line-details">
      <div>
        <p className="mb-1 font-semibold text-text-secondary">Pricing</p>
        <p>{row.values.pricing || row.values.unit_price || "—"}</p>
        <p className="text-text-muted">Line amount: {row.values.amount || "—"}</p>
      </div>
      <div>
        <p className="mb-1 font-semibold text-text-secondary">Delivery schedules ({deliveries.length})</p>
        {deliveries.length ? deliveries.slice(0, 5).map((d) => (
          <p key={d.record_id + value(d, "value")} className="truncate" title={value(d, "value")}>{value(d, "value") || `${value(d, "period_from")} – ${value(d, "period_to")}`}</p>
        )) : <p className="text-text-muted">None linked to this CLIN.</p>}
      </div>
      <div>
        <p className="mb-1 font-semibold text-text-secondary">Destination</p>
        <p>{get("contract.clin.ship_to") || "—"}</p>
        <p className="text-text-muted">DODAAC: {get("contract.clin.dodaac") || "—"} · FOB: {get("contract.clin.fob") || "—"}</p>
        <p className="mt-1 text-text-muted">Source: {row.values.source_reference || "—"}</p>
      </div>
      <div>
        <p className="mb-1 font-semibold text-text-secondary">Oracle mapping</p>
        {mappings.length ? mappings.map((m) => (
          <p key={m.profile.id}><span className={`rounded-full px-1.5 py-0.5 text-[10px] ${MAPPING_TONE[m.state]}`}>{MAPPING_LABEL[m.state]}</span> {m.template.object_name}</p>
        )) : <p className="text-text-muted">No saved mapping exports contract lines.</p>}
        <p className="mt-1 text-text-muted">Related clauses: not linked to lines by the extraction.</p>
      </div>
    </div>
  );
}

function parseDate(text: string): number | null {
  if (!text) return null;
  const time = Date.parse(text);
  return Number.isNaN(time) ? null : time;
}

function DeliveriesView({ data, records, clinDetails, onOpen, selectedId, status }: {
  data: StagingDataset; records: StagingRecord[]; clinDetails: StagingDataset | undefined;
  onOpen: (row: GridRow) => void; selectedId: string | null; status: (s: string | null | undefined) => React.ReactNode;
}) {
  const [timeline, setTimeline] = useState(false);
  const [visible, setVisible] = useState<Set<string> | null>(null);
  const destination = (clin: string) => clinDetails?.records.find((r) => String(r.cells["contract.clin.clin"]?.value ?? "") === clin);
  const rows = records.map((r) => {
    const clin = value(r, "record_id") || value(r, "clin");
    const d = destination(clin);
    return rowOf(r, {
      __destination: d?.cells["contract.clin.ship_to"]?.value ? String(d.cells["contract.clin.ship_to"]!.value) : "",
      __dodaac: d?.cells["contract.clin.dodaac"]?.value ? String(d.cells["contract.clin.dodaac"]!.value) : "",
    });
  });
  const dated = records
    .map((r) => ({ id: r.record_id, label: value(r, "record_id"), from: parseDate(value(r, "period_from")), to: parseDate(value(r, "period_to")), text: `${value(r, "period_from")} – ${value(r, "period_to")}` }))
    .filter((d) => d.from != null && d.to != null && d.to >= d.from) as { id: string; label: string; from: number; to: number; text: string }[];
  const columns = columnsFor(data, [
    { key: "record_id", label: "Related CLIN", width: 120, pinned: true, any: ["clin"] },
    { key: "value", label: "Delivery Schedule", width: 320 },
    { key: "period_from", label: "Performance Start", width: 140 },
    { key: "period_to", label: "Performance End", width: 140 },
    { key: "performance", width: 220 },
    { key: "__destination", label: "Destination (from CLIN details)", width: 220 },
    { key: "__dodaac", label: "DODAAC", width: 110 },
    { key: "quantity_period", label: "Quantity / Period", width: 130 },
    { key: "quantity", width: 100 },
    { key: "unit", width: 90 },
    { key: "source_reference", label: "Source Reference", width: 220 },
  ]);
  return (
    <div className="space-y-3">
      {timeline && <Timeline items={visible ? dated.filter((d) => visible.has(d.id)) : dated} />}
      <SmartDataGrid tableKey="contract:deliveries" exportName="deliveries" renderStatus={status} statusLabel="Evidence" onOpen={onOpen} selectedId={selectedId}
        emptyMessage="No delivery or performance records were found in this document."
        toolbar={dated.length > 0 && (
          <button type="button" aria-pressed={timeline} onClick={() => setTimeline((v) => !v)} className={`h-8 rounded-lg border px-2.5 text-xs font-medium ${timeline ? "border-primary/40 bg-primary/10" : "border-border"}`}>
            Timeline ({dated.length} dated)
          </button>
        )}
        onFilteredChange={(ids) => setVisible(new Set(ids))}
        columns={columns}
        rows={rows} />
    </div>
  );
}

function Timeline({ items }: { items: { id: string; label: string; from: number; to: number; text: string }[] }) {
  if (!items.length) {
    return <p className="rounded-xl border border-border bg-surface p-3 text-xs text-text-muted" data-testid="delivery-timeline">No dated records match the current search and filters.</p>;
  }
  const start = Math.min(...items.map((i) => i.from));
  const end = Math.max(...items.map((i) => i.to));
  const span = Math.max(1, end - start);
  const shown = items.slice(0, 80);
  const year = (t: number) => new Date(t).getFullYear();
  return (
    <section className="rounded-xl border border-border bg-surface p-3" aria-label="Performance timeline" data-testid="delivery-timeline">
      <div className="mb-2 flex justify-between text-[11px] text-text-muted"><span>{new Date(start).toLocaleDateString()}</span><span>{new Date(end).toLocaleDateString()}</span></div>
      <ul className="max-h-64 space-y-1 overflow-y-auto">
        {shown.map((item) => (
          <li key={item.id + item.text} className="flex items-center gap-2 text-[11px]">
            <span className="w-14 shrink-0 tabular-nums text-text-secondary">{item.label}</span>
            <span className="relative h-2.5 flex-1 rounded bg-surface-soft">
              <span className="absolute h-full rounded bg-primary/60" style={{ left: `${((item.from - start) / span) * 100}%`, width: `${Math.max(0.6, ((item.to - item.from) / span) * 100)}%` }} title={item.text} />
            </span>
          </li>
        ))}
      </ul>
      {items.length > shown.length && <p className="mt-1 text-[11px] text-text-muted">Showing {shown.length} of {items.length}; filter the table to narrow.</p>}
      <p className="mt-1 text-[10px] text-text-muted">Bars use only the start and end dates printed in the document ({year(start)}–{year(end)}).</p>
    </section>
  );
}

function ClausesView({ data, records, onOpen, selectedId, status }: {
  data: StagingDataset; records: StagingRecord[]; onOpen: (row: GridRow) => void; selectedId: string | null; status: (s: string | null | undefined) => React.ReactNode;
}) {
  const [tab, setTab] = useState<"incorporated" | "references">("incorporated");
  const hasRegulation = data.columns.some((c) => c.key === "regulation");
  const incorporated = records.filter((r) => value(r, "section") !== "FAR References");
  const references = records.filter((r) => value(r, "section") === "FAR References");
  const list = tab === "incorporated" ? incorporated : references;
  return (
    <div className="space-y-3">
      <div className="flex gap-1" role="tablist" aria-label="Clause records">
        {([["incorporated", `Clauses (${incorporated.length})`], ["references", `References in the text (${references.length})`]] as const).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            className={`rounded-full px-3 py-1 text-xs font-medium ${tab === id ? "bg-primary text-white" : "border border-border text-text-secondary"}`}>{label}</button>
        ))}
      </div>
      <SmartDataGrid key={tab} tableKey={`contract:clauses:${tab}`} exportName={tab === "incorporated" ? "clauses" : "clause-references"} renderStatus={status} statusLabel="Review status"
        onOpen={onOpen} selectedId={selectedId} emptyMessage="No clauses were found in this document."
        columns={columnsFor(data, [
          { key: hasRegulation ? "regulation" : "__regulation", label: hasRegulation ? "Regulation" : "Regulation (from section)", width: 110, filter: "options" },
          { key: "record_id", label: "Clause Number", width: 140, pinned: true, any: ["clause_number"] },
          { key: "title", label: "Clause Title", width: 320 },
          { key: "effective_date", label: "Effective Date", width: 140 },
          { key: "alternate", label: "Alternate / Deviation", width: 160, filter: "options" },
          { key: "incorporation_type", label: "Incorporation", width: 190, filter: "options", any: ["clause_type"] },
          { key: "source_section", label: "Source Section", width: 240, filter: "options" },
          { key: "value", label: "Extracted text", width: 360, optional: true },
        ])}
        rows={list.map((r) => rowOf(r, hasRegulation ? {} : { __regulation: regulationFromSection(value(r, "section")) }))} />
      <p className="text-[11px] text-text-muted">Incorporation is shown only as the document states it; an empty value means the document didn&apos;t say.</p>
    </div>
  );
}

function OracleView({ documentId, mappings, counts }: { documentId: string; mappings: CategoryMapping[] | null; counts: (id: CategoryId) => number }) {
  const categories: CategoryId[] = ["header", "lines", "parties", "deliveries", "clauses", "attachments"];
  return (
    <div className="space-y-4" data-testid="oracle-category-view">
      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        <table className="w-full text-sm">
          <thead className="bg-surface-soft text-left text-[12px] font-semibold text-text-secondary">
            <tr><th className="px-3 py-2">Category</th><th className="px-3 py-2">Records</th><th className="px-3 py-2">Oracle import object (from your templates)</th><th className="px-3 py-2">Status</th></tr>
          </thead>
          <tbody>
            {categories.map((id) => {
              const found = (mappings ?? []).filter((m) => m.category === id);
              return (
                <tr key={id} className="border-t border-border/70 align-top">
                  <td className="px-3 py-2 font-medium text-foreground">{CATEGORY_LABEL[id]}</td>
                  <td className="px-3 py-2 tabular-nums text-text-secondary">{counts(id)}</td>
                  <td className="px-3 py-2">
                    {found.length ? found.map((m) => (
                      <p key={m.profile.id}>
                        {m.template.object_name} v{m.template.version} <span className="text-text-muted">· “{m.profile.name}” · {m.mapped}/{m.columns} columns</span>
                        <Link href={`/mapping/designer?template=${m.template.id}&document=${documentId}`} className="ml-2 inline-flex items-center gap-0.5 text-xs text-primary hover:underline">Open<ExternalLink className="h-3 w-3" /></Link>
                      </p>
                    )) : (
                      <span className="text-text-muted">{NO_DESTINATION.includes(id) ? "No Verified Oracle Import Destination" : "No saved mapping yet"}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {found.length ? found.map((m) => (
                      <span key={m.profile.id} className={`mr-1 inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${MAPPING_TONE[m.state]}`}>{MAPPING_LABEL[m.state]}</span>
                    )) : <span className="rounded-full bg-surface-soft px-2 py-0.5 text-[11px] text-text-muted">Unmapped</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {mappings === null && <p className="text-xs text-text-muted">Checking saved mappings…</p>}
      <p className="text-xs text-text-secondary">
        Mappings are built in <Link href="/mapping" className="text-primary hover:underline">Mapping Studio</Link> from templates you upload; nothing here assumes an Oracle object.
      </p>
    </div>
  );
}
