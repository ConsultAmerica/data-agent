import { getWorkspaceToken, WORKSPACE_HEADER } from "@/lib/workspace";
export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8001";

export type BackendProbeResult =
  | { state: "healthy" }
  | { state: "unavailable"; message: string; retryable: boolean };

export function apiUrl(path: string): string {
  return `${API_URL}${path}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Render's free tier spins the backend down after ~15 minutes idle;
// the first request after that can take 30-90s to wake it. Retry
// through that window with backoff instead of surfacing an error for
// what is really just a slow cold start. A failed fetch() always
// rejects with a TypeError (network failure, DNS, CORS block, ...) —
// there is no way from JS to tell those apart, so we retry on any of
// them and only give up once the backoff window is exhausted.
export const COLD_START_RETRY_DELAYS_MS = [2000, 4000, 8000, 16000, 30000, 45000];

function isRenderBackend(): boolean {
  return API_URL.includes("onrender.com");
}

// Derived from the actual configured API_URL rather than hardcoded, so
// this never goes stale again when the backend is repointed at a
// different Render service (as happened moving off data-agent-backend
// onto data-agent-backend-qbmc).
function renderServiceName(): string {
  try {
    return new URL(API_URL).hostname.split(".")[0];
  } catch {
    return "your Render service";
  }
}

function outdatedBackendMessage(): string {
  return isRenderBackend()
    ? `The Dataomatix API at ${API_URL} doesn't have this feature yet — it is running an older version. ` +
        `Redeploy the ${renderServiceName()} service on Render with the latest commit.`
    : `The Dataomatix API at ${API_URL} doesn't have this feature yet — restart it on the latest code.`;
}

function unreachableBackendMessage(): string {
  if (isRenderBackend()) {
    return (
      `Cannot reach the Dataomatix API at ${API_URL}. ` +
      "The Render backend may be suspended, redeploying, or waking from idle — " +
      "wait 60–90 seconds and retry. If this persists, open the Render dashboard " +
      `and resume or redeploy the ${renderServiceName()} service.`
    );
  }

  return (
    `Cannot reach the Dataomatix API at ${API_URL}. ` +
    "The processing service may be waking up, offline, or blocked — " +
    "retry in a moment, or confirm the FastAPI backend is running."
  );
}

export async function fetchWithRetry(
  path: string,
  init: RequestInit | undefined,
  onRetry?: (attempt: number, total: number) => void,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (typeof window !== "undefined") {
    const workspace = getWorkspaceToken();
    if (workspace && !headers.has(WORKSPACE_HEADER)) {
      headers.set(WORKSPACE_HEADER, workspace);
    }
    if (!headers.has("Authorization")) {
      const accessToken = window.localStorage.getItem(
        "data-agent-access-token",
      );
      if (accessToken) {
        headers.set("Authorization", `Bearer ${accessToken}`);
      }
    }
    if (!headers.has("X-Actor-Id") && !headers.has("Authorization")) {
      const actorId = window.localStorage.getItem("data-agent-actor-id");
      if (actorId) headers.set("X-Actor-Id", actorId);
    }
  }
  const nextInit: RequestInit = { ...init, headers };

  for (
    let attempt = 0;
    attempt <= COLD_START_RETRY_DELAYS_MS.length;
    attempt += 1
  ) {
    try {
      return await fetch(apiUrl(path), nextInit);
    } catch (error) {
      const isLastAttempt =
        attempt === COLD_START_RETRY_DELAYS_MS.length;

      if (!(error instanceof TypeError) || isLastAttempt) {
        throw error;
      }

      onRetry?.(attempt + 1, COLD_START_RETRY_DELAYS_MS.length);

      await sleep(COLD_START_RETRY_DELAYS_MS[attempt]);
    }
  }

  // Unreachable — the loop above always returns or throws.
  throw new TypeError("Failed to fetch");
}

