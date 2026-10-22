import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, apiFetch, probeBackend } from "@/lib/api";

describe("probeBackend", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    vi.useFakeTimers();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("reports healthy immediately without retrying", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    const result = await probeBackend();

    expect(result).toEqual({ state: "healthy" });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("recovers on a retry instead of reporting unavailable on one blip", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce({ ok: true, status: 200 });
    global.fetch = fetchMock;

    const promise = probeBackend();
    await vi.advanceTimersByTimeAsync(1500);

    const result = await promise;
    expect(result).toEqual({ state: "healthy" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports unavailable only after exhausting retries", async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError("network"));

    const promise = probeBackend();
    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(3000);

    const result = await promise;
    expect(result.state).toBe("unavailable");
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-retryable 404 on a Render host, and names the actual service", async () => {
    vi.resetModules();
    vi.stubEnv(
      "NEXT_PUBLIC_API_URL",
      "https://data-agent-backend-qbmc.onrender.com",
    );

    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    global.fetch = fetchMock;

    const { probeBackend: freshProbeBackend } = await import("@/lib/api");
    const result = await freshProbeBackend();

    expect(result.state).toBe("unavailable");
    if (result.state === "unavailable") {
      expect(result.retryable).toBe(false);
      expect(result.message).toContain("data-agent-backend-qbmc");
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.unstubAllEnvs();
  });
});

describe("apiFetch 404s", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function respond(status: number, detail: string) {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail }), { status, headers: { "Content-Type": "application/json" } }),
    );
  }

  it("explains a missing route as an out-of-date API", async () => {
    respond(404, "Not Found");
    const error = await apiFetch("/api/intake/config").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as Error).message).toMatch(/doesn't have this feature yet/);
  });

  it("keeps a specific not-found message as is", async () => {
    respond(404, "Document not found.");
    await expect(apiFetch("/api/documents/x")).rejects.toThrow("Document not found.");
  });
});
