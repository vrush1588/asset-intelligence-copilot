// Shared domain helpers. Every tool reads data through these so that corrections, rule
// overrides and shared facts apply everywhere the same way.
import { db, dbGeneration } from "./db";
import { addDays, addMonths } from "./period";

export type Citation = { type: string; id: string; label?: string; asset_id?: string };

/** "Today": COPILOT_TODAY if set (the date the question document states), else the day after the
 *  latest inspection (stored at ingest). */
export const today = (): string =>
  (/^\d{4}-\d{2}-\d{2}$/.test(process.env.COPILOT_TODAY ?? "") ? process.env.COPILOT_TODAY! : null)
  ?? (db().prepare(`SELECT value FROM meta WHERE key='today'`).get() as any)?.value
  ?? new Date().toISOString().slice(0, 10);

const userCache = new Map<string, string>();
let userCacheGen = -1;
export function userName(id: string | null | undefined) {
  if (!id) return "unknown";
  const d = db();
  if (userCacheGen !== dbGeneration()) { userCache.clear(); userCacheGen = dbGeneration(); }
  if (!userCache.size) for (const u of d.prepare(`SELECT user_id, name FROM users`).all() as any[]) userCache.set(u.user_id, u.name);
  return userCache.get(id) ?? id;
}
export const users = () => db().prepare(`SELECT * FROM users ORDER BY user_id`).all() as any[];
export const areas = () => db().prepare(`SELECT * FROM areas ORDER BY area_id`).all() as any[];

export function resolveUser(s: string | undefined | null) {
  if (!s) return null;
  const all = users();
  const t = s.toLowerCase().trim();
  return all.find((u) => u.user_id.toLowerCase() === t || u.name.toLowerCase() === t)
    ?? all.find((u) => u.name.toLowerCase().includes(t) || t.includes(u.name.toLowerCase())) ?? null;
}

/** "Northeast Block 8", "NE-08", "ne 8", "SW23" → area row */
export function resolveArea(s: string | undefined | null): any | null {
  if (!s) return null;
  const all = areas();
  const t = s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const exact = all.find((a) => a.area_id.toLowerCase() === s.toLowerCase().trim() || a.name.toLowerCase() === t);
  if (exact) return exact;
  const m = t.match(/\b(north ?east|north ?west|south ?east|south ?west|north|south|east|west|ne|nw|se|sw|n|s|e|w)\b\D*(\d+)/);
  if (m) {
    const dirMap: Record<string, string> = { northeast: "NE", "north east": "NE", northwest: "NW", "north west": "NW", southeast: "SE", "south east": "SE", southwest: "SW", "south west": "SW", north: "N", south: "S", east: "E", west: "W" };
    const code = (dirMap[m[1]] ?? m[1]).toUpperCase();
    const n = Number(m[2]);
    const hit = all.find((a) => { const am = a.area_id.match(/^([A-Z]+)-?0*(\d+)$/); return am && am[1] === code && Number(am[2]) === n; });
    if (hit) return hit;
  }
  return all.find((a) => t.includes(a.name.toLowerCase())) ?? null;
}

export function normWell(s: string | number | undefined | null): string | null {
  if (s === undefined || s === null) return null;
  const m = String(s).match(/(\d+)/);
  if (!m) return null;
  const id = `WELL-${m[1].padStart(4, "0")}`;
  return db().prepare(`SELECT 1 FROM wells WHERE asset_id=?`).get(id) ? id : null;
}

export const well = (id: string) => db().prepare(`SELECT w.*, a.name AS area_name FROM wells w LEFT JOIN areas a USING(area_id) WHERE asset_id=?`).get(id) as any;

