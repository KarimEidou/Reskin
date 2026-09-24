// Small formatting helpers shared by the views.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", or a date. */
export function timeAgo(ms: number, now = Date.now()): string {
  const d = now - ms;
  if (d < 45_000) return 'just now';
  if (d < HOUR) return `${Math.max(1, Math.round(d / MINUTE))} min ago`;
  if (d < DAY && sameDay(ms, now)) return `${Math.round(d / HOUR)} h ago`;
  if (isYesterday(ms, now)) return 'yesterday';
  if (d < 7 * DAY) return `${Math.max(2, Math.round(d / DAY))} days ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: sameYear(ms, now) ? undefined : 'numeric' });
}

/** Full local date and time, for tooltips. */
export function fullDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Group heading for a timestamp: Today / Yesterday / This week / Month Year. */
export function dayGroup(ms: number, now = Date.now()): string {
  if (sameDay(ms, now)) return 'Today';
  if (isYesterday(ms, now)) return 'Yesterday';
  if (now - ms < 7 * DAY) return 'This week';
  return new Date(ms).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Keeps the end of a long path: "…\Desktop\Steam.lnk". */
export function shortPath(path: string, max = 56): string {
  if (path.length <= max) return path;
  const sep = path.includes('\\') ? '\\' : '/';
  const parts = path.split(sep);
  let out = parts.pop() ?? path;
  while (parts.length > 0 && out.length + parts[parts.length - 1]!.length + 1 <= max - 2) {
    out = `${parts.pop()}${sep}${out}`;
  }
  return `…${sep}${out}`;
}

/** A base64 PNG (no prefix) or a data URL → something an <img> can show. */
export function pngSrc(b64: string | null | undefined): string | null {
  if (!b64) return null;
  return b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`;
}

function sameDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

function sameYear(a: number, b: number): boolean {
  return new Date(a).getFullYear() === new Date(b).getFullYear();
}

function isYesterday(ms: number, now: number): boolean {
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  return sameDay(ms, y.getTime());
}
