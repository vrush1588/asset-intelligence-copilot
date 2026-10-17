import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Returns the record or document behind a citation chip.
export async function GET(req: Request) {
  const u = new URL(req.url);
  const type = u.searchParams.get("type") ?? "";
  const id = u.searchParams.get("id") ?? "";
  const d = db();
  const one = (sql: string, ...p: any[]) => d.prepare(sql).get(...p) as any;
  let body: any = null;
  let title = id;
  switch (type) {
    case "inspection": body = one(`SELECT * FROM inspections WHERE inspection_id=?`, id); if (body) body.corrections = d.prepare(`SELECT * FROM corrections WHERE inspection_id=?`).all(id); break;
    case "maintenance": body = one(`SELECT * FROM maintenance WHERE maintenance_id=?`, id); break;
    case "report": { const r = one(`SELECT path, text FROM reports WHERE maintenance_id=?`, id); if (r) { title = r.path; body = r.text; } break; }
    case "reg_event": body = one(`SELECT * FROM reg_events WHERE event_id=?`, id); break;
    case "note": body = one(`SELECT * FROM notes WHERE note_id=?`, id); break;
    case "correction": body = one(`SELECT * FROM corrections WHERE id=?`, Number(id.replace(/\D/g, ""))); break;
    case "shared_fact": body = one(`SELECT * FROM shared_facts WHERE id=?`, Number(id.replace(/\D/g, ""))); break;
    case "rule_override": body = one(`SELECT * FROM rule_overrides WHERE id=?`, Number(id.replace(/\D/g, ""))); break;
    case "doc": { const r = one(`SELECT title, text FROM docs WHERE doc_id=?`, id); if (r) { title = r.title; body = r.text; } break; }
    default: body = null;
  }
  if (body === null || body === undefined) {
    // Reports may be cited by maintenance id; fall back to a report lookup.
    const r = one(`SELECT path, text FROM reports WHERE maintenance_id=?`, id);
    if (r) { title = r.path; body = r.text; }
  }
  if (body === null || body === undefined) return NextResponse.json({ error: `No ${type} ${id}` }, { status: 404 });
  return NextResponse.json({ type, id, title, body });
}
