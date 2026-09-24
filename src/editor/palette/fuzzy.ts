// Fuzzy matching for the command palette: a case-insensitive subsequence
// match, ranked in tiers the way people read a result list, then scored
// within a tier like editor palettes do (contiguous runs and word starts
// high, gaps and long labels low).
//
// Tiers, best first: the whole label · a prefix of the label · every typed
// run starting a word of the label ("sa" → Save & Apply) · a synonym
// (keyword) matching in one of those ways · the label as a scattered
// subsequence · a scattered synonym. A better tier always wins, whatever
// the score inside the tier.

/** How a query matched a text, best first. */
export type MatchKind = 'exact' | 'prefix' | 'words' | 'scattered';

export interface FuzzyMatch {
  kind: MatchKind;
  /** Quality within the kind (higher is better); comparable across texts. */
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

/** Every run of consecutive matched characters starts a word. */
function runsStartWords(text: string, indices: readonly number[]): boolean {
  for (let i = 0; i < indices.length; i++) {
    const at = indices[i]!;
    const continues = i > 0 && indices[i - 1] === at - 1;
    if (!continues && !isWordStart(text, at)) return false;
  }
  return true;
}

/**
 * Matches `query` against `text`. Returns null when the query's characters
 * (spaces ignored) do not appear in order. Greedy with a look-ahead that
 * prefers word starts, which is what people type ("sa" → "Save & Apply").
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return { kind: 'scattered', score: 0, indices: [] };
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
  // Shorter texts win ties.
  score -= text.length * 0.04;
  const compact = t.replace(/\s+/g, '');
  const kind: MatchKind =
    compact === q ? 'exact' : compact.startsWith(q) ? 'prefix' : runsStartWords(text, indices) ? 'words' : 'scattered';
  return { kind, score, indices };
}

/** Rank of a match: label kinds, with synonyms slotted between (see the file comment). */
const LABEL_TIER: Record<MatchKind, number> = { exact: 6, prefix: 5, words: 4, scattered: 2 };
const KEYWORD_TIER: Record<MatchKind, number> = { exact: 3, prefix: 3, words: 3, scattered: 1 };
/** Larger than any in-tier score, so tiers never mix. */
const TIER_WEIGHT = 10_000;

/** One number ordering matches: tier first, then the in-tier score. */
export function rankOf(match: FuzzyMatch, source: 'label' | 'keyword'): number {
  return (source === 'label' ? LABEL_TIER : KEYWORD_TIER)[match.kind] * TIER_WEIGHT + match.score;
}

export interface Ranked<T> {
  item: T;
  score: number;
  /** Highlight indices into the label (empty when a keyword matched). */
  indices: number[];
}

/**
 * Filters and ranks items. `label` is highlighted; `keywords` (synonyms)
 * match too but rank below a label match of the same quality. An empty
 * query keeps the original order.
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
    let best: Ranked<T> | null = m ? { item, score: rankOf(m, 'label'), indices: m.indices } : null;
    for (const kw of keywords(item)) {
      const k = fuzzyMatch(q, kw);
      if (!k) continue;
      const score = rankOf(k, 'keyword');
      if (!best || score > best.score) best = { item, score, indices: [] };
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
