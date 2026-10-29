"use client";

import { ChevronDown, ChevronUp, Link2, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import EvidenceBanner from "@/components/viewers/evidence-banner";
import type { ResolvedLocation, SourceView, WordBlock, WordPart } from "@/lib/source-view";

const blockText = (block: WordBlock) => (block.type === "table" ? block.rows.map((r) => r.join(" ")).join(" ") : block.text);

function Marked({ text, needle }: { text: string; needle: string }) {
  if (!needle) return <>{text}</>;
  const lower = text.toLowerCase();
  const out: React.ReactNode[] = [];
  let at = 0;
  for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, i + needle.length)) {
    out.push(text.slice(at, i), <mark key={i} className="rounded bg-warning/40 text-foreground">{text.slice(i, i + needle.length)}</mark>);
    at = i + needle.length;
  }
  out.push(text.slice(at));
  return <>{out}</>;
}

/** A paragraph's runs; a hyperlink's target is shown, never followed or loaded. */
function Parts({ parts, needle }: { parts: WordPart[]; needle: string }) {
  return (
    <>
      {parts.map((part, i) =>
        part.href || part.anchor ? (
          <span key={i} className="text-primary underline decoration-dotted" title={`Link (not followed): ${part.href ?? `#${part.anchor}`}`}>
            <Marked text={part.text} needle={needle} />
            <span className="ml-0.5 inline-flex items-center gap-0.5 text-[10px] text-text-muted no-underline">
              <Link2 className="h-2.5 w-2.5" aria-hidden="true" />{part.href ?? `#${part.anchor}`}
            </span>
          </span>
        ) : (
          <Marked key={i} text={part.text} needle={needle} />
        ),
      )}
    </>
  );
}

/**
 * A Word document's structure — outline, headings, paragraphs, lists,
 * tables — rendered from typed blocks, never from the document's HTML, so
 * nothing in it can run, inject markup or load a resource. Fonts, images
 * and page layout are not reproduced.
 */
export default function WordViewer({ view, resolved, label }: { view: SourceView; resolved: ResolvedLocation | null; label: string | null }) {
  const blocks = useMemo(() => view.blocks ?? [], [view.blocks]);
  const [query, setQuery] = useState("");
  const [match, setMatch] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  const needle = query.trim().toLowerCase();
  const matches = useMemo(() => (needle ? blocks.filter((b) => blockText(b).toLowerCase().includes(needle)).map((b) => b.index) : []), [blocks, needle]);

  // Evidence: the first block (in the recorded section, when there is one)
  // holding the value.
  const target = resolved?.location.kind === "word_text" ? resolved.location : null;
  const evidenceIndex = useMemo(() => {
    if (!target) return null;
    const text = target.text.trim().toLowerCase();
    const inSection = (b: WordBlock) => target.section.every((s, i) => b.section[i] === s);
    const hit = blocks.find((b) => inSection(b) && blockText(b).toLowerCase().includes(text)) ?? blocks.find((b) => blockText(b).toLowerCase().includes(text));
    return hit?.index ?? null;
  }, [target, blocks]);

  const scrollTo = (index: number) => container.current?.querySelector(`[data-block="${index}"]`)?.scrollIntoView?.({ block: "center" });
  useEffect(() => {
    if (evidenceIndex != null) scrollTo(evidenceIndex);
  }, [evidenceIndex]);

  const outline = blocks.filter((b): b is Extract<WordBlock, { type: "heading" }> => b.type === "heading");
  const evidenceNeedle = target?.text.trim().toLowerCase() ?? "";

  return (
    <div className="flex h-full min-h-0 flex-col text-sm" data-testid="word-viewer">
      <EvidenceBanner resolved={resolved} found={!target || evidenceIndex != null} label={label} />
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-2 py-1.5 text-xs">
        <label className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-text-muted" aria-hidden="true" />
          <input value={query} onChange={(e) => { setQuery(e.target.value); setMatch(0); }} placeholder="Search the document…" aria-label="Search the document" className="h-7 w-52 rounded-md border border-border bg-background pl-6 pr-1.5" />
        </label>
        {needle && (
          <span className="flex items-center gap-1" aria-live="polite">
            <span className="tabular-nums text-text-muted">{matches.length ? `${match + 1}/${matches.length}` : "No matches"}</span>
            <button type="button" aria-label="Previous match" disabled={!matches.length} onClick={() => { const n = (match - 1 + matches.length) % matches.length; setMatch(n); scrollTo(matches[n]); }} className="rounded p-0.5 disabled:opacity-40"><ChevronUp className="h-3.5 w-3.5" /></button>
            <button type="button" aria-label="Next match" disabled={!matches.length} onClick={() => { const n = (match + 1) % matches.length; setMatch(n); scrollTo(matches[n]); }} className="rounded p-0.5 disabled:opacity-40"><ChevronDown className="h-3.5 w-3.5" /></button>
          </span>
        )}
        {view.metadata?.title && <span className="ml-auto truncate text-text-muted">{view.metadata.title}{view.metadata.author ? ` · ${view.metadata.author}` : ""}</span>}
      </div>
      <div className="flex min-h-0 flex-1">
        {outline.length > 0 && (
          <nav className="hidden w-48 shrink-0 overflow-y-auto border-r border-border p-2 text-xs md:block" aria-label="Document outline" data-testid="word-outline">
            {outline.map((h) => (
              <button key={h.index} type="button" onClick={() => scrollTo(h.index)} className="block w-full truncate rounded px-1 py-0.5 text-left text-text-secondary hover:bg-surface-soft hover:text-foreground"
                style={{ paddingLeft: 4 + (h.level - 1) * 10 }}>{h.text}</button>
            ))}
          </nav>
        )}
        <div ref={container} className="min-h-0 flex-1 overflow-y-auto px-4 py-3 leading-relaxed" data-testid="word-blocks">
          {blocks.map((block) => {
            const isEvidence = block.index === evidenceIndex;
            const isMatch = matches[match] === block.index;
            const ring = isEvidence ? "rounded bg-warning/15 ring-2 ring-warning" : isMatch ? "rounded bg-primary-soft/60" : "";
            const mark = isEvidence ? evidenceNeedle : needle;
            if (block.type === "heading") {
              const size = block.level === 1 ? "text-lg" : block.level === 2 ? "text-base" : "text-sm";
              return <p key={block.index} data-block={block.index} role="heading" aria-level={Math.min(block.level, 6)} className={`mt-3 font-semibold text-foreground ${size} ${ring}`}><Marked text={block.text} needle={mark} /></p>;
            }
            if (block.type === "table") {
              return (
                <div key={block.index} data-block={block.index} className={`my-2 overflow-x-auto ${ring}`}>
                  <table className="w-full border-collapse text-xs">
                    <tbody>
                      {block.rows.map((row, r) => (
                        <tr key={r}>{row.map((cell, c) => <td key={c} className="border border-border px-2 py-1 align-top whitespace-pre-wrap"><Marked text={cell} needle={mark} /></td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            }
            if (block.type === "list_item") {
              return <p key={block.index} data-block={block.index} className={`my-0.5 ${ring}`} style={{ paddingLeft: 16 + block.level * 16 }}>• <Parts parts={block.parts} needle={mark} /></p>;
            }
            return <p key={block.index} data-block={block.index} className={`my-1.5 whitespace-pre-wrap ${ring}`}><Parts parts={block.parts} needle={mark} /></p>;
          })}
          {view.truncated && <p className="mt-2 text-xs text-warning">Only the first 20,000 blocks are shown.</p>}
          <p className="mt-4 text-[11px] text-text-muted">Structure and text only: fonts, images and page layout aren&apos;t reproduced, and links are shown, not followed.</p>
        </div>
      </div>
    </div>
  );
}
