// The copilot turn: memory → feedback or routing → deterministic tool → visual + citations.
// The model only routes (picks a tool and arguments), extracts feedback it can't parse, and
// writes answers for open questions over documents. Numbers always come from the tools.
import { TOOLS, SQL_SCHEMA_HINT, type ToolName } from "./tools";
import { today, userName, resolveUser, areas, normWell, resolveArea, type Citation } from "./domain";
import { chatJSON, chatText, llmEnabled } from "./llm";
import { extractEntities, heuristicRoute, type Route } from "./router";
import { addMessage, newConversation, recordEntities, recallWells, looksLikeFeedback, parseFeedback, applyFeedback, type Feedback } from "./memory";
import { pickVisual, detectRequestedVisual, allVisuals, type Visual, type VisualType, type ToolResult } from "./visual";
import { followups } from "./followups";
import { db } from "./db";
import { fmtDate, parsePeriod } from "./period";

export type Answer = {
  conversationId: number; messageId?: number; text: string; visual: Visual | null; citations: Citation[];
  visuals?: Partial<Record<VisualType, Visual>>;   // every view of the same data, for the switch buttons
  followups?: string[];
  tool?: string; args?: any; router?: string; needsConfirmation?: boolean;
};

const ROUTER = (process.env.COPILOT_ROUTER ?? "hybrid").toLowerCase(); // hybrid | llm | heuristic

const TOOL_DOCS = `Tools (pick exactly one). Well selection args (any tool): asset_id "WELL-0001" | asset_ids [..] | area "<area name>" | team_id | well_type "T200"|"T350".
Period args: period as plain English ("last 4 months", "2025", "this year", "last 90 days", "this summer", "June 2026") or from/to YYYY-MM-DD.
- well_status {asset_id}: is ONE well producing now, latest inspection, why it is down, open repairs, planned downtime, notes.
- wells_not_producing {area|well_type|team_id}: which wells are NOT producing oil right now and why.
- temperature_series {asset_id, period|weeks}: wellhead vs air temperature over time for one well.
- spills {selection, period, reportable_only?, min_bbl?}: real oil spills (corrections applied), volumes, reporting status, locations.
- spill_heatmap {period, group_by "area"|"well_type"|"well"}: spill counts by group x month.
- downtime {selection, period, top_n?}: days not producing (7 per not-producing weekly inspection), ranking, causes.
- compliance {selection, period, protocol? e.g. "SR-01","SR-02","RC-04", status? "breach"}: rules broken / pending SOP duties (reporting, containment, clean-up, notices, inspections, RCA).
- rca_candidates {selection, equipment_kind? pump_jack|flowline|rod_string|downhole_pump|wellhead|separator}: wells needing a root-cause analysis.
- repairs {selection, period, equipment_kind?, maintenance_type? corrective|scheduled, group_by? "issue"|"equipment"}: repair jobs and their cost; group_by for "which problems happen most".
- regulatory_events {selection, period, status? open|closed, event_type?}: regulator reports, notices, fines, site visits.
- well_list {selection, status? producing|not_producing}: list wells with type, area, location.
- spill_rules {volume_bbl, pad_pct?}: what the SOPs require for a spill of a given size (class, deadlines).
- search_docs {query}: search manuals, SOPs, repair reports and notes for rules or free-text facts.
- run_sql {sql}: last resort read-only SQLite SELECT. ${SQL_SCHEMA_HINT}`;

