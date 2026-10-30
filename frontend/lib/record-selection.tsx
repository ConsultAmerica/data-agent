"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { ScalarTargetResult, TableTargetResult } from "@/types/document";

/**
 * One selection shared by Source Verification and the Staging Workbook.
 *
 * Records are named by stable ids, never by display position:
 *   field:<normalized_key>        an extracted field (Source Verification)
 *   row:<table key>#<n>           row n of an extracted table, in its stored order
 *   item:<presentation item id>   a value in the Staging Workbook
 *   layout:<record key>           a field or table row of the original layout
 *                                 (Original Structure, Business Data, Tables)
 *
 * A field and a workbook value are linked — selecting one selects the other
 * — only when the evidence says they are the same record: same source page
 * and same value, with exactly one candidate on each side. Anything less
 * certain stays unlinked rather than guessed.
 */

export const fieldId = (key: string) => `field:${key}`;
export const rowId = (table: string, index: number) => `row:${table}#${index}`;
export const itemId = (id: string) => `item:${id}`;
export const layoutId = (recordKey: string) => `layout:${recordKey}`;

/** A record any view can link to by its evidence: page and value. */
export interface EvidenceAnchor {
  id: string;
  page: number | null;
  value: unknown;
}

export type CheckState = "checked" | "unchecked" | "indeterminate";

export function checkState(ids: string[], selected: ReadonlySet<string>): CheckState {
  if (ids.length === 0) return "unchecked";
  const count = ids.filter((id) => selected.has(id)).length;
  return count === 0 ? "unchecked" : count === ids.length ? "checked" : "indeterminate";
}

interface Selection {
  selected: ReadonlySet<string>;
  toggle: (ids: string[], on: boolean) => void;
  clear: () => void;
  /** Links between ids naming the same record (from one view's data). */
  setLinks: (source: string, pairs: [string, string][]) => void;
  /** Distinct records selected (linked ids count once). */
  recordCount: number;
  scalars: ScalarTargetResult[];
  tables: TableTargetResult[];
  /** Layout records the Staging Workbook links its values to. */
  anchors: EvidenceAnchor[];
}

const Context = createContext<Selection | null>(null);

const NO_ANCHORS: EvidenceAnchor[] = [];

export function RecordSelectionProvider({
  scalars,
  tables,
  anchors = NO_ANCHORS,
  children,
}: {
  scalars: ScalarTargetResult[];
  tables: TableTargetResult[];
  anchors?: EvidenceAnchor[];
  children: ReactNode;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [linkSets, setLinkSets] = useState<Record<string, [string, string][]>>({});
  const linkSetsRef = useRef(linkSets);
  useEffect(() => {
    linkSetsRef.current = linkSets;
  }, [linkSets]);

  const links = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const pairs of Object.values(linkSets)) {
      for (const [a, b] of pairs) {
        if (!map.has(a)) map.set(a, new Set());
        if (!map.has(b)) map.set(b, new Set());
        map.get(a)!.add(b);
        map.get(b)!.add(a);
      }
    }
    return map;
  }, [linkSets]);

  const toggle = useCallback(
    (ids: string[], on: boolean) =>
      setSelected((previous) => {
        const next = new Set(previous);
        for (const id of ids) {
          for (const linked of [id, ...(links.get(id) ?? [])]) {
            if (on) next.add(linked);
            else next.delete(linked);
          }
        }
        return next;
      }),
    [links],
  );

  const setLinks = useCallback((source: string, pairs: [string, string][]) => {
    const current = linkSetsRef.current[source];
    if (current && JSON.stringify(current) === JSON.stringify(pairs)) return;
    setLinkSets((previous) => ({ ...previous, [source]: pairs }));
  }, []);

  const recordCount = useMemo(() => {
    let count = 0;
    const counted = new Set<string>();
    for (const id of selected) {
      if (counted.has(id)) continue;
      count += 1;
      counted.add(id);
      for (const linked of links.get(id) ?? []) counted.add(linked);
    }
    return count;
  }, [selected, links]);

  const value = useMemo<Selection>(
    () => ({ selected, toggle, clear: () => setSelected(new Set()), setLinks, recordCount, scalars, tables, anchors }),
    [selected, toggle, setLinks, recordCount, scalars, tables, anchors],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** The shared selection, or null outside a provider (views then keep their own). */
export function useRecordSelection(): Selection | null {
  return useContext(Context);
}

function normValue(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Field ↔ workbook value pairs that share page and value, uniquely. */
export function linkByEvidence(
  scalars: ScalarTargetResult[],
  items: { id: string; page: number | null; value: unknown }[],
): [string, string][] {
  return linkAnchors(
    scalars.map((scalar) => ({ id: fieldId(scalar.normalized_key), page: scalar.evidence?.page_number || scalar.page, value: scalar.value })),
    items,
  );
}

/** Anchor ↔ workbook value pairs that share page and value, uniquely:
 * one record on each side, or no link at all. */
export function linkAnchors(
  anchors: EvidenceAnchor[],
  items: { id: string; page: number | null; value: unknown }[],
): [string, string][] {
  const key = (page: number | null | undefined, value: unknown) => `${page ?? "?"}|${normValue(value)}`;
  const left = new Map<string, string[]>();
  for (const anchor of anchors) {
    if (anchor.page == null || normValue(anchor.value).length < 2) continue; // "Y", "" — too common to identify a record
    const k = key(anchor.page, anchor.value);
    left.set(k, [...(left.get(k) ?? []), anchor.id]);
  }
  const values = new Map<string, string[]>();
  for (const item of items) {
    if (item.page == null || normValue(item.value).length < 2) continue;
    const k = key(item.page, item.value);
    values.set(k, [...(values.get(k) ?? []), item.id]);
  }
  const pairs: [string, string][] = [];
  for (const [k, ids] of left) {
    const matches = values.get(k);
    if (ids.length === 1 && matches?.length === 1) pairs.push([ids[0], itemId(matches[0])]);
  }
  return pairs;
}
