import { db } from "./db";
import {
  today, userName, well, selectWells, normWell, rule, effInspections, realSpills, notesFor, factsFor,
  upcomingFacts, repairsAround, openRepairs, describeCorrection, rcaWindowStart, fmtUsd,
  type Citation, type EffInspection,
} from "./domain";
import { addDays, addMonths, resolvePeriod, fmtDate, hoursBetween } from "./period";
import { spillClass } from "./domain";
import type { ToolResult, Visual } from "./visual";

const d = () => db();
const c = (type: string, id: string, label?: string, asset_id?: string): Citation => ({ type, id, label, asset_id });
const uniqCites = (cs: Citation[]) => [...new Map(cs.map((x) => [x.type + x.id, x])).values()];
const f1 = (n: number | null | undefined) => (n === null || n === undefined ? "—" : (Math.round(n * 10) / 10).toFixed(1));
const D = fmtDate;

export type WellSel = { asset_id?: string; asset_ids?: string[]; area?: string; well_type?: string; team_id?: string };
const users_role = (id: string) => ((d().prepare(`SELECT role FROM users WHERE user_id=?`).get(id) as any)?.role ?? "").replace(/_/g, " ");
const teamName = (id?: string) => (id ? (d().prepare(`SELECT name FROM teams WHERE team_id=?`).get(id) as any)?.name ?? id : "");
export type PeriodArgs = { period?: string; from?: string; to?: string };

// ---------------------------------------------------------------------------------------------
// Why a well is not producing on a date: open/nearby repairs, notes and shared facts.
function explainStop(assetId: string, insp: EffInspection) {
  const t = today();
  const reasons: string[] = [];
  const cites: Citation[] = [];
  for (const m of repairsAround(assetId, insp.date)) {
    const open = m.completed_at.slice(0, 10) > t;
    reasons.push(`Repair ${m.maintenance_id}: ${m.equipment_kind.replace("_", " ")} — ${m.issue.toLowerCase()}, started ${D(m.started_at.slice(0, 10))}${open ? ", still open" : `, finished ${D(m.completed_at.slice(0, 10))}`}`);
    cites.push(c("maintenance", m.maintenance_id, m.issue, assetId));
  }
  for (const n of notesFor(assetId, insp.date)) {
    reasons.push(`Note ${n.note_id} by ${userName(n.author_user_id)}: "${n.text}"`);
    cites.push(c("note", n.note_id, n.text, assetId));
  }
  for (const f of factsFor(assetId, insp.date)) {
    reasons.push(`${f.status === "accepted" ? "" : "[UNCONFIRMED] "}Shared note #${f.id} from ${userName(f.author_user_id)}: "${f.text}"`);
    cites.push(c("shared_fact", `FACT-${f.id}`, f.text, assetId));
  }
  return { reasons, cites };
}

function claimsAbout(assetId: string) {
  return (d().prepare(`SELECT * FROM shared_facts WHERE asset_id=? AND kind='status_claim' ORDER BY id`).all(assetId) as any[]);
}

// ---------------------------------------------------------------------------------------------
export function well_status(a: { asset_id: string }): ToolResult {
  const id = normWell(a.asset_id);
  if (!id) throw new Error(`Unknown well "${a.asset_id}"`);
  const w = well(id);
  const t = today();
  const [i] = effInspections({ asset_ids: [id], latestOnly: true });
  const cites: Citation[] = [c("inspection", i.inspection_id, `latest inspection ${i.date}`, id), c("doc", `well-types/${w.well_type}.md`, `${w.well_type} production rule`)];
  const thr = rule("producing_delta_c", w.well_type, id);
  cites.push(thr.citation);
  const recordedOk = (w.recorded_status === "active") === i.producing;
  const fields = [
    { label: "Producing oil", value: i.producing ? "Yes" : "No" },
    { label: "Latest inspection", value: `${i.inspection_id} · ${D(i.date)} · ${i.method} · ${i.inspector}` },
    { label: "Wellhead / air", value: `${f1(i.wellhead_temp_c)} °C / ${f1(i.ambient_temp_c)} °C` },
    { label: "Above air", value: `${f1(i.delta)} °C (${w.well_type} limit ${thr.value} °C — ${thr.source})` },
    { label: "Recorded status", value: `${w.recorded_status}${recordedOk ? "" : " (out of date)"}` },
    { label: "Type · area", value: `${w.well_type} · ${w.area_name}` },
  ];
  const alerts: string[] = [];
  const lines: string[] = [];
  lines.push(`**${id} is ${i.producing ? "" : "not "}producing oil** as of its latest inspection ${i.inspection_id} on ${D(i.date)} (${i.method}, by ${i.inspector}).`);
  lines.push(`- The wellhead read ${f1(i.wellhead_temp_c)} °C against ${f1(i.ambient_temp_c)} °C air: ${f1(i.delta)} °C warmer, ${i.producing ? "at or above" : "below"} the ${w.well_type} limit of ${thr.value} °C (${thr.source}).`);
  for (const corr of i.corrections) {
    lines.push(`- This reading was corrected — ${describeCorrection(corr)}. Original value kept: ${corr.original_value}.`);
    alerts.push(`Corrected reading: ${describeCorrection(corr)}`);
    cites.push(c(corr.source.startsWith("note:") ? "note" : "correction", corr.source.startsWith("note:") ? corr.source.slice(5) : `CORR-${corr.id}`, describeCorrection(corr), id));
    if (corr.conflicts) for (const x of JSON.parse(corr.conflicts)) { lines.push(`  - ⚠ Conflicting evidence: ${x}`); alerts.push(`Conflict: ${x}`); }
  }
  if (i.notes) {
    lines.push(`- Inspector's remark on that inspection: "${i.notes}" (${i.inspector}).`);
    if (i.producing && /not moving|no stroke|stopped|not running|idle/i.test(i.notes)) alerts.push(`Inspector remark "${i.notes}" disagrees with producing status`);
  }
  if (!i.producing) {
    const { reasons, cites: rc } = explainStop(id, i);
    cites.push(...rc);
    if (reasons.length) { lines.push(`- Reason on record:`); reasons.forEach((r) => lines.push(`  - ${r}`)); fields.push({ label: "Reason", value: reasons.join(" · ") }); }
    else { lines.push(`- **No recorded reason** (no open repair or note covers this date). Suggest a field check of the pump jack and prime mover.`); fields.push({ label: "Reason", value: "No recorded reason — field check suggested" }); }
  }
  if (!recordedOk) lines.push(`- The recorded status still says \`${w.recorded_status}\`, which is out of date; the inspection is the truth.`);
  const open = openRepairs(id, t);
  for (const m of open) if (!lines.some((l) => l.includes(m.maintenance_id))) {
    lines.push(`- Open repair ${m.maintenance_id}: ${m.issue}, started ${D(m.started_at.slice(0, 10))}, planned end ${D(m.completed_at.slice(0, 10))}.`);
    cites.push(c("maintenance", m.maintenance_id, m.issue, id));
  }
  const planned = [...upcomingFacts(id, t).filter((f) => f.kind !== "status_claim"),
    ...notesFor(id).filter((n) => n.valid_from && n.valid_from > i.date && (!n.valid_to || n.valid_to >= t))];
  for (const f of planned) {
    const isFact = "kind" in f;
    const ref = isFact ? `shared note #${f.id}` : f.note_id;
    lines.push(`- Planned / upcoming: "${f.text}" (${ref}, ${userName(f.author_user_id)}${f.status && f.status !== "accepted" ? ", unconfirmed" : ""}).`);
    cites.push(isFact ? c("shared_fact", `FACT-${f.id}`, f.text, id) : c("note", f.note_id, f.text, id));
    fields.push({ label: "Planned", value: f.text });
  }
  for (const cl of claimsAbout(id).filter((x) => x.created_at.slice(0, 10) >= i.date)) {
    const agrees = (cl.claimed_producing === 1) === i.producing;
    lines.push(`- Claim by ${userName(cl.author_user_id)}: "${cl.text}" — ${agrees ? "consistent with" : "**contradicts**"} the latest inspection${cl.status === "unconfirmed" ? " (unconfirmed)" : ""}.`);
    if (!agrees) alerts.push(`Unconfirmed claim by ${userName(cl.author_user_id)}: "${cl.text}"`);
    cites.push(c("shared_fact", `FACT-${cl.id}`, cl.text, id));
  }
  for (const p of i.pending) alerts.push(`Unconfirmed correction pending: ${describeCorrection(p)}`);

  const card: Visual = { type: "status_card", title: `${id} — ${w.name}`, status: i.producing ? "producing" : "not_producing",
    headline: i.producing ? "Producing oil" : "Not producing oil", fields, alerts };
  return { tool: "well_status", text: lines.join("\n"), facts: { asset_id: id, producing: i.producing, delta: i.delta, threshold: thr.value, inspection: i.inspection_id },
    visuals: { status_card: card }, defaultVisual: "status_card", citations: uniqCites(cites), entities: [id] };
}

