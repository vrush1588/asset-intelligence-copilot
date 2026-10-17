// Runs the deterministic tools on the example questions and prints the draft answers.
import "../lib/env";
import { TOOLS } from "../lib/tools";

const cases: [string, keyof typeof TOOLS, any][] = [
  ["Q1", "well_status", { asset_id: "WELL-0001" }],
  ["Q2", "wells_not_producing", { area: "Northeast Block 8" }],
  ["Q3", "temperature_series", { asset_id: "WELL-0001", period: "last 13 weeks" }],
  ["Q4", "spills", { asset_id: "WELL-0001", period: "last 4 years" }],
  ["Q5", "downtime", { asset_id: "WELL-0001", period: "2025" }],
  ["Q6", "downtime", { area: "Northeast Block 7", period: "last 4 months", top_n: 3 }],
  ["Q7", "spills", { area: "Northeast Block 8", period: "last 90 days" }],
  ["Q8", "spill_heatmap", { period: "2026" }],
  ["Q9", "compliance", { asset_id: "WELL-0001", period: "last 12 months" }],
  ["Q10", "compliance", { area: "Southwest Block 24", period: "last 90 days", protocol: "SR-02", status: "breach" }],
  ["Q11", "repairs", { asset_ids: ["WELL-0121", "WELL-0138", "WELL-0107"], period: "this year" }],
  ["Q14", "rca_candidates", { area: "Northeast Block 7", equipment_kind: "pump_jack" }],
  ["Q15b", "spills", { area: "Northeast Block 8", period: "last 90 days", reportable_only: true }],
  ["Q18", "spills", { asset_id: "WELL-0101", period: "August 2026" }],
];

const only = process.argv[2];
for (const [name, tool, args] of cases) {
  if (only && only !== name) continue;
  const t0 = Date.now();
  const r = (TOOLS[tool] as any)(args);
  console.log(`\n===== ${name} ${tool} (${Date.now() - t0} ms) visual=${r.defaultVisual} entities=${r.entities.slice(0, 6).join(",")}`);
  console.log(r.text);
  console.log(`citations: ${r.citations.slice(0, 8).map((c: any) => c.id).join(", ")}${r.citations.length > 8 ? ` … (+${r.citations.length - 8})` : ""}`);
}
