import { z } from "zod";

export const Preferences = z.object({
  minimumFitScore: z.number().int().min(0).max(100).default(65),
  autoRefresh: z.boolean().default(false),
  annualTargetUsd: z.number().positive().default(300000),
  minimumHourlyUsd: z.number().nonnegative().nullable(),
  maximumWeeklyHours: z.number().positive().nullable(),
  location: z.string().nullable(), remoteOnly: z.boolean().nullable(),
  keywords: z.array(z.string().min(1)),
  maxAgeDays: z.number().int().positive(), shortlistSize: z.number().int().min(1).max(50),
});
export const ListingUrl = z.url().refine(value => { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; }, "Expected a public HTTP(S) listing URL without embedded credentials");
export const ApplicationField = z.object({ label: z.string().trim().min(1).max(1000), type: z.string().min(1).max(80), required: z.boolean(), options: z.array(z.string().max(1000)).max(500), sourceUrl: ListingUrl });
export const Job = z.object({
  url: ListingUrl,
  source: z.string().trim().min(1).max(200), title: z.string().trim().min(1).max(1000), company: z.string().max(1000),
  description: z.string().min(1).max(100000),
  applicationQuestions: z.array(z.string().trim().min(1).max(1000)).max(300).default([]),
  applicationFields: z.array(ApplicationField).max(300).default([]),
  availability: z.enum(["listed", "closed", "unverified"]).default("unverified"),
  refreshedAt: z.iso.datetime({ offset: true }).nullable().default(null),
  refreshError: z.string().max(1000).nullable().default(null),
  questionsCheckedAt: z.iso.datetime({ offset: true }).nullable().default(null),
  kind: z.enum(["part_time", "contract", "freelance", "full_time", "unknown"]),
  location: z.string().nullable().default(null), remote: z.boolean().nullable().default(null),
  payText: z.string().default("Not stated"),
  hourlyUsd: z.object({ min: z.number().nonnegative(), max: z.number().nonnegative() })
    .refine(value => value.min <= value.max).nullable().default(null),
  weeklyHours: z.number().positive().nullable().default(null),
  fixedBudgetUsd: z.number().positive().nullable().default(null),
  platformFeePercent: z.number().min(0).max(100).nullable().default(null),
  projectCostsUsd: z.number().nonnegative().nullable().default(null),
  postedAt: z.iso.datetime({ offset: true }).nullable().default(null),
});
export type Job = z.infer<typeof Job>;
export const Story = z.object({
  id: z.string(), title: z.string(), url: z.string(), tags: z.array(z.string()),
  summary: z.string(), details: z.array(z.string()), qualifications: z.array(z.string()),
});
export const Profile = z.object({
  fetchedAt: z.string(), name: z.string(), text: z.string(), notes: z.array(z.string()),
  stories: z.array(Story),
});
export type Profile = z.infer<typeof Profile>;
export const WorkPlan = z.object({
  phases: z.array(z.object({
    phase: z.string().max(80), yourWork: z.string().max(500), aiWork: z.string().max(500),
    hoursLow: z.number(), hoursLikely: z.number(), hoursHigh: z.number(),
  })).length(6),
  assumptions: z.array(z.string().max(400)).max(6), exclusions: z.array(z.string().max(400)).max(6),
});
export const Evidence = z.object({ storyId: z.string(), quote: z.string() });
export const Assessment = z.object({
  score: z.number().int().min(0).max(100),
  summary: z.string().max(600), reasons: z.array(z.string().max(400)).max(5), gaps: z.array(z.string().max(400)).max(5),
  evidence: z.array(Evidence.extend({ requirementQuote: z.string() })),
  workPlan: WorkPlan.nullable(),
});
export function projectEconomics(job: Job, plan: z.infer<typeof WorkPlan>) {
  if (!plan.phases.length) throw new Error("Work plan must contain phases");
  let low = 0, likely = 0, high = 0;
  for (const phase of plan.phases) {
    if (phase.hoursLow < 0 || phase.hoursLikely <= 0 || phase.hoursHigh <= 0) throw new Error("Each phase needs positive likely and high human effort");
    if (phase.hoursLow > phase.hoursLikely || phase.hoursLikely > phase.hoursHigh) throw new Error("Work plan hour ranges are out of order");
    low += phase.hoursLow; likely += phase.hoursLikely; high += phase.hoursHigh;
  }
  if (low <= 0) throw new Error("Work plan must include positive human effort");
  const budget = job.fixedBudgetUsd;
  const net = budget !== null && job.platformFeePercent !== null && job.projectCostsUsd !== null ? budget * (1 - job.platformFeePercent / 100) - job.projectCostsUsd : null;
  const rates = (revenue: number) => ({ optimistic: revenue / low, likely: revenue / likely, conservative: revenue / high });
  return { humanHours: { low, likely, high }, grossRates: budget === null ? null : rates(budget), netRatesBeforeTax: net === null ? null : rates(net) };
}
export const Draft = z.object({
  proposal: z.string().max(2500),
  answers: z.array(z.object({ question: z.string().max(1000), answer: z.string().max(3000) })),
  needsConfirmation: z.array(z.string().max(400)).max(8),
  evidence: z.array(z.object({ storyId: z.string(), quote: z.string() })),
});
export const State = z.enum(["new", "saved", "dismissed", "applied"]);

