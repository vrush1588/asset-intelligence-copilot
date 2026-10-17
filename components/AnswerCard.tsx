"use client";
// One assistant answer: text, visual with switch buttons, sources, follow-up chips,
// 👍 / 👎 and the "Correct this" form.
import { useEffect, useState } from "react";
import Markdown from "./Markdown";
import VisualView from "./visuals";
import type { Visual, VisualType } from "@/lib/visual";

export type Citation = { type: string; id: string; label?: string; asset_id?: string };
export type Msg = {
  role: "user" | "assistant"; content: string; id?: number; visual?: Visual | null; visuals?: Partial<Record<VisualType, Visual>>;
  followups?: string[]; citations?: Citation[]; tool?: string; router?: string; needsConfirmation?: boolean; pending?: boolean; rating?: 1 | -1;
};

export const CHIP: Record<string, string> = {
  inspection: "Inspection", maintenance: "Repair", report: "Report", reg_event: "Regulator", note: "Note", doc: "Doc",
  correction: "Correction", shared_fact: "Shared note", rule_override: "Team rule", dataset: "Data", sql: "SQL",
};
const VIEW_LABEL: Record<VisualType, string> = { status_card: "Card", table: "Table", line: "Line chart", bar: "Bar chart", map: "Map", heatmap: "Heatmap" };
const VIEW_ORDER: VisualType[] = ["status_card", "line", "bar", "heatmap", "map", "table"];

type Props = {
  m: Msg; userId: string; busy: boolean;
  onAsk: (q: string) => void; onSource: (c: Citation) => void;
  onCorrected: (userLine: string, answer: any) => void; conversationId: number | null;
};

