// Scratch copy of the live database for tests, so test conversations and corrections never touch
// the real one. VACUUM INTO gives a consistent snapshot even while the server is writing.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { activeDbPath, DATA_DIR } from "./db";

export function snapshotDb(name: string) {
  const src = activeDbPath();
  if (!fs.existsSync(src)) throw new Error(`No database at ${src}. Run "npm run ingest -- <dataset>" first.`);
  const dst = path.join(DATA_DIR, `${name}.db`);
  for (const f of [dst, dst + "-wal", dst + "-shm"]) fs.rmSync(f, { force: true });
  const d = new Database(src);
  d.prepare(`VACUUM INTO ?`).run(dst);
  d.close();
  process.env.COPILOT_DB = dst;
  return { src, dst };
}
