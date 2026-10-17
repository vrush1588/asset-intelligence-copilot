// One-off question from the command line: npx tsx scripts/ask.ts U-201 "question"
import "../lib/env";
async function main() {
  const { ask, usage } = await import("../lib/agent");
  const [userId, ...q] = process.argv.slice(2);
  const t0 = Date.now();
  const a = await ask({ userId, question: q.join(" ") });
  console.log(`[${a.tool} via ${a.router}] args=${JSON.stringify(a.args)} visual=${a.visual?.type ?? "none"} ${Date.now() - t0} ms, LLM calls ${usage.calls}`);
  console.log(a.text);
  console.log("sources:", a.citations.map((c) => c.id).join(", "));
}
main();
