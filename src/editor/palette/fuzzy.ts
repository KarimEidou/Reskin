// Fuzzy matching for the command palette: a case-insensitive subsequence
// match scored like editor palettes do — contiguous runs, word starts and
// prefixes score high, gaps and long labels score low.

export interface FuzzyMatch {
  score: number;
  /** Indices of the matched characters in the text (for highlighting). */
  indices: number[];
}

const SEPARATOR = /[\s\-_/.,:()&]/;

function isWordStart(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1]!;
  const cur = text[i]!;
  if (SEPARATOR.test(prev)) return true;
  // camelCase / digit boundaries: "zoomIn", "ico256".
  return (prev === prev.toLowerCase() && cur !== cur.toLowerCase()) || (/\d/.test(cur) && !/\d/.test(prev));
}

/**
 * Scores `query` against `text`. Returns null when the query's characters
 * (spaces ignored) do not appear in order. Greedy with a look-ahead that
 * prefers word starts, which is what people type ("sa" → "Save & Apply").
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return { score: 0, indices: [] };
  const t = text.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let ti = 0;
  let prevMatch = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]!;
    // Prefer the next occurrence at a word start, unless we are mid-run.
    let found = -1;
    if (prevMatch + 1 === ti && t[ti] === ch) {
      found = ti;
    } else {
      let first = -1;
      for (let i = ti; i < t.length; i++) {
        if (t[i] !== ch) continue;
        if (first < 0) first = i;
        if (isWordStart(text, i)) {
          found = i;
          break;
        }
      }
      if (found < 0) found = first;
    }
    if (found < 0) return null;
    const gap = found - ti;
    if (found === prevMatch + 1) score += 6;
    else if (qi > 0) score -= Math.min(gap, 8) * 0.5;
    if (isWordStart(text, found)) score += found === 0 ? 10 : 7;
    score += 1;
    indices.push(found);
    prevMatch = found;
    ti = found + 1;
  }
  // Whole-label prefix and exact matches beat everything else.
  if (t.startsWith(q)) score += 8;
  if (t === q) score += 10;
  // Shorter labels win ties.
  score -= text.length * 0.04;
  return { score, indices };
}

export interface Ranked<T> {
  item: T;
  score: number;
  /** Highlight indices into the label (empty when a keyword matched). */
  indices: number[];
}

/**
 * Filters and ranks items. `label` is highlighted; `keywords` (synonyms)
 * match too but score lower. An empty query keeps the original order.
 */
export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  label: (item: T) => string,
  keywords: (item: T) => readonly string[] = () => [],
): Ranked<T>[] {
  const q = query.trim();
  if (!q) return items.map((item) => ({ item, score: 0, indices: [] }));
  const out: Ranked<T>[] = [];
  items.forEach((item) => {
    const m = fuzzyMatch(q, label(item));
    let best: Ranked<T> | null = m ? { item, score: m.score, indices: m.indices } : null;
    for (const kw of keywords(item)) {
      // Synonyms count, but a visible label hit reads better: halve them.
      const k = fuzzyMatch(q, kw);
      const score = k ? k.score * 0.5 - 2 : -Infinity;
      if (k && (!best || score > best.score)) best = { item, score, indices: [] };
    }
    if (best) out.push(best);
  });
  // Stable: equal scores keep registry order.
  return out
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.score - a.r.score || a.i - b.i)
    .map(({ r }) => r);
}

/** Splits a label into highlighted / plain runs for rendering. */
export function highlightRuns(text: string, indices: readonly number[]): Array<{ text: string; hit: boolean }> {
  const hits = new Set(indices);
  const runs: Array<{ text: string; hit: boolean }> = [];
  for (let i = 0; i < text.length; i++) {
    const hit = hits.has(i);
    const last = runs[runs.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else runs.push({ text: text[i]!, hit });
  }
  return runs;
}
