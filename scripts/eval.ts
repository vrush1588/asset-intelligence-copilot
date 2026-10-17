// Runs the 18 example scenarios end to end through the copilot (routing, memory, feedback),
// on a fresh copy of the database so memory starts empty.
// Usage: npm run eval [-- --router heuristic|hybrid|llm] [-- --today 2026-10-17] [-- --only Q12]
import "../lib/env";
import Database from "better-sqlite3";
import { snapshotDb } from "../lib/snapshot";

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
if (opt("router")) process.env.COPILOT_ROUTER = opt("router");
if (opt("today")) process.env.COPILOT_TODAY = opt("today");
// Scenarios start with no memory: copy the live database and clear what users taught it.
const { dst: evalDb } = snapshotDb("eval");
{
  const d = new Database(evalDb);
  d.exec(`DELETE FROM corrections WHERE source NOT LIKE 'note:%'; DELETE FROM shared_facts; DELETE FROM rule_overrides;
    DELETE FROM conversations; DELETE FROM messages; DELETE FROM conversation_entities; DELETE FROM answer_ratings;`);
  d.close();
}

type Step = { user: string; q: string; newChat?: boolean; at?: string; expect?: (string | RegExp)[]; not?: (string | RegExp)[]; visual?: string };
type Scenario = { id: string; steps: Step[] };

const MT = "U-201", JR = "U-202", TH = "U-204", JM = "U-102", LS = "U-401";
const D1 = "2026-10-15T09:00:00Z", D2 = "2026-10-16T09:00:00Z";