// ---------------------------------------------------------------------------------------------
export function wells_not_producing(a: WellSel): ToolResult {
  const { wells, area } = selectWells(a);
  const ids = wells.map((w) => w.asset_id);
  const latest = effInspections({ asset_ids: ids, latestOnly: true });
  const rows: any[] = [];
  const cites: Citation[] = [];
  const flipped: string[] = [];
  for (const i of latest) {
    const w = wells.find((x) => x.asset_id === i.asset_id)!;
    const rawProducing = i.raw.wellhead_temp_c - i.raw.ambient_temp_c >= i.threshold;
    if (rawProducing !== i.producing && i.producing) {
      const corr = i.corrections[i.corrections.length - 1];
      flipped.push(`${i.asset_id} is no longer listed: its ${D(i.date)} reading was corrected (${describeCorrection(corr)}); it is now ${f1(i.delta)} °C above air, so it counts as producing.`);
      cites.push(c("correction", `CORR-${corr.id}`, describeCorrection(corr), i.asset_id));
    }
    if (i.producing) continue;
    const { reasons, cites: rc } = explainStop(i.asset_id, i);
    cites.push(c("inspection", i.inspection_id, `${i.date}`, i.asset_id), ...rc);
    rows.push({
      well: i.asset_id, type: w.well_type, last: D(i.date), above_air: `${f1(i.delta)} °C`, limit: `${i.threshold} °C`,
      recorded: `${w.recorded_status}${w.recorded_status === "active" ? " (out of date)" : ""}`,
      reason: reasons.length ? reasons.join("; ") : `**No recorded reason**${i.notes ? `. Inspector noted "${i.notes}"` : ""} — suggest a field check`,
      remark: i.notes || "",
    });
  }
  for (const t of new Set(wells.map((w) => w.well_type))) cites.push(rule("producing_delta_c", t).citation);
  const scope = area ? area.name : a.team_id ? `${teamName(a.team_id)} wells` : a.well_type ? `${a.well_type} wells` : ids.length < 10 ? ids.join(", ") : "the field";
  const noReason = rows.filter((r) => r.reason.startsWith("**No recorded")).length;
  const lines = [`**${rows.length} well${rows.length === 1 ? "" : "s"} in ${scope} ${rows.length === 1 ? "is" : "are"} not producing oil** at ${rows.length === 1 ? "its" : "their"} latest inspection${noReason ? `; ${noReason} with no recorded reason` : ""}.`];
  for (const r of rows) lines.push(`- **${r.well}** (${r.type}, inspected ${r.last}): ${r.above_air} above air (limit ${r.limit}); recorded status ${r.recorded}. Reason: ${r.reason}`);
  if (noReason) lines.push(`\nWhere nothing on record explains the stop, I have not guessed a cause — a field check is suggested.`);
  lines.push(...flipped.map((f) => `\nNote: ${f}`));
  return {
    tool: "wells_not_producing", text: lines.join("\n"), facts: { count: rows.length, wells: rows.map((r) => r.well) },
    visuals: {
      table: { type: "table", title: `Not producing oil — ${scope}`, columns: [
        { key: "well", label: "Well" }, { key: "type", label: "Type" }, { key: "last", label: "Last inspected" },
        { key: "above_air", label: "Wellhead above air" }, { key: "recorded", label: "Recorded status" }, { key: "reason", label: "Reason" }], rows },
      map: { type: "map", title: `Not producing — ${scope}`, points: rows.map((r) => { const w = well(r.well); return { lat: w.lat, lon: w.lon, label: r.well, detail: r.reason, color: "#d9534f" }; }) },
    },
    defaultVisual: "table", citations: uniqCites(cites), entities: rows.map((r) => r.well),
  };
}

// ---------------------------------------------------------------------------------------------
export function temperature_series(a: { asset_id: string } & PeriodArgs & { weeks?: number }): ToolResult {
  const id = normWell(a.asset_id);
  if (!id) throw new Error(`Unknown well "${a.asset_id}"`);
  const t = today();
  const p = a.weeks ? { from: addDays(t, -7 * a.weeks), to: t, label: `last ${a.weeks} weeks` } : resolvePeriod(a, t, "last 13 weeks");
  const rows = effInspections({ asset_ids: [id], from: p.from, to: p.to });
  const w = well(id);
  const down = rows.filter((r) => !r.producing);
  const thr = rule("producing_delta_c", w.well_type, id);
  const text = [
    `${rows.length} readings for ${id} (${p.label}). Not producing oil on ${down.length ? down.map((r) => D(r.date)).join(", ") : "none of them"} (wellhead less than ${thr.value} °C above air, ${thr.source}).`,
    ...down.map((r) => `- ${D(r.date)} (${r.inspection_id}): wellhead ${f1(r.wellhead_temp_c)} °C vs air ${f1(r.ambient_temp_c)} °C → ${f1(r.delta)} °C above air`),
  ].join("\n");
  return {
    tool: "temperature_series", text, facts: { readings: rows.length, not_producing: down.map((r) => r.date) },
    visuals: {
      line: { type: "line", title: `${id} wellhead vs air temperature (${p.label})`, x: "date",
        series: [{ key: "wellhead", label: "Wellhead °C" }, { key: "air", label: "Air °C" }],
        rows: rows.map((r) => ({ date: r.date, wellhead: r.wellhead_temp_c, air: r.ambient_temp_c, delta: r.delta, producing: r.producing })),
        markers: down.map((r) => ({ x: r.date, label: "Not producing" })), yLabel: "°C" },
      table: { type: "table", title: `${id} readings`, columns: [{ key: "date", label: "Date" }, { key: "id", label: "Inspection" }, { key: "wellhead", label: "Wellhead °C" }, { key: "air", label: "Air °C" }, { key: "delta", label: "Above air" }, { key: "status", label: "Producing" }],
        rows: rows.map((r) => ({ date: r.date, id: r.inspection_id, wellhead: f1(r.wellhead_temp_c), air: f1(r.ambient_temp_c), delta: f1(r.delta), status: r.producing ? "yes" : "no" })) },
    },
    defaultVisual: "line", citations: uniqCites([...rows.filter((r) => !r.producing).map((r) => c("inspection", r.inspection_id, r.date, id)), thr.citation]), entities: [id],
  };
}

// ---------------------------------------------------------------------------------------------
function reportingStatus(s: any) {
  const t = today();
  if (s.spill_class !== "reportable" && s.spill_class !== "major") return { text: "no external report needed", overdue: false, cites: [] as Citation[] };
  const limit = rule(s.spill_class === "major" ? "sr01_major_report_hours" : "sr01_report_hours").value;
  const filed = d().prepare(`SELECT * FROM reg_events WHERE related_inspection_id=? AND event_type='spill_report_filed'`).get(s.inspection_id) as any;
  if (filed) {
    const late = filed.hours_to_report > limit;
    return { text: `report filed after ${filed.hours_to_report} h (${filed.event_id})${late ? ` — LATE, limit ${limit} h` : ""}`, overdue: late, cites: [c("reg_event", filed.event_id, filed.detail, s.asset_id)] };
  }
  const due = new Date(new Date(s.inspected_at).getTime() + limit * 3600000).toISOString();
  const overdue = due.slice(0, 10) <= t;
  return { text: `no written notice on record — ${overdue ? "**OVERDUE**" : "due"} by ${D(due.slice(0, 10))} ${due.slice(11, 16)} UTC (${limit} h after discovery)`, overdue, cites: [] };
}

