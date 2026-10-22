import { useCallback, useSyncExternalStore } from "react";

export type TableDensity = "comfortable" | "compact";

const CHANGE_EVENT = "dx:table-density";

function storageKey(scope: string) {
  return `dx-table-density:${scope}`;
}

function read(scope: string): TableDensity {
  try {
    return window.localStorage.getItem(storageKey(scope)) === "compact" ? "compact" : "comfortable";
  } catch {
    // Private mode / blocked storage: fall back to the default.
    return "comfortable";
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** Comfortable / compact row density for one table family, remembered per
 * viewer. The server renders "comfortable"; the browser then reads the saved
 * choice, so there is no hydration mismatch. */
export function useTableDensity(scope: string): [TableDensity, (next: TableDensity) => void] {
  const density = useSyncExternalStore(
    subscribe,
    () => read(scope),
    () => "comfortable" as TableDensity,
  );
  const setDensity = useCallback(
    (next: TableDensity) => {
      try {
        window.localStorage.setItem(storageKey(scope), next);
      } catch {
        // Storage unavailable: the choice can't be remembered, nothing else breaks.
      }
      window.dispatchEvent(new Event(CHANGE_EVENT));
    },
    [scope],
  );
  return [density, setDensity];
}