const S: Scenario[] = [
  { id: "Q1", steps: [{ user: MT, q: "Is WELL-0001 producing oil right now? When was it last inspected, and by whom?", visual: "status_card",
    expect: ["not producing", "INS-0001-0203", "15 Oct 2026", "drone", "Ryan Brooks", "3.2", "CTX-0001-003", "Jake Morales", "out of date"] }] },
  { id: "Q2", steps: [{ user: MT, q: "Which wells in Northeast Block 8 are not producing oil right now, and why? Show them in a table.", visual: "table",
    expect: ["WELL-0164", "WELL-0170", "WELL-0172", "WELL-0175", "MNT-0170-031", "MNT-0172-028", "No recorded reason", "Pump jack not moving", /4 wells/] }] },
  { id: "Q3", steps: [{ user: MT, q: "Show a line chart of WELL-0001's wellhead temperature against air temperature for the last 13 weeks, and mark when it was not producing oil.", visual: "line",
    expect: ["13 readings", "8 Oct 2026", "15 Oct 2026"] }] },
  { id: "Q4", steps: [{ user: MT, q: "How many oil spills has WELL-0001 had in the last 4 years, and how much oil in total? List them in a table.", visual: "table",
    expect: ["6 spills", "15.1 bbl", "INS-0001-0070", "CTX-0001-001", "6.8"] }] },
  { id: "Q5", steps: [{ user: MT, q: "How many days was WELL-0001 down in 2025?", expect: ["21 days", "24 Jul 2025", "51.6", "8.5", "MNT-0001-021", "16 Oct 2025", "23 Oct 2025", "MNT-0001-023"] }] },
  { id: "Q6", steps: [{ user: MT, q: "Which 3 wells in Northeast Block 7 had the most downtime in the last 4 months? Show a bar chart.", visual: "bar",
    expect: [/WELL-0121.*49 days/, /WELL-0138.*42 days/, /WELL-0107.*42 days/, /WELL-0119.*28/] }] },
  { id: "Q7", steps: [{ user: MT, q: "Show on a map every well in Northeast Block 8 with a real spill in the last 90 days.", visual: "map",
    expect: ["WELL-0151", "WELL-0165", "WELL-0175", "WELL-0186", "4.5", "1.2", "3.9", "0.6"], not: ["WELL-0194 ·", "WELL-0199 ·"] }] },
  { id: "Q8", steps: [{ user: MT, q: "Show a heatmap of 2026 spills by geographic area and month.", visual: "heatmap",
    expect: [/Southwest Block 23: 4 · 3 · 3 · 6 · 3 · 4 · 4 · 3 · 3 · 2 → \*\*35/, /Southwest Block 24: 7 · 4 · 5 · 6 · 5 · 5 · 3 · 1 · 5 · 2 → \*\*43/, /Northeast Block 7: .* → \*\*37/, /Northeast Block 8: .* → \*\*26/] }] },
  { id: "Q9", steps: [{ user: MT, q: "Which rules has WELL-0001 broken in the last 12 months, and what is still open?",
    expect: [/4 breaches/, "SR-01", "41 h", "REG-0001-002", "USD 5,000", "SR-02", "about 7 h", "SR-03", "10 Aug 2026", "REG-0001-003", "RC-04", "30 Jul 2026", "MNT-0001-028", "MNT-0001-029", "MNT-0001-032", "Action required", "CTX-0001-003", /7 Mar 2026/] }] },
  { id: "Q10", steps: [{ user: MT, q: "In Southwest Block 24, which spills in the last 90 days were not contained within the SOP time limit?",
    expect: [/2 breaches/, "WELL-0082", "7.1 h", "MNT-0082-028", "INS-0082-0198", "WELL-0100", "8.1 h", "MNT-0100-034", "INS-0100-0196", "4 h"] }] },
  { id: "Q11", steps: [
    { user: MT, at: D1, newChat: true, q: "Which 3 wells in Northeast Block 7 had the most downtime in the last 4 months? Show a bar chart." },
    { user: MT, at: D2, newChat: true, q: "For the three wells we discussed yesterday, what have repairs cost this year?", expect: ["WELL-0121: USD 25,794", "WELL-0138: USD 46,942", "WELL-0107: USD 5,176"] }] },
  { id: "Q12", steps: [
    { user: MT, newChat: true, q: "The 15 Oct reading for WELL-0164 is wrong. The handheld thermal gun used in that inspection was faulty; the field crew re-measured the wellhead at 41.0 °C.",
      expect: ["INS-0164-0205", "41.0", "24.0", "19.9", "21.1", /is producing/, "Pump jack not moving", "Tyler Hughes", "confirm"] },
    { user: MT, q: "Which wells in Northeast Block 8 are not producing oil right now, and why? Show them in a table.", visual: "table",
      expect: [/3 wells/, "WELL-0170", "WELL-0172", "WELL-0175", /WELL-0164 is no longer listed/], not: [/\*\*WELL-0164\*\*/] }] },
  { id: "Q13", steps: [{ user: MT, q: "The AI estimated the 24 Sep spill at WELL-0151 as 4.5 bbl. The field crew measured 5.4 bbl.",
    expect: ["INS-0151-0201", "5.4", "4.5", "reportable", "SR-01", /no written notice/i, "24 Sep 2026 15:30", "MNT-0151-025", "moderate", "6.4 h", "23 Nov 2026"] }] },
  { id: "Q14", steps: [
    { user: MT, newChat: true, q: "Which wells in Northeast Block 7 need a root-cause analysis on their pump jack?", expect: [/3 wells/, "WELL-0108", "WELL-0121", "WELL-0138"], not: [/\*\*WELL-0120\*\*/] },
    { user: MT, q: "Note for all T350 wells: our team now wants a pump jack root-cause analysis after 2 repairs, not 3.", expect: ["T350", "2"] },
    { user: MT, newChat: true, q: "Which wells in Northeast Block 7 need a root-cause analysis on their pump jack?",
      expect: [/4 wells/, /\*\*WELL-0108\*\*/, /\*\*WELL-0120\*\*/, /\*\*WELL-0121\*\*/, /\*\*WELL-0138\*\*/, "Michael Turner", /WELL-0102 \(T200\) has 2/] }] },
  { id: "Q15", steps: [
    { user: JR, newChat: true, q: "Is WELL-0164 producing oil right now?", expect: [/WELL-0164 is producing/, "41.0", "Michael Turner", "Pump jack not moving"] },
    { user: LS, newChat: true, q: "Which spills in Northeast Block 8 in the last 90 days needed a report to the regulator?",
      expect: ["WELL-0151", "5.4", "Michael Turner", "OVERDUE", /1 reportable spill/], not: ["WELL-0175 ·"] }] },
  { id: "Q16", steps: [
    { user: JM, newChat: true, q: "FYI for everyone: WELL-0007 will be shut in from 17 Oct for a 10-day planned workover.", expect: ["WELL-0007", "17 Oct 2026"] },
    { user: MT, newChat: true, q: "Is any downtime planned for WELL-0007?", expect: ["17 Oct", "10-day", "Jake Morales"] },
    { user: JR, newChat: true, q: "For the three wells we discussed yesterday, what have repairs cost this year?", expect: [/don't have an earlier conversation/], not: ["25,794", "WELL-0121"] }] },
  { id: "Q17", steps: [
    { user: MT, newChat: true, q: "WELL-0175 has been shut in for planned work since 14 Oct.", expect: [/Noted for everyone/, "0.4"] },
    { user: TH, newChat: true, q: "WELL-0175 is running fine.", expect: [/can't confirm/, "0.4", "Jessica Reed", "Michael Turner", "unconfirmed"] },
    { user: JM, newChat: true, q: "WELL-0001 is back online since 14 Oct.", expect: [/can't confirm/, "INS-0001-0203", "CTX-0001-003", "20 Oct", "unconfirmed"] }] },
  { id: "Q18", steps: [{ user: LS, newChat: true, q: "Was the 20 Aug spill at WELL-0101 real oil?",
    expect: ["INS-0101-0197", "1.0", "Oil sheen around cellar", "CTX-0101-002", "Ryan Brooks", "CTX-0101-003", "Chris Dalton", "MNT-0101-029", /detection stands/] }] },
];

async function main() {
  const { ask } = await import("../lib/agent");
  const { usage, llmInfo } = await import("../lib/agent");
  const only = opt("only");
  const conv: Record<string, number | undefined> = {};
  let passed = 0, total = 0;
  const failures: string[] = [];
  const t0 = Date.now();
  const { today } = await import("../lib/domain");
  console.log(`router=${process.env.COPILOT_ROUTER ?? "hybrid"} today=${today()} llm=${JSON.stringify(llmInfo())}`);
  for (const s of S) {
    if (only && only !== s.id) { if (s.id === "Q11" || s.id === "Q12" || s.id === "Q13") { /* dependencies run silently */ } continue; }
    for (const [k, st] of s.steps.entries()) {
      if (st.newChat) conv[st.user] = undefined;
      const a = await ask({ userId: st.user, question: st.q, conversationId: conv[st.user], at: st.at });
      conv[st.user] = a.conversationId;
      if (!st.expect && !st.visual) continue;
      total++;
      const missing = (st.expect ?? []).filter((e) => (typeof e === "string" ? !a.text.includes(e) : !e.test(a.text)));
      const present = (st.not ?? []).filter((e) => (typeof e === "string" ? a.text.includes(e) : e.test(a.text)));
      const badVisual = st.visual && a.visual?.type !== st.visual ? `visual ${a.visual?.type ?? "none"} != ${st.visual}` : "";
      const ok = !missing.length && !present.length && !badVisual;
      if (ok) passed++;
      else failures.push(s.id);
      console.log(`${ok ? "PASS" : "FAIL"} ${s.id}.${k + 1} [${a.tool} via ${a.router ?? "-"}] ${st.q.slice(0, 70)}`);
      if (!ok || argv.includes("--verbose")) {
        if (missing.length) console.log(`   missing: ${missing.map(String).join(" | ")}`);
        if (present.length) console.log(`   unexpected: ${present.map(String).join(" | ")}`);
        if (badVisual) console.log(`   ${badVisual}`);
        console.log(`   args: ${JSON.stringify(a.args)}`);
        console.log(a.text.split("\n").map((l) => "   > " + l).join("\n"));
      }
    }
  }
  console.log(`\n${passed}/${total} checks passed in ${((Date.now() - t0) / 1000).toFixed(1)} s. LLM calls ${usage.calls}, tokens ${usage.prompt_tokens}+${usage.completion_tokens}, model time ${(usage.ms / 1000).toFixed(1)} s.`);
  if (failures.length) console.log(`Failed: ${[...new Set(failures)].join(", ")}`);
}
main();
