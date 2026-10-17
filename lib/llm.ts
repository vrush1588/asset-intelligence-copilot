// Model access for the copilot. Two providers:
//   LLM_PROVIDER=ollama (default): local Gemma through Ollama's native API, the same way as
//     stitch-desk/src/ai/gemma.js (/api/tags check, /api/generate with format "json",
//     one request at a time, keep_alive). OLLAMA_HOST, LLM_MODEL (default gemma3:4b).
//   LLM_PROVIDER=gemini: free AI Studio key via Google's OpenAI-compatible endpoint.
//     LLM_API_KEY, LLM_MODEL.
//   LLM_PROVIDER=none: keyword router only, no model calls.
import OpenAI from "openai";

const PROVIDER = (process.env.LLM_PROVIDER ?? "ollama").toLowerCase();
const OLLAMA_HOST = (process.env.OLLAMA_HOST ?? "http://localhost:11434").replace(/\/$/, "");
const MODEL = process.env.LLM_MODEL ?? (PROVIDER === "gemini" ? "gemini-2.5-flash" : "gemma3:4b");
const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX ?? 8192);

export const llmEnabled = () => PROVIDER !== "none";
export const llmInfo = () => ({ provider: PROVIDER, model: MODEL });

export type Usage = { prompt_tokens: number; completion_tokens: number; calls: number; ms: number };
export const usage: Usage = { prompt_tokens: 0, completion_tokens: 0, calls: 0, ms: 0 };

const stripCodeFences = (s: string) => s.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

// ---------- Ollama (native API) ----------
let connected: Promise<void> | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function fetchOllama(p: string, init?: RequestInit) {
  let res: Response;
  try {
    res = await fetch(`${OLLAMA_HOST}${p}`, init);
  } catch {
    throw new Error(`Could not reach Ollama at ${OLLAMA_HOST}. Start Ollama (or set OLLAMA_HOST).`);
  }
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Ollama returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return res;
}

function connectOllama() {
  if (!connected) {
    connected = (async () => {
      const { models } = (await (await fetchOllama("/api/tags")).json()) as { models?: { name: string }[] };
      if (!models?.some((m) => m.name === MODEL || m.name.startsWith(`${MODEL}:`)))
        throw new Error(`The ${MODEL} model is not installed in Ollama (run: ollama pull ${MODEL}).`);
    })().catch((e) => { connected = null; throw e; });
  }
  return connected;
}

async function ollamaGenerate(system: string, prompt: string, json: boolean, maxTokens: number) {
  await connectOllama();
  const run = queue.then(async () => {
    const t0 = Date.now();
    const res = await fetchOllama("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL, system, prompt, stream: false, keep_alive: "10m",
        ...(json ? { format: "json" } : {}),
        options: { temperature: 0, num_predict: maxTokens, num_ctx: NUM_CTX },
      }),
    });
    const r = (await res.json()) as { response?: string; prompt_eval_count?: number; eval_count?: number };
    usage.calls++;
    usage.ms += Date.now() - t0;
    usage.prompt_tokens += r.prompt_eval_count ?? 0;
    usage.completion_tokens += r.eval_count ?? 0;
    if (typeof r.response !== "string" || !r.response.trim()) throw new Error("Ollama returned an empty response.");
    return r.response;
  });
  queue = run.catch(() => undefined);
  return run;
}

// ---------- Gemini (OpenAI-compatible endpoint) ----------
let gemini: OpenAI | null = null;
async function geminiGenerate(system: string, prompt: string, json: boolean, maxTokens: number) {
  gemini ??= new OpenAI({ baseURL: process.env.LLM_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta/openai/", apiKey: process.env.LLM_API_KEY ?? "", timeout: 90_000, maxRetries: 2 });
  const t0 = Date.now();
  const res = await gemini.chat.completions.create({
    model: MODEL, temperature: 0, max_tokens: maxTokens,
    messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
    ...(json ? { response_format: { type: "json_object" as const } } : {}),
  });
  usage.calls++;
  usage.ms += Date.now() - t0;
  usage.prompt_tokens += res.usage?.prompt_tokens ?? 0;
  usage.completion_tokens += res.usage?.completion_tokens ?? 0;
  return res.choices[0]?.message?.content ?? "";
}

const generate = (system: string, prompt: string, json: boolean, maxTokens: number) =>
  PROVIDER === "gemini" ? geminiGenerate(system, prompt, json, maxTokens) : ollamaGenerate(system, prompt, json, maxTokens);

/** Asks for JSON and parses it leniently (small models add prose or code fences). */
export async function chatJSON<T = any>(system: string, prompt: string): Promise<T | null> {
  if (!llmEnabled()) return null;
  try {
    const raw = stripCodeFences(await generate(system, prompt, true, 400));
    const m = raw.match(/\{[\s\S]*\}/);
    return m ? (JSON.parse(m[0]) as T) : null;
  } catch (e) {
    console.warn("[llm] json call failed:", (e as Error).message);
    return null;
  }
}

export async function chatText(system: string, prompt: string, maxTokens = 700): Promise<string | null> {
  if (!llmEnabled()) return null;
  try {
    return stripCodeFences(await generate(system, prompt, false, maxTokens));
  } catch (e) {
    console.warn("[llm] text call failed:", (e as Error).message);
    return null;
  }
}

/** For the UI header: is the model reachable? */
export async function llmHealth(): Promise<{ ok: boolean; detail: string }> {
  if (!llmEnabled()) return { ok: true, detail: "model disabled (keyword router)" };
  if (PROVIDER === "gemini") return { ok: !!process.env.LLM_API_KEY, detail: process.env.LLM_API_KEY ? `Gemini ${MODEL}` : "LLM_API_KEY not set" };
  try { await connectOllama(); return { ok: true, detail: `Ollama ${MODEL}` }; }
  catch (e) { return { ok: false, detail: (e as Error).message }; }
}