/** Wells selected by any combination of ids / area / well type. */
export function selectWells(f: { asset_ids?: string[]; asset_id?: string; area?: string; well_type?: string; team_id?: string }) {
  const where: string[] = [];
  const params: any[] = [];
  if (f.team_id) { where.push(`w.team_id=?`); params.push(f.team_id); }
  const ids = [...(f.asset_ids ?? []), ...(f.asset_id ? [f.asset_id] : [])].map(normWell).filter(Boolean) as string[];
  if (ids.length) { where.push(`asset_id IN (${ids.map(() => "?").join(",")})`); params.push(...ids); }
  let area: any = null;
  if (f.area) {
    area = resolveArea(f.area);
    if (!area) throw new Error(`Unknown area "${f.area}". Known areas: ${areas().map((a) => a.name).join(", ")}`);
    where.push(`w.area_id=?`); params.push(area.area_id);
  }
  if (f.well_type) { where.push(`well_type=?`); params.push(f.well_type.toUpperCase()); }
  const rows = db().prepare(`SELECT w.*, a.name AS area_name FROM wells w LEFT JOIN areas a USING(area_id)
    ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY asset_id`).all(...params) as any[];
  return { wells: rows, area };
}

// ---------- rules ----------
export type RuleValue = { value: number; source: string; citation: Citation; override?: any };

/** Resolution order: override for this well → override for its type → manual/SOP.
 *  `qualifier` (e.g. an equipment kind) matches overrides made for that qualifier or for none. */
export function rule(key: string, wellType?: string, assetId?: string, qualifier?: string): RuleValue {
  const d = db();
  const q = `SELECT * FROM rule_overrides WHERE rule_key=? AND scope_type=? AND scope_value=? AND (qualifier IS NULL OR qualifier=?) ORDER BY (qualifier IS NULL), id DESC`;
  if (assetId) {
    const o = d.prepare(q).get(key, "well", assetId, qualifier ?? "") as any;
    if (o) return overrideValue(o);
  }
  if (wellType) {
    const o = d.prepare(q).get(key, "well_type", wellType, qualifier ?? "") as any;
    if (o) return overrideValue(o);
  }
  const r = (wellType && d.prepare(`SELECT * FROM rules WHERE rule_key=? AND scope_type='well_type' AND scope_value=?`).get(key, wellType))
    || d.prepare(`SELECT * FROM rules WHERE rule_key=? AND scope_type='global'`).get(key) as any;
  if (!r) throw new Error(`No rule ${key}`);
  const label = `${r.source_doc}${r.source_section ? " § " + r.source_section : ""}`;
  return { value: r.value, source: label, citation: { type: "doc", id: r.source_doc, label } };
}

function overrideValue(o: any): RuleValue {
  const scope = (o.scope_type === "well" ? o.scope_value : `all ${o.scope_value} wells`) + (o.qualifier ? `, ${o.qualifier.replace("_", " ")} only` : "");
  return {
    value: o.value,
    source: `team rule from ${userName(o.author_user_id)} (${scope}, ${o.created_at.slice(0, 10)}), overriding the manual`,
    citation: { type: "rule_override", id: `OVR-${o.id}`, label: `${userName(o.author_user_id)}: ${o.reason ?? ""}` },
    override: o,
  };
}

export function spillClass(bbl: number) {
  const minor = rule("minor_below_bbl").value, rep = rule("reportable_bbl").value, major = rule("major_bbl").value;
  return bbl >= major ? "major" : bbl >= rep ? "reportable" : bbl >= minor ? "moderate" : "minor";
}

// ---------- corrections overlay ----------
export function corrections(inspectionIds?: string[]) {
  const d = db();
  const rows = (inspectionIds?.length && inspectionIds.length < 500
    ? d.prepare(`SELECT * FROM corrections WHERE inspection_id IN (${inspectionIds.map(() => "?").join(",")}) ORDER BY id`).all(...inspectionIds)
    : d.prepare(`SELECT * FROM corrections ORDER BY id`).all()) as any[];
  const map = new Map<string, any[]>();
  for (const r of rows) {
    if (!map.has(r.inspection_id)) map.set(r.inspection_id, []);
    map.get(r.inspection_id)!.push(r);
  }
  return map;
}