export function spills(a: WellSel & PeriodArgs & { reportable_only?: boolean; min_bbl?: number }): ToolResult {
  const { wells, area } = selectWells(a);
  const p = resolvePeriod(a, today(), "all");
  const ids = wells.map((w) => w.asset_id);
  const { spills: all, excluded } = realSpills({ asset_ids: ids, from: p.from, to: p.to });
  const repBbl = rule("reportable_bbl").value;
  let list = all;
  if (a.reportable_only) list = list.filter((s) => (s.spill_volume_bbl ?? 0) >= repBbl);
  if (a.min_bbl) list = list.filter((s) => (s.spill_volume_bbl ?? 0) >= a.min_bbl!);
  list.sort((x, y) => x.inspected_at.localeCompare(y.inspected_at));
  const cites: Citation[] = [c("doc", "sops/spill-response-sop.md", "Spill classes and SR-01")];
  const rows = list.map((s) => {
    const rep = reportingStatus(s);
    cites.push(c("inspection", s.inspection_id, `${s.date} ${s.spill_volume_bbl} bbl`, s.asset_id), ...rep.cites);
    const corrected = s.corrections.find((x: any) => x.field === "spill_est_volume_bbl");
    if (corrected) cites.push(c("correction", `CORR-${corrected.id}`, describeCorrection(corrected), s.asset_id));
    return { well: s.asset_id, area: s.area_name, date: D(s.date), inspection: s.inspection_id, bbl: s.spill_volume_bbl,
      volume: `${f1(s.spill_volume_bbl)}${corrected ? ` (corrected from AI estimate ${f1(corrected.original_value)} by ${userName(corrected.author_user_id)})` : ""}`,
      pad_pct: s.spill_area_pct, class: s.spill_class, reporting: rep.text, lat: s.lat, lon: s.lon, _overdue: rep.overdue };
  });
  const total = list.reduce((x, s) => x + (s.spill_volume_bbl ?? 0), 0);
  const scope = area ? area.name : a.team_id ? `${teamName(a.team_id)} wells` : ids.length <= 5 ? ids.join(", ") : a.well_type ? `${a.well_type} wells` : "the field";
  const excl = excluded.filter((e) => !a.reportable_only || (e.raw.spill_est_volume_bbl ?? 0) >= repBbl);
  const lines = [`**${rows.length} ${a.reportable_only ? "reportable " : ""}spill${rows.length === 1 ? "" : "s"} in ${scope}** (${p.label}), **${f1(total)} bbl** in total.`];
  // Field-wide: summarise by area first; the full list stays in the table.
  const byArea = new Map<string, { n: number; bbl: number }>();
  for (const s of list) { const x = byArea.get(s.area_name) ?? { n: 0, bbl: 0 }; x.n++; x.bbl += s.spill_volume_bbl ?? 0; byArea.set(s.area_name, x); }
  const multiArea = byArea.size > 1;
  if (multiArea) for (const [k, v] of [...byArea.entries()].sort((x, y) => y[1].bbl - x[1].bbl)) lines.push(`- **${k}**: ${v.n} spills, ${f1(v.bbl)} bbl`);
  const listed = rows.length > 25 ? rows.filter((r) => r.class === "reportable" || r.class === "major" || r._overdue) : rows;
  if (rows.length > 25) lines.push(`\n${listed.length ? `Reportable spills (all ${rows.length} are in the table):` : `All ${rows.length} spills are in the table.`}`);
  for (const r of listed.slice(0, 40)) lines.push(`- ${r.well} · ${r.date} · ${r.volume} bbl · ${r.class} · ${r.inspection}${r.class === "reportable" || r.class === "major" ? ` · ${r.reporting}` : ""}`);
  if (a.reportable_only && !rows.length) lines.push(`No spill in this period reached ${repBbl} bbl.`);
  if (excl.length) {
    lines.push(`\n${excl.length} detection${excl.length === 1 ? " was" : "s were"} excluded as corrected (not real spills)${excl.length > 8 ? `; the first 8:` : ":"}`);
    for (const e of excl.slice(0, 8)) { const k = e.corrections.find((x: any) => x.field === "spill_detected"); lines.push(`- ${e.asset_id} ${D(e.date)} ${e.inspection_id}: ${k ? describeCorrection(k) : "corrected"}`); if (k) cites.push(c(k.source.startsWith("note:") ? "note" : "correction", k.source.startsWith("note:") ? k.source.slice(5) : `CORR-${k.id}`, k.reason, e.asset_id)); }
  }
  // Disputed detections (opposing notes, no formal correction)
  for (const s of list) {
    const n = notesFor(s.asset_id).filter((x) => x.text.includes(s.inspection_id));
    if (n.length >= 2) {
      const fix = d().prepare(`SELECT maintenance_id, issue FROM maintenance WHERE triggered_by_inspection_id=?`).get(s.inspection_id) as any;
      lines.push(`\n⚠ ${s.asset_id} ${D(s.date)} (${s.inspection_id}, AI-flagged ${f1(s.spill_volume_bbl)} bbl${s.notes ? `, "${s.notes}"` : ""}): people disagree in notes — ${n.map((x) => `${x.note_id} ${userName(x.author_user_id)} (${users_role(x.author_user_id)}): "${x.text}"`).join(" vs ")}. Neither is a formal correction${fix ? `, and a spill repair was done (${fix.maintenance_id}: ${fix.issue})` : ""}, so **the detection stands: it counts as a real oil spill**, with the disagreement on record.`);
      n.forEach((x) => cites.push(c("note", x.note_id, x.text, s.asset_id)));
      if (fix) cites.push(c("maintenance", fix.maintenance_id, fix.issue, s.asset_id));
    }
  }
  const byWell = new Map<string, number>();
  for (const s of list) byWell.set(s.asset_id, (byWell.get(s.asset_id) ?? 0) + (s.spill_volume_bbl ?? 0));
  return {
    tool: "spills", text: lines.join("\n"), facts: { count: rows.length, total_bbl: Math.round(total * 10) / 10, excluded: excl.length },
    visuals: {
      table: { type: "table", title: `Spills — ${scope} (${p.label})`, columns: [
        { key: "well", label: "Well" }, { key: "date", label: "Date" }, { key: "inspection", label: "Inspection" }, { key: "volume", label: "Barrels" },
        { key: "class", label: "Class" }, { key: "reporting", label: "Reporting (SR-01)" }], rows },
      map: { type: "map", title: `Spills — ${scope} (${p.label})`, points: rows.map((r) => ({ lat: r.lat, lon: r.lon, label: r.well, detail: `${r.date} · ${r.volume} bbl · ${r.class}`, color: r.class === "reportable" || r.class === "major" ? "#d9534f" : "#f0ad4e" })) },
      bar: multiArea
        ? { type: "bar", title: `Spill volume by area (${p.label})`, x: "area", series: [{ key: "bbl", label: "Barrels" }], rows: [...byArea.entries()].map(([k, v]) => ({ area: k, bbl: Math.round(v.bbl * 10) / 10, spills: v.n })).sort((x, y) => y.bbl - x.bbl) }
        : { type: "bar", title: `Spill volume by well (${p.label})`, x: "well", series: [{ key: "bbl", label: "Barrels" }],
          rows: [...byWell.entries()].map(([w, v]) => ({ well: w, bbl: Math.round(v * 10) / 10 })).sort((x, y) => y.bbl - x.bbl) },
    },
    defaultVisual: "table", citations: uniqCites(cites), entities: [...new Set(rows.map((r) => r.well))],
  };
}

// ---------------------------------------------------------------------------------------------
export function spill_heatmap(a: WellSel & PeriodArgs & { group_by?: "area" | "well_type" | "well" }): ToolResult {
  const t = today();
  const p = resolvePeriod(a, t, "this year");
  const { wells } = selectWells(a);
  const { spills: list, excluded } = realSpills({ asset_ids: wells.map((w) => w.asset_id), from: p.from, to: p.to });
  const gb = a.group_by ?? "area";
  const months: string[] = [];
  for (let m = p.from.slice(0, 7); m <= p.to.slice(0, 7); m = addMonths(m + "-01", 1).slice(0, 7)) months.push(m);
  const keyOf = (s: any) => (gb === "area" ? s.area_name : gb === "well_type" ? s.well_type : s.asset_id);
  const rowKeys = gb === "area" ? [...new Set(wells.map((w) => w.area_name))] : gb === "well_type" ? [...new Set(wells.map((w) => w.well_type))].sort() : [...new Set(list.map(keyOf))].sort();
  const values = rowKeys.map((rk) => months.map((m) => list.filter((s) => keyOf(s) === rk && s.date.startsWith(m)).length));
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const colLabels = months.map((m) => `${MON[Number(m.slice(5, 7)) - 1]}${months.length > 12 ? ` ${m.slice(2, 4)}` : ""}`);
  const totals = values.map((r) => r.reduce((x, y) => x + y, 0));
  const lines = [`**${list.length} real spills** by ${gb.replace("_", " ")} and month (${p.label}); ${excluded.length} corrected detections removed.`];
  rowKeys.forEach((rk, i) => lines.push(`- ${rk}: ${values[i].join(" · ")} → **${totals[i]}**`));
  const max = Math.max(...totals);
  lines.push(`Highest: ${rowKeys.filter((_, i) => totals[i] === max).join(", ")} (${max}).`);
  return {
    tool: "spill_heatmap", text: lines.join("\n"), facts: Object.fromEntries(rowKeys.map((k, i) => [k, { months: values[i], total: totals[i] }])),
    visuals: {
      heatmap: { type: "heatmap", title: `Spills by ${gb.replace("_", " ")} × month (${p.label})`, rowLabels: rowKeys, colLabels, values, totals: true },
      bar: { type: "bar", title: `Spills by ${gb.replace("_", " ")} (${p.label})`, x: "group", series: [{ key: "spills", label: "Spills" }], rows: rowKeys.map((k, i) => ({ group: k, spills: totals[i] })) },
    },
    defaultVisual: "heatmap",
    citations: [c("dataset", "inspections.jsonl", "spill_detected inspections"), c("dataset", "context.jsonl", `${excluded.length} correction notes applied`), c("doc", "sops/spill-response-sop.md", "§7 False positives")],
    entities: [],
  };
}

