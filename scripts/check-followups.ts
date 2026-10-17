// Asks every follow-up chip generated from a set of starting questions and checks that each one
// is answered (no error, a real tool, not a fallback document search).
import "../lib/env";
import { snapshotDb } from "../lib/snapshot";
process.env.LLM_PROVIDER = "none";
snapshotDb("followups");

const START = [
  "Is WELL-0001 producing oil right now?",
  "Which wells in Northeast Block 8 are not producing oil right now, and why?",
  "Show a line chart of WELL-0001's wellhead temperature against air temperature for the last 13 weeks",
  "How many days was WELL-0001 down in 2025?",
  "Which 3 wells in Northeast Block 7 had the most downtime in the last 4 months?",
  "Show on a map every well in Northeast Block 8 with a real spill in the last 90 days.",
  "How many oil spills has WELL-0001 had in the last 4 years?",
  "Show a heatmap of 2026 spills by geographic area and month.",
  "Which rules has WELL-0001 broken in the last 12 months, and what is still open?",
  "Which wells in Northeast Block 7 need a root-cause analysis on their pump jack?",
  "List all open notices of violation",
  "Who is in charge of WELL-0150 and when was it installed?",
  "What is the reporting deadline for a 30 barrel spill?",
];

async function main() {
  const { ask } = await import("../lib/agent");
  let n = 0, bad = 0;
  for (const q of START) {
    const a = await ask({ userId: "U-201", question: q });
    const views = Object.keys(a.visuals ?? {});
    console.log(`\n${q}\n  [${a.tool}] views: ${views.join(", ") || "none"}`);
    for (const f of a.followups ?? []) {
      const b = await ask({ userId: "U-201", question: f, conversationId: a.conversationId });
      n++;
      const ok = !/couldn't answer|don't have an earlier/.test(b.text) && b.tool !== "search_docs";
      if (!ok) bad++;
      console.log(`  ${ok ? "ok " : "BAD"} → ${f}  [${b.tool}] ${b.text.split("\n")[0].replace(/\*\*/g, "").slice(0, 110)}`);
    }
  }
  console.log(`\n${n - bad}/${n} follow-ups answered`);
}
main();