export type EffInspection = {
  inspection_id: string; asset_id: string; inspected_at: string; date: string; inspector_user_id: string;
  inspector: string; method: string; ambient_temp_c: number; wellhead_temp_c: number;
  delta: number; threshold: number; producing: boolean; spill_detected: boolean; spill_area_pct: number | null;
  spill_volume_bbl: number | null; notes: string; well_type: string;
  raw: { wellhead_temp_c: number; ambient_temp_c: number; spill_detected: boolean; spill_est_volume_bbl: number | null };
  corrections: any[];  // applied (accepted) corrections
  pending: any[];      // unconfirmed corrections, not applied
};

/** Inspections with accepted corrections applied and the producing rule evaluated per reading. */
export function effInspections(f: { asset_ids?: string[]; from?: string; to?: string; latestOnly?: boolean }): EffInspection[] {
  const d = db();
  const where: string[] = [];
  const params: any[] = [];
  if (f.asset_ids) { where.push(`i.asset_id IN (${f.asset_ids.map(() => "?").join(",") || "''"})`); params.push(...f.asset_ids); }
  if (f.from) { where.push(`substr(i.inspected_at,1,10) >= ?`); params.push(f.from); }
  if (f.to) { where.push(`substr(i.inspected_at,1,10) <= ?`); params.push(f.to); }
  if (f.latestOnly) where.push(`i.inspected_at = (SELECT MAX(inspected_at) FROM inspections x WHERE x.asset_id = i.asset_id)`);
  const rows = d.prepare(`SELECT i.*, w.well_type FROM inspections i JOIN wells w USING(asset_id)
    ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY i.asset_id, i.inspected_at`).all(...params) as any[];
  const corr = corrections(rows.length < 500 ? rows.map((r) => r.inspection_id) : undefined);
  const thr = new Map<string, number>();
  const threshold = (wt: string, aid: string) => {
    const k = wt + "|" + aid;
    if (!thr.has(k)) thr.set(k, rule("producing_delta_c", wt, aid).value);
    return thr.get(k)!;
  };
  return rows.map((r) => {
    const cs = corr.get(r.inspection_id) ?? [];
    const accepted = cs.filter((c) => c.status === "accepted");
    const latest = (field: string) => [...accepted].reverse().find((c) => c.field === field);
    const wh = latest("wellhead_temp_c")?.new_value ?? r.wellhead_temp_c;
    const amb = latest("ambient_temp_c")?.new_value ?? r.ambient_temp_c;
    const sdC = latest("spill_detected");
    const volC = latest("spill_est_volume_bbl");
    const spill = sdC ? !!sdC.new_value : !!r.spill_detected;
    const t = threshold(r.well_type, r.asset_id);
    const delta = Math.round((wh - amb) * 10) / 10;
    return {
      inspection_id: r.inspection_id, asset_id: r.asset_id, inspected_at: r.inspected_at, date: r.inspected_at.slice(0, 10),
      inspector_user_id: r.inspector_user_id, inspector: userName(r.inspector_user_id), method: r.method,
      ambient_temp_c: amb, wellhead_temp_c: wh, delta, threshold: t, producing: wh - amb >= t,
      spill_detected: spill, spill_area_pct: r.spill_area_pct,
      spill_volume_bbl: spill ? (volC?.new_value ?? r.spill_est_volume_bbl) : null,
      notes: r.notes, well_type: r.well_type,
      raw: { wellhead_temp_c: r.wellhead_temp_c, ambient_temp_c: r.ambient_temp_c, spill_detected: !!r.spill_detected, spill_est_volume_bbl: r.spill_est_volume_bbl },
      corrections: accepted, pending: cs.filter((c) => c.status !== "accepted"),
    };
  });
}

export function describeCorrection(c: any) {
  const who = userName(c.author_user_id);
  const src = c.source.startsWith("note:") ? c.source.slice(5) : `chat correction #${c.id}`;
  if (c.field === "spill_detected") return `${src} by ${who}: not a real spill ("${(c.reason ?? "").slice(0, 120)}")`;
  return `${src} by ${who}: ${c.field} corrected from ${c.original_value} to ${c.new_value}${c.reason ? ` (${c.reason.slice(0, 120)})` : ""}`;
}