async function llmRoute(q: string, userId: string, ent: ReturnType<typeof extractEntities>): Promise<Route | null> {
  const u = resolveUser(userId);
  const sys = `You route questions about an oil field to one data tool. Today is ${today()}. The user is ${u?.name} (${u?.role}, team ${u?.team_id}).
Areas: ${areas().map((a) => `"${a.name}" (${a.area_id}, team ${a.team_id})`).join("; ")}.
${TOOL_DOCS}
Reply with JSON only: {"tool": "<name>", "args": {...}}. Use the user's exact period words. Do not answer the question.
Examples:
Q: Where did oil leak in Southwest Block 23 this year? Plot it. -> {"tool":"spills","args":{"area":"Southwest Block 23","period":"this year"}}
Q: Was WELL-0042 late filing its spill report? -> {"tool":"compliance","args":{"asset_id":"WELL-0042","protocol":"SR-01"}}
Q: Which leaks took too long to contain last month? -> {"tool":"compliance","args":{"period":"last 1 month","protocol":"SR-02","status":"breach"}}
Q: Rank the T350 wells by days offline since June -> {"tool":"downtime","args":{"well_type":"T350","period":"June 2026 to today"}}
Q: How much did we spend fixing flowlines in 2025? -> {"tool":"repairs","args":{"equipment_kind":"flowline","period":"2025"}}
Q: What does the SOP say about soil samples? -> {"tool":"search_docs","args":{"query":"soil samples TPH"}}`;
  const hint = `Detected: ${JSON.stringify({ wells: ent.asset_ids, area: ent.area, team_id: ent.team_id, well_type: ent.well_type, period: ent.period, top_n: ent.top_n })}`;
  const out = await chatJSON<{ tool: string; args?: any }>(sys, `Question: ${q}\n${hint}`);
  if (!out?.tool || !(out.tool in TOOLS)) return null;
  return { tool: out.tool as ToolName, args: out.args ?? {}, confident: true };
}

const SEL = ["asset_id", "asset_ids", "area", "team_id", "well_type"];
const PER = ["period", "from", "to"];
const ALLOWED: Record<string, string[]> = {
  well_status: ["asset_id"],
  wells_not_producing: SEL,
  temperature_series: ["asset_id", ...PER, "weeks"],
  spills: [...SEL, ...PER, "reportable_only", "min_bbl"],
  spill_heatmap: [...SEL, ...PER, "group_by"],
  downtime: [...SEL, ...PER, "top_n"],
  compliance: [...SEL, ...PER, "protocol", "status"],
  rca_candidates: [...SEL, "equipment_kind"],
  repairs: [...SEL, ...PER, "equipment_kind", "maintenance_type", "group_by"],
  regulatory_events: [...SEL, ...PER, "status", "event_type"],
  well_list: [...SEL, "status"],
  spill_rules: ["volume_bbl", "pad_pct", "well_type"],
  search_docs: ["query", "asset_id", "kind"],
  run_sql: ["sql"],
};

