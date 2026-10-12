"use client";

import { Search } from "lucide-react";
import { useMemo, useState } from "react";

import EvidenceDrawer, { type EvidenceTarget } from "@/components/staging/evidence-drawer";
import { formatCellValue } from "@/components/staging/review-status";
import type { StagingCell, StagingColumn, StagingDataset, StagingRecord, StagingWorkbook } from "@/lib/staging-workbook";

export const INVOICE_PROFILE_ID = "invoice";

export function isInvoiceProfile(workbook: StagingWorkbook): boolean {
  return workbook.profile.profile_id === INVOICE_PROFILE_ID;
}

type InvoiceTab =
  | "overview"
  | "details"
  | "parties"
  | "lines"
  | "charges"
  | "other"
  | "all_fields";

const TABS: { id: InvoiceTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "details", label: "Invoice Details" },
  { id: "parties", label: "Parties" },
  { id: "lines", label: "Line Items" },
  { id: "charges", label: "Charges & Totals" },
  { id: "other", label: "Other Information" },
  { id: "all_fields", label: "All Fields" },
];

const CATEGORY_LABEL: Record<string, string> = {
  "Invoice Summary": "Invoice Details",
  "PO / Contract Reference": "References",
  "Customer / Bill-To": "Bill To",
  "Invoice Lines": "Line Items",
  "Taxes / Charges": "Charges",
  "Other Field": "Other Information",
};

function datasetOf(workbook: StagingWorkbook, id: string): StagingDataset | undefined {
  return workbook.datasets.find((dataset) => dataset.dataset_id === id);
}

function cell(record: StagingRecord | undefined, suffix: string): StagingCell | undefined {
  if (!record) return undefined;
  return Object.entries(record.cells).find(([key]) => key.endsWith(`.${suffix}`))?.[1];
}

function shown(value: StagingCell | undefined): string {
  if (!value || value.value == null) return "";
  return formatCellValue(value);
}

function categoryLabel(raw: string): string {
  const cleaned = raw.replace(/\s*\(page\s+\d+\)/gi, "").trim();
  return CATEGORY_LABEL[cleaned] ?? cleaned;
}

function targetFrom(record: StagingRecord, fieldSuffix: string, context: string, label: string): EvidenceTarget | null {
  const value = cell(record, fieldSuffix);
  if (!value || value.value == null) return null;
  return { context, field: label, cell: value, fieldId: value.canonical_field };
}

export default function InvoicePanes({
  workbook,
  onViewInDocument,
}: {
  workbook: StagingWorkbook;
  onViewInDocument?: (target: EvidenceTarget) => void;
}) {
  const [tab, setTab] = useState<InvoiceTab>("lines");
  const [open, setOpen] = useState<EvidenceTarget | null>(null);

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Invoice sections" className="flex flex-wrap gap-1.5">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            aria-label={label}
            onClick={() => setTab(id)}
            className={[
              "rounded-md border px-2.5 py-1 text-[13px]",
              tab === id ? "border-primary bg-primary text-white" : "border-border bg-surface text-text-secondary",
            ].join(" ")}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "overview" && <Overview workbook={workbook} onOpen={setOpen} />}
      {tab === "details" && <Details workbook={workbook} onOpen={setOpen} />}
      {tab === "parties" && <Parties workbook={workbook} onOpen={setOpen} />}
      {tab === "lines" && <Lines dataset={datasetOf(workbook, "invoice_lines")} onOpen={setOpen} />}
      {tab === "charges" && <Charges workbook={workbook} onOpen={setOpen} />}
      {tab === "other" && <Other workbook={workbook} onOpen={setOpen} />}
      {tab === "all_fields" && <AllFields dataset={datasetOf(workbook, "all_fields")} onOpen={setOpen} />}
      {open && (
        <EvidenceDrawer
          target={open}
          onClose={() => setOpen(null)}
          onViewInDocument={
            onViewInDocument
              ? (next) => {
                  setOpen(null);
                  onViewInDocument(next);
                }
              : undefined
          }
          metadataReviewHref={`/documents/${workbook.document_id}/review`}
        />
      )}
    </div>
  );
}

