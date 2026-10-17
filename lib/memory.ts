// Two levels of memory:
//  - shared: corrections, shared facts and rule overrides, visible to every user;
//  - private: each user's conversations and the wells each answer was about.
import { db } from "./db";
import {
  today, userName, well, normWell, effInspections, rule, spillClass, factsFor, notesFor, type Citation,
} from "./domain";
import { addDays, fmtDate as D } from "./period";
import { compliance } from "./tools";

const now = () => new Date().toISOString();
const f1 = (n: number) => (Math.round(n * 10) / 10).toFixed(1);

// ---------------------------------------------------------------------------------------------
// Conversations (private per user)
export function newConversation(userId: string, title = "New chat", createdAt = now()) {
  const r = db().prepare(`INSERT INTO conversations (user_id, title, created_at) VALUES (?,?,?)`).run(userId, title, createdAt);
  return Number(r.lastInsertRowid);
}
export const listConversations = (userId: string) =>
  db().prepare(`SELECT * FROM conversations WHERE user_id=? ORDER BY id DESC`).all(userId) as any[];
export const conversation = (id: number) => db().prepare(`SELECT * FROM conversations WHERE id=?`).get(id) as any;
export const messages = (convId: number) =>
  (db().prepare(`SELECT m.*, r.rating FROM messages m LEFT JOIN answer_ratings r ON r.message_id = m.id WHERE m.conversation_id=? ORDER BY m.id`).all(convId) as any[])
    .map((m) => ({ ...m, payload: m.payload ? JSON.parse(m.payload) : null }));

export function addMessage(convId: number, role: "user" | "assistant", content: string, payload?: any, createdAt = now()) {
  const r = db().prepare(`INSERT INTO messages (conversation_id, role, content, payload, created_at) VALUES (?,?,?,?,?)`)
    .run(convId, role, content, payload ? JSON.stringify(payload) : null, createdAt);
  const c = conversation(convId);
  if (role === "user" && c?.title === "New chat") db().prepare(`UPDATE conversations SET title=? WHERE id=?`).run(content.slice(0, 60), convId);
  return Number(r.lastInsertRowid);
}

/** 👍 / 👎 on an answer. Only the owner of the conversation can rate it; a new rating replaces the old one. */
export function rateAnswer(messageId: number, userId: string, rating: 1 | -1, comment?: string) {
  const m = db().prepare(`SELECT m.id FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id=? AND c.user_id=? AND m.role='assistant'`).get(messageId, userId);
  if (!m) return false;
  db().prepare(`DELETE FROM answer_ratings WHERE message_id=? AND user_id=?`).run(messageId, userId);
  db().prepare(`INSERT INTO answer_ratings (message_id, user_id, rating, comment, created_at) VALUES (?,?,?,?,?)`).run(messageId, userId, rating, comment ?? null, now());
  return true;
}

export function recordEntities(convId: number, userId: string, wells: string[], createdAt = now()) {
  const ins = db().prepare(`INSERT INTO conversation_entities VALUES (?,?,?,?,?,?)`);
  wells.forEach((w, i) => ins.run(convId, userId, "well", w, i, createdAt));
}

/** Wells from this user's earlier conversations ("the three wells we discussed yesterday"). */
export function recallWells(userId: string, _currentConvId: number | null, opts: { count?: number; yesterday?: boolean } = {}) {
  const rows = db().prepare(`SELECT ce.*, c.title FROM conversation_entities ce JOIN conversations c ON c.id = ce.conversation_id
    WHERE ce.user_id=? ORDER BY ce.created_at DESC, ce.rank`).all(userId) as any[];
  if (!rows.length) return null;
  // Group by answer (same created_at = same answer), newest first; prefer one with the requested count.
  const answers = new Map<string, any[]>();
  for (const r of rows) answers.set(`${r.conversation_id}|${r.created_at}`, [...(answers.get(`${r.conversation_id}|${r.created_at}`) ?? []), r]);
  const list = [...answers.values()];
  // "the three wells" must match an answer about three wells; never substitute a different set.
  const pick = opts.count ? list.find((a) => a.length === opts.count) : list[0];
  if (!pick) return { wells: null, mentioned: [...new Set(rows.map((r) => r.entity_id))].slice(0, 10) };
  return { wells: pick.sort((a, b) => a.rank - b.rank).map((r) => r.entity_id) as string[], conversation_id: pick[0].conversation_id, title: pick[0].title, at: pick[0].created_at as string };
}

