"use client";

import { Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";

type Theme = "light" | "dark";

const listeners = new Set<() => void>();

function current(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function apply(theme: Theme) {
  if (theme === "dark") document.documentElement.dataset.theme = "dark";
  else delete document.documentElement.dataset.theme;
  try {
    window.localStorage.setItem("dx-theme", theme);
  } catch {
    // the choice still applies to this page
  }
  listeners.forEach((listener) => listener());
}

/** Light (default) or dark; remembered per browser (applied before first
 * paint by the root layout). */
export default function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, current, () => "light" as Theme);
  const dark = theme === "dark";
  return (
    <button
      type="button"
      onClick={() => apply(dark ? "light" : "dark")}
      aria-pressed={dark}
      aria-label={dark ? "Use light theme" : "Use dark theme"}
      title={dark ? "Light theme" : "Dark theme"}
      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/15 text-white/85 hover:bg-white/10"
      data-testid="theme-toggle"
    >
      {dark ? <Sun className="h-4 w-4" aria-hidden="true" /> : <Moon className="h-4 w-4" aria-hidden="true" />}
    </button>
  );
}