// ---------------------------------------------------------------------------------------------
export function downtime(a: WellSel & PeriodArgs & { top_n?: number }): ToolResult {
  const t = today();
  const p = resolvePeriod(a, t, "last 12 months");
  const { wells, area } = selectWells(a);
  const ins = effInspections({ asset_ids: wells.map((w) => w.asset_id), from: p.from, to: p.to });
  const per = wells.map((w) => {
    const mine = ins.filter((i) => i.asset_id === w.asset_id);
    const down = mine.filter((i) => !i.producing);
    return { well: w.asset_id, type: w.well_type, days: down.length * 7, down, inspections: mine.length };
  }).sort((x, y) => y.days - x.days || x.well.localeCompare(y.well));
  const single = per.length === 1;
  const shown = a.top_n ? per.slice(0, a.top_n) : per.filter((x) => x.days > 0);
  const cites: Citation[] = [c("doc", "02-dataset-guide.md", "Downtime = 7 days per not-producing weekly inspection")];
  for (const t2 of new Set(wells.map((w) => w.well_type))) cites.push(rule("producing_delta_c", t2).citation);
  const lines: string[] = [];
  const scope = area ? area.name : a.team_id ? `${teamName(a.team_id)} wells` : single ? per[0].well : a.well_type ? `${a.well_type} wells` : "the field";
  if (single) {
    const x = per[0];
    lines.push(`**${x.well} was down ${x.days} days** (${p.label}): ${x.down.length} weekly inspection${x.down.length === 1 ? "" : "s"} found it not producing oil, 7 days each.`);
    for (const i of x.down) {
      const { reasons, cites: rc } = explainStop(x.well, i);
      cites.push(c("inspection", i.inspection_id, i.date, x.well), ...rc);
      const hot = i.wellhead_temp_c >= 45 ? ` The wellhead looks hot, but only the difference matters.` : "";
      lines.push(`- **${D(i.date)}** (${i.inspection_id}): wellhead ${f1(i.wellhead_temp_c)} °C, air ${f1(i.ambient_temp_c)} °C → only ${f1(i.delta)} °C warmer (limit ${i.threshold} °C).${hot} Cause: ${reasons.length ? reasons.join("; ") : "no recorded reason"}`);
    }
  } else {
    lines.push(`**Downtime in ${scope}** (${p.label}), counted as 7 days per weekly inspection that found the well not producing oil:`);
    shown.forEach((x, k) => lines.push(`${k + 1}. **${x.well}** (${x.type}): ${x.days} days — ${x.down.map((i) => D(i.date)).join(", ") || "none"}`));
    for (let k = 1; k < shown.length; k++)
      if (shown[k].days === shown[k - 1].days && shown[k].days > 0) lines.push(`(${shown[k - 1].well} and ${shown[k].well} are tied at ${shown[k].days} days.)`);
    if (a.top_n && per[a.top_n]) {
      const tie = per[a.top_n].days === per[a.top_n - 1].days;
      lines.push(`${tie ? `⚠ Also tied at ${per[a.top_n].days} days, just outside the top ${a.top_n}: ` : "Next: "}${per[a.top_n].well}${tie ? "" : ` at ${per[a.top_n].days} days`}.`);
    }
    for (const x of shown) for (const i of x.down) cites.push(c("inspection", i.inspection_id, i.date, x.well));
    if (shown.length <= 5) {
      lines.push(`\n**Why:**`);
      for (const x of shown) {
        const causes = new Map<string, string>();
        for (const i of x.down) {
          const { reasons, cites: rc } = explainStop(x.well, i);
          reasons.forEach((r) => causes.set(r.split(":")[0], r));
          cites.push(...rc);
        }
        lines.push(`- **${x.well}**: ${causes.size ? [...causes.values()].join("; ") : "no recorded reason for these stops"}`);
      }
    }
  }
  return {
    tool: "downtime", text: lines.join("\n"), facts: shown.map((x) => ({ well: x.well, type: x.type, days: x.days })),
    visuals: single ? {} : {
      bar: { type: "bar", title: `Downtime days — ${scope} (${p.label})`, x: "well", series: [{ key: "days", label: "Days down" }], rows: shown.map((x) => ({ well: x.well, days: x.days, type: x.type })), yLabel: "days" },
      table: { type: "table", title: `Downtime — ${scope} (${p.label})`, columns: [{ key: "well", label: "Well" }, { key: "type", label: "Type" }, { key: "days", label: "Days down" }, { key: "dates", label: "Not-producing inspections" }],
        rows: shown.map((x) => ({ well: x.well, type: x.type, days: x.days, dates: x.down.map((i) => i.date).join(", ") })) },
      map: { type: "map", title: `Downtime — ${scope}`, points: shown.map((x) => { const w = well(x.well); return { lat: w.lat, lon: w.lon, label: x.well, detail: `${x.days} days down`, color: "#d9534f" }; }) },
    },
    defaultVisual: single ? null : "bar", citations: uniqCites(cites), entities: shown.map((x) => x.well),
  };
}

// ---------------------------------------------------------------------------------------------
type Item = { well: string; protocol: string; status: "breach" | "pending" | "met" | "check"; title: string; detail: string; due?: string; cites: Citation[] };

