// Smoke test for whatever dataset is loaded (sample, test, or both). Picks real wells, areas and
// spills from the data, asks one question per tool through the full copilot on a scratch copy,
// and checks each answer: no error, the expected tool and visual, sources cited.
// Usage: npm run smoke            (keyword routing only, fast)
//        npm run smoke -- --llm   (also lets the model route unclear questions)
import "../lib/env";
import { snapshotDb } from "../lib/snapshot";

const useLlm = process.argv.includes("--llm");
if (!useLlm) process.env.LLM_PROVIDER = "none";
snapshotDb("smoke");

type Check = { q: string; user?: string; newChat?: boolean; tool?: string | string[]; visual?: string; cites?: boolean; expect?: (string | RegExp)[] };

async function main() {
  const { db } = await import("../lib/db");
  const { today } = await import("../lib/domain");
  const { ask, usage } = await import("../lib/agent");
  const d = db();
  const one = (sql: string, ...p: any[]) => d.prepare(sql).get(...p) as any;
  const t = today();
  const year = t.slice(0, 4);

  // Pick subjects from the loaded data.
  const area = one(`SELECT a.name, a.team_id, COUNT(*) n FROM wells w JOIN areas a USING(area_id) GROUP BY a.area_id ORDER BY n DESC, a.area_id DESC LIMIT 1`);
  const lead = one(`SELECT user_id, name FROM users WHERE team_id=? ORDER BY user_id LIMIT 1`, area.team_id) ?? one(`SELECT user_id, name FROM users ORDER BY user_id LIMIT 1`);
  const other = one(`SELECT user_id, name FROM users WHERE user_id != ? ORDER BY user_id DESC LIMIT 1`, lead.user_id);
  const well = one(`SELECT w.asset_id FROM wells w JOIN areas a USING(area_id) WHERE a.name=? ORDER BY w.asset_id DESC LIMIT 1`, area.name).asset_id;
  const spillWell = one(`SELECT i.asset_id FROM inspections i WHERE spill_detected=1 AND NOT EXISTS (SELECT 1 FROM corrections c WHERE c.inspection_id=i.inspection_id AND c.field='spill_detected') ORDER BY inspected_at DESC LIMIT 1`).asset_id;
  const last = one(`SELECT inspection_id, substr(inspected_at,1,10) day, wellhead_temp_c FROM inspections WHERE asset_id=? ORDER BY inspected_at DESC LIMIT 1`, well);
  const dayText = new Date(last.day + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  const wells = (d.prepare(`SELECT COUNT(*) n FROM wells`).get() as any).n;
  console.log(`Dataset: ${wells} wells · today ${t} · area "${area.name}" · well ${well} · spill well ${spillWell} · users ${lead.name}, ${other.name}\n`);

  const checks: Check[] = [
    { q: `Is ${well} producing oil right now?`, tool: "well_status", visual: "status_card", cites: true, expect: [well, last.inspection_id] },
    { q: `Which wells in ${area.name} are not producing oil right now, and why? Show them in a table.`, tool: "wells_not_producing", visual: "table", cites: true },
    { q: `Show a line chart of ${well}'s wellhead temperature against air temperature for the last 13 weeks.`, tool: "temperature_series", visual: "line", expect: [/1[23] readings/] },
    { q: `How many oil spills has ${spillWell} had in the last 4 years? List them in a table.`, tool: "spills", visual: "table", cites: true, expect: [spillWell] },
    { q: `Show on a map every well in ${area.name} with a real spill in the last 90 days.`, tool: "spills", visual: "map" },
    { q: `Show a heatmap of ${year} spills by geographic area and month.`, tool: "spill_heatmap", visual: "heatmap", expect: [area.name] },
    { q: `Which 3 wells in ${area.name} had the most downtime in the last 4 months? Show a bar chart.`, tool: "downtime", visual: "bar", newChat: true },
    { q: `For the three wells we discussed yesterday, what have repairs cost this year?`, tool: "repairs", newChat: true, expect: [/USD/] },
    { q: `Which rules has ${spillWell} broken in the last 12 months, and what is still open?`, tool: "compliance", visual: "table", expect: [/breach/] },
    { q: `Which wells in ${area.name} need a root-cause analysis on their pump jack?`, tool: "rca_candidates", visual: "table" },
    { q: `List all open notices of violation`, tool: "regulatory_events", visual: "table" },
    { q: `Who is in charge of ${well} and when was it installed?`, tool: "well_list", expect: ["in charge", "installed"] },
    { q: `What is the reporting deadline for a 7 barrel spill?`, tool: "spill_rules", cites: true, expect: [/reportable/, /hours/] },
    { q: `What does the spill SOP say about soil samples?`, tool: "search_docs", cites: true },
    { q: `The ${dayText} reading for ${well} is wrong. The thermal camera was faulty; the crew re-measured the wellhead at ${(last.wellhead_temp_c + 30).toFixed(1)} °C.`, tool: "record_feedback", expect: [last.inspection_id, "original"] },
    { q: `Is ${well} producing oil right now?`, user: other.user_id, newChat: true, tool: "well_status", expect: [lead.name, /corrected/i] },
    { q: `For the three wells we discussed yesterday, what have repairs cost this year?`, user: other.user_id, newChat: true, tool: "recall", expect: [/don't have an earlier conversation/] },
  ];

  const conv: Record<string, number | undefined> = {};
  let pass = 0;
  for (const c of checks) {
    const user = c.user ?? lead.user_id;
    if (c.newChat) conv[user] = undefined;
    const t0 = Date.now();
    let a: any;
    try { a = await ask({ userId: user, question: c.q, conversationId: conv[user] }); }
    catch (e) { a = { text: `THREW: ${(e as Error).message}`, citations: [] }; }
    conv[user] = a.conversationId;
    const problems: string[] = [];
    if (/^THREW|I couldn't answer/.test(a.text)) problems.push("error: " + a.text.slice(0, 160));
    if (!a.text?.trim()) problems.push("empty answer");
    const tools = Array.isArray(c.tool) ? c.tool : c.tool ? [c.tool] : [];
    if (tools.length && !tools.includes(a.tool)) problems.push(`tool ${a.tool} (expected ${tools.join("/")})`);
    if (c.visual && a.visual?.type !== c.visual) problems.push(`visual ${a.visual?.type ?? "none"} (expected ${c.visual})`);
    if (c.cites && !a.citations?.length) problems.push("no sources");
    for (const e of c.expect ?? []) if (typeof e === "string" ? !a.text.includes(e) : !e.test(a.text)) problems.push(`missing ${e}`);
    const ok = !problems.length;
    if (ok) pass++;
    console.log(`${ok ? "PASS" : "FAIL"} ${String(Date.now() - t0).padStart(5)} ms  [${a.tool ?? "-"}] ${c.q.slice(0, 90)}`);
    if (!ok) console.log(`      ${problems.join(" · ")}\n      > ${(a.text ?? "").split("\n")[0].slice(0, 200)}`);
  }
  console.log(`\n${pass}/${checks.length} passed${useLlm ? `; model calls ${usage.calls}, ${(usage.ms / 1000).toFixed(1)} s` : " (keyword routing; add -- --llm to include the model)"}.`);
  process.exitCode = pass === checks.length ? 0 : 1;
}
main();
