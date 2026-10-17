import { NextResponse } from "next/server";
import path from "node:path";
import { users, areas, today } from "@/lib/domain";
import { db, currentDbPath } from "@/lib/db";
import { llmHealth, llmInfo } from "@/lib/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const raw = (db().prepare(`SELECT value FROM meta WHERE key='health'`).get() as any)?.value;
    const health = raw ? JSON.parse(raw) : null;
    if (health && process.env.COPILOT_TODAY) health.summary.today_setting = process.env.COPILOT_TODAY;
    return NextResponse.json({
      users: users(), areas: areas(), teams: db().prepare(`SELECT * FROM teams ORDER BY team_id`).all(), today: today(), health, db: path.basename(currentDbPath()),
      llm: { ...llmInfo(), ...(await llmHealth()) },
    });
  } catch (e) {
    return NextResponse.json({ error: `Database not ready — run "npm run ingest -- <dataset>" first. ${(e as Error).message}` }, { status: 500 });
  }
}
