import { apiFetch } from "@/lib/api";

/** Mirrors backend app/services/clause_playbook.py and app/api/playbook.py. */

export type PlaybookExpectation = "required" | "prohibited" | "review";
export type PlaybookSeverity = "high" | "medium" | "low";
export type PlaybookAppliesTo = "all" | "dod";
export type PlaybookRuleSource = "default" | "override" | "custom";
export type PlaybookFindingStatus =
  | "missing"
  | "present_prohibited"
  | "present_review"
  | "present_text_match"
  | "satisfied";
export type PlaybookPatternKind = "regex" | "phrase";

/** A phrase or regex looked for in page text when the clause is not cited. */
export interface PlaybookPattern {
  kind: PlaybookPatternKind;
  pattern: string;
  note: string;
}

export interface PlaybookRule {
  rule_id: string;
  clause_number: string;
  title: string;
  expectation: PlaybookExpectation;
  severity: PlaybookSeverity;
  rationale: string;
  applies_to: PlaybookAppliesTo;
  enabled: boolean;
  source: PlaybookRuleSource;
  /** Clause-library grouping, e.g. "Cybersecurity & supply chain". */
  category: string;
  /** Issuing agency the rule is specific to ("Navy", "DLA"); "" = all. */
  agency: string;
  /** Text the team entered (or copied from an ingested record) — never
   * generated regulation text. */
  standard_text: string;
  /** Corporate fallback / acceptable deviation language. */
  fallback_text: string;
  extraction_patterns: PlaybookPattern[];
}

export type PlaybookRuleInput = Partial<Omit<PlaybookRule, "rule_id" | "source">>;

export interface PlaybookFinding {
  rule_id: string;
  clause_number: string;
  title: string;
  expectation: PlaybookExpectation;
  severity: PlaybookSeverity;
  status: PlaybookFindingStatus;
  rationale: string;
  page: number | null;
  evidence: string | null;
  /** Set when the status is present_text_match: the pattern that matched. */
  pattern_match?: PlaybookPattern | null;
}

export interface PlaybookSummary {
  high: number;
  medium: number;
  low: number;
  satisfied: number;
  deviations: number;
  /** Clauses not cited but whose text matched a rule pattern. */
  text_matches?: number;
}

export interface DocumentPlaybook {
  document_id: string;
  applicable: boolean;
  is_dod: boolean;
  findings: PlaybookFinding[];
  summary: PlaybookSummary;
}

export interface PlaybookPortfolioDocument {
  document_id: string;
  filename: string;
  document_type: string | null;
  is_dod: boolean;
  summary: PlaybookSummary;
  /** Deviations only (satisfied findings are omitted). */
  findings: PlaybookFinding[];
}

export interface PlaybookPortfolio {
  totals: { documents: number; with_deviations: number; high: number; medium: number; low: number };
  documents: PlaybookPortfolioDocument[];
}

export const STATUS_LABELS: Record<PlaybookFindingStatus, string> = {
  missing: "Required clause missing",
  present_prohibited: "Prohibited clause present",
  present_review: "Present — review",
  present_text_match: "Text match — confirm citation",
  satisfied: "Satisfied",
};

