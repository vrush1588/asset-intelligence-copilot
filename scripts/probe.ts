// Unseen-question probe: new phrasings and question types, run on a scratch copy of the DB.
import "../lib/env";
import { snapshotDb } from "../lib/snapshot";

snapshotDb("probe");

const QS: [string, string][] = [
  ["U-201", "Which wells in my area were down the longest this summer, and why?"],
  ["U-401", "What is the reporting deadline for a 30 barrel spill?"],
  ["U-101", "How much did flowline repairs cost in Southwest Block 23 in 2025?"],
  ["U-401", "List all open notices of violation"],
  ["U-201", "Which T350 wells are not producing right now?"],
  ["U-101", "Show WELL-0042's temperature trend since June 2026"],
  ["U-401", "Which wells went more than 14 days without an inspection in the last year?"],
  ["U-201", "Where are the T200 wells in Northeast Block 7?"],
  ["U-401", "Compare total spill volume across the four areas this year"],
  ["U-201", "Who is in charge of WELL-0150 and when was it installed?"],
  ["U-401", "Any reportable spills still waiting for clean-up verification?"],
  ["U-301", "Which pump jack problems happen most often?"],
];

async function main() {
  const { ask, usage } = await import("../lib/agent");
  for (const [u, q] of QS) {
    const t0 = Date.now();
    const a = await ask({ userId: u, question: q });
    console.log(`\n### ${q}\n[${a.tool} via ${a.router}] args=${JSON.stringify(a.args)} visual=${a.visual?.type ?? "none"} ${Date.now() - t0} ms`);
    console.log(a.text.split("\n").slice(0, 7).map((l) => "  " + l.slice(0, 220)).join("\n"));
  }
  console.log(`\nLLM calls ${usage.calls}, tokens ${usage.prompt_tokens}+${usage.completion_tokens}, model time ${(usage.ms / 1000).toFixed(1)} s`);
}
main();
