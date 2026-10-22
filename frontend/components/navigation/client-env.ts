"use client";

import { useSyncExternalStore } from "react";

const noopSubscribe = () => () => {};

/** Where this build is running, for the header's environment badge.
 * NEXT_PUBLIC_DEPLOY_ENV wins (e.g. "GovCloud-US-East"); otherwise inferred
 * from the host. Never claims a regulated environment on its own. */
export function deployEnvironment(hostname: string, configured = process.env.NEXT_PUBLIC_DEPLOY_ENV): string {
  const explicit = (configured ?? "").trim();
  if (explicit) return explicit;
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local")) return "Local";
  if (host.endsWith(".vercel.app")) return "Preview";
  return "Production";
}

/** The environment label, or null during server render (no host there). */
export function useDeployEnvironment(): string | null {
  return useSyncExternalStore(
    noopSubscribe,
    () => deployEnvironment(window.location.hostname),
    () => null,
  );
}

/** "⌘K" on Apple platforms, "Ctrl K" elsewhere (and on the server). */
export function useShortcutLabel(): string {
  return useSyncExternalStore(
    noopSubscribe,
    () => (/mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent) ? "⌘K" : "Ctrl K"),
    () => "Ctrl K",
  );
}
