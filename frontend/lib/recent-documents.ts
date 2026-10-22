import { useMemo, useSyncExternalStore } from "react";

/**
 * Documents this browser opened recently, newest first. A convenience only
 * (quick-pick a document ID, name a crumb before the document loads):
 * private mode or blocked storage just means an empty list.
 */

export interface RecentDocument {
  id: string;
  name: string;
  /** Epoch ms of the last visit. */
  at: number;
}

const RECENT_DOCUMENTS_KEY = "da-recent-documents";
const RECENT_DOCUMENTS_LIMIT = 8;
/** Fired in this tab when the list changes ("storage" covers other tabs). */
const RECENT_DOCUMENTS_EVENT = "da-recent-documents-changed";

function readRaw(): string {
  try {
    return window.localStorage.getItem(RECENT_DOCUMENTS_KEY) ?? "[]";
  } catch {
    return "[]";
  }
}

function parse(raw: string): RecentDocument[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is RecentDocument =>
          Boolean(item) && typeof item.id === "string" && typeof item.name === "string" && typeof item.at === "number",
      )
      .slice(0, RECENT_DOCUMENTS_LIMIT);
  } catch {
    return [];
  }
}

export function loadRecentDocuments(): RecentDocument[] {
  if (typeof window === "undefined") return [];
  return parse(readRaw());
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(RECENT_DOCUMENTS_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(RECENT_DOCUMENTS_EVENT, onChange);
  };
}

/** The recent list as React state: empty on the server and at hydration,
 * then this browser's list (and live as it changes). */
export function useRecentDocuments(): RecentDocument[] {
  const raw = useSyncExternalStore(subscribe, readRaw, () => "[]");
  return useMemo(() => parse(raw), [raw]);
}

export function recordRecentDocument(id: string, name: string): void {
  if (typeof window === "undefined" || !id || !name) return;
  try {
    const next = [{ id, name, at: Date.now() }, ...loadRecentDocuments().filter((item) => item.id !== id)].slice(
      0,
      RECENT_DOCUMENTS_LIMIT,
    );
    window.localStorage.setItem(RECENT_DOCUMENTS_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event(RECENT_DOCUMENTS_EVENT));
  } catch {
    // Private mode / blocked storage: recents are a convenience only.
  }
}
