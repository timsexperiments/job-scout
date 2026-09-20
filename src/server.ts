import { chatState, chatBusy, startChat, restoreDraft, ChatInput } from "./draft-chat.ts";
import { sameSubnet } from "./setup-auth.ts";
import { startRemoteBrowser } from "./remote-browser.ts";
import { startMailSetup } from "./mail-setup.ts";
import { flushAlerts } from "./notifications.ts";
import { mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { Assessment, Job, Preferences, Profile, State, WorkPlan, filterJob, hourlyPay, projectEconomics, financialFit } from "./domain.ts";
import { log, read, root, save, Store } from "./io.ts";

await mkdir(resolve(root, "data"), { recursive: true, mode: 0o700 });
const store = new Store(resolve(root, "data/jobs.sqlite"));
const port = z.coerce.number().int().min(1024).max(65535).parse(process.env.JOB_SCOUT_PORT ?? 4317);
const token = crypto.randomUUID();
const fingerprint = (value: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");
type Task = { state: "idle" } | { state: "running" | "done" | "failed"; action: string; startedAt: string; logs: string };
let task: Task = { state: "idle" };
let running: ReturnType<typeof Bun.spawn> | null = null;
async function run(args: string[]) {
  if (task.state === "running") throw new Error("A task is already running");
  task = { state: "running", action: args[0] ?? "task", startedAt: new Date().toISOString(), logs: "" };
  const current = task;
  const child = Bun.spawn([process.execPath, "src/cli.ts", ...args], { cwd: root, stdout: "pipe", stderr: "pipe", env: process.env });
  running = child;
  const capture = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) current.logs = (current.logs + decoder.decode(chunk)).slice(-16000);
  };
  await Promise.all([capture(child.stdout), capture(child.stderr)]);
  const code = await child.exited;
  current.state = code === 0 ? "done" : "failed";
  store.setMeta("last_task", JSON.stringify(current));
  running = null;
}
type ApplicationTask = { state: "idle" } | { state: "running" | "done" | "failed"; jobId: string; startedAt: string; error: string | null };
let applicationTask: ApplicationTask = { state: "idle" };
let draftProcess: ReturnType<typeof Bun.spawn> | null = null;
async function runDraft(jobId: string) {
  const current: ApplicationTask = { state: "running", jobId, startedAt: new Date().toISOString(), error: null };
  applicationTask = current;
  try {
    const child = Bun.spawn([process.execPath, "src/cli.ts", "draft", jobId], { cwd: root, stdout: "pipe", stderr: "pipe", env: process.env });
    draftProcess = child;
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) {
      const errors = (stdout + "\n" + stderr).split("\n").flatMap(line => { try { const value = z.object({ event: z.string(), message: z.string() }).safeParse(JSON.parse(line)); return value.success && value.data.event === "error" ? [value.data.message] : []; } catch { return []; } });
      throw new Error(errors.at(-1) ?? (stderr.trim().slice(-500) || "Draft preparation failed. Try again."));
    }
    current.state = "done";
  } catch (error) { current.state = "failed"; current.error = error instanceof Error ? error.message : "Draft preparation failed"; }
  finally { draftProcess = null; }
}
const response = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const commandSchema = z.object({ action: z.enum(["run", "fetch", "rank", "profile", "draft", "shortlist", "browse", "computer", "browser-login"]), id: z.string().regex(/^[a-f0-9]{16}$/).optional(), source: z.string().regex(/^[a-z0-9-]+$/).optional() });
const cachedAssessment = z.object({ result: Assessment, profileHash: z.string(), preferencesHash: z.string(), model: z.string(), version: z.literal(3) });

