import type { OraclePayloadPreview } from "@/lib/reviewed-export";

/**
 * The checklist shown before an Oracle send. Every item must pass before the
 * confirm button unlocks, so a payload is never sent by accident or without
 * the header Oracle needs to create the record.
 */

export interface OracleChecklistItem {
  id: string;
  group: "system" | "metadata";
  label: string;
  passed: boolean;
  /** The value found, or what to do when the check fails. */
  detail: string;
}

/** Header metadata Oracle needs, with the field keys each can come from
 * (contract and invoice profiles name them differently). */
export const ORACLE_REQUIRED_METADATA: { id: string; label: string; keys: string[] }[] = [
  {
    id: "identifier",
    label: "Contract / document number",
    keys: ["contract_number", "piid", "award_number", "order_number", "invoice_number", "document_number"],
  },
  {
    id: "counterparty",
    label: "Counterparty (contractor / vendor)",
    keys: ["counterparty", "contractor_name", "contractor", "vendor", "vendor_name", "supplier", "customer"],
  },
  {
    id: "date",
    label: "Effective / award date",
    keys: ["effective_date", "award_date", "date_signed", "date_issued", "invoice_date", "start_date"],
  },
  {
    id: "amount",
    label: "Contract value / amount",
    keys: ["contract_value", "total_value", "total_amount", "obligated_amount", "amount", "invoice_total"],
  },
];

function headerValue(header: Record<string, string>, keys: string[]): string | null {
  for (const key of keys) {
    const value = header[key] ?? header[`v3_${key}`];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return null;
}

export function buildOracleChecklist(preview: OraclePayloadPreview): OracleChecklistItem[] {
  const role: OracleChecklistItem = {
    id: "role",
    group: "system",
    label: "Your role can send to Oracle",
    passed: preview.actor?.can_send === true,
    detail: preview.actor?.can_send === true ? "oracle.send granted" : "Preview only — ask an administrator for oracle.send.",
  };
  // A document Oracle Procurement has no record for (FAR regulation text, an
  // ID, a bank statement): say that once, not four header checks it can never pass.
  if (preview.oracle_scope && !preview.oracle_scope.applicable) {
    return [
      role,
      {
        id: "scope",
        group: "system",
        label: "Document type can go to Oracle Procurement",
        passed: false,
        detail: preview.oracle_scope.reason ?? "This document type isn't sent to Oracle Procurement.",
      },
    ];
  }
  const system: OracleChecklistItem[] = [
    role,
    {
      id: "clean-review",
      group: "system",
      label: "Review set is clean",
      passed: preview.skipped_count === 0,
      detail:
        preview.skipped_count === 0
          ? "No pending or rejected fields"
          : `${preview.skipped_count} pending or rejected field${preview.skipped_count === 1 ? "" : "s"} — finish review first.`,
    },
    {
      id: "authoritative",
      group: "system",
      label: "Authoritative fields present",
      passed: preview.authoritative_count > 0,
      detail:
        preview.authoritative_count > 0
          ? `${preview.authoritative_count} accepted / edited field${preview.authoritative_count === 1 ? "" : "s"}`
          : "Nothing accepted yet.",
    },
  ];
  const metadata = ORACLE_REQUIRED_METADATA.map<OracleChecklistItem>((requirement) => {
    const value = headerValue(preview.contract_header ?? {}, requirement.keys);
    return {
      id: requirement.id,
      group: "metadata",
      label: requirement.label,
      passed: value != null,
      detail: value ?? "Missing — accept or edit this field in review before sending.",
    };
  });
  return [...system, ...metadata];
}

export function checklistPasses(items: OracleChecklistItem[]): boolean {
  return items.every((item) => item.passed);
}