function auditWell(id: string, p: { from: string; to: string }, items: Item[]) {
  const t = today();
  const w = well(id);
  const add = (x: Omit<Item, "well">) => items.push({ well: id, ...x });
  const { spills: sp } = realSpills({ asset_ids: [id], from: p.from, to: p.to });
  const sr02 = rule("sr02_contain_hours").value;
  for (const s of sp) {
    const trig = d().prepare(`SELECT m.*, r.containment_hours, r.spill_class AS report_class, r.path FROM maintenance m LEFT JOIN reports r USING(maintenance_id) WHERE triggered_by_inspection_id=?`).all(s.inspection_id) as any[];
    const rep = trig.find((m) => m.path);
    const sc = s.spill_class;
    const base = `${D(s.date)} spill of ${f1(s.spill_volume_bbl)} bbl (${s.inspection_id}, ${sc})`;
    const sCite = c("inspection", s.inspection_id, base, id);
    if (rep?.containment_hours != null) {
      const late = rep.containment_hours > sr02;
      add({ protocol: "SR-02", status: late ? "breach" : "met", title: base, detail: `contained after about ${rep.containment_hours} h against a ${sr02} h limit (found only in repair report ${rep.maintenance_id})`,
        cites: [sCite, c("report", rep.maintenance_id, rep.path, id), c("doc", "sops/spill-response-sop.md", "SR-02")] });
    }
    if (sc === "reportable" || sc === "major") {
      const limit = rule(sc === "major" ? "sr01_major_report_hours" : "sr01_report_hours").value;
      const filed = d().prepare(`SELECT * FROM reg_events WHERE related_inspection_id=? AND event_type='spill_report_filed'`).get(s.inspection_id) as any;
      if (filed) {
        const nov = d().prepare(`SELECT * FROM reg_events WHERE related_inspection_id=? AND event_type='notice_of_violation'`).get(s.inspection_id) as any;
        add({ protocol: "SR-01", status: filed.hours_to_report > limit ? "breach" : "met", title: base,
          detail: `written notice filed after ${filed.hours_to_report} h (${filed.event_id}) against a ${limit} h limit${nov ? `; led to notice of violation ${nov.event_id} with a ${fmtUsd(nov.fine_usd)} fine (${nov.status})` : ""}`,
          cites: [sCite, c("reg_event", filed.event_id, filed.detail, id), ...(nov ? [c("reg_event", nov.event_id, nov.detail, id)] : []), c("doc", "sops/spill-response-sop.md", "SR-01")] });
      } else {
        const due = new Date(new Date(s.inspected_at).getTime() + limit * 3600000).toISOString();
        add({ protocol: "SR-01", status: due.slice(0, 10) <= t ? "breach" : "pending", title: base,
          detail: `no written notice on record; it was due within ${limit} h of the ${D(s.date)} ${s.inspected_at.slice(11, 16)} UTC inspection (by ${D(due.slice(0, 10))} ${due.slice(11, 16)})${s.corrections.some((x: any) => x.field === "spill_est_volume_bbl") ? " — reportable because of the corrected volume" : ""}. Possible breach.`,
          due: due.slice(0, 10), cites: [sCite, c("doc", "sops/spill-response-sop.md", "SR-01")] });
      }
      const vd = rule("sr03_verify_days").value;
      const due = addDays(s.date, vd);
      const visits = d().prepare(`SELECT * FROM reg_events WHERE related_inspection_id=? AND event_type='site_inspection'`).all(s.inspection_id) as any[];
      const passed = visits.some((v) => v.status === "closed") && !visits.some((v) => v.status === "open");
      const openV = visits.find((v) => v.status === "open");
      add({ protocol: "SR-03", status: passed ? "met" : due < t ? "breach" : "pending", title: base,
        detail: passed ? `agency verification closed (${visits.map((v) => v.event_id).join(", ")})` : `agency verification of the clean-up due within ${vd} days, by ${D(due)}; ${openV ? `still open (${openV.event_id}: ${openV.detail})` : "no passing site inspection on record"}`,
        due, cites: [sCite, ...visits.map((v) => c("reg_event", v.event_id, v.detail, id)), c("doc", "sops/spill-response-sop.md", "SR-03")] });
      if (rep?.report_class && rep.report_class !== sc)
        add({ protocol: "SR-04", status: "check", title: base, detail: `repair report ${rep.maintenance_id} classed the spill as "${rep.report_class}" with no reporting duty, based on the original estimate of ${f1(s.raw.spill_est_volume_bbl)} bbl; with the corrected volume that no longer holds`,
          cites: [c("report", rep.maintenance_id, rep.path, id)] });
    }
  }
  // Notices of violation: response within N days (RC-04). Open notices are always shown.
  const rc04 = rule("rc04_response_days").value;
  const novs = d().prepare(`SELECT * FROM reg_events WHERE asset_id=? AND event_type='notice_of_violation' AND (status='open' OR date BETWEEN ? AND ?)`).all(id, p.from, p.to) as any[];
  for (const n of novs) {
    const resp = d().prepare(`SELECT * FROM reg_events WHERE asset_id=? AND event_type='nov_response_filed' AND date >= ? AND (related_inspection_id IS ? OR related_inspection_id=?) ORDER BY date LIMIT 1`).get(id, n.date, n.related_inspection_id, n.related_inspection_id) as any;
    const due = addDays(n.date, rc04);
    add({ protocol: "RC-04", status: resp ? (resp.date <= due ? "met" : "breach") : due < t ? "breach" : "pending", title: `Notice of violation ${n.event_id} (${D(n.date)}, ${fmtUsd(n.fine_usd)} fine, ${n.status})`,
      detail: resp ? `response ${resp.event_id} filed ${D(resp.date)} (due ${D(due)})` : `a response was due by ${D(due)}; none is recorded. Fine ${fmtUsd(n.fine_usd)} still ${n.status}`,
      due, cites: [c("reg_event", n.event_id, n.detail, id), ...(resp ? [c("reg_event", resp.event_id, resp.detail, id)] : []), c("doc", "sops/regulatory-compliance-sop.md", "RC-04")] });
  }
  // RC-01: inspection at least every N days.
  const rc01 = rule("rc01_inspection_days").value;
  const ins = effInspections({ asset_ids: [id], from: addDays(p.from, -rc01), to: p.to });
  for (let k = 1; k < ins.length; k++) {
    const gap = Math.round(hoursBetween(ins[k - 1].inspected_at, ins[k].inspected_at) / 24);
    if (gap > rc01 && ins[k].date >= p.from)
      add({ protocol: "RC-01", status: "breach", title: `Inspection gap of ${gap} days`, detail: `no inspection between ${D(ins[k - 1].date)} (${ins[k - 1].inspection_id}) and ${D(ins[k].date)} (${ins[k].inspection_id}); limit ${rc01} days`,
        cites: [c("inspection", ins[k].inspection_id, ins[k].date, id), c("doc", "sops/regulatory-compliance-sop.md", "RC-01")] });
  }
  // RC-02: yearly flowline integrity test.
  const hasFlowline = d().prepare(`SELECT 1 FROM equipment WHERE asset_id=? AND kind='flowline'`).get(id);
  if (hasFlowline) {
    for (let y = Number(p.from.slice(0, 4)); y <= Number(p.to.slice(0, 4)); y++) {
      if (`${y}-12-31` < w.installed_on) continue;
      const test = d().prepare(`SELECT * FROM maintenance WHERE asset_id=? AND equipment_kind='flowline' AND issue LIKE '%integrity test%' AND substr(started_at,1,4)=?`).get(id, String(y)) as any;
      const yearOver = `${y}-12-31` < t;
      if (!test && !yearOver && y !== Number(t.slice(0, 4))) continue;
      add({ protocol: "RC-02", status: test ? "met" : yearOver ? "breach" : "pending", title: `Flowline integrity test ${y}`,
        detail: test ? `done on ${D(test.started_at.slice(0, 10))} (${test.maintenance_id})` : yearOver ? `no integrity test recorded in ${y}` : `not yet done in ${y}; due by 31 Dec`,
        cites: [...(test ? [c("maintenance", test.maintenance_id, test.issue, id)] : []), c("doc", "sops/regulatory-compliance-sop.md", "RC-02")] });
    }
  }
  // RC-03: more than N consecutive days down must be reported to the supervisor.
  const rc03 = rule("rc03_downtime_days").value;
  let run: EffInspection[] = [];
  const flush = () => {
    if (run.length * 7 > rc03) add({ protocol: "RC-03", status: "check", title: `${run.length * 7} consecutive days not producing`, detail: `${D(run[0].date)} – ${D(run[run.length - 1].date)}; must be reported to the area production supervisor (no record of a report in the data)`,
      cites: [c("inspection", run[0].inspection_id, run[0].date, id), c("doc", "sops/regulatory-compliance-sop.md", "RC-03")] });
    run = [];
  };
  for (const i of ins.filter((x) => x.date >= p.from)) { if (!i.producing) run.push(i); else flush(); }
  flush();
  // Manual §10: root-cause analysis after N corrective repairs on the same equipment in the window.
  const since = rcaWindowStart(w.well_type, id);
  const corr = d().prepare(`SELECT * FROM maintenance WHERE asset_id=? AND maintenance_type='corrective' AND substr(started_at,1,10) > ? AND substr(started_at,1,10) <= ? ORDER BY started_at`).all(id, since, t) as any[];
  const byKind = new Map<string, any[]>();
  for (const m of corr) byKind.set(m.equipment_kind, [...(byKind.get(m.equipment_kind) ?? []), m]);
  for (const [kind, ms] of byKind) {
    const rcaN = rule("rca_count", w.well_type, id, kind);
    if (ms.length < rcaN.value) continue;
    const flagged = d().prepare(`SELECT maintenance_id FROM report_checks WHERE maintenance_id IN (${ms.map(() => "?").join(",")}) AND result LIKE 'Action required%'`).all(...ms.map((m) => m.maintenance_id)) as any[];
    add({ protocol: "RCA", status: "pending", title: `Root-cause analysis due on the ${kind.replace("_", " ")}`,
      detail: `${ms.length} corrective repairs in the last 12 months (${ms.map((m) => m.maintenance_id).join(", ")}); threshold ${rcaN.value} (${rcaN.source})${flagged.length ? `; report ${flagged.map((f) => f.maintenance_id).join(", ")} marks it "Action required"` : ""}`,
      cites: [...ms.map((m) => c("maintenance", m.maintenance_id, m.issue, id)), rcaN.citation] });
  }
  // Manual §4: a planned shut-in must be recorded in the maintenance system before work starts.
  const planned = [...notesFor(id, t), ...factsFor(id, t).filter((f) => f.kind === "planned_downtime")].filter((n) => /shut[- ]?in|workover|planned/i.test(n.text));
  for (const n of planned) {
    const from = n.valid_from ?? t;
    const rec = d().prepare(`SELECT 1 FROM maintenance WHERE asset_id=? AND substr(started_at,1,10) BETWEEN ? AND ?`).get(id, addDays(from, -2), addDays(t, 30));
    if (!rec) add({ protocol: `${w.well_type} manual §4`, status: from <= t ? "pending" : "check", title: `Planned shut-in from ${D(from)} not in the maintenance system`,
      detail: `${n.note_id ? `note ${n.note_id}` : `shared note #${n.id}`} by ${userName(n.author_user_id)}: "${n.text}" — the ${w.well_type} manual requires the shut-in to be recorded in the maintenance system before work starts`,
      cites: [n.note_id ? c("note", n.note_id, n.text, id) : c("shared_fact", `FACT-${n.id}`, n.text, id), c("doc", `well-types/${w.well_type}.md`, "§4 Start-up and shut-in")] });
  }
  // Temperature alarm.
  const alarm = rule("temp_alarm_c", w.well_type, id).value;
  for (const i of ins.filter((x) => x.date >= p.from && x.wellhead_temp_c > alarm))
    add({ protocol: `${w.well_type} manual §9.4`, status: "check", title: `Wellhead ${f1(i.wellhead_temp_c)} °C above the ${alarm} °C alarm`, detail: `${i.inspection_id} on ${D(i.date)}: shut in and inspect within 24 h`, cites: [c("inspection", i.inspection_id, i.date, id)] });
  // Anything else a repair report marks "Not met".
  const notMet = d().prepare(`SELECT rc.*, m.started_at FROM report_checks rc JOIN maintenance m USING(maintenance_id) WHERE m.asset_id=? AND rc.result LIKE 'Not met%' AND rc.protocol NOT IN ('SR-01','SR-02') AND substr(m.started_at,1,10) BETWEEN ? AND ?`).all(id, p.from, p.to) as any[];
  for (const r of notMet) add({ protocol: r.protocol, status: "breach", title: `Repair ${r.maintenance_id} compliance check`, detail: `${r.result}: ${r.detail}`, cites: [c("report", r.maintenance_id, r.detail, id)] });
}

