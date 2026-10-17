import type { Citation } from "./domain";

export type VisualType = "status_card" | "table" | "line" | "bar" | "map" | "heatmap";

export type Column = { key: string; label: string };
export type Visual =
  | { type: "status_card"; title: string; status: "producing" | "not_producing" | "unknown"; headline: string;
      fields: { label: string; value: string }[]; alerts: string[] }
  | { type: "table"; title: string; columns: Column[]; rows: Record<string, any>[] }
  | { type: "line"; title: string; x: string; series: { key: string; label: string }[]; rows: Record<string, any>[];
      markers?: { x: string; label: string }[]; yLabel?: string }
  | { type: "bar"; title: string; x: string; series: { key: string; label: string }[]; rows: Record<string, any>[]; yLabel?: string }
  | { type: "map"; title: string; points: { lat: number; lon: number; label: string; detail: string; color?: string }[] }
  | { type: "heatmap"; title: string; rowLabels: string[]; colLabels: string[]; values: number[][]; totals?: boolean };

export type ToolResult = {
  tool: string;
  text: string;                 // deterministic, correct draft answer (markdown)
  facts: any;                   // compact data for the model
  visuals: Partial<Record<VisualType, Visual>>;
  defaultVisual: VisualType | null;
  citations: Citation[];
  entities: string[];           // wells the answer is about, in display order (for per-user memory)
};

export function pickVisual(r: ToolResult, requested?: VisualType | null): Visual | null {
  if (requested && r.visuals[requested]) return r.visuals[requested]!;
  if (requested === "table") {
    // Any visual can become a table.
    const v = r.defaultVisual ? r.visuals[r.defaultVisual] : null;
    if (v && "rows" in v && "series" in v) return { type: "table", title: v.title, columns: [{ key: v.x, label: v.x }, ...v.series], rows: v.rows };
    if (v?.type === "heatmap") return { type: "table", title: v.title, columns: [{ key: "row", label: "" }, ...v.colLabels.map((c) => ({ key: c, label: c }))], rows: v.rowLabels.map((rl, i) => ({ row: rl, ...Object.fromEntries(v.colLabels.map((c, j) => [c, v.values[i][j]])) })) };
    if (v?.type === "map") return { type: "table", title: v.title, columns: [{ key: "label", label: "Well" }, { key: "detail", label: "Detail" }, { key: "lat", label: "Lat" }, { key: "lon", label: "Lon" }], rows: v.points };
    if (v?.type === "status_card") return { type: "table", title: v.title, columns: [{ key: "label", label: "" }, { key: "value", label: "" }], rows: v.fields };
  }
  return r.defaultVisual ? r.visuals[r.defaultVisual] ?? null : null;
}

/** Every visual the answer's data supports, for the switch buttons under an answer. Always
 *  includes a table when there are rows; the client switches between them without a new request. */
export function allVisuals(r: ToolResult): Partial<Record<VisualType, Visual>> {
  const out: Partial<Record<VisualType, Visual>> = { ...r.visuals };
  if (!out.table) { const t = pickVisual(r, "table"); if (t?.type === "table") out.table = t; }
  for (const k of Object.keys(out) as VisualType[]) {
    const v = out[k]!;
    const empty = (v.type === "map" && !v.points.length) || ((v.type === "table" || v.type === "bar" || v.type === "line") && !v.rows.length);
    if (empty && k !== r.defaultVisual) delete out[k];
  }
  return out;
}

export function detectRequestedVisual(q: string): VisualType | null {
  const t = q.toLowerCase();
  if (/heat ?map/.test(t)) return "heatmap";
  if (/\bmap\b|on a map|locations?\b(?! of the)|^where\b|\bwhere (are|is|were|did)\b/.test(t)) return "map";
  if (/line chart|line graph|trend|over time/.test(t)) return "line";
  if (/bar chart|bar graph|\bbars?\b|compare/.test(t)) return "bar";
  if (/\btable\b|\blist them\b/.test(t)) return "table";
  if (/status card|\bcard\b/.test(t)) return "status_card";
  return null;
}
