import { describe, expect, it } from "vitest";

import { invoiceRecognition } from "@/lib/invoice-recognition";
import { evidenceHref, formatKeyDate, relativeLabel } from "@/lib/key-dates";
import type { StagingWorkbook } from "@/lib/staging-workbook";

describe("key dates", () => {
  it("describes how far away a date is", () => {
    expect(relativeLabel({ kind: "expiry", days_remaining: 45 })).toBe("Expires in 45 days");
    expect(relativeLabel({ kind: "expiry", days_remaining: 1 })).toBe("Expires in 1 day");
    expect(relativeLabel({ kind: "expiry", days_remaining: 0 })).toBe("Expires today");
    expect(relativeLabel({ kind: "expiry", days_remaining: -12 })).toBe("Expired 12 days ago");
    expect(relativeLabel({ kind: "renewal", days_remaining: 3 })).toBe("Renews in 3 days");
  });

  it("formats ISO dates without a timezone shift", () => {
    expect(formatKeyDate("2032-04-15")).toMatch(/2032/);
    expect(formatKeyDate("2032-04-15")).toMatch(/15/);
  });

  it("links to the evidence on its page", () => {
    const href = evidenceHref({ document_id: "d1", page: 2, evidence_text: "Policy Expiration Date: 12/10/2026\nmore" });
    expect(href).toBe("/documents/d1?view=source&page=2&hl=Policy+Expiration+Date%3A+12%2F10%2F2026");
  });
});

function workbook(erpRows: [string, string | null, string | null, string | null][]): StagingWorkbook {
  const cell = (value: string | null) => ({ value }) as never;
  return {
    datasets: [
      {
        dataset_id: "erp_staging",
        records: erpRows.map(([field, value, source, status], i) => ({
          record_id: `erp:${i}`,
          cells: {
            "invoice.erp.field": cell(field),
            "invoice.erp.value": cell(value),
            "invoice.erp.source": cell(source),
            "invoice.erp.status": cell(status),
          },
        })),
      },
      {
        dataset_id: "invoice_validation",
        records: [
          {
            record_id: "v0",
            cells: {
              "invoice.validation.check": cell("PO exists"),
              "invoice.validation.result": cell("PASS"),
              "invoice.validation.details": cell("PO found."),
            },
          },
        ],
      },
    ],
  } as unknown as StagingWorkbook;
}

describe("invoice recognition", () => {
  it("reads the IDR status and whether the supplier matched", () => {
    const matched = invoiceRecognition(
      workbook([
        ["Recognition Status", "Not Validated", "Dataomatix", "Ready for ERP validation"],
        ["Supplier", "Northwind", "Supplier master", "Matched by exact name"],
      ]),
    );
    expect(matched?.status).toBe("Not Validated");
    expect(matched?.supplierMatched).toBe(true);
    expect(matched?.checks).toEqual([{ check: "PO exists", result: "PASS", details: "PO found." }]);

    const unmatched = invoiceRecognition(
      workbook([
        ["Recognition Status", "Incomplete", "Dataomatix", "supplier not matched to the supplier master"],
        ["Supplier", "NW Supply", "Invoice", "Not matched"],
      ]),
    );
    expect(unmatched?.supplierMatched).toBe(false);
    expect(unmatched?.reasons).toContain("supplier not matched");
  });

  it("is absent for other profiles", () => {
    expect(invoiceRecognition({ datasets: [] } as unknown as StagingWorkbook)).toBeNull();
  });
});
