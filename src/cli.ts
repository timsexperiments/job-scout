import { collectBrowser, browserLogin } from "./browser.ts";
import { assessJob, draftApplication } from "./analysis.ts";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { Assessment, Draft, Job, Preferences, Profile, State, filterJob, selectEvidence, verifyEvidence, projectEconomics, hourlyPay, verifyJobEvidence, financialFit } from "./domain.ts";
import { fetchRemotive, infer, localBaseUrl, syncProfile, modelId } from "./connectors.ts";
import { jsonFetch, log, read, root, save, Store } from "./io.ts";

const help = `Local job assistant, powered by LocalBase

bun run jobs browse [SOURCE]     Collect public listings with headless Chromium
bun run jobs computer [SOURCE]   Navigate a visible browser with LocalBase
bun run jobs browser-login SOURCE  Open a dedicated browser for manual login
bun run jobs profile             Cache résumé and detailed stories from the configured MCP
bun run jobs fetch               Fetch Remotive software jobs (six-hour cache)
bun run jobs import FILE.json    Import an array of listings, including Upwork
bun run jobs shortlist           Filter and export reports/shortlist.md, without AI
bun run jobs rank [COUNT]        Assess up to COUNT candidates locally (default 5)
bun run jobs draft JOB_ID [questions.json]  Save proposal and application answers
bun run jobs mark JOB_ID saved|dismissed|applied|new
bun run jobs run                 Fetch, assess five jobs, and export shortlist
bun run jobs doctor              Check LocalBase and local profile

Preferences: preferences.json. Secrets: .env. No application is submitted.
Browser source access varies; inspect reports/browser-coverage.json for blocks and collection limits.
`;
const Evaluated = z.object({ result: Assessment, profileHash: z.string(), preferencesHash: z.string(), model: z.string(), version: z.literal(3) });
const fingerprint = (value: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");
const safeText = (text: string) => text.replace(/[\[\]<>`]/g, "").replace(/\r?\n/g, " ");
function renderPlan(job: Job, plan: z.infer<typeof Assessment>["workPlan"], minimum: number | null): string {
  if (!plan) return "";
  const economics = projectEconomics(job, plan);
  const format = (rates: NonNullable<typeof economics.grossRates>) => `optimistic $${rates.optimistic.toFixed(0)}/h, likely $${rates.likely.toFixed(0)}/h, conservative $${rates.conservative.toFixed(0)}/h`;
  return `\n### AI-assisted delivery estimate\n\nThese are estimates of your active time, not guarantees.\n\n` +
    plan.phases.map(phase => `- ${phase.phase}: ${phase.hoursLow}/${phase.hoursLikely}/${phase.hoursHigh} human hours, low/likely/high. You: ${phase.yourWork}. AI: ${phase.aiWork}.`).join("\n") +
    `\n\nGross effective rate: ${economics.grossRates ? format(economics.grossRates) : "Budget unknown"}.\n\nAfter platform fees and project costs, before taxes: ${economics.netRatesBeforeTax ? format(economics.netRatesBeforeTax) : "Unknown; enter platformFeePercent and projectCostsUsd"}.\n\n` +
    (minimum === null ? "" : `Gross budget needed to clear $${minimum}/h even at high estimated hours: $${Math.ceil(minimum * economics.humanHours.high)}.\n\n`) +
    `Assumptions:\n\n${plan.assumptions.map(item => `- ${item}`).join("\n")}\n\nExcluded scope:\n\n${plan.exclusions.map(item => `- ${item}`).join("\n")}\n`;
}


async function main() {
  const [command, arg, extra] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") { process.stdout.write(help); return; }
  if (command === "browser-login") { if (!arg) throw new Error("Supply a source ID"); await browserLogin(arg); return; }
  if (command === "profile") { await syncProfile(); return; }
  if (command === "doctor") {
    const health = await jsonFetch(`${localBaseUrl()}/health`);
    log("doctor", { gateway: health, profileExists: await Bun.file(resolve(root, "data/profile.json")).exists(), apiKeyConfigured: Boolean(process.env.LOCALBASE_API_KEY) });
    return;
  }
  await mkdir(resolve(root, "data"), { recursive: true, mode: 0o700 });
  const store = new Store(resolve(root, "data/jobs.sqlite"));
  try {
    if (command === "browse" || command === "computer") { const results = await collectBrowser(store, command === "browse" ? "headless" : "computer", arg); if (results.every(item => ["failed", "blocked", "empty"].includes(item.status))) process.exitCode = 1; return; }
    if (command === "fetch") { await fetchRemotive(store); return; }
    if (command === "import") {
      if (!arg) throw new Error("Supply a JSON file containing an array of jobs");
      const jobs = z.array(Job).parse(await Bun.file(resolve(arg)).json());
      for (const job of jobs) store.upsert(job);
      log("imported", { jobs: jobs.length }); return;
    }
    if (command === "mark") {
      if (!arg) throw new Error("Supply a job ID");
      store.mark(arg, State.parse(extra)); log("status_updated", { id: arg, status: extra }); return;
    }
    const prefs = await read("preferences.json", Preferences);
    if (command === "draft") {
      const row = store.all().find(value => value.id === arg);
      if (!row) throw new Error("Unknown job ID; see reports/shortlist.md");
      if (["applied", "dismissed"].includes(row.status)) throw new Error("Restore this job to saved or new before drafting");
      const profile = await read("data/profile.json", Profile);
      const stories = selectEvidence(row.job, profile);
      const questions = extra ? z.array(z.string()).parse(await Bun.file(resolve(extra)).json()) : row.job.applicationQuestions;
      const result = await draftApplication(row.job, profile, prefs, questions);
      verifyEvidence(result.evidence, stories);
      await save(`drafts/${row.id}.json`, { jobId: row.id, url: row.job.url, reviewRequired: true, generatedAt: new Date().toISOString(), ...result });
      await save(`drafts/${row.id}.md`, `# Draft: ${safeText(row.job.title)}\n\nApplication: ${row.job.url}\n\nReview required. Nothing has been submitted.\n\n${result.proposal}\n\n## Application answers\n\n${result.answers.map(answer => `### ${safeText(answer.question)}\n\n${answer.answer || "Needs your answer"}`).join("\n\n")}\n\n## Confirm before use\n\n${result.needsConfirmation.map(item => `- ${item}`).join("\n")}\n\n## Supporting records\n\n${result.evidence.map(item => `- resume://experience/${item.storyId}: ${item.quote}`).join("\n")}\n`);
      log("draft_saved", { file: `drafts/${row.id}.md` }); return;
    }
    if (!["shortlist", "rank", "run"].includes(command)) throw new Error("Unknown command; run bun run jobs help");
    if (command === "run") { store.setMeta("last_scheduled_run", String(Date.now())); await fetchRemotive(store).catch(error => log("feed_failed", { message: String(error) })); await collectBrowser(store, "headless"); }
    const profile = await Bun.file(resolve(root, "data/profile.json")).exists() ? await read("data/profile.json", Profile) : null;
    const runtime = await read("runtime.json", z.object({ localbaseModel: z.string() }));
    const selectedModel = process.env.LOCALBASE_MODEL ?? runtime.localbaseModel;
    const profileHash = fingerprint(profile);
    const preferencesHash = fingerprint(prefs);
    const candidates = () => store.all().filter(row => row.status !== "dismissed" && row.status !== "applied")
      .map(row => ({ ...row, screening: filterJob({ ...row.job, hourlyUsd: row.job.hourlyUsd ?? hourlyPay(row.job.payText, row.job.location) }, prefs), evaluated: row.assessment ? Evaluated.safeParse(JSON.parse(row.assessment)).data ?? null : null }))
      .filter(row => row.screening.excluded.length === 0 && row.screening.keywordHits.length > 0)
      .map(row => ({ ...row, evaluated: row.evaluated?.profileHash === profileHash && row.evaluated.preferencesHash === preferencesHash && row.evaluated.model === selectedModel ? row.evaluated : null }))
      .sort((a, b) => b.screening.keywordHits.length - a.screening.keywordHits.length);
    let failures = 0;
    if (command === "rank" || command === "run") {
      if (!profile) throw new Error("Run bun run jobs profile first");
      const count = z.coerce.number().int().min(1).max(50).parse(arg ?? 5);
      for (const row of candidates().filter(row => !row.evaluated).slice(0, count)) {
        try {
          const stories = selectEvidence(row.job, profile);
          log("assessing", { id: row.id, title: row.job.title });
          const result = await assessJob(row.job, profile, prefs);
          verifyEvidence(result.evidence, stories);
          verifyJobEvidence(row.job, result.evidence);
          if (row.job.fixedBudgetUsd !== null && result.workPlan === null) throw new Error("Fixed-price project requires an effort plan");
          if (result.workPlan) projectEconomics(row.job, result.workPlan);
          store.assess(row.id, { result, profileHash, preferencesHash, model: await modelId(), version: 3 });
        } catch (error) { failures++; log("assessment_failed", { id: row.id, message: error instanceof Error ? error.message : "Unknown error" }); }
      }
    }
    const rows = candidates().filter(row => !row.evaluated || row.evaluated.result.score >= prefs.minimumFitScore).filter(row => financialFit(row.job, row.evaluated?.result.workPlan ?? null, prefs.minimumHourlyUsd).status !== "below_target").sort((a, b) => (b.evaluated?.result.score ?? -1) - (a.evaluated?.result.score ?? -1)).slice(0, prefs.shortlistSize);
    const pending = Object.entries(prefs).filter(([, value]) => value === null).map(([key]) => key);
    await save("reports/shortlist.json", { generatedAt: new Date().toISOString(), pendingPreferences: pending, jobs: rows.map(row => ({ ...row, economics: row.evaluated?.result.workPlan ? projectEconomics(row.job, row.evaluated.result.workPlan) : null })) });
    const annualMath = `Target: $${prefs.annualTargetUsd.toLocaleString()}/year; minimum $${prefs.minimumHourlyUsd ?? "unset"}/hour. At 10/15/20 hours per week for 48 working weeks, required gross effective rates are ${[10,15,20].map(hours => `$${Math.ceil(prefs.annualTargetUsd / (hours * 48))}/hour`).join(" / ")}. These are revenue targets before taxes, platform fees, costs, and nonbillable sales work.\n\n`;
    await save("reports/earnings-target.md", `# Earnings target\n\n${annualMath}`);
    const sections = rows.map(row => {
      const assessment = row.evaluated?.result;
      return `## ${safeText(row.job.title)} · ${safeText(row.job.company)}\n\nID: \`${row.id}\` · ${safeText(row.job.source)} · ${row.job.kind} · ${row.status}\n\n[Open source listing](<${row.job.url}>)\n\nAdvertised pay: ${safeText(row.job.payText)}. Location: ${safeText(row.job.location ?? "Not stated")}. Posted: ${row.job.postedAt ?? "Unknown"}.\n\n${assessment ? `Local AI technical-fit estimate: ${assessment.score}/100, a subjective estimate.\n\n${assessment.summary}\n\n${assessment.reasons.map(reason => `- ${reason}`).join("\n")}\n\nMissing evidence:\n\n${assessment.gaps.map(gap => `- ${gap}`).join("\n") || "None identified by model."}\n\nEvidence:\n\n${assessment.evidence.map(item => `- resume://experience/${item.storyId}: ${item.quote}`).join("\n")}` : `Keyword screening only; not yet assessed by LocalBase. Matched: ${row.screening.keywordHits.join(", ")}.`}\n\nConfirm:\n\n${row.screening.unknowns.map(item => `- ${item}`).join("\n")}\n`;
    }).map((section, index) => { const row = rows[index]; return section + (row?.evaluated?.result.workPlan ? renderPlan(row.job, row.evaluated.result.workPlan, prefs.minimumHourlyUsd) : ""); });
    await save("reports/shortlist.md", `# Job shortlist\n\nGenerated ${new Date().toISOString()}.\n\nPreferences still needed: ${pending.join(", ") || "none"}.\n\nRemotive listings come from its public API, delayed 24 hours. Imported listings are not independently checked for availability. Full-time and stale listings are excluded; contract hours require confirmation.\n\n${sections.join("\n") || "No candidates passed the current filters. Import more listings or adjust preferences."}\n`);
    log("shortlist_saved", { jobs: rows.length, assessmentFailures: failures, path: "reports/shortlist.md" });
    if (failures) process.exitCode = 1;
  } finally { store.close(); }
}
main().catch(error => { log("error", { message: error instanceof Error ? error.message : "Unknown error" }); process.exitCode = 1; });
