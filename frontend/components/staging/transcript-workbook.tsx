"use client";

import { Columns3, Search } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import EvidenceDrawer, { type EvidenceTarget } from "@/components/staging/evidence-drawer";
import { formatCellValue } from "@/components/staging/review-status";
import type { StagingColumn, StagingDataset, StagingRecord, StagingWorkbook } from "@/lib/staging-workbook";
import {
  fieldCell,
  TRANSCRIPT_TABS,
  type TranscriptTabId,
  byCategory,
  fieldRecord,
  findDataset,
  populatedColumns,
  text,
} from "@/lib/transcript-workbook";

interface TranscriptPanesProps {
  workbook: StagingWorkbook;
  onViewInDocument?: (target: EvidenceTarget) => void;
}

function recordCount(workbook: StagingWorkbook, id: TranscriptTabId): number | null {
  if (id === "overview") return null;
  return findDataset(workbook, id)?.records.length ?? 0;
}

/** A field-style record (Field / Value / Category …) as an evidence target. */
function fieldTarget(record: StagingRecord, context?: string): EvidenceTarget | null {
  const cell = fieldCell(record, "value");
  if (!cell) return null;
  const scope = text(fieldCell(record, "scope"));
  return {
    context: context ?? (text(fieldCell(record, "category")) || "Field"),
    field: text(fieldCell(record, "name")) + (scope ? ` (${scope})` : ""),
    cell,
    sourceLabel: text(fieldCell(record, "source_label")) || null,
    fieldId: text(fieldCell(record, "field_id")) || null,
    fragments: record.source_columns,
  };
}

/** The Academic Transcript staging experience: the profile's datasets
 * grouped as Overview | Student & Program | Academic Record | Academic
 * Summary | Other Information | All Fields. Any value opens its evidence. */
export default function TranscriptPanes({ workbook, onViewInDocument }: TranscriptPanesProps) {
  const [tab, setTab] = useState<TranscriptTabId>("overview");
  const [target, setTarget] = useState<EvidenceTarget | null>(null);

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Transcript sections" className="flex flex-wrap gap-x-1 gap-y-1 border-b border-border">
        {TRANSCRIPT_TABS.map(({ id, label }) => {
          const count = recordCount(workbook, id);
          const selected = tab === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setTab(id)}
              className={[
                "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition",
                selected
                  ? "border-primary text-foreground"
                  : count === 0
                    ? "border-transparent font-normal text-text-muted hover:text-text-secondary"
                    : "border-transparent text-text-secondary hover:text-foreground",
              ].join(" ")}
            >
              {label}
              {count != null && count > 0 && <span className="ml-1.5 text-xs text-text-muted">{count}</span>}
            </button>
          );
        })}
      </div>

      {tab === "overview" && <Overview workbook={workbook} onSelect={setTarget} onOpenTab={setTab} />}
      {tab === "student_program" && (
        <GroupedFields
          dataset={findDataset(workbook, "student_program")}
          empty="No student or program details are printed on this document."
          onSelect={setTarget}
        />
      )}
      {tab === "academic_record" && (
        <AcademicRecord dataset={findDataset(workbook, "academic_record")} onSelect={setTarget} />
      )}
      {tab === "academic_summary" && (
        <GroupedFields
          dataset={findDataset(workbook, "academic_summary")}
          empty="No GPA, credit totals or other summary values are printed on this document."
          onSelect={setTarget}
          scoped
        />
      )}
      {tab === "other_information" && (
        <GroupedFields
          dataset={findDataset(workbook, "other_information")}
          empty="No other information was found on this document."
          onSelect={setTarget}
        />
      )}
      {tab === "all_fields" && <AllFields dataset={findDataset(workbook, "all_fields")} onSelect={setTarget} />}

      {target && (
        <EvidenceDrawer
          target={target}
          onClose={() => setTarget(null)}
          onViewInDocument={
            onViewInDocument
              ? (t) => {
                  setTarget(null);
                  onViewInDocument(t);
                }
              : undefined
          }
          metadataReviewHref={`/documents/${workbook.document_id}/review`}
        />
      )}
    </div>
  );
}

// --- Overview ---------------------------------------------------------------------

