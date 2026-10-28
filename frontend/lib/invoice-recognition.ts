import { apiFetch } from "@/lib/api";
import type { StagingWorkbook } from "@/lib/staging-workbook";

// IDR-style invoice recognition (backend services/invoice_matching.py):
// "Not Validated" = every expected field recognized and matched (ready for
// ERP validation); "Incomplete" = needs attention.

export interface ReferenceSupplier {
  id: number;
  supplier_number: string;
  name: string;
  excluded_from_recognition: boolean;
}

export interface SupplierCorrectionResult {
  printed_name: string;
  supplier_number: string;
  supplier_name: string;
  alias_learned: boolean;
  status: string;
  method: string | null;
}

export interface InvoiceRecognition {
  status: string | null;
  reasons: string | null;
  supplierMatched: boolean;
  erp: { field: string; value: string | null; source: string | null; status: string | null }[];
  checks: { check: string; result: string; details: string }[];
}

function cellValue(
  cells: Record<string, { value: string | number | boolean | null }>,
  suffix: string,
): string | null {
  const key = Object.keys(cells).find((k) => k.endsWith(`.${suffix}`));
  const value = key ? cells[key].value : null;
  return value === null || value === undefined ? null : String(value);
}

export function invoiceRecognition(workbook: StagingWorkbook): InvoiceRecognition | null {
  const erpSet = workbook.datasets.find((d) => d.dataset_id === "erp_staging");
  if (!erpSet) return null;
  const erp = erpSet.records.map((r) => ({
    field: cellValue(r.cells, "field") ?? "",
    value: cellValue(r.cells, "value"),
    source: cellValue(r.cells, "source"),
    status: cellValue(r.cells, "status"),
  }));
  const checks = (workbook.datasets.find((d) => d.dataset_id === "invoice_validation")?.records ?? []).map((r) => ({
    check: cellValue(r.cells, "check") ?? "",
    result: cellValue(r.cells, "result") ?? "",
    details: cellValue(r.cells, "details") ?? "",
  }));
  const status = erp.find((row) => row.field === "Recognition Status");
  const supplier = erp.find((row) => row.field === "Supplier");
  return {
    status: status?.value ?? null,
    reasons: status?.status ?? null,
    supplierMatched: Boolean(supplier?.status?.startsWith("Matched")),
    erp,
    checks,
  };
}

export function listSuppliers(): Promise<ReferenceSupplier[]> {
  return apiFetch("/api/reference/suppliers");
}

export function correctInvoiceSupplier(documentId: string, supplierId: number): Promise<SupplierCorrectionResult> {
  return apiFetch(`/api/documents/${documentId}/invoice/supplier-match`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ supplier_id: supplierId }),
  });
}
