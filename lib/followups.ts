// Suggested next questions under each answer. Built from the tool, its arguments and the wells in
// the answer (no model call), and worded so the keyword router answers them instantly.
import { today } from "./domain";
import type { ToolResult } from "./visual";

export function followups(tool: string, args: Record<string, any>, r: ToolResult | null, wells: string[]): string[] {
  const year = Number(today().slice(0, 4));
  const scope = args.area ? ` in ${args.area}` : args.well_type ? ` among ${args.well_type} wells` : "";
  const one = args.asset_id ?? (wells.length === 1 ? wells[0] : undefined);
  const first = wells[0];
  const out: string[] = [];
  const add = (q: string | false | undefined) => { if (q && !out.includes(q)) out.push(q); };
  // Name the wells so the chip means the same thing whenever it is clicked.
  const list = wells.length > 1 && wells.length <= 5 ? `${wells.slice(0, -1).join(", ")} and ${wells[wells.length - 1]}` : "";

  switch (tool) {
    case "well_status":
      if (one && r?.facts?.producing === false) add(`How many days was ${one} down in the last 4 months, and why?`);
      if (one) add(`Show ${one}'s wellhead temperature against air temperature for the last 13 weeks`);
      if (one) add(`Which rules has ${one} broken in the last 12 months, and what is still open?`);
      break;
    case "wells_not_producing":
      if (first) add(`Is ${first} producing oil right now?`);
      add(`Which 3 wells${scope} had the most downtime in the last 4 months?`);
      if (list) add(`What have repairs cost this year for ${list}?`);
      break;
    case "temperature_series":
      if (one) add(`How many days was ${one} down in ${year}?`);
      if (one) add(`Is ${one} producing oil right now?`);
      break;
    case "downtime":
      if (one) {
        add(`Is ${one} producing oil right now?`);
        add(`What have repairs cost for ${one} this year?`);
      } else {
        if (first) add(`How many days was ${first} down in the last 4 months, and why?`);
        add(`Which 3 wells${scope} had the most downtime in ${year - 1}?`);
        if (list) add(`What have repairs cost this year for ${list}?`);
      }
      break;
    case "spills":
      if (one) add(`Which rules has ${one} broken in the last 12 months, and what is still open?`);
      else {
        if (!args.reportable_only) add(`Which spills${scope} in the last 90 days needed a report to the regulator?`);
        add(`Which spills${scope} in the last 90 days were not contained within the SOP time limit?`);
      }
      add(`Show a heatmap of ${year} spills by geographic area and month`);
      break;
    case "spill_heatmap":
      add(`Show a heatmap of ${year - 1} spills by geographic area and month`);
      add(`Compare total spill volume across the areas this year`);
      add(`Which reportable spills are still waiting for clean-up verification?`);
      break;
    case "compliance":
      add(`List all open notices of violation`);
      if (first && !one) add(`Which rules has ${first} broken in the last 12 months, and what is still open?`);
      if (one) add(`How many oil spills has ${one} had in the last 4 years?`);
      break;
    case "rca_candidates":
      if (list) add(`What have repairs cost this year for ${list}?`);
      add(`Which ${args.equipment_kind ? args.equipment_kind.replace("_", " ") + " " : ""}problems happen most often?`);
      break;
    case "repairs":
      if (first && wells.length > 1) add(`Is ${first} producing oil right now?`);
      add(`Which pump jack problems happen most often?`);
      break;
    case "regulatory_events":
      if (first) add(`Which rules has ${first} broken in the last 12 months, and what is still open?`);
      break;
    case "well_list":
      if (one) add(`Is ${one} producing oil right now?`);
      if (one) add(`How many oil spills has ${one} had in the last 4 years?`);
      break;
    case "spill_rules":
      add(`Which reportable spills are still waiting for clean-up verification?`);
      break;
    case "record_feedback":
      if (first) add(`Is ${first} producing oil right now?`);
      if (first) add(`Which rules has ${first} broken in the last 12 months, and what is still open?`);
      break;
  }
  return out.slice(0, 3);
}
