// Command-line scripts read .env.local like the Next.js app does. Variables already set in the
// shell win, so `LLM_PROVIDER=none npm run eval` still works.
import fs from "node:fs";
import path from "node:path";

export function loadLocalEnv(file = path.join(process.cwd(), ".env.local")) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, "$2");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

loadLocalEnv();
