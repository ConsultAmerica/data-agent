import type { CSSProperties } from "react";

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