// Pulls the most specific message a FastAPI error response can offer:
// a plain string `detail`, a nested `detail.message` (some endpoints
// wrap validation errors this way), a top-level `message`, or — if
// the body isn't JSON at all (e.g. a raw 500 traceback page) — its
// raw text. Falls back to the HTTP status if none of that is present.
async function extractErrorMessage(
  response: Response,
): Promise<string> {
  let message = `API returned ${response.status}`;

  try {
    const body = await response.json();

    if (typeof body?.detail === "string") {
      message = body.detail;
    } else if (typeof body?.detail?.message === "string") {
      message = body.detail.message;
    } else if (typeof body?.message === "string") {
      message = body.message;
    }
  } catch {
    const text = await response.text().catch(() => "");

    if (text) {
      message = text;
    }
  }

  return message;
}

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * Fetches from the Dataomatix API and returns the parsed JSON body.
 * Throws a descriptive Error on any failure so callers never have to
 * repeat response.ok / response.json() handling themselves.
 */
export async function apiFetch<T = unknown>(
  path: string,
  init?: RequestInit,
  onRetry?: (attempt: number, total: number) => void,
): Promise<T> {
  let response: Response;

  try {
    response = await fetchWithRetry(path, init, onRetry);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(unreachableBackendMessage());
    }

    throw error;
  }

  if (!response.ok) {
    const message = await extractErrorMessage(response);
    // FastAPI's bare "Not Found" means the route itself doesn't exist (missing
    // records say what is missing), i.e. the API is older than this app.
    if (response.status === 404 && message.trim() === "Not Found") {
      throw new ApiError(outdatedBackendMessage(), 404);
    }
    throw new ApiError(message, response.status);
  }

  const text = await response.text();

  if (!text) {
    return undefined as T;
  }

  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    return JSON.parse(text) as T;
  }

  return text as unknown as T;
}

import { ensureBackendHealthy } from "@/lib/backend-warmup";

/**
 * Ping the backend health endpoint before uploads or long-running work.
 * Uses the shared warm-up loop (gentle backoff, long per-attempt timeout)
 * so callers do not each start aggressive /health polling.
 */
export async function wakeBackend(
  _onRetry?: (attempt: number, total: number) => void,
): Promise<void> {
  await ensureBackendHealthy();
}

// A few quick attempts rather than a single shot — Render's free tier is
// prone to brief multi-second blips (see this session's OCR load-testing
// history) that resolve on their own; a UI banner shouldn't alarm the
// user over something that would have passed by the next request anyway.
const PROBE_RETRY_DELAYS_MS = [1500, 3000];

async function probeOnce(): Promise<BackendProbeResult> {
  try {
    const response = await fetch(apiUrl("/health"), {
      cache: "no-store",
      method: "GET",
    });

    if (response.ok) {
      return { state: "healthy" };
    }

    if (response.status === 404 && isRenderBackend()) {
      return {
        state: "unavailable",
        retryable: false,
        message:
          `The Render backend has no active server at this URL. Resume or redeploy the ${renderServiceName()} ` +
          "service in the Render dashboard, then retry.",
      };
    }

    return {
      state: "unavailable",
      retryable: true,
      message: `Backend responded with HTTP ${response.status}. Wait a moment and retry.`,
    };
  } catch {
    return {
      state: "unavailable",
      retryable: true,
      message: unreachableBackendMessage(),
    };
  }
}

/**
 * Connectivity probe for UI banners. Retries a couple of times over a
 * few seconds before reporting unavailable, so a brief blip doesn't
 * flash an alarming "service unavailable" banner at the user.
 */
export async function probeBackend(): Promise<BackendProbeResult> {
  let result = await probeOnce();

  for (const delay of PROBE_RETRY_DELAYS_MS) {
    if (result.state === "healthy" || !result.retryable) break;
    await sleep(delay);
    result = await probeOnce();
  }

  return result;
}