async function handleRequest(request: Request) {
    try {
      const url = new URL(request.url);
      if (!allowed.has(request.headers.get("host") ?? "")) return response({ error: "Invalid host" }, 403);
      if (request.method !== "GET" && request.method !== "HEAD") {
        const origin = request.headers.get("origin");
        if (request.headers.get("x-scout-token") !== token || (origin !== null && origin !== url.origin)) return response({ error: "Invalid request origin or token" }, 403);
        if (!request.headers.get("content-type")?.startsWith("application/json")) return response({ error: "JSON required" }, 415);
      }
      if (url.pathname === "/api/state" && request.method === "GET") {
        const preferences = await read("preferences.json", Preferences);
        const profile = await Bun.file(resolve(root, "data/profile.json")).exists() ? await read("data/profile.json", Profile) : null;
        const runtime = await read("runtime.json", z.object({ localbaseModel: z.string() }));
        const ph = fingerprint(profile), pf = fingerprint(preferences);
        const jobs = store.all().map(row => {
          const job = { ...row.job, hourlyUsd: row.job.hourlyUsd ?? hourlyPay(row.job.payText, row.job.location) };
          const evaluated = row.assessment ? cachedAssessment.safeParse(JSON.parse(row.assessment)) : null;
          const assessment = evaluated?.success && evaluated.data.profileHash === ph && evaluated.data.preferencesHash === pf && evaluated.data.model === runtime.localbaseModel ? evaluated.data.result : null;
          return { id: row.id, job, status: row.status, screening: filterJob(job, preferences), assessment,
            financialFit: financialFit(job, assessment?.workPlan ?? null, preferences.minimumHourlyUsd), economics: assessment?.workPlan ? projectEconomics(job, assessment.workPlan) : null };
        });
        const draftIds = (await readdir(resolve(root,"drafts")).catch(() => [])).filter(name => /^[a-f0-9]{16}\.json$/.test(name)).map(name => name.slice(0,-5));
        return response({ token, preferences, runtime, jobs, task, applicationTask, draftIds, profile: profile ? { name: profile.name, stories: profile.stories.length, fetchedAt: profile.fetchedAt } : null, lastFetch: store.meta("remotive_fetched_at"), nextRefresh: preferences.autoRefresh ? new Date(Number(store.meta("last_scheduled_run") ?? 0) + 24 * 3600000).toISOString() : null });
      }
      if (url.pathname === "/api/data-validation" && request.method === "GET") {
        const file = Bun.file(resolve(root, "reports/data-validation.json"));
        return await file.exists() ? response(await file.json()) : response({ error: "Run the data validation command first" }, 404);
      }
      if (url.pathname === "/api/browser-coverage" && request.method === "GET") {
        const file = Bun.file(resolve(root, "reports/browser-coverage.json"));
        return response(await file.exists() ? await file.json() : { sources: [] });
      }
      if (url.pathname === "/api/stop" && request.method === "POST") {
        running?.kill(); return response({ ok: true });
      }
      if (url.pathname === "/api/preferences" && request.method === "POST") {
        const preferences = Preferences.parse(await request.json()); await save("preferences.json", preferences); return response({ ok: true });
      }
      if (url.pathname === "/api/import" && request.method === "POST") {
        if (task.state === "running") return response({ error: "Wait for the current task to finish" }, 409);
        const job = Job.parse(await request.json()); const id = store.upsert(job); return response({ id });
      }
      if (url.pathname === "/api/plan" && request.method === "POST") {
        if (task.state === "running") return response({ error: "Wait for the current task to finish" }, 409);
        const input = z.object({ id: z.string().regex(/^[a-f0-9]{16}$/), plan: WorkPlan }).parse(await request.json());
        const row = store.all().find(item => item.id === input.id);
        if (!row?.assessment) return response({ error: "Assess this job before editing its plan" }, 400);
        projectEconomics(row.job, input.plan);
        const existing = cachedAssessment.parse(JSON.parse(row.assessment));
        store.assess(row.id, { ...existing, result: { ...existing.result, workPlan: input.plan }, planEditedAt: new Date().toISOString() });
        return response({ ok: true });
      }
      if (url.pathname === "/api/status" && request.method === "POST") {
        const body = z.object({ id: z.string().regex(/^[a-f0-9]{16}$/), status: State }).parse(await request.json());
        store.mark(body.id, body.status); return response({ ok: true });
      }
      if (url.pathname === "/api/command" && request.method === "POST") {
        const body = commandSchema.parse(await request.json());
        if (body.action === "draft") {
          if (!body.id) return response({ error: "Choose a job before preparing a draft" }, 400);
          if (!store.all().some(row => row.id === body.id)) return response({ error: "Job not found" }, 404);
          if (applicationTask.state === "running" || chatBusy()) return response({ error: "Another application draft is being prepared. Wait for it to finish." }, 409);
          void runDraft(body.id);
          return response({ ok: true }, 202);
        }
        if (task.state === "running") return response({ error: "A task is already running" }, 409);
        if (body.action === "browser-login" && !body.source) return response({ error: "Choose a source for login" }, 400);

        void run(body.source && ["browse", "computer", "browser-login"].includes(body.action) ? [body.action, body.source] : [body.action]).catch(error => { task = { state: "failed", action: body.action, startedAt: new Date().toISOString(), logs: error instanceof Error ? error.message : "Task failed" }; });
        return response({ ok: true }, 202);
      }
      const chat = url.pathname.match(/^\/api\/draft\/([a-f0-9]{16})\/(chat|restore)$/);
      if(chat) {
        const id = chat[1] ?? "", action = chat[2];
        const row = store.all().find(item => item.id === id);
        if(!row) return response({error:"Job not found"},404);
        if(action === "chat" && request.method === "GET") return response(await chatState(id));
        if(request.method === "POST") {
          if(applicationTask.state === "running") return response({error:"Wait for draft preparation to finish."},409);
          if(chatBusy(id)) return response({error:"An edit is already running for this application."},409);
          if(action === "chat") { await startChat(id,row.job,ChatInput.parse(await request.json())); return response({ok:true},202); }
          const input = z.object({versionId:z.uuid(),revision:z.string().regex(/^[a-f0-9]{64}$/)}).parse(await request.json());
          await restoreDraft(id,input.versionId,input.revision);return response({ok:true});
        }
      }
      const draft = url.pathname.match(/^\/api\/draft\/([a-f0-9]{16})$/);
      if (draft && request.method === "GET") {
        const file = Bun.file(resolve(root, `drafts/${draft[1]}.json`));
        return await file.exists() ? response(await file.json()) : response({ error: "No draft yet" }, 404);
      }
      const assets: Record<string, string> = { "/": "web/index.html", "/app.js": "web/app.js", "/draft-chat.js": "web/draft-chat.js", "/style.css": "web/style.css" };
      const asset = assets[url.pathname];
      if (asset && (request.method === "GET" || request.method === "HEAD")) return new Response(Bun.file(resolve(root, asset)), { headers: { "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
      return response({ error: "Not found" }, 404);
    } catch (error) { return response({ error: error instanceof Error ? error.message : "Request failed" }, 400); }
}
const server = Bun.serve({ hostname: "127.0.0.1", port, maxRequestBodySize: 1024 * 1024, fetch: handleRequest });
async function startLanDashboard() {
  if (!await Bun.file(resolve(root, "data/mail-setup/config.json")).exists()) return null;
  const config = await read("data/mail-setup/config.json", z.object({ address: z.ipv4(), netmask: z.ipv4() }));
  const host = `${config.address}:${port}`;
  allowed.add(host);
  const lan = Bun.serve({ hostname: config.address, port, maxRequestBodySize: 1024 * 1024,
    tls: { key: Bun.file(resolve(root, "data/mail-setup/key.pem")), cert: Bun.file(resolve(root, "data/mail-setup/cert.pem")) },
    fetch(request) {
      const peer = lan.requestIP(request)?.address;
      if (!peer || !sameSubnet(peer, config.address, config.netmask) || request.headers.get("host") !== host) return response({ error: "LAN access only" }, 403);
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && ["/help", "/mail-setup"].includes(path)) return Response.redirect(`https://${config.address}:${path === "/help" ? 4319 : 4318}/`, 302);
      return handleRequest(request);
    },
  });
  log("lan_dashboard_started", { url: `https://${host}` });
  return lan;
}
const lanDashboard = await startLanDashboard().catch(() => { log("lan_dashboard_failed", { message: "Check the LAN address and certificate" }); return null; });
log("server_started", { url: `http://127.0.0.1:${port}` });
const remoteBrowser = await startRemoteBrowser().catch(()=>{log("remote_browser_failed",{});return null;});
const mailSetup = await startMailSetup().catch(() => { log("mail_setup_failed",{message:"Could not start the private LAN setup listener. Check its address and certificate."}); return null; });
void flushAlerts();
setInterval(() => { void flushAlerts(); },60000);
process.on("SIGTERM", async () => { await remoteBrowser?.stop(); mailSetup?.stop(); running?.kill(); draftProcess?.kill(); lanDashboard?.stop(); server.stop(); store.close(); process.exit(0); });

// Scheduling stays local and only runs while this server is running.
let checkingSchedule = false;
setInterval(async () => {
  if (checkingSchedule || task.state === "running" || remoteBrowser?.active()) return;
  checkingSchedule = true;
  try {
    const prefs = await read("preferences.json", Preferences);
    if (!prefs.autoRefresh) return;
    const last = Number(store.meta("last_scheduled_run") ?? 0);
    if (Date.now() - last < 24 * 3600000) return;
    store.setMeta("last_scheduled_run", String(Date.now()));
    await run(["run"]);
  } catch (error) { log("scheduled_run_failed", { message: error instanceof Error ? error.message : "Unknown error" }); }
  finally { checkingSchedule = false; }
}, 60000);