export default function AnswerCard({ m, userId, busy, onAsk, onSource, onCorrected, conversationId }: Props) {
  // The answer's own visual first, then the other views of the same data.
  const views = VIEW_ORDER.filter((k) => m.visuals?.[k]).sort((a, b) => Number(b === m.visual?.type) - Number(a === m.visual?.type));
  const [view, setView] = useState<VisualType | null>(m.visual?.type ?? null);
  const [rating, setRating] = useState<1 | -1 | undefined>(m.rating);
  const [comment, setComment] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState(false);
  const shown = (view && m.visuals?.[view]) || m.visual || null;

  async function rate(r: 1 | -1, text?: string) {
    if (!m.id) return;
    setRating(r);
    await fetch("/api/rate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId, messageId: m.id, rating: r, comment: text }) });
  }

  return (
    <div className="my-4">
      <div className={`rounded-2xl rounded-bl-sm border bg-panel px-4 py-3 ${m.needsConfirmation ? "border-warn" : "border-line"}`}>
        {m.pending ? <span className="animate-pulse text-muted">Looking through the records…</span> : <Markdown text={m.content} />}

        {views.length > 1 && (
          <div className="mt-3 inline-flex rounded-lg border border-line bg-panel-2 p-0.5 text-xs" role="tablist" aria-label="Show as">
            {views.map((k) => (
              <button key={k} role="tab" aria-selected={shown?.type === k} onClick={() => setView(k)}
                className={`rounded-md px-2.5 py-1 ${shown?.type === k ? "bg-panel font-semibold shadow-sm" : "text-muted hover:text-ink"}`}>
                {VIEW_LABEL[k]}
              </button>
            ))}
          </div>
        )}
        {shown && <VisualView key={shown.type} v={shown} />}

        {!!m.citations?.length && (
          <div className="mt-3 flex flex-wrap gap-1.5 border-t border-line pt-2">
            <span className="text-xs text-muted">Sources:</span>
            {m.citations.slice(0, 24).map((c, j) => (
              <button key={j} onClick={() => onSource(c)} title={c.label} className="rounded-full bg-panel-2 px-2 py-0.5 text-xs hover:bg-accent-soft">
                <span className="text-muted">{CHIP[c.type] ?? c.type}</span> {c.id}
              </button>
            ))}
            {m.citations.length > 24 && <span className="text-xs text-muted">+{m.citations.length - 24} more</span>}
          </div>
        )}

        {!m.pending && m.id && (
          <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-line pt-2 text-xs">
            <button onClick={() => rate(1)} aria-label="Helpful" className={`rounded-md px-2 py-1 ${rating === 1 ? "bg-good-soft text-good" : "text-muted hover:bg-panel-2"}`}>👍</button>
            <button onClick={() => { setComment(""); rate(-1); }} aria-label="Not helpful" className={`rounded-md px-2 py-1 ${rating === -1 ? "bg-bad-soft text-bad" : "text-muted hover:bg-panel-2"}`}>👎</button>
            <button onClick={() => setCorrecting(true)} className="rounded-md border border-line px-2 py-1 text-muted hover:border-accent hover:text-ink">✎ Correct this</button>
            {comment !== null && (
              <form className="flex flex-1 gap-1" onSubmit={(e) => { e.preventDefault(); rate(-1, comment); setComment(null); }}>
                <input autoFocus value={comment} onChange={(e) => setComment(e.target.value)} placeholder="What was wrong? (optional)" className="min-w-0 flex-1 rounded-md border border-line bg-panel-2 px-2 py-1" />
                <button className="rounded-md bg-panel-2 px-2">Send</button>
              </form>
            )}
          </div>
        )}
      </div>

      {!m.pending && !!m.followups?.length && (
        <div className="mt-2 flex flex-wrap gap-1.5 pl-1">
          {m.followups.map((q) => (
            <button key={q} disabled={busy} onClick={() => onAsk(q)} className="rounded-full border border-line bg-panel px-3 py-1 text-xs text-accent hover:border-accent disabled:opacity-50">
              {q}
            </button>
          ))}
        </div>
      )}
      {m.tool && <div className="mt-1 pl-2 text-[11px] text-muted">tool: {m.tool}{m.router ? ` · routed by ${m.router}` : ""}</div>}

      {correcting && (
        <CorrectionForm
          inspections={[...new Set((m.citations ?? []).filter((c) => c.type === "inspection").map((c) => c.id))]}
          userId={userId} conversationId={conversationId}
          onClose={() => setCorrecting(false)}
          onDone={(line, a) => { setCorrecting(false); onCorrected(line, a); }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
const FIELDS = [
  { key: "wellhead_temp_c", label: "Wellhead temperature (°C)", kind: "raw data" },
  { key: "ambient_temp_c", label: "Air temperature (°C)", kind: "raw data" },
  { key: "spill_est_volume_bbl", label: "Spill volume (bbl)", kind: "AI analysis" },
  { key: "spill_detected", label: "Not a real spill", kind: "AI analysis" },
];

function CorrectionForm({ inspections, userId, conversationId, onClose, onDone }: {
  inspections: string[]; userId: string; conversationId: number | null;
  onClose: () => void; onDone: (userLine: string, answer: any) => void;
}) {
  const [insp, setInsp] = useState(inspections[0] ?? "");
  const [current, setCurrent] = useState<any>(null);
  const [field, setField] = useState("wellhead_temp_c");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!/^INS-\d+-\d+$/i.test(insp.trim())) { setCurrent(null); return; }
    fetch(`/api/correct?inspection_id=${encodeURIComponent(insp.trim())}`).then((r) => r.json()).then((r) => setCurrent(r.error ? null : r));
  }, [insp]);

  const currentValue = current && field !== "spill_detected" ? current[field] : null;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!insp.trim()) return setError("Choose or type an inspection ID.");
    if (field !== "spill_detected" && !Number.isFinite(Number(value))) return setError("Enter the new value as a number.");
    if (!reason.trim()) return setError("Say why, so other users can trust the correction.");
    setSaving(true);
    const r = await fetch("/api/correct", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, conversationId, inspection_id: insp.trim(), field, value: Number(value), reason }) });
    const a = await r.json();
    setSaving(false);
    if (!r.ok) return setError(a.error ?? "Could not save the correction.");
    const label = FIELDS.find((f) => f.key === field)!.label;
    onDone(`Correction for ${insp.trim().toUpperCase()}: ${field === "spill_detected" ? "not a real spill" : `${label} → ${value}`}. Reason: ${reason}`, a);
  }

  return (
    <div className="fixed inset-0 z-1000 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <form onSubmit={submit} onClick={(e) => e.stopPropagation()} className="w-full max-w-md space-y-3 rounded-xl bg-panel p-5 text-sm shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Correct this</h2>
          <button type="button" onClick={onClose} className="rounded px-2 text-muted hover:bg-panel-2" aria-label="Close">✕</button>
        </div>
        <p className="text-muted">The original value is kept. Your correction, with your name and reason, is used in every later answer for every user.</p>

        <label className="block">
          <span className="font-medium">Inspection</span>
          <input list="insp-options" value={insp} onChange={(e) => setInsp(e.target.value)} placeholder="INS-0164-0205"
            className="mt-1 w-full rounded-lg border border-line bg-panel-2 px-2 py-1.5" />
          <datalist id="insp-options">{inspections.map((i) => <option key={i} value={i} />)}</datalist>
          {current && (
            <span className="mt-1 block text-xs text-muted">
              {current.asset_id} · {current.inspected_at.slice(0, 10)} · wellhead {current.wellhead_temp_c} °C · air {current.ambient_temp_c} °C
              {current.spill_detected ? ` · spill ${current.spill_est_volume_bbl} bbl` : " · no spill"}{current.notes ? ` · "${current.notes}"` : ""}
            </span>
          )}
        </label>

        <label className="block">
          <span className="font-medium">What is wrong</span>
          <select value={field} onChange={(e) => setField(e.target.value)} className="mt-1 w-full rounded-lg border border-line bg-panel-2 px-2 py-1.5">
            {FIELDS.map((f) => <option key={f.key} value={f.key} disabled={!!current && !current.spill_detected && f.kind === "AI analysis"}>{f.label} — {f.kind}</option>)}
          </select>
        </label>

        {field !== "spill_detected" && (
          <label className="block">
            <span className="font-medium">Correct value</span>{currentValue !== null && currentValue !== undefined && <span className="text-muted"> (now {currentValue})</span>}
            <input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="41.0"
              className="mt-1 w-full rounded-lg border border-line bg-panel-2 px-2 py-1.5" />
          </label>
        )}

        <label className="block">
          <span className="font-medium">Reason</span>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="The handheld thermal gun was faulty; the crew re-measured the wellhead."
            className="mt-1 w-full rounded-lg border border-line bg-panel-2 px-2 py-1.5" />
        </label>

        {error && <p className="text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-muted hover:bg-panel-2">Cancel</button>
          <button disabled={saving} className="rounded-lg bg-accent px-3 py-1.5 font-semibold text-white disabled:opacity-50">{saving ? "Saving…" : "Save correction"}</button>
        </div>
      </form>
    </div>
  );
}
