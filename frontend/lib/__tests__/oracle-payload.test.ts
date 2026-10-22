import { describe, expect, it } from "vitest";

import { formatKb, oracleEnvironment, payloadBytes, payloadSchema, tokenizeJson } from "@/lib/oracle-payload";
import { formatContractValue } from "@/lib/document-repository";
import { relatedFromHierarchy } from "@/lib/related-documents";
import type { OraclePayloadPreview } from "@/lib/reviewed-export";
import type { HierarchyNode } from "@/types/document";

const preview = {
  document_id: "d1",
  source_document: "contract.pdf",
  erp_target: "Oracle Fusion Cloud Procurement",
  mode: "preview",
  dry_run: true,
  send_allowed: false,
  generated_at: "2026-10-08T12:00:00Z",
  excluded_statuses: ["pending", "rejected"],
  contract_header: { contract_number: "C-1" },
  fields: [
    {
      field: "Contract Number",
      field_key: "contract_number",
      extracted_value: "C-1",
      value: "C-1",
      review_status: "accepted",
      confidence: 0.98,
      validation: { status: "passed" },
      source: { page: 1 },
    },
  ],
  skipped: [],
  authoritative_count: 1,
  skipped_count: 0,
  ready_to_send: true,
} satisfies OraclePayloadPreview;

describe("oracle payload helpers", () => {
  it("tokenizes JSON losslessly and tells keys from string values", () => {
    const text = JSON.stringify({ a: "x", n: -1.5e3, ok: true, none: null, list: [1, "two"] }, null, 2);
    const tokens = tokenizeJson(text);
    expect(tokens.map((token) => token.text).join("")).toBe(text);
    expect(tokens.find((token) => token.text === '"a"')?.kind).toBe("key");
    expect(tokens.find((token) => token.text === '"x"')?.kind).toBe("string");
    expect(tokens.find((token) => token.text === "-1500")?.kind).toBe("number");
    expect(tokens.find((token) => token.text === "true")?.kind).toBe("boolean");
    expect(tokens.find((token) => token.text === "null")?.kind).toBe("null");
    // Escaped quotes stay inside their string.
    const escaped = tokenizeJson('{"q": "say \\"hi\\""}');
    expect(escaped.filter((token) => token.kind === "string").map((token) => token.text)).toEqual(['"say \\"hi\\""']);
  });

  it("maps source fields to payload keys and reports the environment honestly", () => {
    const [header, fields] = payloadSchema(preview);
    expect(header.entries).toEqual([{ source: "Contract Number", payloadKey: "contract_header.contract_number" }]);
    expect(fields.entries[0]).toMatchObject({ source: "Contract Number", payloadKey: "fields[0]" });
    expect(oracleEnvironment({ dry_run: true }).kind).toBe("dry-run");
    expect(oracleEnvironment({ dry_run: false }).label).toBe("Live");
    expect(payloadBytes(preview)).toBe(new TextEncoder().encode(JSON.stringify(preview)).length);
    expect(formatKb(2048)).toBe("2.00 KB");
  });
});

describe("repository helpers", () => {
  it("formats dollar values, groups bare numbers, and leaves other text alone", () => {
    expect(formatContractValue("$1250000")).toBe("$1,250,000.00");
    expect(formatContractValue("$1,250,000.50")).toBe("$1,250,000.50");
    expect(formatContractValue("125000")).toBe("125,000");
    expect(formatContractValue("EUR 10.000,00")).toBe("EUR 10.000,00");
    expect(formatContractValue(null)).toBe("—");
  });

  it("finds a document's parent, siblings and children in the hierarchy", () => {
    const node = (id: string, children: HierarchyNode[] = []): HierarchyNode => ({
      document_id: id,
      title: id,
      document_number: null,
      document_type: null,
      relationship_type: "modification",
      relationship_status: "confirmed",
      children,
    });
    const roots = [node("base", [node("m1", [node("m1a")]), node("m2")]), node("other", [node("x")])];
    expect(relatedFromHierarchy(roots, "m1").map((item) => `${item.role}:${item.documentId}`)).toEqual([
      "parent:base",
      "sibling:m2",
      "child:m1a",
    ]);
    expect(relatedFromHierarchy(roots, "missing")).toEqual([]);
  });
});
