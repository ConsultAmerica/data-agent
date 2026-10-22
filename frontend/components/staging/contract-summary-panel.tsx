"use client";

import type { SourceViewRequest } from "@/components/source-verification-panel";
import { ReviewStatusBadge, cellSourceRequest, formatCellValue } from "@/components/staging/review-status";
import { fieldToneClass, toneFromStagingCell } from "@/lib/field-tone";
import type { StagingDataset } from "@/lib/staging-workbook";

const GROUPS: { title: string; fields: string[] }[] = [
  {
    title: "Contract",
    fields: [
      "contract.contract_number",
      "contract.solicitation_number",
      "contract.contract_vehicle",
      "contract.agency_office",
      "contract.contractor_name",
      "contract.award_date",
    ],
  },
  {
    title: "Financial",
    fields: ["contract.ceiling_amount", "contract.minimum_guarantee"],
  },
  {
    title: "Performance",
    fields: [
      "contract.base_period",
      "contract.options",
      "contract.max_duration",
      "contract.task_order_range",
    ],
  },
  {
    title: "Classification",
    fields: ["contract.naics", "contract.size_standard"],
  },
];

export default function ContractSummaryPanel({
  dataset,
  onOpenSource,
}: {
  dataset: StagingDataset;
  onOpenSource?: (request: SourceViewRequest) => void;
}) {
  const record = dataset.records[0];
  if (!record) return null;
  const missing = dataset.columns.filter((column) => {
    const cell = record.cells[column.canonical_field];
    return cell && (cell.value == null || cell.review_status === "Missing");
  });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {GROUPS.map((group) => (
        <section key={group.title} className="rounded-lg border border-border">
          <h4 className="border-b border-border px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-text-muted">
            {group.title}
          </h4>
          <dl>
            {group.fields.map((field) => {
              const column = dataset.columns.find((item) => item.canonical_field === field);
              const cell = record.cells[field];
              if (!column || !cell) return null;
              const request = cellSourceRequest(cell, `${dataset.dataset_id}:${record.record_id}:${field}`);
              const text = formatCellValue(cell);
              const tone = fieldToneClass(toneFromStagingCell(cell));
              return (
                <div key={field} className="grid grid-cols-[minmax(7rem,1fr)_minmax(0,1.2fr)_auto] items-center gap-2 border-t border-border px-3 py-2 text-[13px] first:border-t-0">
                  <dt className="text-text-secondary">{column.display_label}</dt>
                  <dd className="truncate">
                    {cell.value == null ? (
                      <span className="text-text-muted">—</span>
                    ) : request && onOpenSource ? (
                      <button
                        type="button"
                        onClick={() => onOpenSource(request)}
                        className={`max-w-full truncate text-left font-medium text-foreground underline decoration-dotted ${tone}`}
                      >
                        {text}
                      </button>
                    ) : (
                      <span className={`font-medium ${tone}`}>{text}</span>
                    )}
                  </dd>
                  <ReviewStatusBadge status={cell.review_status} />
                </div>
              );
            })}
          </dl>
        </section>
      ))}
      <section className="rounded-lg border border-border lg:col-span-2">
        <h4 className="border-b border-border px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-text-muted">
          Missing information
        </h4>
        {missing.length === 0 ? (
          <p className="px-3 py-2 text-sm text-text-secondary">No expected summary fields are missing.</p>
        ) : (
          <p className="px-3 py-2 text-sm text-text-secondary">{missing.map((column) => column.display_label).join(" · ")}</p>
        )}
      </section>
    </div>
  );
}
