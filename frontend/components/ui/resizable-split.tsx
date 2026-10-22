"use client";

import { useCallback, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

const CHANGE_EVENT = "ui-resizable-split-change";

function readStored(storageKey: string, fallback: number): number {
  try {
    const raw = window.localStorage.getItem(storageKey);
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeStored(storageKey: string, value: number) {
  try {
    window.localStorage.setItem(storageKey, String(Math.round(value)));
  } catch {
    // private mode / blocked storage: the split still works for this visit
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(callback: () => void) {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

/**
 * Two panes with a draggable divider (lg and up). Drag, or focus the divider
 * and use ←/→ (5% steps), Home/End (limits); double-click resets. The split
 * is remembered per browser. Below lg the panes stack and the divider hides;
 * the caller's pane classes decide what shows.
 */
export default function ResizableSplit({
  left,
  right,
  storageKey,
  defaultPercent = 50,
  min = 30,
  max = 70,
  label = "Resize panels",
  className = "",
  leftClassName = "",
  rightClassName = "",
}: {
  left: ReactNode;
  right: ReactNode;
  storageKey: string;
  defaultPercent?: number;
  min?: number;
  max?: number;
  label?: string;
  className?: string;
  leftClassName?: string;
  rightClassName?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const clamp = useCallback((value: number) => Math.min(max, Math.max(min, value)), [min, max]);
  const stored = useSyncExternalStore(
    subscribe,
    () => clamp(readStored(storageKey, defaultPercent)),
    () => defaultPercent,
  );
  // While dragging only local state moves; the value is saved on release.
  const [dragPercent, setDragPercent] = useState<number | null>(null);
  const percent = dragPercent ?? stored;

  const percentAt = (clientX: number) => {
    const box = containerRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return percent;
    return clamp(((clientX - box.left) / box.width) * 100);
  };

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragPercent(percentAt(event.clientX));
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (dragPercent === null) return;
    setDragPercent(percentAt(event.clientX));
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (dragPercent === null) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    writeStored(storageKey, dragPercent);
    setDragPercent(null);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const next =
      event.key === "ArrowLeft"
        ? percent - 5
        : event.key === "ArrowRight"
          ? percent + 5
          : event.key === "Home"
            ? min
            : event.key === "End"
              ? max
              : null;
    if (next === null) return;
    event.preventDefault();
    writeStored(storageKey, clamp(next));
  }

  return (
    <div
      ref={containerRef}
      className={`flex min-h-0 flex-1 overflow-hidden ${dragPercent !== null ? "cursor-col-resize select-none" : ""} ${className}`}
      style={{ ["--split-left" as string]: `${percent}%` }}
    >
      <div className={`min-w-0 flex-1 lg:flex-none lg:basis-[var(--split-left)] ${leftClassName}`}>{left}</div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Math.round(percent)}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        onDoubleClick={() => writeStored(storageKey, defaultPercent)}
        title="Drag to resize · double-click to reset"
        className="group relative hidden w-2 shrink-0 cursor-col-resize touch-none items-center justify-center bg-border/40 outline-none transition-colors hover:bg-primary/20 focus-visible:bg-primary/30 lg:flex"
        data-testid="split-handle"
      >
        <span className="h-10 w-1 rounded-full bg-text-muted/40 transition-colors group-hover:bg-primary group-focus-visible:bg-primary" />
      </div>
      <div className={`min-w-0 flex-1 ${rightClassName}`}>{right}</div>
    </div>
  );
}