function Overview({ workbook, onOpen }: { workbook: StagingWorkbook; onOpen: (target: EvidenceTarget) => void }) {
  const summary = datasetOf(workbook, "invoice_summary")?.records[0];
  const supplier = datasetOf(workbook, "supplier")?.records[0];
  const customer = datasetOf(workbook, "customer")?.records[0];
  const reference = datasetOf(workbook, "reference")?.records[0];
  const totals = datasetOf(workbook, "totals")?.records[0];
  const rows = [
    ["Invoice Number", summary, "invoice_number"],
    ["Supplier", supplier, "name"],
    ["Customer", customer, "name"],
    ["Invoice Date", summary, "invoice_date"],
    ["Due Date", summary, "due_date"],
    ["PO Number", reference, "po_number"],
    ["Currency", summary, "currency"],
    ["Payment Terms", summary, "payment_terms"],
    ["Invoice Total", totals, "invoice_amount"],
    ["Amount Due", totals, "amount_due"],
  ] as const;
  const visible = rows.filter(([, record, suffix]) => shown(cell(record, suffix)));
  return (
    <dl className="grid gap-px overflow-hidden rounded-lg border border-border sm:grid-cols-2">
      {visible.map(([label, record, suffix]) => {
        const value = cell(record, suffix);
        const evidence = record ? targetFrom(record, suffix, "Invoice", label) : null;
        return (
          <div key={label} className="grid grid-cols-[9rem_1fr] gap-2 border-border bg-surface px-3 py-2 text-sm">
            <dt className="text-text-secondary">{label}</dt>
            <dd>
              {evidence ? (
                <button type="button" className="text-left font-medium underline decoration-dotted" onClick={() => onOpen(evidence)}>
                  {shown(value)}
                </button>
              ) : (
                shown(value)
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function Details({ workbook, onOpen }: { workbook: StagingWorkbook; onOpen: (target: EvidenceTarget) => void }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <FieldSection title="Document" workbook={workbook} datasetId="invoice_summary" onOpen={onOpen} />
      <FieldSection title="References" workbook={workbook} datasetId="reference" onOpen={onOpen} />
    </div>
  );
}

function Parties({ workbook, onOpen }: { workbook: StagingWorkbook; onOpen: (target: EvidenceTarget) => void }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <FieldSection title="Supplier" workbook={workbook} datasetId="supplier" onOpen={onOpen} />
      <FieldSection title="Bill To" workbook={workbook} datasetId="customer" onOpen={onOpen} />
    </div>
  );
}

function FieldSection({
  title,
  workbook,
  datasetId,
  onOpen,
}: {
  title: string;
  workbook: StagingWorkbook;
  datasetId: string;
  onOpen: (target: EvidenceTarget) => void;
}) {
  const record = datasetOf(workbook, datasetId)?.records[0];
  const fields = (datasetOf(workbook, datasetId)?.columns ?? []).filter((column) => shown(record?.cells[column.canonical_field]));
  if (!record || fields.length === 0) {
    return (
      <section className="rounded-lg border border-border px-3 py-3 text-sm text-text-secondary">
        <h4 className="text-[11px] font-medium uppercase tracking-wide text-text-muted">{title}</h4>
        <p className="mt-2">No source-supported {title.toLowerCase()} values.</p>
      </section>
    );
  }
  return (
    <section className="rounded-lg border border-border">
      <h4 className="border-b border-border px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-text-muted">{title}</h4>
      <dl>
        {fields.map((column) => {
          const evidence = targetFrom(record, column.key, title, column.display_label);
          return (
            <div key={column.canonical_field} className="grid grid-cols-[9rem_1fr] gap-2 border-t border-border px-3 py-2 text-[13px] first:border-t-0">
              <dt className="text-text-secondary">{column.display_label}</dt>
              <dd>
                {evidence ? (
                  <button type="button" className="text-left underline decoration-dotted" onClick={() => onOpen(evidence)}>
                    {shown(record.cells[column.canonical_field])}
                  </button>
                ) : (
                  shown(record.cells[column.canonical_field])
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

function visibleLineColumns(dataset: StagingDataset): StagingColumn[] {
  return dataset.columns.filter((column) => {
    if (column.key === "source_table" || column.key === "found_by" || column.key === "value_type") return false;
    if (column.key === "other_values") {
      return dataset.records.some((record) => {
        const value = shown(record.cells[column.canonical_field]);
        return value && !/^column\s+\d+/i.test(value);
      });
    }
    return dataset.records.some((record) => shown(record.cells[column.canonical_field]));
  });
}

function Lines({ dataset, onOpen }: { dataset?: StagingDataset; onOpen: (target: EvidenceTarget) => void }) {
  const [query, setQuery] = useState("");
  const columns = dataset ? visibleLineColumns(dataset) : [];
  const records = useMemo(() => {
    const all = dataset?.records ?? [];
    const needle = query.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((record) =>
      columns.some((column) => shown(record.cells[column.canonical_field]).toLowerCase().includes(needle)),
    );
  }, [dataset, query, columns]);
  if (!dataset || dataset.records.length === 0) {
    return <p className="text-sm text-text-secondary">No line items were found on this invoice.</p>;
  }
  return (
    <div className="space-y-2">
      <label className="flex max-w-xs items-center gap-2 rounded-lg border border-border px-2 py-1 text-sm">
        <Search className="h-3.5 w-3.5 text-text-muted" />
        <input aria-label="Search line items" value={query} onChange={(event) => setQuery(event.target.value)} className="w-full bg-transparent outline-none" placeholder="Search line items" />
      </label>
      <div className="max-h-[65vh] overflow-auto rounded-lg border border-border">
        <table className="w-full min-w-max text-sm" aria-label="Line items">
          <thead className="sticky top-0 z-10 bg-surface-soft text-left text-[11px] font-medium text-text-muted">
            <tr>
              {columns.map((column) => (
                <th key={column.canonical_field} className="whitespace-nowrap px-3 py-2">{column.display_label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {records.map((record) => (
              <tr key={record.record_id} className="h-11 border-t border-border">
                {columns.map((column) => {
                  const value = record.cells[column.canonical_field];
                  const evidence = targetFrom(record, column.key, "Line Items", column.display_label);
                  const text = shown(value);
                  return (
                    <td key={column.canonical_field} className="max-w-[18rem] truncate px-3 align-middle">
                      {evidence && text ? (
                        <button type="button" className="underline decoration-dotted" onClick={() => onOpen(evidence)}>{text}</button>
                      ) : (
                        text || "—"
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Charges({ workbook, onOpen }: { workbook: StagingWorkbook; onOpen: (target: EvidenceTarget) => void }) {
  const charges = datasetOf(workbook, "taxes_charges");
  return (
    <div className="space-y-4">
      {charges && charges.records.length > 0 && (
        <section>
          <h4 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-text-muted">Charges</h4>
          <ul className="divide-y divide-border rounded-lg border border-border text-sm">
            {charges.records.map((record) => {
              const evidence = targetFrom(record, "amount", "Charges", shown(cell(record, "label")) || "Charge");
              return (
                <li key={record.record_id} className="flex items-center justify-between px-3 py-2">
                  <span>{shown(cell(record, "label")) || shown(cell(record, "charge_type"))}</span>
                  {evidence ? (
                    <button type="button" className="underline decoration-dotted" onClick={() => onOpen(evidence)}>
                      {shown(cell(record, "amount"))}
                    </button>
                  ) : (
                    <span>{shown(cell(record, "amount"))}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <FieldSection title="Totals" workbook={workbook} datasetId="totals" onOpen={onOpen} />
    </div>
  );
}

function Other({ workbook, onOpen }: { workbook: StagingWorkbook; onOpen: (target: EvidenceTarget) => void }) {
  const other = datasetOf(workbook, "other_fields");
  const distributions = datasetOf(workbook, "distributions");
  if ((!other || other.records.length === 0) && (!distributions || distributions.records.length === 0)) {
    return <p className="text-sm text-text-secondary">No additional invoice information was found.</p>;
  }
  return (
    <div className="space-y-4">
      {other && other.records.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border text-sm">
          {other.records.map((record) => {
            const evidence = targetFrom(record, "value", "Other Information", shown(cell(record, "name")));
            return (
              <li key={record.record_id} className="grid grid-cols-[minmax(8rem,1fr)_minmax(0,1.4fr)] gap-2 px-3 py-2">
                <span className="text-text-secondary">{shown(cell(record, "name"))}</span>
                {evidence ? (
                  <button type="button" className="text-left underline decoration-dotted" onClick={() => onOpen(evidence)}>
                    {shown(cell(record, "value"))}
                  </button>
                ) : (
                  <span>{shown(cell(record, "value"))}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {distributions && distributions.records.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border text-sm">
          {distributions.records.map((record) => (
            <li key={record.record_id} className="grid grid-cols-3 gap-2 px-3 py-2">
              <span>{shown(cell(record, "dimension"))}</span>
              <span>{shown(cell(record, "value"))}</span>
              <span>{shown(cell(record, "amount"))}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AllFields({ dataset, onOpen }: { dataset?: StagingDataset; onOpen: (target: EvidenceTarget) => void }) {
  const [query, setQuery] = useState("");
  const records = useMemo(() => {
    const all = dataset?.records ?? [];
    const needle = query.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((record) =>
      ["name", "value", "category"].some((part) => shown(cell(record, part)).toLowerCase().includes(needle)),
    );
  }, [dataset, query]);
  if (!dataset || dataset.records.length === 0) {
    return <p className="text-sm text-text-secondary">No fields were read from this invoice.</p>;
  }
  return (
    <div className="space-y-2">
      <label className="flex max-w-xs items-center gap-2 rounded-lg border border-border px-2 py-1 text-sm">
        <Search className="h-3.5 w-3.5 text-text-muted" />
        <input
          aria-label="Search all fields"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search fields"
          className="w-full bg-transparent outline-none"
        />
      </label>
      <div className="max-h-[65vh] overflow-auto rounded-lg border border-border">
      <table className="w-full text-sm" aria-label="All fields">
        <thead className="sticky top-0 bg-surface-soft text-left text-[11px] font-medium uppercase text-text-muted">
          <tr>
            <th className="px-3 py-2">Field</th>
            <th className="px-3 py-2">Value</th>
            <th className="px-3 py-2">Category</th>
          </tr>
        </thead>
        <tbody>
          {records.map((record) => {
            const evidence = targetFrom(record, "value", categoryLabel(shown(cell(record, "category"))), shown(cell(record, "name")));
            return (
              <tr key={record.record_id} className="h-10 border-t border-border">
                <td className="px-3">{shown(cell(record, "name"))}</td>
                <td className="px-3">
                  {evidence ? (
                    <button type="button" className="underline decoration-dotted" onClick={() => onOpen(evidence)}>
                      {shown(cell(record, "value"))}
                    </button>
                  ) : (
                    shown(cell(record, "value"))
                  )}
                </td>
                <td className="px-3 text-text-secondary">{categoryLabel(shown(cell(record, "category")))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </div>
  );
}