export function compliance(a: WellSel & PeriodArgs & { protocol?: string; status?: string }): ToolResult {
  const t = today();
  const p = resolvePeriod(a, t, "last 12 months");
  const { wells, area } = selectWells(a);
  const items: Item[] = [];
  for (const w of wells) auditWell(w.asset_id, p, items);
  let list = items;
  if (a.protocol) { const pr = a.protocol.toUpperCase().replace(/\s+/g, ""); list = list.filter((i) => i.protocol.toUpperCase().replace(/\s+/g, "").startsWith(pr)); }
  if (a.status === "pending") list = list.filter((i) => i.status === "pending" || i.status === "check");
  else if (a.status) list = list.filter((i) => i.status === a.status);
  const single = wells.length === 1;
  const scope = area ? area.name : a.team_id ? `${teamName(a.team_id)} wells` : single ? wells[0].asset_id : a.well_type ? `${a.well_type} wells` : "the field";
  const breaches = list.filter((i) => i.status === "breach");
  const pending = list.filter((i) => i.status === "pending" || i.status === "check");
  const met = list.filter((i) => i.status === "met");
  const fines = d().prepare(`SELECT COALESCE(SUM(fine_usd),0) s FROM reg_events WHERE status='open' AND event_type='notice_of_violation' AND asset_id IN (${wells.map(() => "?").join(",")})`).get(...wells.map((w) => w.asset_id)) as any;
  const lines = [a.status === "pending"
    ? `**${pending.length} item${pending.length === 1 ? "" : "s"} still pending** in ${scope} (${p.label}${a.protocol ? `, ${a.protocol}` : ""}): deadlines not passed yet, or work under way.`
    : `**${breaches.length} breach${breaches.length === 1 ? "" : "es"}** in ${scope} (${p.label}${a.protocol ? `, ${a.protocol}` : ""})${fines.s ? `; **${fmtUsd(fines.s)} in fines still open**` : ""}.`];
  const fmtI = (i: Item) => `- **${i.protocol}**${single ? "" : ` · ${i.well}`} — ${i.title}: ${i.detail}`;
  if (breaches.length) lines.push(...breaches.map(fmtI));
  if (pending.length && a.status === "pending") lines.push(...pending.map(fmtI));
  else if (pending.length && a.status !== "breach") lines.push(`
**Still pending / to check** (not counted as breaches — deadline not passed or work under way):`, ...pending.map(fmtI));
  if (met.length && single && a.status !== "breach") lines.push(`\n**Met:**`, ...met.map(fmtI));
  return {
    tool: "compliance", text: lines.join("\n"), facts: { breaches: breaches.length, pending: pending.length, open_fines_usd: fines.s },
    visuals: {
      table: { type: "table", title: `Compliance — ${scope} (${p.label})`, columns: [
        ...(single ? [] : [{ key: "well", label: "Well" }]), { key: "protocol", label: "Rule" }, { key: "status", label: "Status" }, { key: "title", label: "Item" }, { key: "detail", label: "Detail" }],
        rows: [...breaches, ...pending, ...(single ? met : [])].map((i) => ({ well: i.well, protocol: i.protocol, status: i.status, title: i.title, detail: i.detail })) },
      bar: { type: "bar", title: `Breaches by well (${p.label})`, x: "well", series: [{ key: "breaches", label: "Breaches" }],
        rows: [...new Set(breaches.map((b) => b.well))].map((w) => ({ well: w, breaches: breaches.filter((b) => b.well === w).length })).sort((x, y) => y.breaches - x.breaches) },
      map: { type: "map", title: `Breaches — ${scope}`, points: [...new Set(breaches.map((b) => b.well))].map((wid) => { const w = well(wid); return { lat: w.lat, lon: w.lon, label: wid, detail: breaches.filter((b) => b.well === wid).map((b) => b.protocol).join(", "), color: "#d9534f" }; }) },
    },
    defaultVisual: "table", citations: uniqCites(list.flatMap((i) => i.cites)), entities: [...new Set(breaches.map((b) => b.well))],
  };
}

// ---------------------------------------------------------------------------------------------
export function rca_candidates(a: WellSel & { equipment_kind?: string }): ToolResult {
  const t = today();
  const { wells, area } = selectWells(a);
  const kind = a.equipment_kind?.toLowerCase().replace(/\s+/g, "_");
  const rows: any[] = [];
  const near: string[] = [];
  const cites: Citation[] = [];
  const overrides = new Set<string>();
  for (const w of wells) {
    const since = rcaWindowStart(w.well_type, w.asset_id);
    const ms = d().prepare(`SELECT * FROM maintenance WHERE asset_id=? AND maintenance_type='corrective' AND substr(started_at,1,10) > ? AND substr(started_at,1,10) <= ? ${kind ? "AND equipment_kind=?" : ""} ORDER BY started_at`)
      .all(...[w.asset_id, since, t, ...(kind ? [kind] : [])]) as any[];
    const byKind = new Map<string, any[]>();
    for (const m of ms) byKind.set(m.equipment_kind, [...(byKind.get(m.equipment_kind) ?? []), m]);
    for (const [k, list] of byKind) {
      const r = rule("rca_count", w.well_type, w.asset_id, k);
      if (list.length >= r.value) {
        rows.push({ well: w.asset_id, type: w.well_type, equipment: k, repairs: list.length, ids: list.map((m) => m.maintenance_id).join(", "), threshold: r.value, rule: r.override ? `team rule (${userName(r.override.author_user_id)})` : "manual §10" });
        cites.push(...list.map((m) => c("maintenance", m.maintenance_id, m.issue, w.asset_id)), r.citation);
        if (r.override) overrides.add(r.source);
      } else if (list.length >= 2) {
        near.push(`${w.asset_id} (${w.well_type}) has ${list.length} ${k.replace("_", " ")} repairs, below its threshold of ${r.value} (${r.override ? "team rule" : "manual"})`);
      }
    }
  }
  const scope = area ? area.name : a.team_id ? `${teamName(a.team_id)} wells` : a.well_type ? `${a.well_type} wells` : "the field";
  const lines = [`**${rows.length} well${rows.length === 1 ? "" : "s"} in ${scope} need a root-cause analysis${kind ? ` on the ${kind.replace("_", " ")}` : ""}:** ${rows.map((r) => r.well).join(", ") || "none"}.`];
  for (const r of rows) lines.push(`- **${r.well}** (${r.type}): ${r.repairs} corrective ${r.equipment.replace("_", " ")} repairs in the last 12 months (${r.ids}); threshold ${r.threshold} — ${r.rule}`);
  lines.push(`\nRule: T200 manual §10 (the T350 manual refers to it) — RCA after ${rule("rca_count", "T200").value} corrective repairs on the same equipment within 12 months.`);
  for (const o of overrides) lines.push(`This answer also applies a ${o}.`);
  if (near.length) lines.push(`\nBelow threshold:`, ...near.map((n) => `- ${n}`));
  return {
    tool: "rca_candidates", text: lines.join("\n"), facts: rows.map((r) => ({ well: r.well, repairs: r.repairs, threshold: r.threshold })),
    visuals: {
      table: { type: "table", title: `Root-cause analysis needed — ${scope}`, columns: [{ key: "well", label: "Well" }, { key: "type", label: "Type" }, { key: "equipment", label: "Equipment" }, { key: "repairs", label: "Corrective repairs (12 mo)" }, { key: "ids", label: "Repairs" }, { key: "rule", label: "Rule" }], rows },
      bar: { type: "bar", title: `Corrective repairs (12 months) — ${scope}`, x: "well", series: [{ key: "repairs", label: "Repairs" }], rows },
    },
    defaultVisual: "table", citations: uniqCites([...cites, c("doc", "well-types/T200.md", "§10 Maintenance escalation")]), entities: rows.map((r) => r.well),
  };
}

