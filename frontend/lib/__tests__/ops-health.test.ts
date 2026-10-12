import { afterEach, describe, expect, it, vi } from "vitest";

import { probeOpsHealth } from "@/lib/ops-health";

describe("probeOpsHealth", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports available when health and ready succeed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.includes("/health")) {
          return new Response("{}", { status: 200 });
        }
        return new Response(
          JSON.stringify({
            status: "ready",
            oracle_dry_run: true,
            rbac_enforced: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const snap = await probeOpsHealth();
    expect(snap.kind).toBe("available");
    expect(snap.label).toMatch(/available/i);
    expect(snap.oracleDryRun).toBe(true);
    expect(snap.rbacEnforced).toBe(true);
  });

  it("reports waking when health cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    const snap = await probeOpsHealth();
    expect(snap.kind).toBe("waking");
  });

  it("reports degraded when ready fails after health ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.includes("/health")) {
          return new Response("{}", { status: 200 });
        }
        return new Response(JSON.stringify({ status: "not_ready" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const snap = await probeOpsHealth();
    expect(snap.kind).toBe("degraded");
    expect(snap.readyStatus).toBe("not_ready");
  });

  it("reports unavailable when health returns non-OK", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("down", { status: 502 })),
    );

    const snap = await probeOpsHealth();
    expect(snap.kind).toBe("unavailable");
  });
});
