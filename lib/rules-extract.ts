// Pulls the numeric rules that decide answers out of the manuals and SOPs, keeping the section
// each one came from so answers can cite it. Every rule has a pattern; a default is used only
// when the pattern does not match, and the ingest log says so.

export type ExtractedRule = {
  rule_key: string;
  scope_type: "global" | "well_type";
  scope_value: string;
  value: number;
  unit: string;
  source_doc: string;
  source_section: string;
  quote: string;
  extracted: boolean;
  /** The document discusses this rule but the number couldn't be read: inherited/default value is suspect. */
  unreadable?: boolean;
};

// `re` (and `alt`) must capture the number; `topic` says the document talks about this rule at all.
type Spec = { key: string; unit: string; re: RegExp; alt?: RegExp[]; topic?: RegExp; fallback: number; map?: (m: RegExpMatchArray) => number };

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
const num = (s: string) => (WORDS[s.toLowerCase()] ?? Number(s));

const MANUAL_SPECS: Spec[] = [
  { key: "producing_delta_c", unit: "°C above ambient", re: /producing[^.]*?at least (\d+(?:\.\d+)?) ?°C above ambient/i,
    alt: [/(?:producing|production|running|active|flowing)[^.]*?(\d+(?:\.\d+)?)\s*(?:°\s*C|degrees(?:\s*C(?:elsius)?)?)[^.]*?(?:above|over|warmer than|higher than|more than)\s+(?:the\s+)?(?:ambient|air|outside)/i,
      /(?:above|over|warmer than)\s+(?:the\s+)?(?:ambient|air)[^.]*?(?:by\s+)?(?:at least\s+)?(\d+(?:\.\d+)?)\s*(?:°\s*C|degrees)/i],
    topic: /production temperature|considered producing|producing \(active\)|counts as (?:producing|running)|above ambient|over ambient/i, fallback: 15 },
  { key: "temp_alarm_c", unit: "°C", re: /at or below (\d+(?:\.\d+)?) ?°C/i, alt: [/(?:alarm|must not exceed|maximum)[^.]*?(\d+(?:\.\d+)?) ?°\s*C/i], topic: /temperature alarm/i, fallback: 85 },
  { key: "pad_shutin_pct", unit: "% of pad", re: /more than (\d+(?:\.\d+)?) ?% of the pad/i, fallback: 5 },
  { key: "rca_count", unit: "corrective repairs", re: /(\w+) or more corrective/i, fallback: 3, map: (m) => num(m[1]) },
  { key: "rca_window_months", unit: "months", re: /corrective[^.]*?(\d+) months/i, fallback: 12 },
  { key: "downtime_report_days", unit: "consecutive days", re: /more than (\d+) consecutive days/i, fallback: 14 },
];

const SOP_SPECS: Record<string, Spec[]> = {
  "spill-response-sop": [
    { key: "minor_below_bbl", unit: "bbl", re: /Minor \| below (\d+(?:\.\d+)?) bbl/i, fallback: 1 },
    { key: "reportable_bbl", unit: "bbl", re: /Reportable \| (\d+(?:\.\d+)?) bbl/i, fallback: 5 },
    { key: "major_bbl", unit: "bbl", re: /Major \| (\d+(?:\.\d+)?) bbl/i, fallback: 25 },
    { key: "sr01_report_hours", unit: "hours", re: /written notice[^|]*?within (\d+) hours/i, fallback: 24 },
    { key: "sr01_major_report_hours", unit: "hours", re: /or within (\d+) hours for a major/i, fallback: 2 },
    { key: "sr02_contain_hours", unit: "hours", re: /contained within (\d+) hours/i, fallback: 4 },
    { key: "sr03_verify_days", unit: "days", re: /verified within (\d+) days/i, fallback: 60 },
    { key: "hse_notice_hours", unit: "hours", re: /notify HSE within (\d+) ?h/i, fallback: 72 },
  ],
  "regulatory-compliance-sop": [
    { key: "rc01_inspection_days", unit: "days", re: /at least once every (\d+) days/i, fallback: 14 },
    { key: "rc03_downtime_days", unit: "days", re: /more than (\d+) consecutive days/i, fallback: 14 },
    { key: "rc04_response_days", unit: "days", re: /answered within (\d+) days/i, fallback: 30 },
  ],
  "field-work-sop": [
    { key: "ws07_report_days", unit: "days", re: /within (\d+) days of finishing/i, fallback: 3 },
  ],
};

