import type { CSSProperties, ReactNode } from "react";

/* The shimmer's keyframes ship with the component. React 19 hoists and
   de-duplicates a <style> that has href + precedence, so many skeletons on
   a page add one rule. Reduced motion gets a still placeholder. */
const SHIMMER_CSS = `
.ui-skeleton { position: relative; overflow: hidden; background: color-mix(in srgb, var(--border) 55%, transparent); }
@media (prefers-reduced-motion: no-preference) {
  .ui-skeleton::after {
    content: ""; position: absolute; inset: 0; transform: translateX(-100%);
    background: linear-gradient(90deg, transparent, rgba(255,255,255,0.55), transparent);
    animation: ui-skeleton-shimmer 1.5s ease-in-out infinite;
  }
}
@keyframes ui-skeleton-shimmer { 100% { transform: translateX(100%); } }
.ui-refetch-strip { position: absolute; inset: 0 0 auto 0; z-index: 15; height: 2px; overflow: hidden; pointer-events: none; }
.ui-refetch-strip::after {
  content: ""; position: absolute; inset: 0; width: 35%;
  background: linear-gradient(90deg, transparent, var(--primary), transparent);
  animation: ui-refetch-slide 1.1s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) { .ui-refetch-strip::after { animation: none; width: 100%; opacity: 0.45; } }
@keyframes ui-refetch-slide { from { transform: translateX(-100%); } to { transform: translateX(290%); } }
`;

export function SkeletonStyles() {
  return (
    <style href="ui-skeleton" precedence="default">
      {SHIMMER_CSS}
    </style>
  );
}

export function Skeleton({ className = "", style }: { className?: string; style?: CSSProperties }) {
  return (
    <>
      <SkeletonStyles />
      <div aria-hidden="true" className={`ui-skeleton rounded-md ${className}`} style={style} />
    </>
  );
}

/** Lines of text; the last one is shorter, like a paragraph's end. */
export function SkeletonText({ lines = 3, className = "" }: { lines?: number; className?: string }) {
  return (
    <div className={`space-y-2 ${className}`} aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} className="h-3" style={{ width: index === lines - 1 ? "62%" : `${92 - index * 4}%` }} />
      ))}
    </div>
  );
}

/** A table-shaped placeholder: a header row and `rows` body rows. */
export function SkeletonTable({ rows = 6, columns = 5, className = "" }: { rows?: number; columns?: number; className?: string }) {
  return (
    <div className={`overflow-hidden rounded-xl border border-border bg-surface ${className}`} aria-hidden="true">
      <div className="flex gap-4 border-b border-border bg-surface-soft px-4 py-3">
        {Array.from({ length: columns }, (_, index) => (
          <Skeleton key={index} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="flex items-center gap-4 border-b border-border/60 px-4 py-3.5 last:border-0">
          {Array.from({ length: columns }, (_, column) => (
            <Skeleton
              key={column}
              className="h-3 flex-1"
              style={{ maxWidth: column === 0 ? "34%" : `${70 - ((row + column) % 3) * 12}%` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** A workspace page while it loads: title, four stat tiles, a table. */
export function SkeletonPage({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="w-full px-4 py-5 sm:px-6" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}</span>
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-3 h-7 w-64 max-w-full" />
      <Skeleton className="mt-2 h-3.5 w-96 max-w-full" />
      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="rounded-xl border border-border bg-surface p-4">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-3 h-6 w-12" />
          </div>
        ))}
      </div>
      <SkeletonTable className="mt-6" rows={7} columns={6} />
    </div>
  );
}

/** A thin indeterminate bar along the top of a positioned container: data
 * is being refreshed, but the rows already on screen stay readable. */
export function RefetchStrip({ active, label = "Updating…" }: { active: boolean; label?: string }) {
  if (!active) return null;
  return (
    <>
      <SkeletonStyles />
      <div className="ui-refetch-strip" role="status" data-testid="refetch-strip">
        <span className="sr-only">{label}</span>
      </div>
    </>
  );
}

/** The ConsoleHeader band: icon, title, description and underline tabs. */
export function SkeletonConsoleHeader({ tabs = 4, withAction = true }: { tabs?: number; withAction?: boolean }) {
  return (
    <div className="console-header border-b border-border px-4 pt-4 sm:px-6 sm:pt-5" aria-hidden="true">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <Skeleton className="h-9 w-9 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="mt-2 h-3 w-[28rem] max-w-full" />
          </div>
        </div>
        {withAction && <Skeleton className="h-9 w-36 shrink-0 rounded-lg" />}
      </div>
      {tabs > 0 ? (
        <div className="mt-4 flex gap-5 pb-3">
          {Array.from({ length: tabs }, (_, index) => (
            <Skeleton key={index} className="h-3.5" style={{ width: `${index === 0 ? 6.5 : 4.5 + (index % 2)}rem` }} />
          ))}
        </div>
      ) : (
        <div className="h-4 sm:h-5" />
      )}
    </div>
  );
}

function SkeletonShell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="w-full" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/** /documents: header with status tabs, filter toolbar, document table. */
export function SkeletonDocumentsPage() {
  return (
    <SkeletonShell label="Loading documents…">
      <SkeletonConsoleHeader tabs={5} />
      <div className="px-4 py-4 sm:px-6 sm:py-5">
        <div className="data-panel overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
            <Skeleton className="h-9 min-w-[14rem] flex-1 rounded-lg" />
            {[8, 7, 7, 9].map((width, index) => (
              <Skeleton key={index} className="hidden h-9 rounded-lg sm:block" style={{ width: `${width}rem` }} />
            ))}
          </div>
          <SkeletonTable rows={9} columns={6} className="rounded-none border-0" />
        </div>
      </div>
    </SkeletonShell>
  );
}

/** /review-queue: header with issue tabs, four summary cells, a list. */
export function SkeletonReviewQueuePage() {
  return (
    <SkeletonShell label="Loading the review queue…">
      <SkeletonConsoleHeader tabs={5} />
      <div className="px-[var(--layout-workspace-gutter)] pb-10 pt-5">
        <div className="data-panel mb-4 grid grid-cols-2 gap-px overflow-hidden !bg-border lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="bg-surface px-4 py-3">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="mt-2.5 h-6 w-12" />
              <Skeleton className="mt-2 h-2.5 w-32" />
            </div>
          ))}
        </div>
        <div className="mb-4 flex flex-wrap gap-2">
          <Skeleton className="h-9 min-w-[14rem] flex-1 rounded-lg" />
          <Skeleton className="h-9 w-32 rounded-lg" />
          <Skeleton className="h-9 w-32 rounded-lg" />
        </div>
        <div className="data-panel divide-y divide-border overflow-hidden">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="flex h-14 items-center gap-4 px-4">
              <Skeleton className="h-4 w-4 rounded" />
              <Skeleton className="h-3 w-40" />
              <Skeleton className="h-3 flex-1" style={{ maxWidth: `${70 - (index % 3) * 12}%` }} />
              <Skeleton className="hidden h-7 w-20 rounded-lg sm:block" />
            </div>
          ))}
        </div>
      </div>
    </SkeletonShell>
  );
}

