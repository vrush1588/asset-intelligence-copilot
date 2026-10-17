// Keyword router: extracts entities from the question and picks a tool by intent.
// Used to fill in what the model misses and as the whole router when no model is available.
import { areas, normWell, resolveArea } from "./domain";
import { parseDates } from "./memory";
import { addDays } from "./period";
import type { ToolName } from "./tools";

export type Entities = {
  asset_ids: string[]; area?: string; team_id?: string; well_type?: string; period?: string; top_n?: number;
  equipment_kind?: string; protocol?: string; memoryRef: boolean; refCount?: number;
};
export type Route = { tool: ToolName; args: Record<string, any>; confident: boolean };

const NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, thirteen: 13 };
const toNum = (s: string) => NUM[s.toLowerCase()] ?? Number(s);

export function extractEntities(q: string, user?: { team_id?: string }): Entities {
  const t = q.toLowerCase();
  const asset_ids = [...new Set([...q.matchAll(/WELL[- ]?(\d{1,4})/gi)].map((m) => normWell(m[1])).filter(Boolean) as string[])];
  let area: string | undefined;
  for (const a of areas()) if (t.includes(a.name.toLowerCase()) || new RegExp(`\\b${a.area_id.toLowerCase()}\\b`).test(t)) area = a.name;
  if (!area) { const m = t.match(/\b(?:north|south)\s?(?:east|west)\s+block\s+\d+|\b(?:ne|nw|se|sw)[- ]?\d{1,2}\b/); if (m) area = resolveArea(m[0])?.name; }
  const team_id = !area && /\bmy (area|team|wells|block)\b/.test(t) ? user?.team_id : undefined;
  const wt = q.match(/\bT(\d{3})\b/);
  const n = "(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|thirteen)";
  let period: string | undefined;
  const pm = t.match(new RegExp(`\\b(?:last|past|previous)\\s+${n}?\\s*(days?|weeks?|months?|years?)\\b`));
  const since = t.match(/\bsince\s+((?:\d{1,2}\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:\s+\d{4})?|\d{4}-\d{2}-\d{2}|20\d{2})\b/);
  if (since) period = `since ${since[1]}`;
  else if (pm) period = `last ${pm[1] ? toNum(pm[1]) : 1} ${pm[2]}`;
  else if (/\bthis year\b/.test(t)) period = "this year";
  else if (/\blast year\b/.test(t)) period = "last year";
  else if (/\b(this|last)?\s*(summer|winter|spring|autumn|fall)\b/.test(t)) period = t.match(/\b(?:this |last )?(?:summer|winter|spring|autumn|fall)(?:\s+\d{4})?/)![0];
  else {
    const days = parseDates(q);
    const my = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(20\d{2})\b/);
    if (days.length && /\b(spill|inspection|reading|on|the)\b/.test(t)) period = `${addDays(days[0], -3)} to ${addDays(days[days.length - 1], 3)}`;
    else if (my) period = my[0];
    else { const y = t.match(/\b(20\d{2})\b/); if (y) period = y[1]; }
  }
  const top = t.match(new RegExp(`\\b(?:top|which|the)\\s+${n}\\s+wells?\\b`)) ?? t.match(new RegExp(`\\b${n}\\s+wells?\\s+(?:with|had|have)\\s+the\\s+most\\b`));
  const eq: [RegExp, string][] = [[/pump ?jack/, "pump_jack"], [/flow ?line/, "flowline"], [/rod string|sucker rod/, "rod_string"], [/downhole pump/, "downhole_pump"], [/stuffing box|well ?head/, "wellhead"], [/separator/, "separator"]];
  const proto = q.match(/\b(SR|RC|WS)-?0?(\d)\b/i);
  const memoryRef = /\b(we (discussed|talked about|looked at)|discussed (yesterday|earlier|before)|those (three |two |\d+ )?wells|these wells|same wells|from (yesterday|earlier|last time)|last time)\b/.test(t);
  const rc = t.match(new RegExp(`\\b(?:the|those|these)\\s+${n}\\s+wells\\b`));
  return {
    asset_ids, area, team_id, well_type: wt ? `T${wt[1]}` : undefined, period, top_n: top ? toNum(top[1]) : undefined,
    equipment_kind: eq.find(([re]) => re.test(t))?.[1], protocol: proto ? `${proto[1].toUpperCase()}-0${proto[2]}` : undefined,
    memoryRef, refCount: rc ? toNum(rc[1]) : undefined,
  };
}

