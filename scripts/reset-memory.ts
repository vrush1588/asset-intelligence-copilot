// Clears what users taught the copilot (chat corrections, shared notes, team rules) and all
// conversations. Dataset corrections from context.jsonl are kept.
import "../lib/env";
import { db, closeDb } from "../lib/db";

const d = db();
const n = {
  corrections: d.prepare(`DELETE FROM corrections WHERE source = 'chat'`).run().changes,
  shared_facts: d.prepare(`DELETE FROM shared_facts`).run().changes,
  rule_overrides: d.prepare(`DELETE FROM rule_overrides`).run().changes,
  conversations: d.prepare(`DELETE FROM conversations`).run().changes,
  messages: d.prepare(`DELETE FROM messages`).run().changes,
  conversation_entities: d.prepare(`DELETE FROM conversation_entities`).run().changes,
  answer_ratings: d.prepare(`DELETE FROM answer_ratings`).run().changes,
};
console.log("cleared", n);
closeDb();
