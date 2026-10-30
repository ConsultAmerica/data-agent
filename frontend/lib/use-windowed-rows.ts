"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Below this many rows everything renders (small lists stay simple and
 * fully searchable by the browser). */
export const WINDOW_ABOVE = 150;
const OVERSCAN = 20;

/**
 * Renders only the rows near a scroll container's viewport. Rows above and
 * below are replaced by two spacer heights, from the measured average row
 * height, so the scrollbar keeps the full length. Returns the index range
 * to render and the spacer heights; attach the returned ref to the scroll
 * container.
 */
export function useWindowedRows(count: number, estimate = 30) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [range, setRange] = useState<[number, number]>([0, Math.min(count, WINDOW_ABOVE)]);
  const [rowHeight, setRowHeight] = useState(estimate);
  const windowed = count > WINDOW_ABOVE;

  const update = useCallback(() => {
    const box = ref.current;
    if (!box || !windowed) return;
    // Measured rows give the real height (wrapped text, density).
    const rows = box.querySelectorAll<HTMLElement>("[data-window-row]");
    if (rows.length > 4) {
      const total = Array.from(rows).reduce((sum, row) => sum + row.offsetHeight, 0);
      const average = total / rows.length;
      if (Math.abs(average - rowHeight) > 1) setRowHeight(average);
    }
    const first = Math.max(0, Math.floor(box.scrollTop / rowHeight) - OVERSCAN);
    const visible = Math.ceil(box.clientHeight / rowHeight) + OVERSCAN * 2;
    const next: [number, number] = [first, Math.min(count, first + visible)];
    setRange((current) => (current[0] === next[0] && current[1] === next[1] ? current : next));
  }, [count, rowHeight, windowed]);

  useEffect(() => {
    const box = ref.current;
    if (!box || !windowed) return;
    const frame = requestAnimationFrame(update);
    box.addEventListener("scroll", update, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      box.removeEventListener("scroll", update);
    };
  }, [update, windowed]);

  const [start, end] = windowed ? range : [0, count];
  // The ref apart from the values, so rendering reads no ref.
  return [
    ref,
    {
      windowed,
      start,
      end: Math.min(end, count),
      before: windowed ? start * rowHeight : 0,
      after: windowed ? Math.max(0, (count - Math.min(end, count)) * rowHeight) : 0,
    },
  ] as const;
}
