// Turns "last 4 months", "2025", "this summer", "June 2026", "last 90 days" into a date window.
// Periods end today and compare by date (YYYY-MM-DD strings).

export type Period = { from: string; to: string; label: string };

export const addDays = (d: string, n: number) => {
  const t = new Date(d + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
export const addMonths = (d: string, n: number) => {
  const t = new Date(d + "T00:00:00Z");
  const day = t.getUTCDate();
  t.setUTCDate(1);
  t.setUTCMonth(t.getUTCMonth() + n);
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, last));
  return t.toISOString().slice(0, 10);
};
export const daysBetween = (a: string, b: string) =>
  Math.round((new Date(b.slice(0, 10) + "T00:00:00Z").getTime() - new Date(a.slice(0, 10) + "T00:00:00Z").getTime()) / 86400000);
export const hoursBetween = (a: string, b: string) => (new Date(b).getTime() - new Date(a).getTime()) / 3600000;

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const monthIdx = (s: string) => MONTHS.findIndex((m) => m.startsWith(s.toLowerCase().slice(0, 3)));
const endOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);
const pad = (n: number) => String(n).padStart(2, "0");
const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmt = (d: string) => `${Number(d.slice(8, 10))} ${SHORT[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;

export function parsePeriod(text: string | undefined | null, today: string): Period | null {
  if (!text) return null;
  const t = text.toLowerCase().trim();
  const year = Number(today.slice(0, 4));
  const mk = (from: string, to: string, label?: string): Period => ({ from, to: to > today ? today : to, label: label ?? `${fmt(from)} – ${fmt(to > today ? today : to)}` });

  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})\s*(?:to|–|-|\.\.)\s*(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return mk(`${m[1]}-${m[2]}-${m[3]}`, `${m[4]}-${m[5]}-${m[6]}`);

  // "since June 2026", "since 3 Mar 2026", "since 2025-04-01", "June 2026 to today"
  m = t.match(/(?:since|from|after)\s+(.+?)(?:\s+(?:to|until|till)\s+(?:today|now))?$/) ?? t.match(/^(.+?)\s+(?:to|until|till)\s+(?:today|now)$/);
  if (m) {
    const s = m[1].trim();
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) return mk(s, today);
    const dmy = s.match(/^(\d{1,2})\s+([a-z]{3,9})(?:\s+(\d{4}))?$/);
    if (dmy && monthIdx(dmy[2]) >= 0) return mk(`${dmy[3] ?? year}-${pad(monthIdx(dmy[2]) + 1)}-${pad(Number(dmy[1]))}`, today);
    const my = s.match(/^([a-z]{3,9})(?:\s+(\d{4}))?$/);
    if (my && monthIdx(my[1]) >= 0) {
      let y = my[2] ? Number(my[2]) : year;
      if (!my[2] && `${y}-${pad(monthIdx(my[1]) + 1)}-01` > today) y -= 1;
      return mk(`${y}-${pad(monthIdx(my[1]) + 1)}-01`, today);
    }
    const yy = s.match(/^(\d{4})$/);
    if (yy) return mk(`${yy[1]}-01-01`, today);
  }

  m = t.match(/(?:last|past|previous)\s+(\d+|a|one|two|three|four|six|twelve)?\s*(day|week|month|year)s?/);
  if (m) {
    const words: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4, six: 6, twelve: 12 };
    const n = m[1] ? (words[m[1]] ?? Number(m[1])) : 1;
    const unit = m[2];
    const from = unit === "day" ? addDays(today, -n) : unit === "week" ? addDays(today, -7 * n) : unit === "month" ? addMonths(today, -n) : addMonths(today, -12 * n);
    return mk(from, today);
  }
  if (/this year|year to date|ytd/.test(t)) return mk(`${year}-01-01`, today, `${year} to date`);
  if (/last year/.test(t)) return mk(`${year - 1}-01-01`, `${year - 1}-12-31`, `${year - 1}`);
  if (/this month/.test(t)) return mk(today.slice(0, 8) + "01", today);

  const season = t.match(/(this |last )?(summer|winter|spring|autumn|fall)(?:\s+(\d{4}))?/);
  if (season) {
    const s = season[2];
    let y = season[3] ? Number(season[3]) : year;
    const ranges: Record<string, [number, number]> = { spring: [2, 4], summer: [5, 7], autumn: [8, 10], fall: [8, 10], winter: [11, 13] };
    const [a, b] = ranges[s];
    if (!season[3] && (season[1]?.trim() === "last" || `${y}-${pad(a + 1)}-01` > today)) y -= 1;
    const from = `${y}-${pad(a + 1)}-01`;
    const to = b >= 12 ? endOfMonth(y + 1, b - 12) : endOfMonth(y, b);
    return mk(from, to, `${s} ${y}`);
  }

  m = t.match(/\b([a-z]{3,9})\s+(\d{4})\b/);
  if (m && monthIdx(m[1]) >= 0) {
    const mi = monthIdx(m[1]);
    return mk(`${m[2]}-${pad(mi + 1)}-01`, endOfMonth(Number(m[2]), mi), `${MONTHS[mi][0].toUpperCase()}${MONTHS[mi].slice(1)} ${m[2]}`);
  }
  m = t.match(/^(?:in\s+)?(\d{4})$/) ?? t.match(/\b(?:in|during|for)\s+(\d{4})\b/);
  if (m) return mk(`${m[1]}-01-01`, `${m[1]}-12-31`, m[1]);
  m = t.match(/\b(20\d{2})\b/);
  if (m) return mk(`${m[1]}-01-01`, `${m[1]}-12-31`, m[1]);
  if (/all time|ever|history|4 years|four years/.test(t)) return mk("1900-01-01", today, "all records");
  return null;
}

export function resolvePeriod(args: { period?: string; from?: string; to?: string }, today: string, fallback?: string): Period {
  if (args.from || args.to) {
    const from = args.from ?? "1900-01-01";
    const to = args.to ?? today;
    return { from, to, label: `${args.from ? fmt(from) : "start"} – ${fmt(to)}` };
  }
  return parsePeriod(args.period, today) ?? parsePeriod(fallback, today) ?? { from: "1900-01-01", to: today, label: "all records" };
}

export { fmt as fmtDate };