// ---------------------------------------------------------------------------------------------
// Feedback parsing (deterministic first; the agent may pass model-extracted fields instead)
export type Feedback =
  | { kind: "raw_correction" | "analysis_correction"; asset_id: string; date?: string; inspection_id?: string; field: string; value: number; reason: string }
  | { kind: "rule_override"; rule_key: string; scope_type: "well_type" | "well"; scope_value: string; value: number; qualifier?: string; reason: string }
  | { kind: "shared_fact"; asset_id: string; fact_kind: "planned_downtime" | "info"; text: string; valid_from?: string; valid_to?: string; claimed_producing?: boolean }
  | { kind: "status_claim"; asset_id: string; claimed_producing: boolean; since?: string; text: string };

const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };

export function parseDates(text: string): string[] {
  const out: string[] = [];
  const y = today().slice(0, 4);
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) out.push(`${m[1]}-${m[2]}-${m[3]}`);
  for (const m of text.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s+(\d{4}))?/gi))
    out.push(`${m[3] ?? y}-${MONTHS[m[2].toLowerCase()]}-${m[1].padStart(2, "0")}`);
  for (const m of text.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?/gi))
    out.push(`${m[3] ?? y}-${MONTHS[m[1].toLowerCase()]}-${m[2].padStart(2, "0")}`);
  return out;
}

const EQUIP: [RegExp, string][] = [[/pump ?jack/i, "pump_jack"], [/flow ?line/i, "flowline"], [/rod string|sucker rod/i, "rod_string"], [/downhole pump/i, "downhole_pump"], [/well ?head|stuffing box/i, "wellhead"], [/separator/i, "separator"]];

export function looksLikeFeedback(msg: string) {
  const t = msg.trim();
  if (/\?\s*$/.test(t) || /^(is|are|was|were|which|what|when|who|how|show|list|give|do|does|did|can|could|why|where)\b/i.test(t)) return false;
  return /\b(wrong|faulty|incorrect|mistake|correct(ed|ion)?|re-?measured|actually|measured|not a spill|was (water|rain|mud)|note for|from now on|our team|fyi|for everyone|shut in|shut-in|workover|planned|running fine|back online|is down|is running|is producing|not producing|down for)\b/i.test(t);
}

