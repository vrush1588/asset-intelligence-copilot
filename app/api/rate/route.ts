import { NextResponse } from "next/server";
import { rateAnswer } from "@/lib/memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 👍 / 👎 on an answer: { userId, messageId, rating: 1 | -1, comment? }
export async function POST(req: Request) {
  const { userId, messageId, rating, comment } = await req.json();
  if (!userId || !messageId || (rating !== 1 && rating !== -1)) return NextResponse.json({ error: "userId, messageId and rating (1 or -1) are required" }, { status: 400 });
  const ok = rateAnswer(Number(messageId), userId, rating, comment?.toString().slice(0, 1000));
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Answer not found in your conversations" }, { status: 404 });
}
