import { apiFetch } from "@/lib/api";

export type AskAnswerType = "fields" | "clauses" | "obligations" | "passages" | "none";

export interface AskScope {
  document_id: string | null;
  document_name: string | null;
  document_count: number;
}

export interface AskFact {
  document_id: string;
  document_name: string;
  label: string;
  value: string;
  page: number | null;
  citation: number | null;
}

export interface AskClauseMatch {
  document_id: string;
  document_name: string;
  clause_number: string;
  title: string | null;
  present: boolean;
  page: number | null;
  citation: number | null;
}

export interface AskObligation {
  document_id: string;
  document_name: string;
  title: string;
  due_date: string | null;
  status: string;
  page: number | null;
  citation: number | null;
}

export interface AskPassage {
  document_id: string;
  document_name: string;
  page: number;
  text: string;
  score: number;
  citation: number;
}

export interface AskCitation {
  n: number;
  document_id: string;
  document_name: string;
  page: number | null;
  snippet: string;
  href: string;
}

export interface AskDocumentHit {
  document_id: string;
  document_name: string;
  hits: number;
}

export interface AskResponse {
  question: string;
  scope: AskScope;
  /** Plain text with inline citation markers: "[1]", "[2][3]". */
  answer: string;
  answer_type: AskAnswerType;
  facts: AskFact[];
  clause_matches: AskClauseMatch[];
  obligations: AskObligation[];
  passages: AskPassage[];
  citations: AskCitation[];
  documents: AskDocumentHit[];
  suggestions: string[];
  engine: string;
}

/** Answers come only from extracted data and source pages; every claim
 * carries a citation that opens the cited page. */
export async function askQuestion(question: string, documentId?: string | null): Promise<AskResponse> {
  return apiFetch<AskResponse>("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, document_id: documentId || null }),
  });
}

export type AnswerPart = { kind: "text"; text: string } | { kind: "cite"; n: number };

/** Splits "Award date is 29-Sep-2023 [1][2]." into text and citation parts. */
export function splitCitations(answer: string): AnswerPart[] {
  const parts: AnswerPart[] = [];
  const pattern = /\[(\d+)\]/g;
  let last = 0;
  for (let match = pattern.exec(answer); match; match = pattern.exec(answer)) {
    if (match.index > last) parts.push({ kind: "text", text: answer.slice(last, match.index) });
    parts.push({ kind: "cite", n: Number(match[1]) });
    last = match.index + match[0].length;
  }
  if (last < answer.length) parts.push({ kind: "text", text: answer.slice(last) });
  return parts;
}

const STOPWORDS = new Set([
  "a", "an", "and", "are", "about", "does", "for", "from", "how", "in", "include", "is", "it", "list",
  "next", "of", "on", "or", "the", "this", "to", "what", "when", "which", "who", "with", "contract",
  "contracts", "days", "summarize", "extract", "key",
]);

/** Words worth bolding in a passage: the question minus filler words. */
export function queryTerms(question: string): string[] {
  const terms = question.toLowerCase().match(/\d{2,3}\.\d{3}-\d{1,4}|[a-z][a-z0-9-]{2,}/g) ?? [];
  return [...new Set(terms.filter((term) => !STOPWORDS.has(term)))];
}