export function canonicalUrl(raw: string): string {
  const url = new URL(raw);
  if (["#details", "#apply", "#application"].includes(url.hash)) url.hash = "";
  for (const name of [...url.searchParams.keys()]) {
    if (name.startsWith("utm_")) url.searchParams.delete(name);
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.searchParams.sort();
  return url.toString();
}
export function jobId(job: Job): string {
  return new Bun.CryptoHasher("sha256").update(canonicalUrl(job.url)).digest("hex").slice(0, 16);
}
export function filterJob(job: Job, prefs: z.infer<typeof Preferences>, now = Date.now()) {
  const excluded: string[] = [];
  const unknowns: string[] = [];
  if (job.kind === "full_time") excluded.push("Listed as full-time");
  if (job.postedAt === null) unknowns.push("Posting date unknown");
  else if (now - Date.parse(job.postedAt) > prefs.maxAgeDays * 86400000) excluded.push("Older than search window");
  if (prefs.remoteOnly && job.remote === false) excluded.push("Not remote");
  if (job.remote === null) unknowns.push("Remote status unknown");
  if (job.availability === "closed") excluded.push("Listing is closed or removed");
  if (job.refreshError) unknowns.push(`Refresh incomplete: ${job.refreshError}`);
  if (prefs.minimumHourlyUsd !== null && job.hourlyUsd !== null && job.hourlyUsd.max < prefs.minimumHourlyUsd) excluded.push("Maximum advertised rate below target");
  if (job.hourlyUsd === null) unknowns.push("Comparable USD hourly pay unknown");
  else if (prefs.minimumHourlyUsd !== null && job.hourlyUsd.min < prefs.minimumHourlyUsd && job.hourlyUsd.max >= prefs.minimumHourlyUsd) unknowns.push("Only part of advertised rate range meets target");
  if (prefs.maximumWeeklyHours !== null && job.weeklyHours !== null && job.weeklyHours > prefs.maximumWeeklyHours) excluded.push("Hours exceed availability");
  if(job.source==="Upwork" && prefs.maximumWeeklyHours!==null){const lower=job.description.match(/\nMore than (\d+) hrs\/week\n/);if(lower?.[1] && Number(lower[1])>=prefs.maximumWeeklyHours)excluded.push("Advertised minimum hours exceed availability");}
  if (job.weeklyHours === null){
    const range=job.source==="Upwork"?job.description.match(/\n((?:More|Less) than \d+ hrs\/week)\n/):null;
    unknowns.push(range?.[1]?`Advertised ${range[1]}; confirm the exact weekly commitment`:"Weekly hours unknown; contract does not imply part-time");
  }
  if (job.kind === "unknown") unknowns.push("Employment type unknown");
  unknowns.push(`Location eligibility needs review: ${job.location ?? "not stated"}`);
  const text = `${job.title} ${job.description}`.toLowerCase();
  const hits = prefs.keywords.filter(keyword => new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text));
  return { excluded, unknowns, keywordHits: hits };
}
export function selectEvidence(job: Job, profile: Profile) {
  const tokens = new Set(`${job.title} ${job.description}`.toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}/g));
  return [...profile.stories].map(story => ({ story, score: story.tags.reduce((n, tag) => n + tag.toLowerCase().split(/\W+/).filter(token => tokens.has(token)).length, 0) }))
    .sort((a, b) => b.score - a.score).slice(0, 5).map(item => item.story);
}
export function verifyEvidence(evidence: z.infer<typeof Evidence>[], stories: z.infer<typeof Story>[]) {
  if (!evidence.length) throw new Error("Model returned no supporting evidence");
  for (const item of evidence) {
    const story = stories.find(value => value.id === item.storyId);
    if (!story || !item.quote.trim() || ![story.summary, ...story.details, ...story.qualifications].some(text => text.includes(item.quote))) {
      throw new Error(`Model supplied unsupported evidence for ${item.storyId}`);
    }
  }
}

// A dollar sign alone is ambiguous internationally. Only parse USD or US-only listings.
export function hourlyPay(text: string, location: string | null) {
  if(/\best\.|estimated|estimate/i.test(text))return null;
  if (!/USD|US\$/i.test(text) && !/^(USA|United States)( Only)?$/i.test(location ?? "")) return null;
  const match = text.match(/(?:USD\s*|US\$|\$)\s*(\d+(?:\.\d+)?)(?:\s*[-–]\s*(?:(?:USD|US\$|\$)\s*)?(\d+(?:\.\d+)?))?\s*(?:USD\s*)?(?:\/\s*h(?:ou)?r?s?\b|per\s+hour\b|hourly\b)/i);
  if (!match?.[1]) return null;
  const min = Number(match[1]), max = Number(match[2] ?? match[1]);
  return min <= max ? { min, max } : null;
}

export function verifyJobEvidence(job: Job, evidence: z.infer<typeof Assessment>["evidence"]) {
  for (const item of evidence) {
    if (!item.requirementQuote.trim() || ![job.title, job.description].some(text => text.includes(item.requirementQuote))) throw new Error("Model cited a requirement that is not in the job listing");
  }
}
export function financialFit(job: Job, plan: z.infer<typeof WorkPlan> | null, minimum: number | null) {
  if (minimum === null || !plan) return { status: "unknown", basis: "unknown", likelyRate: null, conservativeRate: null };
  const economics = projectEconomics(job, plan);
  const rates = economics.netRatesBeforeTax ?? economics.grossRates;
  if (!rates) return { status: "unknown", basis: "unknown", likelyRate: null, conservativeRate: null };
  return { status: rates.conservative >= minimum ? "meets_target" : rates.likely >= minimum ? "scope_sensitive" : "below_target", basis: economics.netRatesBeforeTax ? "after_stated_fees_and_costs" : "gross", likelyRate: rates.likely, conservativeRate: rates.conservative };
}
