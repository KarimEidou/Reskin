// Font list filtering for the font picker (unit tested).

/**
 * Families matching `query` (case-insensitive): names starting with it
 * first, then names with a word starting with it, then any other match.
 * An empty query lists everything, with `current` included even when the
 * system list lacks it (e.g. a project made on another PC).
 */
export function filterFonts(fonts: readonly string[], query: string, current = ''): string[] {
  const q = query.trim().toLowerCase();
  const all = current && !fonts.includes(current) ? [current, ...fonts] : [...fonts];
  if (!q) return all;
  const prefix: string[] = [];
  const word: string[] = [];
  const other: string[] = [];
  for (const f of all) {
    const name = f.toLowerCase();
    if (name.startsWith(q)) prefix.push(f);
    else if (name.split(/[\s\-_]+/).some((w) => w.startsWith(q))) word.push(f);
    else if (name.includes(q)) other.push(f);
  }
  return [...prefix, ...word, ...other];
}
