import type { AskResponse } from "@/lib/ask";

/** Where a FAR/DFARS query is cited in one document: the page, a link that
 * opens it highlighted, and the cited text. */
export interface DocumentCitation {
  page: number | null;
  href: string;
  snippet: string;
  clause: string | null;
}

/** The first grounded citation per document: a matched clause reference
 * when the query names a clause, otherwise the best page passage. */
export function citationsByDocument(response: AskResponse): Map<string, DocumentCitation> {
  const byN = new Map(response.citations.map((citation) => [citation.n, citation]));
  const out = new Map<string, DocumentCitation>();
  for (const match of response.clause_matches) {
    const citation = match.citation != null ? byN.get(match.citation) : undefined;
    if (!match.present || !citation || out.has(match.document_id)) continue;
    out.set(match.document_id, {
      page: citation.page,
      href: citation.href,
      snippet: citation.snippet,
      clause: match.clause_number,
    });
  }
  for (const passage of response.passages) {
    const citation = byN.get(passage.citation);
    if (!citation || out.has(passage.document_id)) continue;
    out.set(passage.document_id, { page: citation.page, href: citation.href, snippet: citation.snippet, clause: null });
  }
  return out;
}

/** Preset questions, each concrete enough for the grounded Ask engine to
 * answer from the clauses your documents actually cite. */
export const PRESET_PROMPTS = [
  {
    label: "Commercial item determinations",
    question: "Which contracts include FAR 52.212-4 or FAR 52.212-5 for commercial products and commercial services?",
  },
  {
    label: "Small business subcontracting plans",
    question: "Which contracts include FAR 52.219-9 Small Business Subcontracting Plan?",
  },
  {
    label: "CMMC cybersecurity requirements",
    question: "Which contracts include DFARS 252.204-7012, 252.204-7019, 252.204-7020 or 252.204-7021?",
  },
] as const;

const CLAUSE_NUMBER = /\b2?52\.\d{3}-\d{1,4}\b/g;

/** What to full-text search for: the clause numbers a question names (a
 * whole question rarely matches document text), else the query itself. */
export function searchTerms(query: string): string[] {
  const numbers = [...new Set(query.match(CLAUSE_NUMBER) ?? [])];
  return numbers.length ? numbers.slice(0, 6) : [query];
}
