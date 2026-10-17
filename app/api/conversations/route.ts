import { NextResponse } from "next/server";
import { listConversations, messages, conversation } from "@/lib/memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET ?userId=U-201 → that user's conversations; GET ?id=12&userId=U-201 → its messages.
// Conversations are private: a user can only open their own.
export async function GET(req: Request) {
  const u = new URL(req.url);
  const userId = u.searchParams.get("userId");
  const id = u.searchParams.get("id");
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });
  if (id) {
    const c = conversation(Number(id));
    if (!c || c.user_id !== userId) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ conversation: c, messages: messages(Number(id)) });
  }
  return NextResponse.json({ conversations: listConversations(userId) });
}
