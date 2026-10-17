import { NextResponse } from "next/server";
import { correct } from "@/lib/agent";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "Correct this" form.
// GET ?inspection_id=INS-0164-0205 → current values, to prefill the form.
// POST { userId, conversationId?, inspection_id, field, value, reason } → the copilot's reply.
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("inspection_id")?.trim().toUpperCase();
  const row = id ? db().prepare(`SELECT inspection_id, asset_id, inspected_at, ambient_temp_c, wellhead_temp_c, spill_detected, spill_est_volume_bbl, notes FROM inspections WHERE inspection_id=?`).get(id) : null;
  return row ? NextResponse.json(row) : NextResponse.json({ error: `No inspection ${id}` }, { status: 404 });
}

export async function POST(req: Request) {
  const b = await req.json();
  if (!b.userId || !b.inspection_id || !b.field || !b.reason?.trim()) return NextResponse.json({ error: "userId, inspection_id, field and reason are required" }, { status: 400 });
  if (b.field !== "spill_detected" && !Number.isFinite(Number(b.value))) return NextResponse.json({ error: "A numeric new value is required" }, { status: 400 });
  try {
    return NextResponse.json(correct({ userId: b.userId, conversationId: b.conversationId ?? undefined, inspection_id: b.inspection_id, field: b.field, value: Number(b.value), reason: b.reason.trim() }));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
