/**
 * Shared backend warm-up for the extraction workflow.
 *
 * Starts a single /health probe loop as soon as the extraction page mounts
 * so Render cold starts overlap with file selection. Callers join the same
 * in-flight promise — they must not start competing poll loops.
 */

import { apiUrl } from "@/lib/api";

/** Bounded exponential backoff for cold-start wake (not aggressive polling). */
// Short first steps: a local or warm host (e.g. mid-reload) answers within
// a second, and Render cold starts still get the long tail.
export const HEALTH_BACKOFF_MS = [500, 1000, 2000, 3000, 5000, 8000, 13000, 21000, 34000];

/** Per-attempt health timeout — short timeouts falsely mark a booting host down. */
export const HEALTH_ATTEMPT_TIMEOUT_MS = 60_000;

export type WarmupStatus =
  | "idle"
  | "warming"
  | "healthy"
  | "failed";

export interface WarmupTimings {
  pageOpenedAt: number | null;
  healthStartedAt: number | null;
  healthyAt: number | null;
  uploadStartedAt: number | null;
  uploadCompletedAt: number | null;
  processingStartedAt: number | null;
  extractionCompletedAt: number | null;
}

type StatusListener = (status: WarmupStatus) => void;

let status: WarmupStatus = "idle";
let inflight: Promise<void> | null = null;
let listeners = new Set<StatusListener>();

const timings: WarmupTimings = {
  pageOpenedAt: null,
  healthStartedAt: null,
  healthyAt: null,
  uploadStartedAt: null,
  uploadCompletedAt: null,
  processingStartedAt: null,
  extractionCompletedAt: null,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setStatus(next: WarmupStatus) {
  status = next;
  for (const listener of listeners) {
    listener(next);
  }
}

function mark(label: string, field: keyof WarmupTimings) {
  const now = Date.now();
  timings[field] = now;
  if (typeof console !== "undefined" && console.debug) {
    const opened = timings.pageOpenedAt;
    const delta = opened != null ? ` (+${now - opened}ms)` : "";
    console.debug(`[dataomatix timing] ${label}${delta}`);
  }
}

export function getWarmupStatus(): WarmupStatus {
  return status;
}

export function getWarmupTimings(): Readonly<WarmupTimings> {
  return timings;
}

export function markUploadStarted() {
  mark("file upload started", "uploadStartedAt");
}

export function markUploadCompleted() {
  mark("upload completed", "uploadCompletedAt");
  logWarmupSummary("after upload");
}

export function markProcessingStarted() {
  mark("processing job started", "processingStartedAt");
}

export function markExtractionCompleted() {
  mark("extraction completed", "extractionCompletedAt");
  logWarmupSummary("after extraction");
}

function logWarmupSummary(when: string) {
  if (typeof console === "undefined" || !console.info) return;
  const t = timings;
  const opened = t.pageOpenedAt;
  if (opened == null) return;
  const delta = (at: number | null) =>
    at == null ? "—" : `${at - opened}ms`;
  console.info(
    `[dataomatix timing summary ${when}]`,
    `page→healthy=${delta(t.healthyAt)}`,
    `page→uploadStart=${delta(t.uploadStartedAt)}`,
    `page→uploadDone=${delta(t.uploadCompletedAt)}`,
    `healthy→uploadStart=${
      t.healthyAt != null && t.uploadStartedAt != null
        ? `${t.uploadStartedAt - t.healthyAt}ms`
        : "—"
    }`,
  );
}

export function subscribeWarmupStatus(listener: StatusListener): () => void {
  listeners.add(listener);
  listener(status);
  return () => {
    listeners.delete(listener);
  };
}

async function probeHealthOnce(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    HEALTH_ATTEMPT_TIMEOUT_MS,
  );

  try {
    const response = await fetch(apiUrl("/health"), {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function runWarmupLoop(): Promise<void> {
  if (timings.pageOpenedAt == null) {
    mark("frontend page opened / warm-up begin", "pageOpenedAt");
  }
  if (timings.healthStartedAt == null) {
    mark("health request started", "healthStartedAt");
  }

  setStatus("warming");

  for (let attempt = 0; attempt <= HEALTH_BACKOFF_MS.length; attempt += 1) {
    const ok = await probeHealthOnce();
    if (ok) {
      mark("backend healthy", "healthyAt");
      setStatus("healthy");
      logWarmupSummary("backend healthy");
      return;
    }

    if (attempt === HEALTH_BACKOFF_MS.length) {
      break;
    }

    await sleep(HEALTH_BACKOFF_MS[attempt]);
  }

  setStatus("failed");
  throw new Error(
    "Processing service did not become ready in time. Your file is still selected — retry in a moment.",
  );
}

/** Any successful API response proves the backend is up — skip the probe loop. */
export function markBackendHealthy() {
  if (status === "healthy") return;
  mark("backend healthy (API response)", "healthyAt");
  setStatus("healthy");
}

/**
 * Start (or join) background /health warm-up. Safe to call from page mount
 * and from the uploader — only one loop runs.
 */
export function startBackendWarmup(): Promise<void> {
  if (status === "healthy") {
    return Promise.resolve();
  }

  if (inflight) {
    return inflight;
  }

  inflight = runWarmupLoop().finally(() => {
    // Keep healthy; clear inflight so a later failure can retry.
    if (status !== "healthy") {
      inflight = null;
    }
  });

  return inflight;
}

/** Await readiness — joins the shared warm-up; does not start a second poll storm. */
export async function ensureBackendHealthy(): Promise<void> {
  if (status === "healthy") return;
  try {
    await startBackendWarmup();
  } catch {
    // First cycle failed; allow one fresh retry (inflight cleared in finally).
    await startBackendWarmup();
  }
}

/** Test helper — reset singleton state between vitest cases. */
export function __resetBackendWarmupForTests() {
  status = "idle";
  inflight = null;
  listeners = new Set();
  timings.pageOpenedAt = null;
  timings.healthStartedAt = null;
  timings.healthyAt = null;
  timings.uploadStartedAt = null;
  timings.uploadCompletedAt = null;
  timings.processingStartedAt = null;
  timings.extractionCompletedAt = null;
}
