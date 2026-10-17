"use client";
// User picker: initials avatars coloured by role, users grouped by role, search, keyboard support.
import { useEffect, useMemo, useRef, useState } from "react";

export type User = { user_id: string; name: string; role: string; team_id: string };

// Role → group and avatar colour. Unknown roles from a new dataset fall into "Other".
const ROLE_STYLE: Record<string, { group: string; color: string }> = {
  production_supervisor: { group: "Production", color: "#2563eb" },
  field_operator: { group: "Field", color: "#16a34a" },
  field_inspector: { group: "Field", color: "#7c3aed" },
  maintenance_lead: { group: "Maintenance", color: "#ea580c" },
  maintenance_technician: { group: "Maintenance", color: "#ea580c" },
  hse_officer: { group: "HSE", color: "#dc2626" },
};
const GROUP_ORDER = ["Production", "Field", "Maintenance", "HSE", "Other"];
const styleOf = (role: string) => ROLE_STYLE[role] ?? { group: "Other", color: "#64748b" };

export const roleLabel = (role: string) => role.replace(/_/g, " ");
export const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).map((p) => p[0]).filter((ch) => /\p{L}/u.test(ch)).slice(0, 2).join("").toUpperCase() || "?";

export function Avatar({ user, size = 28 }: { user: Pick<User, "name" | "role">; size?: number }) {
  return (
    <span aria-hidden className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, background: styleOf(user.role).color, fontSize: Math.round(size * 0.4) }}>
      {initials(user.name)}
    </span>
  );
}

export function UserPicker({ users, value, onChange, compact = false }: { users: User[]; value: string; onChange: (id: string) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const me = users.find((u) => u.user_id === value);

  // Filtered users in display order (by group), and the same list grouped for rendering.
  const { flat, groups } = useMemo(() => {
    const t = q.trim().toLowerCase();
    const match = users.filter((u) => !t || u.name.toLowerCase().includes(t) || roleLabel(u.role).includes(t) || u.team_id.toLowerCase().includes(t));
    const groups = GROUP_ORDER.map((g) => ({ g, list: match.filter((u) => styleOf(u.role).group === g) })).filter((x) => x.list.length);
    return { flat: groups.flatMap((x) => x.list), groups };
  }, [users, q]);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setActive(Math.max(0, users.findIndex((u) => u.user_id === value)));
    setTimeout(() => search.current?.focus(), 0);
    const close = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (active >= flat.length) setActive(Math.max(0, flat.length - 1)); }, [flat.length, active]);
  useEffect(() => { root.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [active]);

  const choose = (id: string) => { onChange(id); setOpen(false); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(flat.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); if (flat[active]) choose(flat[active].user_id); }
    else if (e.key === "Escape") setOpen(false);
  };

  let index = -1;
  return (
    <div ref={root} className="relative" onKeyDown={open ? onKey : undefined}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}
        className={`flex w-full items-center gap-2 rounded-lg border border-line bg-panel-2 text-left hover:border-accent ${compact ? "px-2 py-1" : "px-2.5 py-2"}`}>
        {me ? <Avatar user={me} size={compact ? 24 : 32} /> : <span className="h-8 w-8 rounded-full bg-line" />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{me?.name ?? "Choose a user"}</span>
          {!compact && me && <span className="block truncate text-xs capitalize text-muted">{roleLabel(me.role)}</span>}
        </span>
        <span aria-hidden className="text-muted">▾</span>
      </button>

      {open && (
        <div className={`absolute z-1000 mt-1 rounded-xl border border-line bg-panel shadow-xl ${compact ? "right-0 w-72" : "left-0 right-0"}`}>
          <div className="border-b border-line p-2">
            <input ref={search} value={q} onChange={(e) => { setQ(e.target.value); setActive(0); }} placeholder="Search name, role or team…"
              aria-label="Search users" className="w-full rounded-md border border-line bg-panel-2 px-2 py-1.5 text-sm outline-none focus:border-accent" />
          </div>
          <ul role="listbox" aria-label="Users" className="max-h-80 overflow-y-auto py-1">
            {groups.map(({ g, list }) => (
              <li key={g} role="presentation">
                <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{g}</div>
                <ul role="presentation">
                  {list.map((u) => {
                    index++;
                    const i = index;
                    const selected = u.user_id === value;
                    return (
                      <li key={u.user_id} role="option" aria-selected={selected} data-index={i}
                        onMouseEnter={() => setActive(i)} onClick={() => choose(u.user_id)}
                        className={`flex cursor-pointer items-center gap-2.5 px-3 py-1.5 ${i === active ? "bg-accent-soft" : ""}`}>
                        <Avatar user={u} size={30} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold">{u.name}</span>
                          <span className="block truncate text-xs capitalize text-muted">{roleLabel(u.role)}</span>
                        </span>
                        {selected && <span className="text-accent" aria-hidden>✓</span>}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
            {!flat.length && <li className="px-3 py-2 text-sm text-muted">No one matches “{q}”.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