const OVERVIEW_FACTS: [string, string[]][] = [
  ["Student Name", ["transcript.student.name"]],
  ["Institution", ["transcript.program.institution"]],
  ["Program / Degree", ["transcript.program.program"]],
  ["Major", ["transcript.program.major"]],
  ["Graduation", ["transcript.program.graduation_year", "transcript.program.graduation_date"]],
];

function Overview({
  workbook,
  onSelect,
  onOpenTab,
}: {
  workbook: StagingWorkbook;
  onSelect: (target: EvidenceTarget) => void;
  onOpenTab: (tab: TranscriptTabId) => void;
}) {
  const studentProgram = findDataset(workbook, "student_program");
  const summary = findDataset(workbook, "academic_summary");
  const courses = findDataset(workbook, "academic_record")?.records.length ?? 0;

  const facts = OVERVIEW_FACTS.map(([label, ids]) => {
    const record = ids.map((id) => fieldRecord(studentProgram, id)).find(Boolean);
    return record ? ([label, record] as const) : null;
  }).filter((fact): fact is readonly [string, StagingRecord] => fact !== null);

  const metrics: { label: string; value: string; record?: StagingRecord; tab: TranscriptTabId }[] = [];
  if (courses > 0) metrics.push({ label: "Courses", value: String(courses), tab: "academic_record" });
  const credits = fieldRecord(summary, "transcript.summary.total_credits");
  if (credits) metrics.push({ label: "Credits", value: text(fieldCell(credits, "value")), record: credits, tab: "academic_summary" });
  const gpa = fieldRecord(summary, "transcript.summary.cumulative_gpa");
  if (gpa) metrics.push({ label: "Cumulative GPA", value: text(fieldCell(gpa, "value")), record: gpa, tab: "academic_summary" });

  const needsReview = workbook.datasets
    .filter((d) => d.role === "business" && d.dataset_id !== "all_fields")
    .flatMap((d) => d.records)
    .flatMap((r) => Object.values(r.cells))
    .filter((cell) => cell.review_status === "Needs Review").length;

  if (facts.length === 0 && metrics.length === 0) {
    return (
      <p className="rounded-xl border border-border bg-surface-soft px-4 py-8 text-center text-sm text-text-secondary">
        No student, program or result details could be read from this document. The original and its extracted text
        are available under Document.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      {facts.length > 0 && (
        <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
          {facts.map(([label, record]) => {
            const target = fieldTarget(record, "Overview");
            return (
              <div key={label} className="min-w-0">
                <dt className="text-xs text-text-secondary">{label}</dt>
                <dd className="mt-0.5">
                  <button
                    type="button"
                    onClick={() => target && onSelect({ ...target, field: label })}
                    className="text-left text-base font-medium text-foreground hover:text-primary"
                  >
                    {text(fieldCell(record, "value"))}
                  </button>
                </dd>
              </div>
            );
          })}
        </dl>
      )}
      {metrics.length > 0 && (
        <div className="flex flex-wrap gap-x-10 gap-y-3 border-t border-border pt-4">
          {metrics.map((metric) => (
            <button
              key={metric.label}
              type="button"
              onClick={() => {
                const target = metric.record ? fieldTarget(metric.record, "Overview") : null;
                if (target) onSelect({ ...target, field: metric.label });
                else onOpenTab(metric.tab);
              }}
              className="text-left"
            >
              <p className="text-2xl font-semibold tabular-nums text-foreground">{metric.value}</p>
              <p className="text-xs text-text-secondary">{metric.label}</p>
            </button>
          ))}
        </div>
      )}
      <p className="text-xs text-text-secondary">
        {needsReview > 0
          ? `${needsReview} value${needsReview === 1 ? "" : "s"} should be checked against the original. `
          : ""}
        Select any value to see where it appears in the document.
      </p>
    </div>
  );
}

// --- Field groups ---------------------------------------------------------------------

function EmptyState({ message }: { message: string }) {
  return (
    <p className="rounded-xl border border-border bg-surface-soft px-4 py-8 text-center text-sm text-text-secondary">
      {message}
    </p>
  );
}

function GroupedFields({
  dataset,
  empty,
  onSelect,
  scoped = false,
}: {
  dataset: StagingDataset | undefined;
  empty: string;
  onSelect: (target: EvidenceTarget) => void;
  scoped?: boolean;
}) {
  if (!dataset || dataset.records.length === 0) return <EmptyState message={empty} />;
  const showScope = scoped && dataset.records.some((r) => text(fieldCell(r, "scope")));
  return (
    <div className="space-y-5">
      {byCategory(dataset.records).map(([category, records]) => (
        <section key={category} aria-label={category} className="space-y-1.5">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{category}</h4>
          <div className="overflow-hidden rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="bg-surface-soft">
                <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
                  <th className="w-[38%] px-3 py-2">Field</th>
                  <th className="px-3 py-2">Value</th>
                  {showScope && <th className="w-[28%] px-3 py-2">Applies To</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {records.map((record) => (
                  <FieldRow key={record.record_id} record={record} onSelect={onSelect} showScope={showScope} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}

function FieldRow({
  record,
  onSelect,
  showScope,
}: {
  record: StagingRecord;
  onSelect: (target: EvidenceTarget) => void;
  showScope: boolean;
}) {
  const target = fieldTarget(record);
  const value = fieldCell(record, "value");
  const open = () => target && onSelect(target);
  return (
    <tr className="h-10 cursor-pointer hover:bg-surface-soft/70" onClick={open}>
      <td className="px-3 align-middle text-text-secondary">{text(fieldCell(record, "name"))}</td>
      <td className="px-3 align-middle">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            open();
          }}
          className="text-left text-foreground hover:text-primary"
        >
          {value ? formatCellValue(value) : "—"}
        </button>
        {value?.review_status === "Needs Review" && <ReviewDot />}
      </td>
      {showScope && <td className="px-3 align-middle text-text-secondary">{text(fieldCell(record, "scope"))}</td>}
    </tr>
  );
}

function ReviewDot() {
  return (
    <span
      title="Check against the original"
      aria-label="Check against the original"
      className="ml-2 inline-block h-1.5 w-1.5 rounded-full bg-warning align-middle"
    />
  );
}

// --- Academic Record ---------------------------------------------------------------------

const MANY_COLUMNS = 6;

function AcademicRecord({
  dataset,
  onSelect,
}: {
  dataset: StagingDataset | undefined;
  onSelect: (target: EvidenceTarget) => void;
}) {
  const [query, setQuery] = useState("");
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const columns = useMemo(() => (dataset ? populatedColumns(dataset) : []), [dataset]);
  const records = useMemo(() => {
    if (!dataset) return [];
    const needle = query.trim().toLowerCase();
    if (!needle) return dataset.records;
    return dataset.records.filter((record) =>
      columns.some((c) => text(record.cells[c.canonical_field]).toLowerCase().includes(needle)),
    );
  }, [dataset, columns, query]);

  if (!dataset || dataset.records.length === 0) {
    return <EmptyState message="No course or result rows could be read from this document." />;
  }
  const visible = columns.filter((c) => !hidden.has(c.canonical_field));
  const title = columns.find((c) => c.canonical_field.endsWith(".title")) ?? columns[0];

  function open(record: StagingRecord, column: StagingColumn) {
    const cell = record.cells[column.canonical_field];
    if (!cell || cell.value == null) return;
    const course = text(record.cells[title.canonical_field]);
    onSelect({
      context: course ? `Academic Record · ${course}` : "Academic Record",
      field: column.display_label,
      cell,
      sourceLabel: cell.source_column?.raw_header ?? null,
      fieldId: column.canonical_field,
      fragments: record.source_columns?.filter(
        (fragment) => fragment.raw_header == null || fragment.raw_header === cell.source_column?.raw_header,
      ),
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex min-w-[220px] flex-1 items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm sm:max-w-xs">
          <Search className="h-3.5 w-3.5 text-text-muted" aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search courses"
            aria-label="Search academic record"
            className="w-full bg-transparent outline-none placeholder:text-text-muted"
          />
        </label>
        <div className="flex items-center gap-3 text-xs text-text-secondary">
          <span>
            {records.length} of {dataset.records.length} course{dataset.records.length === 1 ? "" : "s"}
          </span>
          {columns.length > MANY_COLUMNS && (
            <div className="relative" ref={menuRef}>
              <button
                type="button"
                onClick={() => setMenuOpen((value) => !value)}
                className="btn-secondary text-xs"
                aria-expanded={menuOpen}
              >
                <Columns3 className="h-3.5 w-3.5" />
                Columns
              </button>
              {menuOpen && (
                <div className="absolute right-0 top-full z-20 mt-1 w-56 rounded-lg border border-border bg-surface p-2 shadow-lg">
                  {columns.map((column) => (
                    <label key={column.canonical_field} className="flex items-center gap-2 px-1 py-1 text-xs text-foreground">
                      <input
                        type="checkbox"
                        checked={!hidden.has(column.canonical_field)}
                        onChange={() =>
                          setHidden((previous) => {
                            const next = new Set(previous);
                            if (next.has(column.canonical_field)) next.delete(column.canonical_field);
                            else next.add(column.canonical_field);
                            return next;
                          })
                        }
                      />
                      {column.display_label}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="max-h-[65vh] overflow-auto rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-surface-soft">
            <tr>
              {visible.map((column) => (
                <th
                  key={column.canonical_field}
                  className="whitespace-nowrap px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-text-secondary"
                >
                  {column.display_label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {records.map((record) => (
              <tr key={record.record_id} className="h-11 hover:bg-surface-soft/60">
                {visible.map((column) => {
                  const cell = record.cells[column.canonical_field];
                  const value = cell ? formatCellValue(cell) : "";
                  return (
                    <td key={column.canonical_field} className="max-w-[22rem] px-3 align-middle">
                      {value ? (
                        <button
                          type="button"
                          onClick={() => open(record, column)}
                          className="block max-w-full truncate text-left text-foreground hover:text-primary"
                          title={value}
                        >
                          {value}
                        </button>
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
                      {cell?.review_status === "Needs Review" && value && <ReviewDot />}
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

// --- All Fields ------------------------------------------------------------------------------

function AllFields({
  dataset,
  onSelect,
}: {
  dataset: StagingDataset | undefined;
  onSelect: (target: EvidenceTarget) => void;
}) {
  const [query, setQuery] = useState("");
  const records = useMemo(() => {
    const all = dataset?.records ?? [];
    const needle = query.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((record) =>
      (["name", "value", "category"] as const).some((part) => text(fieldCell(record, part)).toLowerCase().includes(needle)),
    );
  }, [dataset, query]);

  if (!dataset || dataset.records.length === 0) {
    return <EmptyState message="No fields were read from this document." />;
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex min-w-[220px] flex-1 items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm sm:max-w-xs">
          <Search className="h-3.5 w-3.5 text-text-muted" aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search fields"
            aria-label="Search all fields"
            className="w-full bg-transparent outline-none placeholder:text-text-muted"
          />
        </label>
        <span className="text-xs text-text-secondary">
          {records.length} of {dataset.records.length} fields
        </span>
      </div>
      <div className="max-h-[65vh] overflow-auto rounded-xl border border-border">
        <table className="w-full text-sm" aria-label="All fields">
          <thead className="sticky top-0 z-10 bg-surface-soft">
            <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
              <th className="px-3 py-2">Field</th>
              <th className="px-3 py-2">Value</th>
              <th className="px-3 py-2">Category</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {records.map((record) => {
              const target = fieldTarget(record);
              const open = () => target && onSelect(target);
              return (
                <tr key={record.record_id} className="h-10 cursor-pointer hover:bg-surface-soft/70" onClick={open}>
                  <td className="px-3 align-middle text-text-secondary">{text(fieldCell(record, "name"))}</td>
                  <td className="max-w-[28rem] px-3 align-middle">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        open();
                      }}
                      className="block max-w-full truncate text-left text-foreground hover:text-primary"
                      title={text(fieldCell(record, "value"))}
                    >
                      {text(fieldCell(record, "value"))}
                    </button>
                  </td>
                  <td className="whitespace-nowrap px-3 align-middle text-text-secondary">
                    {text(fieldCell(record, "category"))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
