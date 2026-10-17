// Usage: npm run ingest -- <dataset-root> [<dataset-root> ...] [--today YYYY-MM-DD] [--fresh-memory]
// Each root has fleet/ and assets/. Several roots load together (sample + test dataset).
// Builds a new database file, carries over what users taught the copilot (unless --fresh-memory),
// then points data/active.json at it. A running server switches over within a second.
import "../lib/env";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { openDb, activeDbPath, DATA_DIR, ACTIVE_FILE, DATA_SCHEMA, DATA_TABLES } from "../lib/db";
import { extractRules } from "../lib/rules-extract";
import { parseCorrectionNote } from "../lib/note-parse";

const argv = process.argv.slice(2);
const flag = (k: string) => argv.includes(`--${k}`);
const todayArg = flag("today") ? argv[argv.indexOf("--today") + 1] : undefined;
const roots = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--today");
if (!roots.length) {
  console.error("usage: npm run ingest -- <dataset-root> [...] [--today YYYY-MM-DD] [--fresh-memory]");
  process.exit(1);
}
for (const r of roots) if (!fs.existsSync(path.join(r, "fleet")) || !fs.existsSync(path.join(r, "assets"))) {
  console.error(`${r} must contain fleet/ and assets/`);
  process.exit(1);
}

// COPILOT_DB pins one file (eval/probe): rebuild it in place. Otherwise build a new file.
const pinned = !!process.env.COPILOT_DB;
const previous = activeDbPath();
const target = pinned ? previous : path.join(DATA_DIR, `copilot-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}.db`);

const readJsonl = (p: string): any[] =>
  fs.existsSync(p)
    ? fs.readFileSync(p, "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l, i) => {
        try { return JSON.parse(l); } catch { console.warn(`bad json ${p}:${i + 1}`); return null; }
      }).filter(Boolean)
    : [];

const d = openDb(target);
d.pragma("foreign_keys = OFF");
for (const t of DATA_TABLES) d.exec(`DROP TABLE IF EXISTS ${t}`);
d.exec(DATA_SCHEMA);