export function parseFeedback(msg: string): Feedback | null {
  const t = msg.replace(/\s+/g, " ").trim();
  const wid = t.match(/WELL[- ]?(\d{1,4})/i);
  const asset_id = wid ? normWell(wid[1]) : null;
  const dates = parseDates(t);

  // Rule for a whole well type: "Note for all T350 wells: ... after 2 repairs, not 3."
  const typeScope = t.match(/\b(?:all|every|each)\s+(T\d{3})\b/i) ?? t.match(/\b(T\d{3})\s+wells\b/i);
  if (typeScope && /(rule|from now on|now wants|should|after \d+|threshold|limit|instead|not \d+)/i.test(t)) {
    const wt = typeScope[1].toUpperCase();
    let rule_key = "", value = NaN, qualifier: string | undefined;
    if (/root[- ]cause|rca/i.test(t)) {
      rule_key = "rca_count";
      value = Number(t.match(/after (\d+)\s*(?:corrective )?(?:repairs?|events?|failures?)/i)?.[1] ?? t.match(/(\d+) (?:corrective )?repairs?/i)?.[1]);
      qualifier = EQUIP.find(([re]) => re.test(t))?.[1];
    } else if (/producing|production|°c|degrees|above (air|ambient)/i.test(t)) {
      rule_key = "producing_delta_c";
      value = Number(t.match(/(\d+(?:\.\d+)?)\s*(?:°\s*c|degrees|c\b)/i)?.[1]);
    }
    if (rule_key && Number.isFinite(value)) return { kind: "rule_override", rule_key, scope_type: "well_type", scope_value: wt, value, qualifier, reason: t };
  }
  if (!asset_id) return null;

  // Correction of the AI's spill estimate or a spill detection.
  const bbls = [...t.matchAll(/(\d+(?:\.\d+)?)\s*(?:bbl|barrels?)/gi)].map((m) => ({ v: Number(m[1]), i: m.index ?? 0 }));
  if (bbls.length) {
    const notX = t.match(/not (\d+(?:\.\d+)?)\s*(?:bbl|barrels?)/i);
    const meas = t.match(/(?:measured|actual(?:ly)?|really|real volume|was|is)\s*(?:about\s*)?(\d+(?:\.\d+)?)\s*(?:bbl|barrels?)/gi);
    let value = bbls[bbls.length - 1].v;
    if (notX) value = bbls.find((b) => b.v !== Number(notX[1]))?.v ?? value;
    else if (meas) { const last = meas[meas.length - 1].match(/(\d+(?:\.\d+)?)/); if (last) value = Number(last[1]); }
    if (/(estimat|ai|wrong|measured|actual|not \d)/i.test(t))
      return { kind: "analysis_correction", asset_id, date: dates[0], field: "spill_est_volume_bbl", value, reason: t };
  }
  if (/(not (a |an )?(real )?(crude )?(spill|oil)|was (just )?(water|rain|mud|a puddle|a shadow)|false (alarm|positive))/i.test(t))
    return { kind: "analysis_correction", asset_id, date: dates[0], field: "spill_detected", value: 0, reason: t };

  // Correction of a raw reading.
  const temp = t.match(/(?:re-?measured|real value|actual(?:ly)?|correct(?:ed)? (?:value|reading)|should be|was really|is really|reads?)[^.]*?(-?\d+(?:\.\d+)?)\s*°?\s*c\b/i)
    ?? (/(wrong|faulty|incorrect|error)/i.test(t) ? t.match(/(-?\d+(?:\.\d+)?)\s*°\s*c\b/i) : null);
  if (temp && /(reading|thermal|temperature|wellhead|air|ambient|°)/i.test(t)) {
    const field = /(air|ambient)[^.]*?\d+(?:\.\d+)?\s*°/i.test(t) && !/wellhead/i.test(t) ? "ambient_temp_c" : "wellhead_temp_c";
    return { kind: "raw_correction", asset_id, date: dates[0], field, value: Number(temp[1]), reason: t };
  }

  // Planned downtime shared with everyone.
  if (/(shut[- ]?in|workover|planned|maintenance|down for)/i.test(t)) {
    const days = Number(t.match(/(\d+)[- ]day/i)?.[1] ?? NaN);
    const from = dates[0] ?? today();
    const to = dates[1] ?? (Number.isFinite(days) ? addDays(from, days) : undefined);
    return { kind: "shared_fact", asset_id, fact_kind: "planned_downtime", text: t, valid_from: from, valid_to: to, claimed_producing: from <= today() ? false : undefined };
  }
  if (/(running fine|back online|is producing|is running|is up|working (fine|again|normally)|producing again|online)/i.test(t))
    return { kind: "status_claim", asset_id, claimed_producing: true, since: dates[0], text: t };
  if (/(is down|not producing|stopped|is shut|offline)/i.test(t))
    return { kind: "status_claim", asset_id, claimed_producing: false, since: dates[0], text: t };
  if (/(fyi|for everyone|note:|heads up)/i.test(t))
    return { kind: "shared_fact", asset_id, fact_kind: "info", text: t, valid_from: dates[0] ?? today() };
  return null;
}

function findInspection(assetId: string, date?: string, inspectionId?: string, preferSpill = false) {
  if (inspectionId) return db().prepare(`SELECT * FROM inspections WHERE inspection_id=?`).get(inspectionId) as any;
  if (date) {
    const rows = db().prepare(`SELECT * FROM inspections WHERE asset_id=? AND substr(inspected_at,1,10) BETWEEN ? AND ? ORDER BY ${preferSpill ? "spill_detected DESC," : ""} abs(julianday(substr(inspected_at,1,10)) - julianday(?))`)
      .all(assetId, addDays(date, -3), addDays(date, 3), date) as any[];
    return rows[0];
  }
  return db().prepare(`SELECT * FROM inspections WHERE asset_id=? ${preferSpill ? "AND spill_detected=1" : ""} ORDER BY inspected_at DESC LIMIT 1`).get(assetId) as any;
}

