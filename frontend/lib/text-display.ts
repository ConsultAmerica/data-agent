/** Normalize extracted text for on-screen tables: fix PDF/Word bullet glyphs. */

const LEADING_BULLET =
  /^[\s\u00A0]*[\uF000-\uF8FF\u25A0\u25A1\u25AA\u25AB\u25CF\u25CB\u2022\u2043\u2219\u00B7\u2023\u25E6\u2610\u2611\u2612\u25A0\u2610\u25AA□■▪▫●○☑☒☐‣∙•]+[\s\u00A0]*/u;

/** Strip private-use / box “bullets” and replace with a real bullet. */
export function normalizeDisplayLine(line: string): string {
  let text = line.replace(/\u00A0/g, " ").trimEnd();
  const hadBullet = LEADING_BULLET.test(text);
  if (hadBullet) text = text.replace(LEADING_BULLET, "");
  // Remaining Private Use Area glyphs (common in Word→PDF extractions).
  text = text.replace(/[\uF000-\uF8FF]/g, "").replace(/[☐☑☒■□▪▫]/g, "").trim();
  if (hadBullet || text.startsWith("•")) {
    return `• ${text.replace(/^•+\s*/, "")}`;
  }
  return text;
}

/** Split a multi-line cell into display lines with bullets normalized. */
export function displayLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => normalizeDisplayLine(line))
    .filter((line) => line.length > 0);
}
