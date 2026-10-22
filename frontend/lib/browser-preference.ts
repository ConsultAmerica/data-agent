import { useCallback, useSyncExternalStore } from "react";

/**
 * A small per-browser UI choice (a view toggle, a split pane) kept in
 * localStorage. The server and the first client render use the fallback;
 * the browser then reads the saved choice, so there is no hydration
 * mismatch. Blocked storage (private mode) just means the default.
 */

const CHANGE_EVENT = "dx:browser-preference";

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = window.localStorage.getItem(key);
    return value != null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
  } catch {
    return fallback;
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

export function useBrowserPreference<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): [T, (next: T) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => read(key, allowed, fallback),
    () => fallback,
  );
  const setValue = useCallback(
    (next: T) => {
      try {
        window.localStorage.setItem(key, next);
      } catch {
        // Storage unavailable: the choice isn't remembered, nothing else breaks.
      }
      window.dispatchEvent(new Event(CHANGE_EVENT));
    },
    [key],
  );
  return [value, setValue];
}
