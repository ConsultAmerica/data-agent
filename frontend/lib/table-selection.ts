"use client";

import { createContext, createElement, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

/** Excel-style selection in a staging grid: which cells of which records,
 * by stable ids (record_id → field ids, field = canonical_field). Never a
 * row index, so a selection survives search, filters and pagination. */
export type Selection = ReadonlyMap<string, ReadonlySet<string>>;

export const EMPTY_SELECTION: Selection = new Map();

export function isSelected(selection: Selection, recordId: string, field: string): boolean {
  return selection.get(recordId)?.has(field) ?? false;
}

/** Adds (on) or removes (off) every record × field cell. */
export function setCells(selection: Selection, recordIds: string[], fields: string[], on: boolean): Selection {
  const next = new Map(selection);
  for (const recordId of recordIds) {
    const cells = new Set(next.get(recordId) ?? []);
    for (const field of fields) {
      if (on) cells.add(field);
      else cells.delete(field);
    }
    if (cells.size) next.set(recordId, cells);
    else next.delete(recordId);
  }
  return next;
}

export function toggleCell(selection: Selection, recordId: string, field: string): Selection {
  return setCells(selection, [recordId], [field], !isSelected(selection, recordId, field));
}

/** Plain click: only this cell — or nothing, when it already was the only one. */
export function onlyCell(selection: Selection, recordId: string, field: string): Selection {
  const sole = selection.size === 1 && selection.get(recordId)?.size === 1 && isSelected(selection, recordId, field);
  return sole ? EMPTY_SELECTION : setCells(EMPTY_SELECTION, [recordId], [field], true);
}

export function allSelected(selection: Selection, recordIds: string[], fields: string[]): boolean {
  if (recordIds.length === 0 || fields.length === 0) return false;
  return recordIds.every((recordId) => fields.every((field) => isSelected(selection, recordId, field)));
}

export function someSelected(selection: Selection, recordIds: string[], fields: string[]): boolean {
  return recordIds.some((recordId) => fields.some((field) => isSelected(selection, recordId, field)));
}

/** A checkbox over a block of cells: on adds the whole block, off clears it. */
export function toggleBlock(selection: Selection, recordIds: string[], fields: string[]): Selection {
  return setCells(selection, recordIds, fields, !allSelected(selection, recordIds, fields));
}

/** Shift+click: the rectangle between two cells in the grid's own order. */
export function rangeBlock(
  recordOrder: string[],
  fieldOrder: string[],
  anchor: { recordId: string; field: string },
  target: { recordId: string; field: string },
): { recordIds: string[]; fields: string[] } | null {
  const r = [recordOrder.indexOf(anchor.recordId), recordOrder.indexOf(target.recordId)];
  const f = [fieldOrder.indexOf(anchor.field), fieldOrder.indexOf(target.field)];
  if (r.includes(-1) || f.includes(-1)) return null;
  return {
    recordIds: recordOrder.slice(Math.min(...r), Math.max(...r) + 1),
    fields: fieldOrder.slice(Math.min(...f), Math.max(...f) + 1),
  };
}

export function selectionCounts(selection: Selection): { cells: number; records: number; fields: number } {
  const fields = new Set<string>();
  let cells = 0;
  for (const set of selection.values()) {
    cells += set.size;
    for (const field of set) fields.add(field);
  }
  return { cells, records: selection.size, fields: fields.size };
}

/** What the export endpoint receives: ids only — never values. */
export function selectionManifest(selection: Selection): { record_id: string; fields: string[] }[] {
  return [...selection.entries()].map(([record_id, fields]) => ({ record_id, fields: [...fields] }));
}

// --- the store: one selection per document dataset, shared by the grid,
// its toolbar and the workspace's Export menu ------------------------------------------------

export interface ActiveSelection {
  documentId: string;
  datasetId: string;
  datasetName: string;
  selection: Selection;
}

type SelectionUpdate = Selection | ((current: Selection) => Selection);

export interface SelectionStore {
  get: (key: string) => Selection;
  /** Stable across renders: an update never re-creates the grid's handlers. */
  set: (key: string, next: SelectionUpdate, active: Omit<ActiveSelection, "selection">) => void;
  active: ActiveSelection | null;
}

const SelectionContext = createContext<SelectionStore | null>(null);

export function storeKey(documentId: string, datasetId: string): string {
  return `${documentId}\u0000${datasetId}`;
}

/** The workspace-level store (one per document page). */
export function useSelectionStore(): SelectionStore {
  const [selections, setSelections] = useState<ReadonlyMap<string, Selection>>(new Map());
  const [last, setLast] = useState<Omit<ActiveSelection, "selection"> | null>(null);
  const get = useCallback((key: string) => selections.get(key) ?? EMPTY_SELECTION, [selections]);
  const set = useCallback((key: string, next: SelectionUpdate, active: Omit<ActiveSelection, "selection">) => {
    setSelections((current) => {
      const value = typeof next === "function" ? next(current.get(key) ?? EMPTY_SELECTION) : next;
      return new Map(current).set(key, value);
    });
    setLast(active);
  }, []);
  const active = useMemo(() => {
    if (!last) return null;
    const selection = selections.get(storeKey(last.documentId, last.datasetId)) ?? EMPTY_SELECTION;
    return selection.size ? { ...last, selection } : null;
  }, [last, selections]);
  return useMemo(() => ({ get, set, active }), [get, set, active]);
}

export function SelectionProvider({ store, children }: { store: SelectionStore; children: ReactNode }) {
  return createElement(SelectionContext.Provider, { value: store }, children);
}

/** A grid's selection: from the workspace store when there is one (so it
 * survives filters, tab switches and remounts), else local to the grid. */
export function useTableSelection(
  documentId: string | undefined,
  datasetId: string,
  datasetName: string,
): [Selection, (next: SelectionUpdate) => void] {
  const store = useContext(SelectionContext);
  const [local, setLocal] = useState<Selection>(EMPTY_SELECTION);
  const key = storeKey(documentId ?? "", datasetId);
  const selection = store && documentId ? store.get(key) : local;
  const storeSet = store?.set;
  // Functional updates read the latest selection, so this handler keeps its
  // identity while the selection changes (memoized rows stay untouched).
  const update = useCallback(
    (next: SelectionUpdate) => {
      if (storeSet && documentId) storeSet(key, next, { documentId, datasetId, datasetName });
      else setLocal((current) => (typeof next === "function" ? next(current) : next));
    },
    [storeSet, documentId, key, datasetId, datasetName],
  );
  return [selection, update];
}

/** The most recently edited non-empty selection (for the Export menu). */
export function useActiveSelection(): ActiveSelection | null {
  return useContext(SelectionContext)?.active ?? null;
}