/** Real spills: detections that survive corrections, with corrected volumes and their class. */
export function realSpills(f: { asset_ids?: string[]; from?: string; to?: string }) {
  const d = db();
  const where = [`spill_detected=1`];
  const params: any[] = [];
  if (f.asset_ids) { where.push(`asset_id IN (${f.asset_ids.map(() => "?").join(",") || "''"})`); params.push(...f.asset_ids); }
  if (f.from) { where.push(`substr(inspected_at,1,10) >= ?`); params.push(f.from); }
  if (f.to) { where.push(`substr(inspected_at,1,10) <= ?`); params.push(f.to); }
  const ids = (d.prepare(`SELECT DISTINCT asset_id FROM inspections WHERE ${where.join(" AND ")}`).all(...params) as any[]).map((r) => r.asset_id);
  if (!ids.length) return { spills: [], excluded: [] };
  const all = effInspections({ asset_ids: ids, from: f.from, to: f.to });
  const detected = all.filter((i) => i.raw.spill_detected);
  const spills = detected.filter((i) => i.spill_detected).map((i) => {
    const w = well(i.asset_id);
    return { ...i, area_id: w.area_id, area_name: w.area_name, lat: w.lat, lon: w.lon, spill_class: spillClass(i.spill_volume_bbl ?? 0) };
  });
  const excluded = detected.filter((i) => !i.spill_detected);
  return { spills, excluded };
}

// ---------- context: notes, shared facts, repairs around a date ----------
export function notesFor(assetId: string, onDate?: string) {
  const d = db();
  const rows = d.prepare(`SELECT * FROM notes WHERE asset_id=? AND note_type != 'correction' ORDER BY created_at`).all(assetId) as any[];
  // An open-ended note (no valid_to) is background context, not a reason for a stop months later.
  return onDate ? rows.filter((n) => (!n.valid_from || n.valid_from <= onDate) && (n.valid_to ? n.valid_to >= onDate : !n.valid_from || n.valid_from >= addDays(onDate, -30))) : rows;
}

export function factsFor(assetId: string, onDate?: string) {
  const rows = db().prepare(`SELECT * FROM shared_facts WHERE asset_id=? ORDER BY id`).all(assetId) as any[];
  return onDate ? rows.filter((n) => (!n.valid_from || n.valid_from <= onDate) && (!n.valid_to || n.valid_to >= onDate)) : rows;
}

export function upcomingFacts(assetId: string, from: string) {
  return (db().prepare(`SELECT * FROM shared_facts WHERE asset_id=? ORDER BY id`).all(assetId) as any[])
    .filter((f) => !f.valid_to || f.valid_to >= from);
}

/** Repairs that explain a stop on a given date: covering it, or corrective and starting within a week of it. */
export function repairsAround(assetId: string, date: string) {
  const rows = db().prepare(`SELECT * FROM maintenance WHERE asset_id=? AND substr(started_at,1,10) <= ? AND substr(completed_at,1,10) >= ?`)
    .all(assetId, addDays(date, 7), addDays(date, -7)) as any[];
  return rows.filter((m) => {
    const s = m.started_at.slice(0, 10), e = m.completed_at.slice(0, 10);
    const covers = s <= date && e >= date;
    return covers || m.maintenance_type === "corrective";
  });
}

export const openRepairs = (assetId: string, t = today()) =>
  db().prepare(`SELECT * FROM maintenance WHERE asset_id=? AND substr(started_at,1,10) <= ? AND substr(completed_at,1,10) > ? ORDER BY started_at`).all(assetId, t, t) as any[];

export function rcaWindowStart(wellType: string, assetId?: string) {
  return addMonths(today(), -rule("rca_window_months", wellType, assetId).value);
}

export const fmtUsd = (n: number) => `USD ${Math.round(n).toLocaleString("en-US")}`;
