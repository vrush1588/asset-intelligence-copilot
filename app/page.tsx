"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "@/components/Markdown";
import AnswerCard, { CHIP, type Msg, type Citation } from "@/components/AnswerCard";
import { UserPicker, Avatar, roleLabel, type User } from "@/components/UserPicker";


const SUGGESTIONS = [
  "Is WELL-0001 producing oil right now? Show me its status card.",
  "Which wells in my area are not producing oil right now, and why?",
  "Which 3 wells in Northeast Block 7 had the most downtime in the last 4 months?",
  "Show a heatmap of 2026 spills by geographic area and month.",
  "Which rules has WELL-0001 broken in the last 12 months, and what is still open?",
  "Show on a map every well in Northeast Block 8 with a real spill in the last 90 days.",
];


export default function Home() {
  const [meta, setMeta] = useState<{ users: User[]; teams?: any[]; today: string; llm: any; health?: any; error?: string } | null>(null);
  const [userId, setUserId] = useState("U-201");
  const [convs, setConvs] = useState<any[]>([]);
  const [convId, setConvId] = useState<number | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<any>(null);
  const [switched, setSwitched] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Polls so the sidebar follows a dataset reload without refreshing the page.
    const load = () => fetch("/api/meta").then((r) => r.json()).then(setMeta).catch((e) => setMeta({ users: [], today: "", llm: null, error: String(e) }));
    load();
    const t = setInterval(load, 5000);
    try { const u = localStorage.getItem("copilot-user"); if (u) setUserId(u); } catch {}
    return () => clearInterval(t);
  }, []);

  const loadConvs = useCallback(async (uid: string) => {
    const r = await fetch(`/api/conversations?userId=${uid}`).then((r) => r.json());
    setConvs(r.conversations ?? []);
  }, []);

  useEffect(() => {
    loadConvs(userId);
    setConvId(null);
    setMsgs([]);
    try { localStorage.setItem("copilot-user", userId); } catch {}
  }, [userId, loadConvs]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs]);

  async function openConv(id: number) {
    const r = await fetch(`/api/conversations?userId=${userId}&id=${id}`).then((r) => r.json());
    setConvId(id);
    setMsgs((r.messages ?? []).map((m: any) => ({ role: m.role, content: m.content, id: m.id, rating: m.rating ?? undefined, ...(m.payload ?? {}) })));
  }

  async function send(q: string) {
    if (!q.trim() || busy) return;
    setInput("");
    setBusy(true);
    setMsgs((m) => [...m, { role: "user", content: q }, { role: "assistant", content: "", pending: true }]);
    try {
      const r = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId, question: q, conversationId: convId }) });
      const a = await r.json();
      if (!r.ok) throw new Error(a.error ?? r.statusText);
      setConvId(a.conversationId);
      setMsgs((m) => [...m.slice(0, -1), toMsg(a)]);
      loadConvs(userId);
    } catch (e) {
      setMsgs((m) => [...m.slice(0, -1), { role: "assistant", content: `Something went wrong: ${(e as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  }

  function toMsg(a: any): Msg {
    return { role: "assistant", content: a.text, id: a.messageId, visual: a.visual, visuals: a.visuals, followups: a.followups,
      citations: a.citations, tool: a.tool, router: a.router, needsConfirmation: a.needsConfirmation };
  }

  function onCorrected(userLine: string, a: any) {
    setConvId(a.conversationId);
    setMsgs((m) => [...m, { role: "user", content: userLine }, toMsg(a)]);
    loadConvs(userId);
  }

  async function openSource(c: Citation) {
    setSource({ loading: true, title: `${CHIP[c.type] ?? c.type} ${c.id}` });
    const r = await fetch(`/api/source?type=${encodeURIComponent(c.type)}&id=${encodeURIComponent(c.id)}`).then((r) => r.json());
    setSource(r.error ? { title: c.id, body: c.label ?? r.error } : r);
  }

  const me = meta?.users.find((u) => u.user_id === userId);
  const teamName = (id: string) => meta?.teams?.find((t: any) => t.team_id === id)?.name ?? "";

  function switchUser(id: string) {
    if (id === userId) return;
    setUserId(id);
    const u = meta?.users.find((x) => x.user_id === id);
    setSwitched(u?.name ?? id);
    setTimeout(() => setSwitched(null), 4000);
  }

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className="hidden w-72 shrink-0 flex-col border-r border-line bg-panel md:flex">
        <div className="border-b border-line p-4">
          <div className="text-lg font-bold">Asset Copilot</div>
          <div className="text-xs text-muted">Oil field · today {meta?.today ?? "…"}</div>
        </div>
        <div className="space-y-2 p-4">
          <div className="text-xs font-semibold text-muted">Signed in as</div>
          <UserPicker users={meta?.users ?? []} value={userId} onChange={switchUser} />
          <button onClick={() => { setConvId(null); setMsgs([]); }} className="w-full rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:opacity-90">+ New chat</button>
        </div>
        <div className="px-4 pb-1 text-xs font-semibold text-muted">Your conversations (private)</div>
        <nav className="flex-1 overflow-y-auto px-2 pb-4">
          {convs.length === 0 && <p className="px-2 text-sm text-muted">None yet.</p>}
          {convs.map((c) => (
            <button key={c.id} onClick={() => openConv(c.id)} className={`block w-full truncate rounded-lg px-2 py-1.5 text-left text-sm hover:bg-panel-2 ${c.id === convId ? "bg-accent-soft font-medium" : ""}`}>
              {c.title}
              <span className="block text-xs text-muted">{c.created_at.slice(0, 10)}</span>
            </button>
          ))}
        </nav>
        <div className="space-y-1 border-t border-line p-3 text-xs text-muted">
          {meta?.health && (
            <details>
              <summary className="cursor-pointer">
                Data: {meta.health.summary.wells} wells · latest {meta.health.summary.latest_inspection}
                {meta.health.errors.length > 0 && <span className="ml-1 rounded bg-bad px-1.5 font-semibold text-white">{meta.health.errors.length} error{meta.health.errors.length > 1 ? "s" : ""}</span>}
                {meta.health.warnings.length > 0 && <span className="ml-1 rounded bg-warn-soft px-1.5 text-warn">{meta.health.warnings.length} warning{meta.health.warnings.length > 1 ? "s" : ""}</span>}
              </summary>
              <div className="mt-1 max-h-56 space-y-1 overflow-y-auto">
                <div>{meta.health.summary.inspections} inspections · {meta.health.summary.repairs} repairs · types {meta.health.summary.well_types.join(", ")}</div>
                <div>Areas: {meta.health.summary.areas.join(", ")}</div>
                <div>Folders: {meta.health.summary.roots.map((r: string) => r.split(/[\\/]/).slice(-2).join("/")).join(", ")}</div>
                {meta.health.errors.map((e: string, i: number) => <div key={`e${i}`} className="text-bad">✖ {e}</div>)}
                {meta.health.warnings.map((w: string, i: number) => <div key={`w${i}`} className="text-warn">⚠ {w}</div>)}
              </div>
            </details>
          )}
          <div>Model: {meta?.llm ? <span className={meta.llm.ok ? "text-good" : "text-bad"}>{meta.llm.detail}</span> : "…"}</div>
        </div>
      </aside>

      {/* Chat */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-line bg-panel px-4 py-2">
          <span className="font-bold md:hidden">Asset Copilot</span>
          {me && (
            <div key={me.user_id} className="hidden min-w-0 items-center gap-2 text-sm md:flex">
              <span className="text-muted">Chatting as</span>
              <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-good" />
              <Avatar user={me} size={22} />
              <span className="truncate"><strong>{me.name}</strong> <span className="text-muted">({roleLabel(me.role)}{teamName(me.team_id) ? ` · ${teamName(me.team_id)}` : ""})</span></span>
            </div>
          )}
          <span className="ml-auto hidden text-xs text-muted lg:inline">🔒 Conversations are private to each user</span>
          <div className="ml-auto w-44 md:hidden"><UserPicker users={meta?.users ?? []} value={userId} onChange={switchUser} compact /></div>
        </header>
        {switched && (
          <div role="status" className="border-b border-line bg-accent-soft px-4 py-1.5 text-center text-xs">
            Switched to <strong>{switched}</strong>. Showing only {switched.split(" ")[0]}&apos;s conversations; shared notes and corrections still apply.
          </div>
        )}
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-4xl px-4 py-6">
            {meta?.error && <div className="mb-4 rounded-lg bg-bad-soft p-3 text-sm text-bad">{meta.error}</div>}
            {msgs.length === 0 && (
              <div className="mt-8">
                <h1 className="text-2xl font-bold">Hi {me?.name.split(" ")[0] ?? ""}, what would you like to know?</h1>
                <p className="mt-1 text-muted">Ask about wells, downtime, spills, repairs and compliance. You can also correct data or share notes, e.g. “The 15 Oct reading for WELL-0164 is wrong…”.</p>
                <div className="mt-6 grid gap-2 sm:grid-cols-2">
                  {SUGGESTIONS.map((s) => <button key={s} onClick={() => send(s)} className="rounded-xl border border-line bg-panel p-3 text-left text-sm hover:border-accent">{s}</button>)}
                </div>
              </div>
            )}
            {msgs.map((m, i) => m.role === "user" ? (
              <div key={i} className="my-4 flex justify-end">
                <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-accent px-4 py-2 text-white">{m.content}</div>
              </div>
            ) : (
              <AnswerCard key={`${convId}-${i}`} m={m} userId={userId} busy={busy} conversationId={convId}
                onAsk={send} onSource={openSource} onCorrected={onCorrected} />
            ))}
            <div ref={endRef} />
          </div>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); send(input); }} className="border-t border-line bg-panel p-3">
          <div className="mx-auto flex max-w-4xl gap-2">
            <input value={input} onChange={(e) => setInput(e.target.value)} disabled={busy} placeholder={`Ask as ${me?.name ?? "…"} — e.g. "Which wells in my area were down the longest this summer, and why?"`}
              className="flex-1 rounded-xl border border-line bg-panel-2 px-4 py-3 outline-none focus:border-accent" />
            <button disabled={busy || !input.trim()} className="rounded-xl bg-accent px-5 font-semibold text-white disabled:opacity-40">Ask</button>
          </div>
        </form>
      </main>

      {/* Source drawer */}
      {source && (
        <div className="fixed inset-0 z-[1000] flex justify-end bg-black/30" onClick={() => setSource(null)}>
          <div className="h-full w-full max-w-xl overflow-y-auto bg-panel p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="font-semibold">{source.title}</h2>
              <button onClick={() => setSource(null)} className="rounded px-2 text-muted hover:bg-panel-2" aria-label="Close">✕</button>
            </div>
            {source.loading ? <p className="text-muted">Loading…</p>
              : typeof source.body === "string" ? <Markdown text={source.body} />
                : <pre className="overflow-x-auto rounded-lg bg-panel-2 p-3 text-xs">{JSON.stringify(source.body, null, 2)}</pre>}
          </div>
        </div>
      )}
    </div>
  );
}
