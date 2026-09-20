import { mkdir, writeFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { Job, State, jobId, canonicalUrl } from "./domain.ts";

export const root = resolve(import.meta.dir, "..");
export async function save(path: string, value: unknown) {
  const target = resolve(root, path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, target);
}
export async function read<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(await Bun.file(resolve(root, path)).json());
}
export function log(event: string, details: object = {}) {
  process.stderr.write(JSON.stringify({ event, ...details }) + "\n");
}
const Row = z.object({ id: z.string(), job: z.string(), status: State, assessment: z.string().nullable(), updated_at: z.string() });
export class Store {
  private db: Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.run("PRAGMA busy_timeout=5000");
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, job TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', assessment TEXT, updated_at TEXT NOT NULL)");
    this.db.run("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }
  upsert(input: Job) {
    const job = Job.parse(input);
    const id = jobId(job);
    const normalized = JSON.stringify({ ...job, url: canonicalUrl(job.url) });
    this.db.query("INSERT INTO jobs (id,job,updated_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET assessment = CASE WHEN jobs.job = excluded.job THEN jobs.assessment ELSE NULL END, job=excluded.job, updated_at=excluded.updated_at").run(id, normalized, new Date().toISOString());
    return id;
  }
  all() {
    return z.array(Row).parse(this.db.query("SELECT * FROM jobs").all()).map(row => ({ ...row, job: Job.parse(JSON.parse(row.job)) }));
  }
  mark(id: string, status: z.infer<typeof State>) {
    const result = this.db.query("UPDATE jobs SET status=? WHERE id=?").run(status, id);
    if (!result.changes) throw new Error("Unknown job ID");
  }
  assess(id: string, value: unknown) { this.db.query("UPDATE jobs SET assessment=? WHERE id=?").run(JSON.stringify(value), id); }
  meta(key: string) {
    const row = this.db.query("SELECT value FROM metadata WHERE key=?").get(key);
    return row ? z.object({ value: z.string() }).parse(row).value : null;
  }
  setMeta(key: string, value: string) { this.db.query("INSERT OR REPLACE INTO metadata VALUES (?,?)").run(key, value); }
  close() { this.db.close(); }
}

export async function jsonFetch(url: string, init: RequestInit = {}, timeout = 30000): Promise<unknown> {
  let response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeout) });
  for (let retry = 0; response.status === 429 && retry < 3; retry++) {
    const header = response.headers.get("retry-after");
    const seconds = header && Number.isFinite(Number(header)) ? Number(header) : 60;
    await response.body?.cancel();
    log("rate_limited", { origin: new URL(url).origin, retryInSeconds: Math.min(120, Math.max(1, seconds)) });
    await Bun.sleep(Math.min(120, Math.max(1, seconds)) * 1000);
    response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeout) });
  }
  if (response.status === 503 && ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) {
    await response.body?.cancel();
    log("localbase_retry", { reason: "service_unavailable", delaySeconds: 3 });
    await Bun.sleep(3000);
    response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeout) });
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const detail = z.object({ error: z.object({ message: z.string() }) }).safeParse(body);
    throw new Error(`HTTP ${response.status} from ${new URL(url).origin}: ${detail.success ? detail.data.error.message.slice(0, 1000) : "request failed"}`);
  }
  const text = await response.text();
  if (text.length > 12000000) throw new Error("Response exceeds size limit");
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const events = text.split(/\r?\n\r?\n/).map(block => block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n")).filter(Boolean);
    const last = events.at(-1);
    if (!last) throw new Error("Empty MCP event stream");
    return JSON.parse(last);
  }
  return JSON.parse(text);
}