// Memory: dataset corrections are rebuilt from notes; what users taught the copilot is carried over.
const MEMORY_TABLES = ["corrections", "shared_facts", "rule_overrides", "conversations", "messages", "conversation_entities", "answer_ratings"];
if (pinned) {
  d.exec(`DELETE FROM corrections WHERE source LIKE 'note:%'`);
  if (flag("fresh-memory")) for (const t of MEMORY_TABLES) d.exec(`DELETE FROM ${t}`);
} else if (!flag("fresh-memory") && fs.existsSync(previous)) {
  const old = new Database(previous, { readonly: true, fileMustExist: true });
  for (const t of MEMORY_TABLES) {
    const newCols = (d.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((c) => c.name);
    const oldCols = new Set((old.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((c) => c.name));
    const cols = newCols.filter((c) => oldCols.has(c));
    if (!cols.length) continue;
    const rows = old.prepare(`SELECT ${cols.join(",")} FROM ${t}${t === "corrections" ? " WHERE source NOT LIKE 'note:%'" : ""}`).all() as any[];
    const put = d.prepare(`INSERT INTO ${t} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
    d.transaction(() => rows.forEach((r) => put.run(...cols.map((c) => r[c]))))();
    if (rows.length) console.log(`carried over ${rows.length} ${t}`);
  }
  old.close();
}

const ins = {
  area: d.prepare(`INSERT OR REPLACE INTO areas VALUES (?,?,?,?,?)`),
  team: d.prepare(`INSERT OR REPLACE INTO teams VALUES (?,?,?)`),
  user: d.prepare(`INSERT OR REPLACE INTO users VALUES (?,?,?,?)`),
  well: d.prepare(`INSERT OR REPLACE INTO wells VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
  equip: d.prepare(`INSERT OR REPLACE INTO equipment VALUES (?,?,?,?)`),
  insp: d.prepare(`INSERT OR REPLACE INTO inspections VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
  mnt: d.prepare(`INSERT OR REPLACE INTO maintenance VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  report: d.prepare(`INSERT OR REPLACE INTO reports VALUES (?,?,?,?,?,?,?)`),
  check: d.prepare(`INSERT INTO report_checks VALUES (?,?,?,?)`),
  reg: d.prepare(`INSERT OR REPLACE INTO reg_events VALUES (?,?,?,?,?,?,?,?,?,?,?)`),
  note: d.prepare(`INSERT OR REPLACE INTO notes VALUES (?,?,?,?,?,?,?,?,?)`),
  doc: d.prepare(`INSERT OR REPLACE INTO docs VALUES (?,?,?,?,?)`),
  chunk: d.prepare(`INSERT INTO doc_chunks (doc_id, section, text) VALUES (?,?,?)`),
  fts: d.prepare(`INSERT INTO search_fts VALUES (?,?,?,?,?)`),
  rule: d.prepare(`INSERT OR REPLACE INTO rules VALUES (?,?,?,?,?,?,?,?)`),
  corr: d.prepare(`INSERT INTO corrections (inspection_id, asset_id, field, original_value, new_value,
    author_user_id, reason, source, status, created_at) VALUES (?,?,?,?,?,?,?,?,'accepted',?)`),
  meta: d.prepare(`INSERT OR REPLACE INTO meta VALUES (?,?)`),
};

function parseReport(text: string) {
  const flat = text.replace(/\*\*/g, "");
  const cont = flat.match(/contained\s+(?:about|after|within|in)?\s*~?(\d+(?:\.\d+)?)\s*(?:h\b|hours?)/i);
  const cls = flat.match(/\((minor|moderate|reportable|major) class\)/i) ?? flat.match(/\b(minor|moderate|reportable|major) spill\b/i);
  const written = flat.match(/Report written:\s*([^\n]+)/i);
  const checks: { protocol: string; result: string; detail: string }[] = [];
  const sec = flat.split(/^## Compliance check\s*$/m)[1];
  if (sec) {
    for (const line of sec.split("\n")) {
      const cells = line.split("|").map((c) => c.trim());
      if (cells.length >= 4 && cells[1] && !/^-+$/.test(cells[1]) && cells[1] !== "Protocol")
        checks.push({ protocol: cells[1], result: cells[2], detail: cells[3] });
      if (line.startsWith("## ")) break;
    }
  }
  return {
    containment_hours: cont ? Number(cont[1]) : null,
    spill_class: cls ? cls[1].toLowerCase() : null,
    report_written: written ? written[1].trim() : null,
    checks,
  };
}

function chunkDoc(docId: string, md: string) {
  const parts = md.split(/^(?=#{2,3} )/m);
  return parts.map((p) => {
    const h = p.match(/^#{2,3} (.+)$/m);
    return { section: h ? h[1].trim() : "Header", text: p.trim() };
  }).filter((c) => c.text.length > 0);
}

const counts: Record<string, number> = {};
const unparsedCorrections: string[] = [];
const bump = (k: string, n = 1) => (counts[k] = (counts[k] ?? 0) + n);
const manuals: Record<string, string> = {};
const sops: Record<string, string> = {};
let maxInspection = "";

const load = d.transaction((root: string) => {
  const fleet = path.join(root, "fleet");
  const areas = JSON.parse(fs.readFileSync(path.join(fleet, "areas.json"), "utf8"));
  for (const a of areas.areas) ins.area.run(a.area_id, a.name, a.team_id, a.center?.lat ?? null, a.center?.lon ?? null);
  for (const t of areas.teams ?? []) ins.team.run(t.team_id, t.name, t.lead_user_id);
  const users = JSON.parse(fs.readFileSync(path.join(fleet, "users.json"), "utf8"));
  for (const u of users.users) ins.user.run(u.user_id, u.name, u.role, u.team_id);

  for (const sub of ["well-types", "sops"]) {
    const dir = path.join(fleet, sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      const md = fs.readFileSync(path.join(dir, f), "utf8");
      const docId = `${sub}/${f}`;
      const title = md.match(/^# (.+)$/m)?.[1] ?? f;
      ins.doc.run(docId, title, docId, sub === "sops" ? "sop" : "manual", md);
      for (const c of chunkDoc(docId, md)) {
        ins.chunk.run(docId, c.section, c.text);
        ins.fts.run(sub === "sops" ? "sop" : "manual", docId, null, `${title} — ${c.section}`, c.text);
      }
      if (sub === "well-types") manuals[f.replace(/\.md$/, "")] = md;
      else sops[f.replace(/\.md$/, "")] = md;
    }
  }

  const assetsDir = path.join(root, "assets");
  for (const wid of fs.readdirSync(assetsDir).sort()) {
    const wdir = path.join(assetsDir, wid);
    const metaPath = path.join(wdir, "metadata.json");
    if (!fs.existsSync(metaPath)) continue;
    const m = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    ins.well.run(m.asset_id, m.name, m.well_type, m.area_id, m.team_id, m.in_charge_user_id,
      m.location?.lat ?? null, m.location?.lon ?? null, m.installed_on, m.recorded_status,
      m.last_inspection?.inspection_id ?? null, root);
    bump("wells");
    for (const e of m.equipment ?? []) ins.equip.run(e.equipment_id, m.asset_id, e.kind, e.model);

    const inspections = readJsonl(path.join(wdir, "inspections.jsonl"));
    const byId = new Map<string, any>();
    for (const i of inspections) {
      ins.insp.run(i.inspection_id, i.asset_id ?? m.asset_id, i.inspected_at, i.inspector_user_id, i.method,
        i.ambient_temp_c, i.wellhead_temp_c, i.spill_detected ? 1 : 0, i.spill_area_pct,
        i.spill_est_volume_bbl, JSON.stringify(i.evidence_images ?? []), i.notes ?? "");
      byId.set(i.inspection_id, i);
      if (i.inspected_at > maxInspection) maxInspection = i.inspected_at;
      if (i.notes) ins.fts.run("inspection_note", i.inspection_id, m.asset_id, `${i.inspection_id} inspector remark`, i.notes);
    }
    bump("inspections", inspections.length);

    for (const r of readJsonl(path.join(wdir, "maintenance.jsonl"))) {
      ins.mnt.run(r.maintenance_id, r.asset_id ?? m.asset_id, r.started_at, r.completed_at, r.maintenance_type,
        r.equipment_kind, r.issue, r.action_taken, r.technician_user_id, r.contractor, r.downtime_hours,
        r.cost_usd?.labor ?? null, r.cost_usd?.parts ?? null, r.cost_usd?.total ?? null,
        r.triggered_by_inspection_id, r.report_file);
      bump("maintenance");
      if (r.report_file) {
        const p = path.join(wdir, r.report_file);
        if (!fs.existsSync(p)) { bump("missing_report_files"); continue; }
        const text = fs.readFileSync(p, "utf8");
        const pr = parseReport(text);
        ins.report.run(r.maintenance_id, m.asset_id, `${wid}/${r.report_file}`, text, pr.containment_hours, pr.spill_class, pr.report_written);
        for (const c of pr.checks) ins.check.run(r.maintenance_id, c.protocol, c.result, c.detail);
        ins.fts.run("report", r.maintenance_id, m.asset_id, `Repair report ${r.maintenance_id}: ${r.issue}`, text);
        bump("reports");
      }
    }

    for (const e of readJsonl(path.join(wdir, "regulatory-events.jsonl"))) {
      ins.reg.run(e.event_id, e.asset_id ?? m.asset_id, e.date, e.agency, e.event_type, e.protocol_id,
        e.related_inspection_id, e.hours_to_report, e.detail, e.fine_usd, e.status);
      bump("reg_events");
    }

    for (const n of readJsonl(path.join(wdir, "context.jsonl"))) {
      ins.note.run(n.note_id, n.asset_id ?? m.asset_id, n.created_at, n.author_user_id, n.note_type,
        n.inspection_id ?? null, n.text, n.valid_from, n.valid_to);
      ins.fts.run("note", n.note_id, m.asset_id, `Note ${n.note_id} (${n.note_type})`, n.text);
      bump("notes");
      if (n.note_type === "correction" && n.inspection_id) {
        const target = byId.get(n.inspection_id);
        if (!target) { bump("dangling_corrections"); continue; }
        for (const c of parseCorrectionNote(n.text, target)) {
          ins.corr.run(n.inspection_id, m.asset_id, c.field, c.original, c.value, n.author_user_id,
            n.text, `note:${n.note_id}`, n.created_at);
          bump(`corrections.${c.field}`);
          if (c.fallback) unparsedCorrections.push(`${n.note_id}: "${n.text.slice(0, 80)}"`);
        }
      }
    }
  }
});

for (const r of roots) {
  const abs = path.resolve(r);
  console.log(`Loading ${abs}`);
  load(abs);
}

const { rules, log } = extractRules(manuals, sops);
for (const r of rules) ins.rule.run(r.rule_key, r.scope_type, r.scope_value, r.value, r.unit, r.source_doc, r.source_section, r.quote);
for (const r of rules) ins.fts.run("rule", r.rule_key, null, `Rule ${r.rule_key} (${r.scope_value})`, `${r.quote} [${r.source_doc} § ${r.source_section}]`);

// "Today": --today, else the day after the latest inspection. COPILOT_TODAY still wins at runtime.
const inferredToday = new Date(new Date(maxInspection.slice(0, 10)).getTime() + 86400000).toISOString().slice(0, 10);
const today = todayArg ?? inferredToday;
ins.meta.run("today", today);
ins.meta.run("roots", JSON.stringify(roots.map((r) => path.resolve(r))));
ins.meta.run("ingested_at", new Date().toISOString());

// ---------- Health report: errors make answers wrong; warnings need a look ----------
const one = (sql: string) => (d.prepare(sql).get() as any)?.n ?? 0;
const list = (sql: string) => (d.prepare(sql).all() as any[]).map((r) => Object.values(r)[0] as string);
const errors: string[] = [];
const warnings: string[] = [];
const types = list(`SELECT DISTINCT well_type FROM wells ORDER BY 1`);
for (const t of types) {
  const r = rules.find((x) => x.rule_key === "producing_delta_c" && x.scope_value === t);
  if (!r) errors.push(`Well type ${t} has no manual in fleet/well-types/, so the producing rule is unknown.`);
  else if (!r.extracted || r.unreadable) errors.push(`Could not read the producing rule from the ${t} manual; using ${r.extracted ? `the inherited value ${r.value} °C` : `a default of ${r.value} °C`}. Check well-types/${t}.md and fix the rule with a team rule if needed.`);
}
for (const r of rules.filter((x) => (!x.extracted || x.unreadable) && x.rule_key !== "producing_delta_c")) warnings.push(`Rule ${r.scope_value}.${r.rule_key} ${r.unreadable ? "is described but couldn't be read" : "not found"} in ${r.source_doc}; using ${r.value} ${r.unit}.`);
const noIns = list(`SELECT asset_id FROM wells w WHERE NOT EXISTS (SELECT 1 FROM inspections i WHERE i.asset_id=w.asset_id)`);
if (noIns.length) errors.push(`${noIns.length} well(s) have no inspections: ${noIns.slice(0, 5).join(", ")}`);
const noArea = list(`SELECT asset_id FROM wells w WHERE NOT EXISTS (SELECT 1 FROM areas a WHERE a.area_id=w.area_id)`);
if (noArea.length) warnings.push(`${noArea.length} well(s) are not in any area in areas.json: ${noArea.slice(0, 5).join(", ")}`);
const setToday = process.env.COPILOT_TODAY;
if (setToday && setToday !== inferredToday)
  warnings.push(`COPILOT_TODAY is ${setToday}, but the data ends ${maxInspection.slice(0, 10)} (inferred today ${inferredToday}). Make sure it matches the question document.`);
if (setToday && setToday < maxInspection.slice(0, 10)) errors.push(`COPILOT_TODAY (${setToday}) is before the latest inspection (${maxInspection.slice(0, 10)}).`);
if (unparsedCorrections.length) warnings.push(`${unparsedCorrections.length} correction note(s) had unrecognised wording and were treated as "not a spill": ${unparsedCorrections.slice(0, 3).join("; ")}`);
const noCont = one(`SELECT COUNT(*) n FROM reports r JOIN maintenance m USING(maintenance_id) JOIN inspections i ON i.inspection_id=m.triggered_by_inspection_id WHERE i.spill_detected=1 AND r.containment_hours IS NULL`);
if (noCont) warnings.push(`${noCont} spill repair report(s) have no containment time the parser could read (SR-02 checks skip them).`);
const noReport = one(`SELECT COUNT(*) n FROM maintenance m WHERE maintenance_type='corrective' AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.maintenance_id=m.maintenance_id)`);
if (noReport) warnings.push(`${noReport} corrective repair(s) have no report file.`);
if (counts.missing_report_files) warnings.push(`${counts.missing_report_files} report_file path(s) point to missing files.`);
const dangling = one(`SELECT COUNT(*) n FROM maintenance m WHERE triggered_by_inspection_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM inspections i WHERE i.inspection_id=m.triggered_by_inspection_id)`);
if (dangling) warnings.push(`${dangling} repair(s) point to an inspection that doesn't exist.`);
const unknownUsers = list(`SELECT DISTINCT u FROM (SELECT inspector_user_id u FROM inspections UNION SELECT technician_user_id FROM maintenance UNION SELECT author_user_id FROM notes) WHERE u IS NOT NULL AND u NOT IN (SELECT user_id FROM users)`);
if (unknownUsers.length) warnings.push(`Unknown user IDs (not in users.json): ${unknownUsers.slice(0, 8).join(", ")}`);

const summary = {
  roots: roots.map((r) => path.resolve(r)), wells: counts.wells ?? 0, inspections: counts.inspections ?? 0,
  repairs: counts.maintenance ?? 0, reports: counts.reports ?? 0, reg_events: counts.reg_events ?? 0, notes: counts.notes ?? 0,
  well_types: types, areas: list(`SELECT name FROM areas ORDER BY area_id`), latest_inspection: maxInspection.slice(0, 10), today_stored: today,
};
ins.meta.run("health", JSON.stringify({ errors, warnings, summary }));
d.close();

// ---------- Switch the live database ----------
if (!pinned) {
  const tmp = ACTIVE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ db: path.basename(target), roots: summary.roots, at: new Date().toISOString() }, null, 2));
  fs.renameSync(tmp, ACTIVE_FILE);
  // Remove older builds; the one just replaced may still be open in the server, so keep it.
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (!/^copilot-\d{8}T\d{6}\.db(-wal|-shm)?$/.test(f)) continue;
    const base = f.replace(/(-wal|-shm)$/, "");
    if (base === path.basename(target) || path.join(DATA_DIR, base) === previous) continue;
    try { fs.rmSync(path.join(DATA_DIR, f)); } catch { /* in use */ }
  }
}

console.log(`\nLoaded ${summary.wells} wells, ${summary.inspections} inspections, ${summary.repairs} repairs, ${summary.reports} reports, ${summary.reg_events} regulator events, ${summary.notes} notes`);
console.log(`Well types: ${types.join(", ")} · Areas: ${summary.areas.join(", ")}`);
console.log(`Latest inspection ${summary.latest_inspection} · stored today ${today}${setToday ? ` · COPILOT_TODAY=${setToday} (used at runtime)` : ""}`);
console.log(`Rules: ${rules.filter((r) => r.rule_key === "producing_delta_c").map((r) => `${r.scope_value} producing ≥ ${r.value} °C`).join(", ")}${log.length ? `\n  ${log.join("\n  ")}` : ""}`);
console.log(`Database: ${path.relative(process.cwd(), target)}${pinned ? " (COPILOT_DB, rebuilt in place)" : " → now live"}`);
console.log(errors.length ? `\n✖ ${errors.length} ERROR(S) — answers may be wrong:\n  - ${errors.join("\n  - ")}` : "\n✔ No errors");
if (warnings.length) console.log(`⚠ ${warnings.length} warning(s):\n  - ${warnings.join("\n  - ")}`);
process.exitCode = errors.length ? 2 : 0;