// ---------------------------------------------------------------------------------------------
// Apply feedback, checking it against the data and other people's statements first.
export type FeedbackResult = { text: string; citations: Citation[]; entities: string[]; needsConfirmation: boolean };

export function applyFeedback(input: Feedback, userId: string): FeedbackResult {
  let fb: Feedback = input;
  const who = userName(userId);
  const cites: Citation[] = [];
  const lines: string[] = [];
  const t = today();

  if (fb.kind === "rule_override") {
    const before = rule(fb.rule_key, fb.scope_value, undefined, fb.qualifier);
    const r = db().prepare(`INSERT INTO rule_overrides (rule_key, scope_type, scope_value, value, qualifier, author_user_id, reason, created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(fb.rule_key, fb.scope_type, fb.scope_value, fb.value, fb.qualifier ?? null, userId, fb.reason, now());
    const scope = `${fb.scope_type === "well_type" ? `all ${fb.scope_value} wells` : fb.scope_value}${fb.qualifier ? ` (${fb.qualifier.replace("_", " ")} only)` : ""}`;
    lines.push(`Recorded ${who}'s team rule for **${scope}**: ${fb.rule_key.replace(/_/g, " ")} = **${fb.value}** (was ${before.value} from ${before.source}).`);
    lines.push(`It applies only to ${scope}; other wells keep the manual's rule. Every later answer, for every user, will say when it uses this rule.`);
    cites.push({ type: "rule_override", id: `OVR-${r.lastInsertRowid}`, label: fb.reason }, before.citation);
    return { text: lines.join("\n"), citations: cites, entities: [], needsConfirmation: false };
  }

  const w = well(fb.asset_id);
  if (!w) return { text: `I couldn't find well ${fb.asset_id}.`, citations: [], entities: [], needsConfirmation: false };

  if (fb.kind === "raw_correction" || fb.kind === "analysis_correction") {
    const isSpill = fb.field !== "wellhead_temp_c" && fb.field !== "ambient_temp_c";
    const insp = findInspection(fb.asset_id, fb.date, fb.inspection_id, isSpill);
    if (!insp) return { text: `I couldn't find an inspection of ${fb.asset_id}${fb.date ? ` around ${D(fb.date)}` : ""} to correct. Which inspection do you mean?`, citations: [], entities: [fb.asset_id], needsConfirmation: true };
    const original = insp[fb.field === "spill_detected" ? "spill_detected" : fb.field];
    const conflicts: string[] = [];
    const prev = db().prepare(`SELECT * FROM corrections WHERE inspection_id=? AND field=? AND status='accepted' ORDER BY id DESC LIMIT 1`).get(insp.inspection_id, fb.field) as any;
    if (prev && prev.new_value !== fb.value) conflicts.push(`${userName(prev.author_user_id)} earlier corrected ${fb.field} to ${prev.new_value} (${prev.source})`);

    // What the corrected value means.
    if (!isSpill) {
      const wh = fb.field === "wellhead_temp_c" ? fb.value : insp.wellhead_temp_c;
      const amb = fb.field === "ambient_temp_c" ? fb.value : insp.ambient_temp_c;
      const thr = rule("producing_delta_c", w.well_type, w.asset_id);
      const producing = wh - amb >= thr.value;
      const wasProducing = insp.wellhead_temp_c - insp.ambient_temp_c >= thr.value;
      if (producing && insp.notes && /not moving|no stroke|stopped|not running|idle|cold/i.test(insp.notes))
        conflicts.push(`the inspector's remark on ${insp.inspection_id} says "${insp.notes}" (${userName(insp.inspector_user_id)}), which suggests the well was not producing`);
      if (!producing && insp.notes && /running|stroking|normal/i.test(insp.notes)) conflicts.push(`the inspector's remark says "${insp.notes}"`);
      const r = db().prepare(`INSERT INTO corrections (inspection_id, asset_id, field, original_value, new_value, author_user_id, reason, source, status, conflicts, created_at) VALUES (?,?,?,?,?,?,?,'chat','accepted',?,?)`)
        .run(insp.inspection_id, w.asset_id, fb.field, original, fb.value, userId, fb.reason, conflicts.length ? JSON.stringify(conflicts) : null, now());
      lines.push(`Recorded ${who}'s correction to **${insp.inspection_id}** (${w.asset_id}, ${D(insp.inspected_at.slice(0, 10))}): ${fb.field === "wellhead_temp_c" ? "wellhead" : "air"} temperature **${f1(fb.value)} °C** (original ${f1(original)} °C kept for reference).`);
      lines.push(`With ${f1(wh)} °C against ${f1(amb)} °C air (${f1(wh - amb)} °C warmer, ${producing ? "above" : "below"} the ${w.well_type} limit of ${thr.value} °C), ${w.asset_id} **${producing ? "is" : "is not"} producing oil** at that inspection${producing !== wasProducing ? ` — this reverses the earlier result` : ""}.`);
      cites.push({ type: "correction", id: `CORR-${r.lastInsertRowid}`, label: fb.reason, asset_id: w.asset_id }, { type: "inspection", id: insp.inspection_id, asset_id: w.asset_id }, thr.citation);
    } else {
      const r = db().prepare(`INSERT INTO corrections (inspection_id, asset_id, field, original_value, new_value, author_user_id, reason, source, status, conflicts, created_at) VALUES (?,?,?,?,?,?,?,'chat','accepted',?,?)`)
        .run(insp.inspection_id, w.asset_id, fb.field, original, fb.value, userId, fb.reason, conflicts.length ? JSON.stringify(conflicts) : null, now());
      cites.push({ type: "correction", id: `CORR-${r.lastInsertRowid}`, label: fb.reason, asset_id: w.asset_id }, { type: "inspection", id: insp.inspection_id, asset_id: w.asset_id });
      if (fb.field === "spill_detected") {
        lines.push(`Recorded ${who}'s correction: the detection at **${insp.inspection_id}** (${w.asset_id}, ${D(insp.inspected_at.slice(0, 10))}) is **not a real spill**. The original detection (${f1(insp.spill_est_volume_bbl ?? 0)} bbl) is kept for reference and excluded from spill counts from now on.`);
        const supporting = notesFor(w.asset_id).filter((n) => n.text.includes(insp.inspection_id) && /crude|real|stands/i.test(n.text));
        for (const n of supporting) conflicts.push(`${n.note_id} (${userName(n.author_user_id)}) says "${n.text}"`);
        if (db().prepare(`SELECT 1 FROM maintenance WHERE triggered_by_inspection_id=?`).get(insp.inspection_id)) conflicts.push(`a spill repair was logged for this inspection`);
      } else {
        const oldClass = spillClass(insp.spill_est_volume_bbl ?? 0);
        const newClass = spillClass(fb.value);
        lines.push(`Recorded ${who}'s correction to the spill at **${insp.inspection_id}** (${w.asset_id}, ${D(insp.inspected_at.slice(0, 10))} ${insp.inspected_at.slice(11, 16)} UTC): **${f1(fb.value)} bbl** measured by the field crew. The AI estimate of ${f1(insp.spill_est_volume_bbl ?? 0)} bbl is kept for reference.`);
        lines.push(`Class: ${oldClass} → **${newClass}** (Spill Response SOP §3).`);
        if (newClass !== oldClass) {
          const audit = compliance({ asset_id: w.asset_id, from: insp.inspected_at.slice(0, 10), to: t });
          const rel = audit.text.split("\n").filter((l) => l.includes(insp.inspection_id) || l.includes("classed the spill"));
          if (rel.length) lines.push(`What changes:`, ...rel);
          cites.push(...audit.citations.filter((c) => c.asset_id === w.asset_id).slice(0, 8));
        }
      }
      if (conflicts.length) db().prepare(`UPDATE corrections SET conflicts=? WHERE id=?`).run(JSON.stringify(conflicts), Number(r.lastInsertRowid));
    }
    if (conflicts.length) {
      lines.push(`\n⚠ **This disagrees with other evidence:**`, ...conflicts.map((x) => `- ${x}`));
      lines.push(`I've applied the correction for everyone and kept both on record. ${who}, can you confirm?`);
    }
    lines.push(`\nThis correction is shared: every user's later answers will use it and say who corrected it.`);
    return { text: lines.join("\n"), citations: cites, entities: [w.asset_id], needsConfirmation: conflicts.length > 0 };
  }

  // Shared facts and status claims are checked against the latest inspection and other people's notes.
  fb = fb as Extract<Feedback, { kind: "shared_fact" | "status_claim" }>;
  const [latest] = effInspections({ asset_ids: [w.asset_id], latestOnly: true });
  const claimed = fb.kind === "status_claim" ? fb.claimed_producing : fb.claimed_producing;
  const since = fb.kind === "status_claim" ? fb.since : fb.valid_from;
  const conflicts: string[] = [];
  const support: string[] = [];
  cites.push({ type: "inspection", id: latest.inspection_id, asset_id: w.asset_id });
  if (claimed !== undefined && (!since || since <= latest.date)) {
    const ev = `the ${D(latest.date)} inspection ${latest.inspection_id} (by ${latest.inspector}) shows the wellhead ${f1(latest.delta)} °C above air, so the well ${latest.producing ? "was" : "was not"} producing oil (${w.well_type} limit ${latest.threshold} °C)`;
    (claimed === latest.producing ? support : conflicts).push(ev);
  }
  // Includes the author's own earlier notes: people contradict themselves too.
  const others = [...notesFor(w.asset_id, t), ...factsFor(w.asset_id, t)];
  for (const n of others) {
    const ref = n.note_id ?? `shared note #${n.id}`;
    const saysUp = /\b(is|are|now|was)\s+(back online|running fine|producing|running|online)\b/i.test(n.text);
    const saysDown = !saysUp && /shut[- ]?in|workover|not producing|stopped|replacement|is down|waiting on/i.test(n.text);
    const expectedBack = n.text.match(/back(?: online)? (?:around|by|on) (\d{1,2} \w{3}|\w{3} \d{1,2})/i);
    if (claimed === true && saysDown) conflicts.push(`${ref} by ${userName(n.author_user_id)} says "${n.text}"${expectedBack ? ` — it expects a return around ${expectedBack[1]}` : ""}`);
    else if (claimed === false && saysUp) conflicts.push(`${ref} by ${userName(n.author_user_id)} says "${n.text}"`);
    else if (claimed === false && saysDown) support.push(`${ref} by ${userName(n.author_user_id)}: "${n.text}"`);
    else if (claimed === true && saysUp) support.push(`${ref} by ${userName(n.author_user_id)}: "${n.text}"`);
    cites.push(n.note_id ? { type: "note", id: n.note_id, label: n.text, asset_id: w.asset_id } : { type: "shared_fact", id: `FACT-${n.id}`, label: n.text, asset_id: w.asset_id });
  }
  const status = conflicts.length ? "unconfirmed" : "accepted";
  const kind = fb.kind === "status_claim" ? "status_claim" : fb.fact_kind;
  const text = fb.text;
  const r = db().prepare(`INSERT INTO shared_facts (asset_id, kind, text, claimed_producing, valid_from, valid_to, author_user_id, status, conflicts, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(w.asset_id, kind, text, claimed === undefined ? null : claimed ? 1 : 0, fb.kind === "status_claim" ? (fb.since ?? t) : fb.valid_from ?? t,
      fb.kind === "status_claim" ? null : fb.valid_to ?? null, userId, status, conflicts.length ? JSON.stringify(conflicts) : null, now());
  cites.unshift({ type: "shared_fact", id: `FACT-${r.lastInsertRowid}`, label: text, asset_id: w.asset_id });
  if (status === "accepted") {
    lines.push(`Noted for everyone: **${w.asset_id}** — "${text}" (${who}${fb.kind === "shared_fact" && fb.valid_from ? `, from ${D(fb.valid_from)}${fb.valid_to ? ` to about ${D(fb.valid_to)}` : ""}` : ""}). Other users asking about ${w.asset_id} will see it.`);
    if (support.length) lines.push(`This matches the data:`, ...support.map((s) => `- ${s}`));
  } else {
    lines.push(`⚠ **I can't confirm that.** ${who} says: "${text}", but:`);
    lines.push(...conflicts.map((x) => `- ${x}`));
    if (support.length) lines.push(`Supporting the claim:`, ...support.map((s) => `- ${s}`));
    lines.push(`I've kept your statement on record as **unconfirmed** next to the other evidence, without changing the well's status. Can you confirm, for example with a new inspection or a work-order number?`);
  }
  return { text: lines.join("\n"), citations: cites, entities: [w.asset_id], needsConfirmation: status !== "accepted" };
}
