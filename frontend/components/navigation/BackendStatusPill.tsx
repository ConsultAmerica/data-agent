"use client";

import { useEffect, useRef, useState } from "react";

import { useDeployEnvironment } from "@/components/navigation/client-env";
import { probeBackend } from "@/lib/api";

type PillState = "checking" | "ready" | "waking" | "offline";

const POLL_HEALTHY_MS = 60_000;
const POLL_UNHEALTHY_MS = 20_000;

const STATE_META: Record<
  PillState,
  { label: string; dotClass: string }
> = {
  checking: { label: "Checking…", dotClass: "bg-text-muted" },
  ready: { label: "API Ready", dotClass: "bg-success" },
  waking: { label: "Backend waking up…", dotClass: "bg-warning" },
  offline: { label: "Backend offline", dotClass: "bg-danger" },
};

/** API health with the environment it is running in. `labelled` shows the
 * text beside the dot (wide headers); otherwise the dot alone, with the same
 * text in its tooltip and for screen readers. */
export default function BackendStatusPill({
  labelled = true,
  labelClassName = "hidden sm:inline",
}: {
  labelled?: boolean;
  /** When the text beside the dot shows (it is always in the tooltip). */
  labelClassName?: string;
} = {}) {
  const [state, setState] = useState<PillState>("checking");
  const [message, setMessage] = useState<string | null>(null);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    let active = true;

    async function check() {
      const result = await probeBackend();
      if (!active) return;

      if (result.state === "healthy") {
        setState("ready");
        setMessage(null);
        timeoutRef.current = window.setTimeout(check, POLL_HEALTHY_MS);
        return;
      }

      setState(result.retryable ? "waking" : "offline");
      setMessage(result.message);
      timeoutRef.current = window.setTimeout(check, POLL_UNHEALTHY_MS);
    }

    void check();

    return () => {
      active = false;
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const meta = STATE_META[state];
  const environment = useDeployEnvironment();
  // "Local · API Ready": where it runs, then whether the API answers.
  const title = [environment ? `Environment: ${environment}` : null, meta.label, message]
    .filter(Boolean)
    .join(" · ");

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-text-on-dark"
      title={title}
      data-testid="backend-status"
    >

      <span
        className={[
          "h-1.5 w-1.5 shrink-0 rounded-full",
          meta.dotClass,
          state === "checking" || state === "waking"
            ? "animate-pulse"
            : "",
        ].join(" ")}
      />
      {/* No label while probing — "Checking…" reads as broken on first paint. */}
      {state === "checking" || !labelled ? (
        <span className="sr-only">{title}</span>
      ) : (
        <span className={`whitespace-nowrap ${labelClassName}`}>
          {environment && <span className="text-white/60">{environment} · </span>}
          {meta.label}
        </span>
      )}
    </span>
  );
}