// ---------------------------------------------------------------------------------------------
export function repairs(a: WellSel & PeriodArgs & { equipment_kind?: string; maintenance_type?: string; group_by?: "issue" | "equipment" | "well" }): ToolResult {
  if (a.group_by === "issue" || a.group_by === "equipment") return repairBreakdown(a, a.group_by);
  const t = today();
  const p = resolvePeriod(a, t, "all");
  const { wells, area } = selectWells(a);
  const ids = wells.map((w) => w.asset_id);
  const params: any[] = [...ids, p.from, p.to];
  let extra = "";
  if (a.equipment_kind) { extra += " AND equipment_kind=?"; params.push(a.equipment_kind.toLowerCase().replace(/\s+/g, "_")); }
  if (a.maintenance_type) { extra += " AND maintenance_type=?"; params.push(a.maintenance_type.toLowerCase()); }
  const ms = d().prepare(`SELECT * FROM maintenance WHERE asset_id IN (${ids.map(() => "?").join(",")}) AND substr(started_at,1,10) BETWEEN ? AND ? ${extra} ORDER BY started_at`).all(...params) as any[];
  const per = ids.map((id) => {
    const mine = ms.filter((m) => m.asset_id === id);
    return { well: id, count: mine.length, cost: mine.reduce((x, m) => x + (m.cost_total ?? 0), 0), corrective: mine.filter((m) => m.maintenance_type === "corrective").length };
  });
  const total = per.reduce((x, r) => x + r.cost, 0);
  const scope = area ? area.name : a.team_id ? `${teamName(a.team_id)} wells` : ids.length <= 5 ? ids.join(", ") : "the field";
  const lines = [`**Repairs for ${scope}** (${p.label}, by start date): ${ms.length} jobs, **${fmtUsd(total)}** in total.`];
  if (ids.length <= 10) for (const r of per) lines.push(`- **${r.well}: ${fmtUsd(r.cost)}** (${r.count} jobs, ${r.corrective} corrective)`);
  else for (const r of [...per].sort((x, y) => y.cost - x.cost).slice(0, 10)) lines.push(`- ${r.well}: ${fmtUsd(r.cost)} (${r.count} jobs)`);
  const open = ms.filter((m) => m.completed_at.slice(0, 10) > t);
  if (open.length) lines.push(`Still in progress: ${open.map((m) => `${m.maintenance_id} (${m.issue})`).join(", ")}.`);
  return {
    tool: "repairs", text: lines.join("\n"), facts: per,
    visuals: {
      table: { type: "table", title: `Repairs — ${scope} (${p.label})`, columns: [{ key: "id", label: "Repair" }, { key: "well", label: "Well" }, { key: "start", label: "Started" }, { key: "type", label: "Type" }, { key: "equipment", label: "Equipment" }, { key: "issue", label: "Issue" }, { key: "cost", label: "Cost (USD)" }],
        rows: ms.map((m) => ({ id: m.maintenance_id, well: m.asset_id, start: m.started_at.slice(0, 10), type: m.maintenance_type, equipment: m.equipment_kind, issue: m.issue, cost: m.cost_total })) },
      bar: { type: "bar", title: `Repair cost by well (${p.label})`, x: "well", series: [{ key: "cost", label: "USD" }], rows: per.filter((r) => r.count).sort((x, y) => y.cost - x.cost).slice(0, 25) },
    },
    defaultVisual: ids.length > 1 ? "bar" : "table",
    citations: uniqCites(ms.slice(0, 60).map((m) => c("maintenance", m.maintenance_id, `${m.issue} ${fmtUsd(m.cost_total)}`, m.asset_id))), entities: ids.length <= 10 ? ids : per.filter((r) => r.count).map((r) => r.well).slice(0, 10),
  };
}

/** Which problems happen most: repairs counted by issue or equipment, with cost and downtime. */
function repairBreakdown(a: WellSel & PeriodArgs & { equipment_kind?: string; maintenance_type?: string }, by: "issue" | "equipment"): ToolResult {
  const p = resolvePeriod(a, today(), "all");
  const { wells, area } = selectWells(a);
  const ids = wells.map((w) => w.asset_id);
  const params: any[] = [...ids, p.from, p.to];
  let extra = "";
  if (a.equipment_kind) { extra += " AND equipment_kind=?"; params.push(a.equipment_kind.toLowerCase().replace(/\s+/g, "_")); }
  if (a.maintenance_type) { extra += " AND maintenance_type=?"; params.push(a.maintenance_type.toLowerCase()); }
  const key = by === "issue" ? "issue" : "equipment_kind";
  const rows = d().prepare(`SELECT ${key} AS k, COUNT(*) n, COUNT(DISTINCT asset_id) wells, SUM(cost_total) cost, SUM(downtime_hours) hours
    FROM maintenance WHERE asset_id IN (${ids.map(() => "?").join(",")}) AND substr(started_at,1,10) BETWEEN ? AND ? ${extra} GROUP BY ${key} ORDER BY n DESC`).all(...params) as any[];
  const scope = area ? area.name : a.team_id ? `${teamName(a.team_id)} wells` : a.well_type ? `${a.well_type} wells` : ids.length <= 5 ? ids.join(", ") : "the field";
  const what = `${a.maintenance_type ?? ""} ${a.equipment_kind ? a.equipment_kind.replace("_", " ") + " " : ""}repairs`.trim();
  const lines = [`**Most common ${what} in ${scope}** (${p.label}), by ${by}:`,
    ...rows.slice(0, 12).map((r, i) => `${i + 1}. **${r.k}**: ${r.n} jobs on ${r.wells} wells, ${fmtUsd(r.cost)}, ${Math.round(r.hours)} h stopped`)];
  return {
    tool: "repairs", text: lines.join("\n"), facts: rows.slice(0, 12),
    visuals: {
      bar: { type: "bar", title: `${what} by ${by} — ${scope} (${p.label})`, x: "k", series: [{ key: "n", label: "Jobs" }], rows: rows.slice(0, 12) },
      table: { type: "table", title: `${what} by ${by}`, columns: [{ key: "k", label: by }, { key: "n", label: "Jobs" }, { key: "wells", label: "Wells" }, { key: "cost", label: "Cost USD" }, { key: "hours", label: "Hours stopped" }], rows },
    },
    defaultVisual: "bar", citations: [c("dataset", "maintenance.jsonl", `${rows.reduce((x, r) => x + r.n, 0)} repair records`)], entities: [],
  };
}

// ---------------------------------------------------------------------------------------------
export function regulatory_events(a: WellSel & PeriodArgs & { status?: string; event_type?: string }): ToolResult {
  const p = resolvePeriod(a, today(), "all");
  const { wells, area } = selectWells(a);
  const ids = wells.map((w) => w.asset_id);
  const params: any[] = [...ids, p.from, p.to];
  let extra = "";
  if (a.status) { extra += " AND status=?"; params.push(a.status); }
  if (a.event_type) { extra += " AND event_type=?"; params.push(a.event_type); }
  const ev = d().prepare(`SELECT * FROM reg_events WHERE asset_id IN (${ids.map(() => "?").join(",")}) AND date BETWEEN ? AND ? ${extra} ORDER BY date`).all(...params) as any[];
  const fines = ev.filter((e) => e.event_type === "notice_of_violation").reduce((x, e) => x + e.fine_usd, 0);
  const openF = ev.filter((e) => e.event_type === "notice_of_violation" && e.status === "open").reduce((x, e) => x + e.fine_usd, 0);
  const scope = area ? area.name : a.team_id ? `${teamName(a.team_id)} wells` : ids.length <= 5 ? ids.join(", ") : "the field";
  const lines = [`**${ev.length} regulator events** for ${scope} (${p.label}); fines ${fmtUsd(fines)}, of which ${fmtUsd(openF)} still open.`,
    ...ev.slice(0, 40).map((e) => `- ${e.date} · ${e.asset_id} · ${e.event_id} · ${e.event_type} (${e.protocol_id}) · ${e.status}${e.fine_usd ? ` · ${fmtUsd(e.fine_usd)}` : ""} — ${e.detail}`)];
  return {
    tool: "regulatory_events", text: lines.join("\n"), facts: { count: ev.length, fines, open_fines: openF },
    visuals: { table: { type: "table", title: `Regulator events — ${scope}`, columns: [{ key: "date", label: "Date" }, { key: "asset_id", label: "Well" }, { key: "event_id", label: "Event" }, { key: "event_type", label: "Type" }, { key: "protocol_id", label: "Rule" }, { key: "status", label: "Status" }, { key: "fine_usd", label: "Fine USD" }, { key: "detail", label: "Detail" }], rows: ev } },
    defaultVisual: "table", citations: uniqCites(ev.map((e) => c("reg_event", e.event_id, e.detail, e.asset_id))), entities: [...new Set(ev.map((e) => e.asset_id))],
  };
}