export function heuristicRoute(q: string, e: Entities): Route {
  const t = q.toLowerCase();
  const sel: Record<string, any> = {};
  if (e.asset_ids.length === 1) sel.asset_id = e.asset_ids[0];
  else if (e.asset_ids.length > 1) sel.asset_ids = e.asset_ids;
  if (e.area) sel.area = e.area;
  if (e.team_id) sel.team_id = e.team_id;
  if (e.well_type) sel.well_type = e.well_type;
  const per = e.period ? { period: e.period } : {};
  const one = e.asset_ids.length === 1 && !e.area;
  const r = (tool: ToolName, args: Record<string, any>, confident = true): Route => ({ tool, args: { ...sel, ...args }, confident });

  const noScope = !e.asset_ids.length && !e.area && !e.team_id;
  // "What applies to a 30 barrel spill?" — apply the SOP rules to that size.
  const vol = t.match(/(\d+(?:\.\d+)?)\s*(?:bbl|barrels?)\b/);
  if (noScope && vol && /\b(deadline|report|class|classif|reportable|major|minor|moderate|rule|must|need|require|do we|what (happens|applies))/.test(t)) {
    const pct = t.match(/(\d+(?:\.\d+)?)\s*%/);
    return { tool: "spill_rules", args: { volume_bbl: Number(vol[1]), ...(pct ? { pad_pct: Number(pct[1]) } : {}), ...(e.well_type ? { well_type: e.well_type } : {}) }, confident: true };
  }
  // Questions about the rules themselves ("what is the deadline for…") go to the documents.
  if (noScope && (/\b(deadline|threshold|what does the (sop|manual)|according to|procedure|how (soon|quickly|often|long) (must|should|do)|what (is|are) the (rule|limit|requirement)|is required|must (we|i|be)|(sop|manual) say)\b/.test(t)
    || (/\b(sop|sops|manual|procedure|protocol|policy|ws-0\d|rc-0\d|sr-0\d)\b/.test(t) && /\b(require|requires|required|say|says|need|must|how many|what|explain|mean)\b/.test(t) && !/\b(which wells|broken|breach|did we|were|was)\b/.test(t))))
    return { tool: "search_docs", args: { query: q }, confident: true };
  if (/heat ?map/.test(t)) return r("spill_heatmap", { ...per, group_by: /well type|type/.test(t) ? "well_type" : /by well\b/.test(t) ? "well" : "area" });
  if (/root[- ]cause|\brca\b/.test(t)) return r("rca_candidates", { equipment_kind: e.equipment_kind });
  if (/without (an |a )?inspection|not (been )?inspected|missed inspections?|inspection gaps?|inspection frequency/.test(t)) return r("compliance", { ...per, protocol: "RC-01", status: "breach" });
  if (/(clean-?up|remediation|soil) (verification|verified|check)|verification of (the )?clean-?up|waiting for (clean-?up|verification)/.test(t))
    return r("compliance", { ...per, protocol: "SR-03", status: /waiting|pending|still|open|due/.test(t) ? "pending" : undefined });
  if (/notices? of violation|\bnovs?\b|\bfines?\b/.test(t)) return r("regulatory_events", { ...per, status: /\bopen\b|unpaid|outstanding|still/.test(t) ? "open" : /\bclosed\b/.test(t) ? "closed" : undefined, event_type: /notice|nov/.test(t) ? "notice_of_violation" : undefined });
  if (/most (often|common|frequent)|how often|frequent(ly)?|top (issues|problems|failures)|kinds? of (problems|failures|issues)/.test(t) && /(problem|failure|issue|repair|break|fault)/.test(t))
    return r("repairs", { ...per, equipment_kind: e.equipment_kind, maintenance_type: "corrective", group_by: "issue" });
  if (e.asset_ids.length && e.asset_ids.length <= 3 && /in charge|installed|equipment|model|who (owns|manages|is responsible)|details|location|coordinates/.test(t)) return r("well_list", {});
  if (/(rules?|sop|protocol).*(broken|break|breach|violat)|broken.*rules|breach|compliance|non-?complian|overdue|(not|n't) (been )?contained|containment|time limit/.test(t) || e.protocol)
    return r("compliance", { ...per, protocol: e.protocol ?? (/contain/.test(t) ? "SR-02" : undefined), status: /not contained|n't contained|broken|breach|violat|overdue/.test(t) && !/still open|open items|what is (still )?open/.test(t) ? "breach" : undefined });
  if (/(needed|need|require[sd]?|requiring) (a )?report|reportable|report(ed)? to the regulator/.test(t)) return r("spills", { ...per, reportable_only: true });
  if (/\b(spill|spills|leak(ed|s)?|crude|oil on the ground|sheen)\b/.test(t) && !/repair|cost/.test(t)) return r("spills", per);
  if (/\b(regulator|agency|site visits?|site inspections?)\b/.test(t)) return r("regulatory_events", per);
  if (/\b(cost|costs|spent|spend|expensive|money|usd|\$)\b/.test(t) || /\b(repairs?|maintenance|work orders?|jobs?)\b.*\b(list|how many|which|show)\b|\b(list|how many|which|show)\b.*\b(repairs?|maintenance)\b/.test(t))
    return r("repairs", { ...per, period: e.period ?? (/this year/.test(t) ? "this year" : undefined), equipment_kind: e.equipment_kind, maintenance_type: /corrective/.test(t) ? "corrective" : /scheduled/.test(t) ? "scheduled" : undefined });
  if (/temperature|line chart|thermal|trend|over time/.test(t) && one) return r("temperature_series", { period: e.period ?? "last 13 weeks" });
  if (/planned|upcoming|scheduled (shut|down)/.test(t) && one) return r("well_status", {});
  if (/downtime|days? (was|were)? ?(it |they )?down|how (many days|long).*(down|stopped|not producing)|down the longest|most down|longest/.test(t))
    return r("downtime", { ...per, period: e.period ?? (one ? undefined : "last 12 months"), top_n: e.top_n ?? (!one && /longest|most|worst|top/.test(t) ? 5 : undefined) });
  if (/not producing|stopped producing|aren't producing|are down|which wells .*\b(down|stopped|idle|shut)/.test(t) && !one) return r("wells_not_producing", {});
  if (one) return r("well_status", {}, /producing|status|right now|currently|inspected|card|running|online|down/.test(t));
  if (/\b(where|map|locations?|how many wells|list (the |all )?wells|which wells are t\d{3})\b/.test(t)) return r("well_list", {});
  return { tool: "search_docs", args: { query: q }, confident: false };
}
