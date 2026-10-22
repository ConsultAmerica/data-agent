"use client";

import { useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
import type { PageRender } from "@/types/document";

interface PdfPageViewerProps {
  render: PageRender | null;
  loading: boolean;
  error: string;
  zoom?: number;
  rotation?: 0 | 90 | 180 | 270;
  /** Hide the internal "Page N" bar — used when a parent (e.g. the
   * split-pane source preview) already shows document/page context. */
  hideHeader?: boolean;
  /** Changes whenever the reviewer picks a value (even the same one again),
   * so the box is scrolled to and pulsed each time. */
  focusKey?: string | number | null;
  /** Clicking the highlighted box (e.g. to bring its field back into view). */
  onHighlightClick?: () => void;
}

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export default function PdfPageViewer({
  render,
  loading,
  error,
  zoom = 1,
  rotation = 0,
  hideHeader = false,
  focusKey = null,
  onHighlightClick,
}: PdfPageViewerProps) {
  const highlightRef = useRef<HTMLDivElement>(null);
  const highlight = render?.highlight ?? null;
  const highlightKey = highlight
    ? `${render?.page_number}:${highlight.x0}:${highlight.y0}:${highlight.x1}:${highlight.y1}:${focusKey ?? ""}`
    : null;

  // Bring the value's box into view and pulse it twice so the eye finds it.
  useEffect(() => {
    const box = highlightRef.current;
    if (!highlightKey || !box) return;
    const reduce = prefersReducedMotion();
    box.scrollIntoView?.({ behavior: reduce ? "auto" : "smooth", block: "center", inline: "center" });
    if (reduce || typeof box.animate !== "function") return;
    box.animate(
      [
        { boxShadow: "0 0 0 0 rgba(217, 119, 6, 0.55)", transform: "scale(1)" },
        { boxShadow: "0 0 0 10px rgba(217, 119, 6, 0)", transform: "scale(1.04)" },
        { boxShadow: "0 0 0 0 rgba(217, 119, 6, 0)", transform: "scale(1)" },
      ],
      { duration: 650, iterations: 2, delay: 250, easing: "ease-out" },
    );
  }, [highlightKey]);

  if (loading && !render) {
    return (
      <div className="flex h-full items-start justify-center overflow-hidden bg-surface-soft p-4" role="status" aria-busy="true">
        <span className="sr-only">Loading page…</span>
        <div className="w-full max-w-xl rounded-lg border border-border bg-surface p-6 shadow-sm">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="mt-6 h-3 w-full" />
          <Skeleton className="mt-2 h-3 w-11/12" />
          <Skeleton className="mt-2 h-3 w-4/5" />
          <div className="mt-6 grid grid-cols-2 gap-3">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
          <Skeleton className="mt-6 h-3 w-full" />
          <Skeleton className="mt-2 h-3 w-3/4" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-danger">
        {error}
      </div>
    );
  }

  if (!render) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-text-secondary">
        Loading document…
      </div>
    );
  }

  const isSideways = rotation === 90 || rotation === 270;
  const naturalWidth = render.page_width * zoom;
  const naturalHeight = render.page_height * zoom;
  // The outer box's footprint must match the POST-rotation visual size, or
  // a 90°/270° rotation paints the page mostly outside its scrollable
  // ancestor's layout bounds (CSS transforms don't reflow layout).
  const footprintWidth = isSideways ? naturalHeight : naturalWidth;
  const footprintHeight = isSideways ? naturalWidth : naturalHeight;

  return (
    <div className="flex h-full flex-col">
      {!hideHeader && (
        <div className="flex shrink-0 items-center justify-between border-b border-border bg-surface px-4 py-2.5">
          <p className="text-sm font-semibold text-foreground">
            Page {render.page_number}
          </p>

          {loading && (
            <Loader2 className="h-4 w-4 animate-spin text-text-muted" />
          )}
        </div>
      )}

      <div className="min-h-0 min-w-0 flex-1 overflow-auto bg-surface-soft p-4">
        <div
          className="relative mx-auto transition-[width,height]"
          style={{ width: footprintWidth, height: footprintHeight }}
        >
          <div
            className="absolute left-1/2 top-1/2 transition-transform"
            style={{
              width: naturalWidth,
              height: naturalHeight,
              transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={render.image_data_url}
              alt={`Page ${render.page_number}`}
              className="block h-full w-full rounded-lg border border-border shadow-sm"
            />

            {highlight && (
              <div
                ref={highlightRef}
                data-evidence-highlight
                onClick={onHighlightClick}
                title={onHighlightClick ? "Show this value in the list" : undefined}
                className={[
                  "absolute rounded-sm bg-warning/30 ring-2 ring-warning",
                  onHighlightClick ? "cursor-pointer" : "pointer-events-none",
                ].join(" ")}
                style={{
                  left: `${(highlight.x0 / render.page_width) * 100}%`,
                  top: `${(highlight.y0 / render.page_height) * 100}%`,
                  width: `${
                    ((highlight.x1 - highlight.x0) / render.page_width) *
                    100
                  }%`,
                  height: `${
                    ((highlight.y1 - highlight.y0) /
                      render.page_height) *
                    100
                  }%`,
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
