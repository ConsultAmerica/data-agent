/** Column sort for output data grids: click cycles none → asc → desc → none. */

export type SortDirection = "asc" | "desc";

export type SortState = {
  field: string;
  direction: SortDirection;
} | null;

/** Advance the sort for a column header click. */
export function cycleSort(current: SortState, field: string): SortState {
  if (!current || current.field !== field) return { field, direction: "asc" };
  if (current.direction === "asc") return { field, direction: "desc" };
  return null;
}

/** Compare display strings: numbers when both parse, otherwise locale/numeric text. */
export function compareText(a: string, b: string): number {
  const left = a.trim();
  const right = b.trim();
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;

  const strip = (value: string) => value.replace(/[,$%\s]/g, "");
  const na = Number(strip(left));
  const nb = Number(strip(right));
  if (strip(left) !== "" && strip(right) !== "" && Number.isFinite(na) && Number.isFinite(nb)) {
    return na - nb;
  }
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

/** Stable sort of rows by a string key getter. */
export function sortByText<T>(
  rows: readonly T[],
  sort: SortState,
  valueOf: (row: T, field: string) => string,
): T[] {
  if (!sort) return [...rows];
  const { field, direction } = sort;
  const sign = direction === "asc" ? 1 : -1;
  return [...rows]
    .map((row, index) => ({ row, index, value: valueOf(row, field) }))
    .sort((a, b) => compareText(a.value, b.value) * sign || a.index - b.index)
    .map((entry) => entry.row);
}