function json(body: unknown): RequestInit {
  return { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

export function listPlaybookRules(): Promise<PlaybookRule[]> {
  return apiFetch<PlaybookRule[]>("/api/playbook/rules");
}

export function createPlaybookRule(rule: PlaybookRuleInput): Promise<PlaybookRule> {
  return apiFetch<PlaybookRule>("/api/playbook/rules", { method: "POST", ...json(rule) });
}

export function updatePlaybookRule(ruleId: string, changes: PlaybookRuleInput): Promise<PlaybookRule> {
  return apiFetch<PlaybookRule>(`/api/playbook/rules/${encodeURIComponent(ruleId)}`, { method: "PUT", ...json(changes) });
}

export function deletePlaybookRule(ruleId: string): Promise<{ rule_id: string; restored_default: boolean }> {
  return apiFetch(`/api/playbook/rules/${encodeURIComponent(ruleId)}`, { method: "DELETE" });
}

export function resetPlaybookRule(ruleId: string): Promise<PlaybookRule> {
  return apiFetch<PlaybookRule>(`/api/playbook/rules/${encodeURIComponent(ruleId)}/reset`, { method: "POST" });
}

/** One ingested FAR / DFARS regulation record (text exactly as ingested). */
export interface IngestedClauseRecord {
  clause_number: string;
  clause_key: string;
  title: string;
  clause_type: string | null;
  version_date: string | null;
  prescription: string | null;
  document_id: string;
  filename: string | null;
  source_text?: string | null;
}

export interface RuleStandardText {
  rule_id: string;
  clause_number: string;
  /** Newest ingested version, or null when nothing is ingested. */
  ingested: IngestedClauseRecord | null;
  /** Every ingested version (without text), newest first. */
  versions: IngestedClauseRecord[];
  custom_text: string | null;
}

export interface IngestedClause {
  clause_number: string;
  title: string;
  family: "FAR" | "DFARS";
  versions: string[];
}

export function getRuleStandardText(ruleId: string): Promise<RuleStandardText> {
  return apiFetch<RuleStandardText>(`/api/playbook/rules/${encodeURIComponent(ruleId)}/standard-text`);
}

export function listIngestedClauses(q?: string): Promise<IngestedClause[]> {
  const query = q?.trim() ? `?q=${encodeURIComponent(q.trim())}` : "";
  return apiFetch<IngestedClause[]>(`/api/playbook/far-clauses${query}`);
}

export function getIngestedClauseTexts(clauseNumber: string): Promise<{ clause_number: string; records: IngestedClauseRecord[] }> {
  return apiFetch(`/api/playbook/far-clauses/${encodeURIComponent(clauseNumber)}/texts`);
}

/** "FAR" for 52.*, "DFARS" for 252.*, else "" (agency supplements). */
export function clauseFamily(clauseNumber: string): "FAR" | "DFARS" | "" {
  if (clauseNumber.startsWith("252.")) return "DFARS";
  if (clauseNumber.startsWith("52.")) return "FAR";
  return "";
}

const MAX_PATTERN_LENGTH = 200;
// Mirrors the backend's refusal of a repeated group inside a repeat.
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)[+*{]/;

/** Live feedback for a pattern being typed; the server re-validates (its
 * regex dialect is Python's, so a rare pattern may still be refused). */
export function patternError(pattern: Pick<PlaybookPattern, "kind" | "pattern">): string | null {
  const value = pattern.pattern.trim();
  if (!value) return "Enter a phrase or regular expression.";
  if (value.length > MAX_PATTERN_LENGTH) return `Keep it under ${MAX_PATTERN_LENGTH} characters.`;
  if (pattern.kind === "phrase") return value.length < 4 ? "A phrase needs at least 4 characters." : null;
  try {
    new RegExp(value, "i");
  } catch (error) {
    return `Not a valid regular expression: ${error instanceof Error ? error.message : "syntax error"}`;
  }
  if (NESTED_QUANTIFIER.test(value)) return "Avoid a repeated group inside another repeat, e.g. (a+)+.";
  return null;
}

export function getPlaybookPortfolio(): Promise<PlaybookPortfolio> {
  return apiFetch<PlaybookPortfolio>("/api/playbook/portfolio");
}

export function getDocumentPlaybook(documentId: string): Promise<DocumentPlaybook> {
  return apiFetch<DocumentPlaybook>(`/api/documents/${documentId}/playbook`);
}

/** A prompt or extraction criterion saved to the team's playbook, so every
 * reviewer asks the same question the same way. */
export type SavedQueryKind = "ask" | "clause_search" | "extraction";

export interface SavedQuery {
  id: string;
  name: string;
  kind: SavedQueryKind;
  query: string;
  description: string;
  created_by: string;
  created_at: string | null;
  updated_at: string | null;
}

export type SavedQueryInput = Pick<SavedQuery, "name" | "kind" | "query"> & { description?: string };

export const SAVED_QUERY_KIND_LABELS: Record<SavedQueryKind, string> = {
  ask: "Ask Dataomatix prompt",
  clause_search: "FAR / DFARS search",
  extraction: "Extraction criteria",
};

export function listSavedQueries(kind?: SavedQueryKind): Promise<SavedQuery[]> {
  const query = kind ? `?kind=${encodeURIComponent(kind)}` : "";
  return apiFetch<SavedQuery[]>(`/api/playbook/saved-queries${query}`);
}

export function createSavedQuery(input: SavedQueryInput): Promise<SavedQuery> {
  return apiFetch<SavedQuery>("/api/playbook/saved-queries", { method: "POST", ...json(input) });
}

export function updateSavedQuery(id: string, changes: Partial<SavedQueryInput>): Promise<SavedQuery> {
  return apiFetch<SavedQuery>(`/api/playbook/saved-queries/${encodeURIComponent(id)}`, { method: "PUT", ...json(changes) });
}

export function deleteSavedQuery(id: string): Promise<{ id: string; deleted: boolean }> {
  return apiFetch(`/api/playbook/saved-queries/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Where a saved query runs: Ask and clause searches open prefilled;
 * extraction criteria are picked under "Saved criteria" in an extraction's
 * custom instruction, so they open the extraction screen. */
export function savedQueryHref(saved: Pick<SavedQuery, "kind" | "query">): string {
  const q = encodeURIComponent(saved.query);
  if (saved.kind === "clause_search") return `/clauses?q=${q}`;
  if (saved.kind === "extraction") return "/extraction/new";
  return `/ask?q=${q}`;
}
