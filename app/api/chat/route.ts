import { NextResponse } from "next/server";
import { ask } from "@/lib/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { userId, question, conversationId } = await req.json();
  if (!userId || !question?.trim()) return NextResponse.json({ error: "userId and question are required" }, { status: 400 });
  try {
    const answer = await ask({ userId, question: question.trim(), conversationId: conversationId ?? undefined });
    return NextResponse.json(answer);
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
