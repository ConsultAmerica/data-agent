import { afterEach, describe, expect, it, vi } from "vitest";

const fetchWithRetry = vi.fn();
const downloadBlob = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn(), fetchWithRetry: (...args: unknown[]) => fetchWithRetry(...args) }));
vi.mock("@/lib/export", () => ({ downloadBlob: (...args: unknown[]) => downloadBlob(...args) }));

import { exportCsv, sameSource, sourceKey } from "@/lib/oracle-templates";

afterEach(() => {
  fetchWithRetry.mockReset();
  downloadBlob.mockReset();
});

describe("oracle template client", () => {
  it("identifies fields by reference, not by value", () => {
    const pair = { kind: "field" as const, dataset_id: "contract_details", field: "v", shape: "pair" as const, pair_key: "contract.contract_number" };
    expect(sourceKey(pair)).toBe("contract_details|v|contract.contract_number");
    expect(sameSource(pair, { ...pair })).toBe(true);
    expect(sameSource(pair, { ...pair, pair_key: "contract.award_date" })).toBe(false);
    expect(sameSource({ kind: "constant", constant: "ADD" }, { kind: "constant", constant: "ADD" })).toBe(true);
  });

  it("downloads the server's bytes unchanged (no byte-order mark added)", async () => {
    const blob = new Blob(["ContractNumber\r\nFA30\r\n"], { type: "text/csv" });
    // jsdom's Response can't wrap a Blob; the client only reads these members.
    fetchWithRetry.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="Contract.csv"', "X-Import-Ready": "true" }),
      blob: async () => blob,
    });
    const result = await exportCsv("doc-1", 7, { row_dataset: null, mappings: [], key_columns: [] });
    expect(result.importReady).toBe(true);
    const [content, name] = downloadBlob.mock.calls[0];
    expect(content).toBeInstanceOf(Blob);
    expect(name).toBe("Contract.csv");
    expect(fetchWithRetry.mock.calls[0][0]).toBe("/api/documents/doc-1/oracle/templates/7/export");
  });

  it("reports why an export was refused", async () => {
    fetchWithRetry.mockResolvedValue(
      new Response(JSON.stringify({ detail: { message: "Validation found errors; the file is not import-ready." } }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(exportCsv("doc-1", 7, { row_dataset: null, mappings: [], key_columns: [] })).rejects.toThrow(/not import-ready/);
    expect(downloadBlob).not.toHaveBeenCalled();
  });
});