// ---------------------------------------------------------------------------------------------
export function well_list(a: WellSel & { status?: "producing" | "not_producing" }): ToolResult {
  const { wells, area } = selectWells(a);
  const latest = new Map(effInspections({ asset_ids: wells.map((w) => w.asset_id), latestOnly: true }).map((i) => [i.asset_id, i]));
  let rows = wells.map((w) => {
    const i = latest.get(w.asset_id);
    return { well: w.asset_id, name: w.name, type: w.well_type, area: w.area_name, installed: w.installed_on, recorded: w.recorded_status, producing: i ? (i.producing ? "yes" : "no") : "?", last: i?.date ?? "", in_charge: userName(w.in_charge_user_id), lat: w.lat, lon: w.lon };
  });
  if (a.status) rows = rows.filter((r) => (a.status === "producing") === (r.producing === "yes"));
  const scope = area ? area.name : a.team_id ? `${teamName(a.team_id)} wells` : a.well_type ? `${a.well_type} wells` : "the field";
  const types = rows.reduce((m: any, r) => ((m[r.type] = (m[r.type] ?? 0) + 1), m), {});
  const lines = [`**${rows.length} well${rows.length === 1 ? "" : "s"} in ${scope}** (${Object.entries(types).map(([k, v]) => `${v} ${k}`).join(", ")}); ${rows.filter((r) => r.producing === "yes").length} producing at their latest inspection.`];
  if (rows.length <= 3) for (const r of rows) {
    const eq = d().prepare(`SELECT kind, model FROM equipment WHERE asset_id=? ORDER BY equipment_id`).all(r.well) as any[];
    lines.push(`- **${r.well}** (${r.name}): ${r.type} in ${r.area}; in charge: **${r.in_charge}**; installed **${D(r.installed)}**; location ${r.lat}, ${r.lon}; recorded status ${r.recorded}; producing at latest inspection (${D(r.last)}): ${r.producing}.`,
      `  - Equipment: ${eq.map((e) => `${e.kind.replace("_", " ")} ${e.model}`).join("; ")}`);
  }
  return {
    tool: "well_list", text: lines.join("\n"),
    facts: { count: rows.length, types },
    visuals: {
      table: { type: "table", title: `Wells — ${scope}`, columns: [{ key: "well", label: "Well" }, { key: "type", label: "Type" }, { key: "area", label: "Area" }, { key: "installed", label: "Installed" }, { key: "producing", label: "Producing now" }, { key: "recorded", label: "Recorded status" }, { key: "in_charge", label: "In charge" }], rows },
      map: { type: "map", title: `Wells — ${scope}`, points: rows.map((r) => ({ lat: r.lat, lon: r.lon, label: r.well, detail: `${r.type} · producing: ${r.producing}`, color: r.producing === "yes" ? "#2e7d32" : "#d9534f" })) },
    },
    defaultVisual: rows.length <= 3 ? null : "table", citations: rows.length <= 10 ? rows.map((r) => c("dataset", `${r.well}/metadata.json`, "well details", r.well)) : [c("dataset", "metadata.json", "well details")], entities: rows.length <= 10 ? rows.map((r) => r.well) : [],
  };
}

// ---------------------------------------------------------------------------------------------
export function search_docs(a: { query: string; asset_id?: string; kind?: string; limit?: number }): ToolResult {
  const terms = a.query.replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter((x) => x.length > 2 && !/^(the|and|for|what|which|does|how|are|was|with|this|that|from|when|does)$/i.test(x));
  if (!terms.length) throw new Error("empty search");
  const match = terms.map((x) => `"${x.replace(/"/g, "")}"`).join(" OR ");
  const where = [`search_fts MATCH ?`];
  const params: any[] = [match];
  if (a.asset_id) { where.push(`asset_id = ?`); params.push(normWell(a.asset_id)); }
  if (a.kind) { where.push(`ref_type = ?`); params.push(a.kind); }
  const rows = d().prepare(`SELECT ref_type, ref_id, asset_id, title, snippet(search_fts, 4, '**', '**', ' … ', 40) AS snip, bm25(search_fts) AS score
    FROM search_fts WHERE ${where.join(" AND ")} ORDER BY score LIMIT ?`).all(...params, a.limit ?? 6) as any[];
  return {
    tool: "search_docs", text: rows.map((r) => `- **${r.title}** (${r.ref_type} ${r.ref_id}${r.asset_id ? `, ${r.asset_id}` : ""}): ${r.snip.replace(/\s+/g, " ")}`).join("\n") || "No matching documents.",
    facts: rows.map((r) => ({ ref: r.ref_id, type: r.ref_type, title: r.title, snippet: r.snip.replace(/\s+/g, " ") })),
    visuals: {}, defaultVisual: null, citations: rows.map((r) => c(r.ref_type === "manual" || r.ref_type === "sop" ? "doc" : r.ref_type, r.ref_id, r.title, r.asset_id)), entities: [...new Set(rows.map((r) => r.asset_id).filter(Boolean))],
  };
}

// ---------------------------------------------------------------------------------------------
/** What the SOPs require for a spill of a given size (class, reporting, containment, clean-up). */
export function spill_rules(a: { volume_bbl: number; pad_pct?: number; well_type?: string }): ToolResult {
  const v = Number(a.volume_bbl);
  if (!Number.isFinite(v)) throw new Error("volume_bbl required");
  const cls = spillClass(v);
  const R = (k: string, wt?: string) => rule(k, wt);
  const minor = R("minor_below_bbl"), rep = R("reportable_bbl"), major = R("major_bbl");
  const lines = [`**A ${f1(v)} bbl spill is "${cls}"** (Spill Response SOP §3: minor below ${minor.value} bbl, moderate ${minor.value} to below ${rep.value}, reportable ${rep.value} to below ${major.value}, major ${major.value} bbl or more).`];
  const cites: Citation[] = [minor.citation];
  if (cls === "major" || cls === "reportable") {
    const h = R(cls === "major" ? "sr01_major_report_hours" : "sr01_report_hours");
    lines.push(`- **SR-01:** phone the State Oil & Gas Commission immediately, then file the written notice within **${h.value} hours** of discovery (the inspection time)${cls === "major" ? " — the major-spill limit" : ""}.`);
    const vd = R("sr03_verify_days");
    lines.push(`- **SR-03:** clean soil to 1.0% TPH or less, take at least 4 soil samples, and get the clean-up **verified by the environmental agency within ${vd.value} days**.`);
    if (cls === "major") lines.push(`- Major spills also need incident command (SOP §3).`);
    cites.push(h.citation, vd.citation);
  } else if (cls === "moderate") {
    const hse = R("hse_notice_hours");
    lines.push(`- No external report. Record it, clean up, and **notify HSE within ${hse.value} hours**.`);
    cites.push(hse.citation);
  } else lines.push(`- No external report. Record it and clean up (SR-04).`);
  const c2 = R("sr02_contain_hours");
  lines.push(`- **SR-02:** stop the source and contain the spill within **${c2.value} hours** of discovery.`);
  lines.push(`- **SR-04:** record the spill against the well with its volume and affected area.`);
  const pad = R("pad_shutin_pct", a.well_type ?? "T200");
  lines.push(`- If it covers more than **${pad.value}% of the pad**, shut the well in immediately until the source is repaired (well manual, ${pad.source}).${a.pad_pct !== undefined ? ` At ${a.pad_pct}% that ${a.pad_pct > pad.value ? "**applies**" : "does not apply"}.` : ""}`);
  cites.push(c2.citation, pad.citation);
  return { tool: "spill_rules", text: lines.join("\n"), facts: { class: cls }, visuals: {}, defaultVisual: null, citations: uniqCites(cites), entities: [] };
}

// ---------------------------------------------------------------------------------------------
const SQL_TABLES = ["areas", "teams", "users", "wells", "equipment", "inspections", "maintenance", "reports", "report_checks", "reg_events", "notes", "rules", "corrections", "shared_facts", "rule_overrides"];
export function run_sql(a: { sql: string }): ToolResult {
  const sql = a.sql.trim().replace(/;+\s*$/, "");
  if (!/^(select|with)\b/i.test(sql) || /;|\b(insert|update|delete|drop|alter|attach|pragma|create|replace)\b/i.test(sql)) throw new Error("Only a single read-only SELECT is allowed");
  const stmt = d().prepare(sql);
  if (!stmt.reader) throw new Error("not a query");
  const rows = (stmt.all() as any[]).slice(0, 200);
  const cols = rows[0] ? Object.keys(rows[0]) : [];
  return {
    tool: "run_sql", text: `Query returned ${rows.length} row(s).\n` + rows.slice(0, 15).map((r) => "- " + cols.map((k) => `${k}: ${r[k]}`).join(", ")).join("\n"),
    facts: rows.slice(0, 50), visuals: { table: { type: "table", title: "Query result", columns: cols.map((k) => ({ key: k, label: k })), rows } },
    defaultVisual: rows.length > 1 ? "table" : null, citations: [c("sql", "query", sql.slice(0, 200))], entities: [],
  };
}
export const SQL_SCHEMA_HINT = `Tables: ${SQL_TABLES.join(", ")}. inspections(inspection_id, asset_id, inspected_at ISO, ambient_temp_c, wellhead_temp_c, spill_detected 0/1, spill_area_pct, spill_est_volume_bbl, notes). maintenance(maintenance_id, asset_id, started_at, completed_at, maintenance_type, equipment_kind, issue, cost_total, triggered_by_inspection_id). wells(asset_id, well_type, area_id, lat, lon, installed_on, recorded_status). reg_events(event_id, asset_id, date, event_type, protocol_id, related_inspection_id, hours_to_report, fine_usd, status). Raw tables do NOT apply corrections; prefer the other tools.`;

export const TOOLS = { well_status, wells_not_producing, temperature_series, spills, spill_heatmap, downtime, compliance, rca_candidates, repairs, regulatory_events, well_list, spill_rules, search_docs, run_sql };
export type ToolName = keyof typeof TOOLS;