/** Validate model arguments. Values read straight from the question's text win over the model's. */
function cleanArgs(route: Route, ent: ReturnType<typeof extractEntities>, q: string, forcedWells?: string[], fromModel = false): Route {
  const allowed = ALLOWED[route.tool] ?? [];
  const a: Record<string, any> = Object.fromEntries(Object.entries(route.args ?? {}).filter(([k, v]) => allowed.includes(k) && v !== null && v !== "" && !(Array.isArray(v) && !v.length)));
  if (a.asset_id) a.asset_id = normWell(a.asset_id) ?? undefined;
  if (Array.isArray(a.asset_ids)) a.asset_ids = a.asset_ids.map(normWell).filter(Boolean);
  if (a.area && !resolveArea(a.area)) delete a.area;
  if (a.well_type && !/^T\d{3}$/i.test(a.well_type)) delete a.well_type;
  if (a.period && !parsePeriod(a.period, today())) delete a.period;
  for (const k of ["from", "to"]) if (a[k] && !/^\d{4}-\d{2}-\d{2}$/.test(a[k])) delete a[k];
  if (fromModel && a.reportable_only && !/report/i.test(q)) delete a.reportable_only;
  if (fromModel && a.status === "breach" && !/broken|break|breach|violat|not contained|n't contained|overdue|late/i.test(q)) delete a.status;
  if (fromModel && a.protocol && !new RegExp(a.protocol.replace(/-0?/, "-?0?"), "i").test(q) && !(a.protocol === "SR-02" && /contain/i.test(q))) delete a.protocol;

  const has = (k: string) => allowed.includes(k);
  if (forcedWells?.length) { for (const k of SEL) delete a[k]; if (has("asset_ids")) a.asset_ids = forcedWells; else a.asset_id = forcedWells[0]; }
  else if (ent.asset_ids.length || ent.area || ent.team_id) {
    for (const k of ["asset_id", "asset_ids", "area", "team_id"]) delete a[k];
    if (ent.asset_ids.length === 1 || !has("asset_ids")) { if (ent.asset_ids[0]) a.asset_id = ent.asset_ids[0]; }
    else if (ent.asset_ids.length > 1) a.asset_ids = ent.asset_ids;
    if (ent.area && has("area")) a.area = ent.area;
    if (ent.team_id && has("team_id")) a.team_id = ent.team_id;
  }
  if (ent.well_type && has("well_type")) a.well_type = ent.well_type;
  if (ent.period && has("period")) { a.period = ent.period; delete a.from; delete a.to; }
  if (ent.top_n && has("top_n")) a.top_n = ent.top_n;
  if (ent.equipment_kind && has("equipment_kind")) a.equipment_kind = ent.equipment_kind;
  if (ent.protocol && has("protocol")) a.protocol = ent.protocol;
  if (route.tool === "search_docs" && !a.query) a.query = q;
  return { ...route, args: a };
}

const FEEDBACK_SYS = `Extract structured feedback about oil wells. Reply JSON only, one of:
{"kind":"raw_correction","asset_id":"WELL-0001","date":"YYYY-MM-DD","field":"wellhead_temp_c"|"ambient_temp_c","value":41.0}
{"kind":"analysis_correction","asset_id":"WELL-0001","date":"YYYY-MM-DD","field":"spill_est_volume_bbl","value":5.4}  (or field "spill_detected", value 0 for "not a spill")
{"kind":"rule_override","rule_key":"rca_count"|"producing_delta_c","scope_type":"well_type","scope_value":"T350","value":2,"qualifier":"pump_jack"|null}
{"kind":"shared_fact","asset_id":"WELL-0007","fact_kind":"planned_downtime"|"info","valid_from":"YYYY-MM-DD","valid_to":"YYYY-MM-DD"|null}
{"kind":"status_claim","asset_id":"WELL-0001","claimed_producing":true|false,"since":"YYYY-MM-DD"|null}
{"kind":"none"} if it is not feedback.`;

async function extractFeedback(q: string): Promise<Feedback | null> {
  const det = parseFeedback(q);
  if (det) return det;
  const out = await chatJSON<any>(`${FEEDBACK_SYS}\nToday is ${today()}.`, q);
  if (!out || !out.kind || out.kind === "none") return null;
  if (out.asset_id) out.asset_id = normWell(out.asset_id);
  if (out.kind !== "rule_override" && !out.asset_id) return null;
  return { ...out, reason: q, text: q } as Feedback;
}

async function compose(q: string, r: ToolResult) {
  let ctx = r.text;
  if (r.tool === "search_docs") {
    // The matching sections (not whole documents) plus the extracted rule values, so a small
    // model has the exact numbers in front of it.
    const secs = r.citations.filter((c) => c.type === "doc").slice(0, 3).map((c) => {
      const section = (c.label ?? "").split(" — ").pop() ?? "";
      const ch = db().prepare(`SELECT text FROM doc_chunks WHERE doc_id=? AND section=?`).get(c.id, section) as any;
      return ch ? `[${c.id} § ${section}]\n${ch.text.slice(0, 1800)}` : "";
    }).filter(Boolean);
    const rules = (db().prepare(`SELECT rule_key, scope_value, value, unit, source_doc, source_section FROM rules`).all() as any[])
      .map((x) => `${x.rule_key}${x.scope_value !== "*" ? ` (${x.scope_value})` : ""} = ${x.value} ${x.unit} [${x.source_doc} § ${x.source_section}]`).join("\n");
    ctx = `${secs.join("\n\n")}\n\nExtracted rule values:\n${rules}`;
  }
  const out = await chatText(`You answer an oil-field operator's question using ONLY the provided records and documents. Today is ${today()}. Be brief, quote the exact numbers from the context, cite the document and section or record ID in parentheses, and say so if the context does not contain the answer.`,
    `Question: ${q}\n\nContext:\n${ctx.slice(0, 7000)}`);
  if (!out) return r.text;
  return r.tool === "search_docs" ? `${out}\n\n_Answer written by the model from the cited sections; check the sources._` : out;
}

export async function ask(input: { userId: string; question: string; conversationId?: number; at?: string }): Promise<Answer> {
  const { userId, question } = input;
  const user = resolveUser(userId);
  if (!user) throw new Error(`Unknown user ${userId}`);
  const at = input.at ?? new Date().toISOString();
  const conv = input.conversationId ?? newConversation(user.user_id, "New chat", at);
  addMessage(conv, "user", question, undefined, at);

  const finish = (a: Omit<Answer, "conversationId">, wells: string[] = []) => {
    // Rules and documents first, then records; long field-wide answers keep the first 60.
    const rank = (t: string) => (["doc", "rule_override", "correction", "shared_fact"].includes(t) ? 0 : 1);
    a.citations = [...a.citations].sort((x, y) => rank(x.type) - rank(y.type)).slice(0, 60);
    const messageId = addMessage(conv, "assistant", a.text, { visual: a.visual, visuals: a.visuals, followups: a.followups, citations: a.citations, tool: a.tool, args: a.args, router: a.router, needsConfirmation: a.needsConfirmation }, at);
    if (wells.length) recordEntities(conv, user.user_id, wells.slice(0, 20), at);
    return { conversationId: conv, messageId, ...a };
  };

  // 1. Feedback: corrections, team rules, shared facts, status claims.
  if (looksLikeFeedback(question)) {
    const fb = await extractFeedback(question);
    if (fb) {
      const r = applyFeedback(fb, user.user_id);
      return finish({ text: r.text, visual: null, citations: r.citations, tool: "record_feedback", args: fb, needsConfirmation: r.needsConfirmation, followups: followups("record_feedback", {}, null, r.entities) }, r.entities);
    }
  }

  // 2. Private memory: "the three wells we discussed yesterday".
  const ent = extractEntities(question, user);
  let recalled: { wells: string[]; title: string; at: string; conversation_id: number } | null = null;
  if (ent.memoryRef && !ent.asset_ids.length) {
    const r = recallWells(user.user_id, conv, { count: ent.refCount });
    if (!r?.wells) {
      const what = ent.refCount ? `${ent.refCount} wells` : "any wells";
      const other = r?.mentioned?.length ? ` The only wells I've discussed with you are ${r.mentioned.join(", ")}.` : "";
      return finish({ text: `I don't have an earlier conversation with you, ${user.name}, about ${what}, so I can't tell which wells you mean.${other} I only use your own conversations, never other people's. Which wells would you like me to look at?`, visual: null, citations: [], tool: "recall", router: "memory" });
    }
    recalled = { wells: r.wells, title: r.title, at: r.at, conversation_id: r.conversation_id };
  }

  // 3. Route.
  let route: Route | null = null;
  let how = "heuristic";
  const h = heuristicRoute(question, recalled ? { ...ent, asset_ids: recalled.wells } : ent);
  if (ROUTER === "heuristic" || !llmEnabled()) route = h;
  else if (ROUTER === "hybrid" && h.confident) route = h;
  else {
    route = await llmRoute(question, user.user_id, ent);
    how = route ? "llm" : "heuristic (llm failed)";
    route = route ?? h;
  }
  route = cleanArgs(route, ent, question, recalled?.wells, how === "llm");

  // 4. Run the tool; fall back to the keyword route if the chosen call fails.
  let result: ToolResult;
  try {
    result = (TOOLS[route.tool] as any)(route.args);
  } catch (e) {
    const fallback = cleanArgs(h, ent, question, recalled?.wells);
    try { result = (TOOLS[fallback.tool] as any)(fallback.args); route = fallback; how += " → fallback"; }
    catch { return finish({ text: `I couldn't answer that: ${(e as Error).message}`, visual: null, citations: [], tool: route.tool, args: route.args, router: how }); }
  }

  // 5. Text: deterministic, except open questions answered from documents.
  let text = result.text;
  if ((result.tool === "search_docs" || result.tool === "run_sql" || !route.confident) && llmEnabled()) text = await compose(question, result);
  if (recalled) text = recalled.conversation_id === conv
    ? `For the wells in my previous answer (**${recalled.wells.join(", ")}**):\n\n${text}`
    : `From our earlier conversation (${fmtDate(recalled.at.slice(0, 10))}, "${recalled.title}"), the wells were **${recalled.wells.join(", ")}**.\n\n${text}`;

  const requested = detectRequestedVisual(question);
  const visual = pickVisual(result, requested);
  const visuals = allVisuals(result);
  if (visual && !visuals[visual.type]) visuals[visual.type] = visual;
  return finish({ text, visual, visuals, citations: result.citations, tool: route.tool, args: route.args, router: how,
    followups: followups(route.tool, route.args, result, result.entities) }, result.entities);
}

export { userName };
export { usage, llmInfo } from "./llm";

// ---------------------------------------------------------------------------------------------
// "Correct this" form: a structured correction goes through the same checks as one typed in chat.
const FIELD_LABEL: Record<string, string> = {
  wellhead_temp_c: "wellhead temperature", ambient_temp_c: "air temperature",
  spill_est_volume_bbl: "spill volume", spill_detected: "spill detection",
};

export function correct(input: { userId: string; conversationId?: number; inspection_id: string; field: string; value: number; reason: string }): Answer {
  const user = resolveUser(input.userId);
  if (!user) throw new Error(`Unknown user ${input.userId}`);
  if (!FIELD_LABEL[input.field]) throw new Error(`Unknown field ${input.field}`);
  const insp = db().prepare(`SELECT inspection_id, asset_id, substr(inspected_at,1,10) day FROM inspections WHERE inspection_id=?`).get(input.inspection_id.trim().toUpperCase()) as any;
  if (!insp) throw new Error(`No inspection ${input.inspection_id}`);
  const at = new Date().toISOString();
  const conv = input.conversationId ?? newConversation(user.user_id, "New chat", at);
  const what = input.field === "spill_detected" ? "not a real spill" : `${FIELD_LABEL[input.field]} -> ${input.value}${input.field === "spill_est_volume_bbl" ? " bbl" : " °C"}`;
  addMessage(conv, "user", `Correction for ${insp.inspection_id} (${insp.asset_id}, ${fmtDate(insp.day)}): ${what}. Reason: ${input.reason}`, { form: true }, at);
  const fb: Feedback = {
    kind: input.field === "wellhead_temp_c" || input.field === "ambient_temp_c" ? "raw_correction" : "analysis_correction",
    asset_id: insp.asset_id, inspection_id: insp.inspection_id, field: input.field,
    value: input.field === "spill_detected" ? 0 : Number(input.value), reason: input.reason,
  };
  const r = applyFeedback(fb, user.user_id);
  const fu = followups("record_feedback", {}, null, r.entities);
  const messageId = addMessage(conv, "assistant", r.text, { visual: null, citations: r.citations, tool: "record_feedback", args: fb, needsConfirmation: r.needsConfirmation, followups: fu }, at);
  recordEntities(conv, user.user_id, r.entities, at);
  return { conversationId: conv, messageId, text: r.text, visual: null, citations: r.citations, tool: "record_feedback", args: fb, needsConfirmation: r.needsConfirmation, followups: fu };
}