export function clean(md: string) {
  return md.replace(/\*\*/g, "").replace(/[ \t]*\r?\n[ \t]*/g, "\n");
}

/** Heading (## / ###) that precedes a character offset. */
export function sectionAt(md: string, offset: number) {
  const before = md.slice(0, offset);
  const heads = [...before.matchAll(/^#{2,3} (.+)$/gm)];
  return heads.length ? heads[heads.length - 1][1].trim() : "";
}

function quoteAround(text: string, idx: number, len: number) {
  const s = Math.max(0, text.lastIndexOf("\n", idx) + 1);
  let e = text.indexOf("\n", idx + len);
  if (e < 0) e = text.length;
  return text.slice(s, e).replace(/\s+/g, " ").trim().slice(0, 300);
}

function run(spec: Spec, text: string, docId: string, scope_type: ExtractedRule["scope_type"], scope_value: string): ExtractedRule | null {
  // Paragraph lines are joined so a rule split across a line break still matches; headings,
  // tables and list items keep their own lines.
  const flat = text.split("\n").reduce((acc, line, i, all) => {
    const prev = all[i - 1] ?? "";
    const joinable = i > 0 && line.trim() && prev.trim() && !/^(#|\||>|-|\d+\.)/.test(line) && !/^(#|\|)/.test(prev);
    return acc + (i === 0 ? "" : joinable ? " " : "\n") + line;
  }, "");
  const m = [spec.re, ...(spec.alt ?? [])].map((re) => flat.match(re)).find(Boolean);
  if (!m) return null;
  return {
    rule_key: spec.key, scope_type, scope_value, unit: spec.unit, source_doc: docId,
    value: spec.map ? spec.map(m) : Number(m[1]),
    source_section: sectionAt(flat, m.index ?? 0),
    quote: quoteAround(flat, m.index ?? 0, m[0].length),
    extracted: true,
  };
}

/** manuals: { T200: md, T350: md }, sops: { 'spill-response-sop': md, ... } */
export function extractRules(manuals: Record<string, string>, sops: Record<string, string>) {
  const out: ExtractedRule[] = [];
  const log: string[] = [];
  const base = "T200" in manuals ? "T200" : Object.keys(manuals)[0];

  for (const [type, raw] of Object.entries(manuals)) {
    const text = clean(raw);
    for (const spec of MANUAL_SPECS) {
      let r = run(spec, text, `well-types/${type}.md`, "well_type", type);
      // The manual talks about this rule but the number couldn't be read: never inherit silently.
      const unreadable = !r && !!spec.topic?.test(text.replace(/\s+/g, " "));
      if (!r && type !== base && /same as T200|follow the T200|refers? to/i.test(text)) {
        const parent = out.find((x) => x.rule_key === spec.key && x.scope_value === base);
        if (parent) {
          r = { ...parent, scope_value: type, quote: `Inherited from ${base} manual: ${parent.quote}`, unreadable };
          log.push(`${unreadable ? "WARN " : ""}${type}.${spec.key} = ${r.value} (inherited from ${base}${unreadable ? `, but the ${type} manual has its own wording that couldn't be read` : ""})`);
        }
      }
      if (!r) {
        r = { rule_key: spec.key, scope_type: "well_type", scope_value: type, value: spec.fallback, unit: spec.unit,
          source_doc: `well-types/${type}.md`, source_section: "", quote: "(default, not found in manual)", extracted: false, unreadable };
        log.push(`WARN ${type}.${spec.key} not found, default ${spec.fallback}`);
      }
      out.push(r);
    }
  }
  for (const [docId, specs] of Object.entries(SOP_SPECS)) {
    const raw = sops[docId];
    for (const spec of specs) {
      const r = raw ? run(spec, clean(raw), `sops/${docId}.md`, "global", "*") : null;
      if (r) out.push(r);
      else {
        out.push({ rule_key: spec.key, scope_type: "global", scope_value: "*", value: spec.fallback, unit: spec.unit,
          source_doc: `sops/${docId}.md`, source_section: "", quote: "(default, not found in SOP)", extracted: false });
        log.push(`WARN ${docId}.${spec.key} not found, default ${spec.fallback}`);
      }
    }
  }
  return { rules: out, log };
}
