// Evidence page numbers start at 1; 0 (or none) means the value has no
// source page — never show it as "Page 0" or link to a page.

export function hasSourcePage(page: number | null | undefined): page is number {
  return typeof page === "number" && page >= 1;
}

export function sourcePageLabel(page: number | null | undefined): string {
  return hasSourcePage(page) ? `Page ${page}` : "No source page";
}
