"use client";
import dynamic from "next/dynamic";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend, BarChart, Bar, ReferenceDot, ReferenceArea, LabelList,
} from "recharts";
import type { Visual } from "@/lib/visual";
import { Inline } from "./Markdown";

const MapView = dynamic(() => import("./MapView"), { ssr: false, loading: () => <div className="h-80 animate-pulse rounded-lg bg-panel-2" /> });

const axis = { stroke: "var(--muted)", fontSize: 12 };
const tooltipStyle = { background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text)" };

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <figure className="mt-3 rounded-xl border border-line bg-panel p-3">
      <figcaption className="mb-2 text-sm font-semibold text-muted">{title}</figcaption>
      {children}
    </figure>
  );
}

export default function VisualView({ v }: { v: Visual }) {
  switch (v.type) {
    case "status_card": {
      const good = v.status === "producing";
      return (
        <div className="mt-3 overflow-hidden rounded-xl border border-line bg-panel">
          <div className={`flex items-center justify-between px-4 py-3 ${good ? "bg-good-soft" : "bg-bad-soft"}`}>
            <div className="font-semibold">{v.title}</div>
            <span className={`rounded-full px-3 py-1 text-sm font-semibold text-white ${good ? "bg-good" : "bg-bad"}`}>{v.headline}</span>
          </div>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 px-4 py-3 text-sm sm:grid-cols-[max-content_1fr]">
            {v.fields.map((f) => (
              <div key={f.label} className="contents">
                <dt className="text-muted">{f.label}</dt>
                <dd className="font-medium">{f.value}</dd>
              </div>
            ))}
          </dl>
          {v.alerts.length > 0 && (
            <ul className="space-y-1 border-t border-line bg-warn-soft px-4 py-2 text-sm text-warn">
              {v.alerts.map((a, i) => <li key={i}>⚠ {a}</li>)}
            </ul>
          )}
        </div>
      );
    }
    case "table":
      return (
        <Frame title={`${v.title} · ${v.rows.length} row${v.rows.length === 1 ? "" : "s"}`}>
          <div className="max-h-[28rem] overflow-auto">
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 bg-panel">
                <tr>{v.columns.map((c) => <th key={c.key} className="border-b border-line px-2 py-1.5 text-left font-semibold whitespace-nowrap text-muted">{c.label}</th>)}</tr>
              </thead>
              <tbody>
                {v.rows.map((r, i) => (
                  <tr key={i} className="align-top odd:bg-panel-2/50">
                    {v.columns.map((c) => <td key={c.key} className="border-b border-line px-2 py-1.5"><Inline text={r[c.key] === null || r[c.key] === undefined ? "—" : String(r[c.key])} /></td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Frame>
      );
    case "line":
      return (
        <Frame title={v.title}>
          <div className="h-80">
            <ResponsiveContainer>
              <LineChart data={v.rows} margin={{ top: 10, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis dataKey={v.x} tick={axis} tickFormatter={(d) => String(d).slice(5)} />
                <YAxis tick={axis} unit={v.yLabel === "°C" ? "°" : ""} />
                <Tooltip contentStyle={tooltipStyle} />
                <Legend />
                {(v.markers ?? []).map((m) => <ReferenceArea key={m.x} x1={m.x} x2={m.x} stroke="var(--bad)" strokeOpacity={0.6} strokeWidth={10} />)}
                {v.series.map((s, i) => <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={i ? "var(--series-2)" : "var(--series-1)"} strokeWidth={2} dot={{ r: 3 }} />)}
                {(v.markers ?? []).map((m) => {
                  const row = v.rows.find((r) => r[v.x] === m.x);
                  return row ? <ReferenceDot key={`d${m.x}`} x={m.x} y={row[v.series[0].key]} r={6} fill="var(--bad)" stroke="white" /> : null;
                })}
              </LineChart>
            </ResponsiveContainer>
          </div>
          {(v.markers?.length ?? 0) > 0 && <p className="mt-1 text-xs text-muted">Red markers: readings where the well was not producing oil.</p>}
        </Frame>
      );
    case "bar":
      return (
        <Frame title={v.title}>
          <div style={{ height: Math.max(220, Math.min(480, 60 + v.rows.length * 34)) }}>
            <ResponsiveContainer>
              <BarChart data={v.rows} layout="vertical" margin={{ top: 4, right: 40, bottom: 0, left: 8 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" tick={axis} />
                <YAxis type="category" dataKey={v.x} tick={axis} width={110} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--panel-2)" }} />
                {v.series.map((s) => (
                  <Bar key={s.key} dataKey={s.key} name={s.label} fill="var(--series-1)" radius={[0, 4, 4, 0]} maxBarSize={28}>
                    <LabelList dataKey={s.key} position="right" fill="var(--text)" fontSize={12} />
                  </Bar>
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Frame>
      );
    case "map":
      return <Frame title={`${v.title} · ${v.points.length} location${v.points.length === 1 ? "" : "s"}`}><MapView points={v.points} /></Frame>;
    case "heatmap": {
      const max = Math.max(1, ...v.values.flat());
      return (
        <Frame title={v.title}>
          <div className="overflow-x-auto">
            <table className="border-separate border-spacing-1 text-sm">
              <thead>
                <tr>
                  <th />
                  {v.colLabels.map((c) => <th key={c} className="px-1 text-center font-medium text-muted">{c}</th>)}
                  {v.totals && <th className="px-2 text-center font-semibold text-muted">Total</th>}
                </tr>
              </thead>
              <tbody>
                {v.rowLabels.map((rl, i) => (
                  <tr key={rl}>
                    <th className="pr-2 text-left font-medium whitespace-nowrap">{rl}</th>
                    {v.values[i].map((val, j) => (
                      <td key={j} title={`${rl} · ${v.colLabels[j]}: ${val}`} className="h-9 min-w-9 rounded text-center font-medium"
                        style={{ background: `color-mix(in srgb, var(--bad) ${Math.round((val / max) * 85)}%, var(--panel-2))`, color: val / max > 0.55 ? "white" : "var(--text)" }}>
                        {val}
                      </td>
                    ))}
                    {v.totals && <td className="px-2 text-center font-bold">{v.values[i].reduce((a, b) => a + b, 0)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Frame>
      );
    }
    default:
      return null;
  }
}