/** /extraction/new: the upload portal beside the processing queue. */
export function SkeletonExtractionPage() {
  return (
    <SkeletonShell label="Loading extraction…">
      <SkeletonConsoleHeader tabs={0} withAction={false} />
      <div className="px-[var(--layout-workspace-gutter)] pb-12 pt-6">
        <div className="grid items-start gap-4 lg:gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <div className="rounded-xl border border-border bg-surface p-5">
            <Skeleton className="h-4 w-40" />
            <div className="mt-4 flex h-48 flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-border">
              <Skeleton className="h-10 w-10 rounded-full" />
              <Skeleton className="h-3 w-56 max-w-[80%]" />
              <Skeleton className="h-2.5 w-40 max-w-[60%]" />
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {Array.from({ length: 4 }, (_, index) => (
                <Skeleton key={index} className="h-9 rounded-lg" />
              ))}
            </div>
          </div>
          <div className="rounded-xl border border-border bg-surface p-5">
            <Skeleton className="h-4 w-32" />
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index} className="mt-4 flex items-center gap-3">
                <Skeleton className="h-9 w-9 shrink-0 rounded-lg" />
                <div className="flex-1">
                  <Skeleton className="h-3 w-3/5" />
                  <Skeleton className="mt-2 h-1.5 w-full rounded-full" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </SkeletonShell>
  );
}

/** One document open: an overview column beside the fields/results area. */
export function SkeletonDocumentWorkspace({ label = "Opening document…" }: { label?: string }) {
  return (
    <SkeletonShell label={label}>
      <div className="border-b border-border bg-surface px-[var(--layout-workspace-gutter)] py-3" aria-hidden="true">
        <Skeleton className="h-2.5 w-28" />
        <Skeleton className="mt-2 h-5 w-72 max-w-full" />
      </div>
      <div className="grid gap-5 px-[var(--layout-workspace-gutter)] pb-12 pt-6 lg:grid-cols-[minmax(260px,30fr)_minmax(0,70fr)]">
        <div className="space-y-4 rounded-xl border border-border bg-surface p-5">
          <div className="flex items-center gap-3">
            <Skeleton className="h-10 w-10 shrink-0 rounded-lg" />
            <div className="flex-1">
              <Skeleton className="h-3.5 w-3/4" />
              <Skeleton className="mt-2 h-2.5 w-1/3" />
            </div>
          </div>
          <SkeletonText lines={4} />
          <Skeleton className="h-20 rounded-lg" />
          <SkeletonText lines={3} />
        </div>
        <div className="space-y-4">
          <div className="flex gap-2">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} className="h-8 w-24 rounded-lg" />
            ))}
          </div>
          <SkeletonTable rows={8} columns={4} />
        </div>
      </div>
    </SkeletonShell>
  );
}
