import { apiFetch } from "@/lib/api";

/** Mirrors backend app/services/validation_rules.py and app/api/validation_rules.py. */

export type ValidationRuleType = "regex" | "required_field" | "funding_gap" | "max_amount" | "field_match";
export type ValidationSeverity = "high" | "medium" | "low";
export type ValidationRuleSource = "template" | "override" | "custom";
export type ValidationStatus = "pass" | "fail" | "missing" | "not_applicable";

export interface ValidationRule {
  rule_id: string;
  name: string;
  rule_type: ValidationRuleType;
  /** Field label(s) from the extracted data; "|" separates alternatives. */
  field_label: string | null;
  /** regex: the pattern. field_match: the second field label(s). */
  pattern: string | null;
  /** funding_gap / max_amount: dollars. */
  threshold: number | null;
  severity: ValidationSeverity;
  enabled: boolean;
  description: string;
  source: ValidationRuleSource;
}

export type ValidationRuleInput = Partial<Omit<ValidationRule, "rule_id" | "source">>;

export interface ValidationResult {
  rule_id: string;
  name: string;
  rule_type: ValidationRuleType;
  severity: ValidationSeverity;
  status: ValidationStatus;
  detail: string;
  value: string | null;
  page: number | null;
}

export interface ValidationSummary {
  fail: number;
  missing: number;
  pass: number;
  not_applicable: number;
  high: number;
  medium: number;
  low: number;
}

export interface DocumentValidation {
  document_id: string;
  /** False when no rule is enabled: nothing was checked. */
  applicable: boolean;
  results: ValidationResult[];
  summary: ValidationSummary;
}

export interface ValidationPortfolio {
  totals: { documents: number; with_failures: number; fail: number; missing: number; rules_enabled: number };
  documents: {
    document_id: string;
    filename: string | null;
    document_type: string | null;
    summary: ValidationSummary;
    results: ValidationResult[];
  }[];
}

export const RULE_TYPE_LABELS: Record<ValidationRuleType, string> = {
  regex: "Pattern (regex)",
  required_field: "Required field",
  funding_gap: "Funding gap",
  max_amount: "Amount limit",
  field_match: "Fields must match",
};

function json(body: unknown): RequestInit {
  return { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

export function listValidationRules(): Promise<ValidationRule[]> {
  return apiFetch<ValidationRule[]>("/api/validation-rules/rules");
}

export function createValidationRule(rule: ValidationRuleInput): Promise<ValidationRule> {
  return apiFetch<ValidationRule>("/api/validation-rules/rules", { method: "POST", ...json(rule) });
}

export function updateValidationRule(ruleId: string, changes: ValidationRuleInput): Promise<ValidationRule> {
  return apiFetch<ValidationRule>(`/api/validation-rules/rules/${encodeURIComponent(ruleId)}`, {
    method: "PUT",
    ...json(changes),
  });
}

export function deleteValidationRule(ruleId: string): Promise<unknown> {
  return apiFetch(`/api/validation-rules/rules/${encodeURIComponent(ruleId)}`, { method: "DELETE" });
}

export function resetValidationRule(ruleId: string): Promise<ValidationRule> {
  return apiFetch<ValidationRule>(`/api/validation-rules/rules/${encodeURIComponent(ruleId)}/reset`, { method: "POST" });
}

/** Evaluate an unsaved rule against one document (live preview). */
export function testValidationRule(rule: ValidationRuleInput, documentId: string): Promise<ValidationResult> {
  return apiFetch<ValidationResult>("/api/validation-rules/rules/test", {
    method: "POST",
    ...json({ ...rule, document_id: documentId }),
  });
}

export function getValidationPortfolio(): Promise<ValidationPortfolio> {
  return apiFetch<ValidationPortfolio>("/api/validation-rules/portfolio");
}

export function getDocumentValidation(documentId: string): Promise<DocumentValidation> {
  return apiFetch<DocumentValidation>(`/api/documents/${encodeURIComponent(documentId)}/validation`);
}
