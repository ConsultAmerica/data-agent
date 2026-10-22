/** Word-level diff (longest common subsequence) for comparing two
 * regulation texts. No dependencies; large texts are diffed line by line
 * first so the LCS table stays small. */

export type DiffOp = "equal" | "insert" | "delete";

export interface DiffSegment {
  op: DiffOp;
  text: string;
}

// Above this many table cells a word LCS is too slow/large for the browser;
// the texts are aligned by line first and only changed hunks are word-diffed.
const MAX_CELLS = 2_000_000;

/** Words and the whitespace after them, so joining tokens reproduces the
 * text exactly. */
export function tokenize(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

function key(token: string): string {
  return token.trim();
}

/** Plain LCS over token keys; returns segments in order. */
function lcs(a: string[], b: string[]): DiffSegment[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        key(a[i]) === key(b[j])
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const out: DiffSegment[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (key(a[i]) === key(b[j])) {
      push(out, "equal", b[j]);
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      push(out, "delete", a[i]);
      i += 1;
    } else {
      push(out, "insert", b[j]);
      j += 1;
    }
  }
  for (; i < n; i += 1) push(out, "delete", a[i]);
  for (; j < m; j += 1) push(out, "insert", b[j]);
  return out;
}

function push(out: DiffSegment[], op: DiffOp, text: string) {
  const last = out[out.length - 1];
  if (last && last.op === op) last.text += text;
  else out.push({ op, text });
}

function diffTokens(a: string[], b: string[]): DiffSegment[] {
  // Common prefix / suffix never enter the table.
  let start = 0;
  while (start < a.length && start < b.length && key(a[start]) === key(b[start])) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && key(a[endA - 1]) === key(b[endB - 1])) {
    endA -= 1;
    endB -= 1;
  }
  const out: DiffSegment[] = [];
  if (start > 0) push(out, "equal", b.slice(0, start).join(""));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if ((midA.length + 1) * (midB.length + 1) <= MAX_CELLS) {
    for (const segment of lcs(midA, midB)) push(out, segment.op, segment.text);
  } else {
    if (midA.length) push(out, "delete", midA.join(""));
    if (midB.length) push(out, "insert", midB.join(""));
  }
  if (endB < b.length) push(out, "equal", b.slice(endB).join(""));
  return out;
}

function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Word-level diff of `before` → `after`. Joining the equal + insert
 * segments gives `after`; equal + delete gives `before` (whitespace
 * around unchanged words follows `after`). */
export function wordDiff(before: string, after: string): DiffSegment[] {
  const a = tokenize(before);
  const b = tokenize(after);
  if ((a.length + 1) * (b.length + 1) <= MAX_CELLS) return diffTokens(a, b);

  // Long texts: align lines, then word-diff each changed hunk.
  const lineOps = diffTokens(lines(before), lines(after));
  const out: DiffSegment[] = [];
  for (let index = 0; index < lineOps.length; index += 1) {
    const segment = lineOps[index];
    const next = lineOps[index + 1];
    if (segment.op === "delete" && next?.op === "insert") {
      for (const part of diffTokens(tokenize(segment.text), tokenize(next.text))) push(out, part.op, part.text);
      index += 1;
    } else {
      push(out, segment.op, segment.text);
    }
  }
  return out;
}

export function diffStats(segments: DiffSegment[]): { inserted: number; deleted: number; unchanged: number } {
  const count = (text: string) => text.split(/\s+/).filter(Boolean).length;
  return segments.reduce(
    (totals, segment) => {
      if (segment.op === "insert") totals.inserted += count(segment.text);
      else if (segment.op === "delete") totals.deleted += count(segment.text);
      else totals.unchanged += count(segment.text);
      return totals;
    },
    { inserted: 0, deleted: 0, unchanged: 0 },
  );
}
