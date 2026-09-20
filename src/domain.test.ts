import { describe, test, expect } from "bun:test";
import { Assessment, Job, Preferences, Story, filterJob, jobId, verifyEvidence, projectEconomics, hourlyPay } from "./domain.ts";
import { Store } from "./io.ts";
const prefs = Preferences.parse({ minimumHourlyUsd: 100, maximumWeeklyHours: 15, location: null, remoteOnly: true, keywords: ["Go", "API"], maxAgeDays: 30, shortlistSize: 10 });
const job = Job.parse({ url: "https://example.com/job/1", source: "test", title: "Go API integration", company: "Test", description: "Build an API", kind: "contract", remote: true });
describe("screening and evidence", () => {
  test("unknown pay and contract hours never count as confirmed matches", () => {
    const result = filterJob(job, prefs);
    expect(result.excluded).toEqual([]);
    expect(result.unknowns).toContain("Comparable USD hourly pay unknown");
    expect(result.unknowns).toContain("Weekly hours unknown; contract does not imply part-time");
  });
  test("rejects incompatible pay, hours, full-time, and old postings", () => {
    const result = filterJob({ ...job, kind: "full_time", hourlyUsd: { min: 30, max: 50 }, weeklyHours: 40, postedAt: "2020-01-01T00:00:00Z" }, prefs);
    expect(result.excluded).toHaveLength(4);
  });
  test("Go does not match Google or ongoing", () => {
    expect(filterJob({ ...job, title: "Google", description: "ongoing" }, prefs).keywordHits).toEqual([]);
  });
  test("evidence must quote an actual selected record", () => {
    const story = Story.parse({ id: "work", title: "Work", url: "resume://experience/work", tags: [], summary: "Designed an API.", details: [], qualifications: [] });
    expect(() => verifyEvidence([{ storyId: "work", quote: "Designed an API." }], [story])).not.toThrow();
    expect(() => verifyEvidence([{ storyId: "work", quote: "Saved millions" }], [story])).toThrow();
    expect(() => verifyEvidence([{ storyId: "fake", quote: "Designed an API." }], [story])).toThrow();
  });
  test("dedup preserves dismissed status and invalidates stale assessments", () => {
    const store = new Store(":memory:");
    try {
      const id = store.upsert(job);
      store.mark(id, "dismissed");
      store.assess(id, { score: 80 });
      store.upsert({ ...job, url: job.url + "?utm_source=alert" });
      expect(store.all()).toHaveLength(1);
      expect(store.all()[0]?.status).toBe("dismissed");
      expect(store.all()[0]?.assessment).not.toBeNull();
      store.upsert({ ...job, description: "Changed scope" });
      expect(store.all()[0]?.assessment).toBeNull();
      expect(store.all()[0]?.status).toBe("dismissed");
      expect(jobId({ ...job, url: job.url + "#details" })).toBe(id);
    } finally { store.close(); }
  });
  test("external payloads cannot use executable URLs or invalid rates", () => {
    expect(Job.safeParse({ ...job, url: "javascript:alert(1)" }).success).toBe(false);
    expect(Job.safeParse({ ...job, hourlyUsd: { min: 200, max: 100 } }).success).toBe(false);
    expect(Assessment.safeParse({ score: 101, summary: "", reasons: [], gaps: [], evidence: [] }).success).toBe(false);
  });
});

test("hourly pay parsing rejects $14 US work without converting annual salary", () => {
  expect(hourlyPay("$14/hour", "USA")).toEqual({ min: 14, max: 14 });
  expect(hourlyPay("USD $135-$180/hr", "Worldwide")).toEqual({ min: 135, max: 180 });
  expect(hourlyPay("$300,000/year", "USA")).toBeNull();
  expect(hourlyPay("$150/hour", "Canada")).toBeNull();
});
test("fixed-price economics uses human effort, fees, and costs", () => {
  const plan = { phases: [{ phase: "Delivery", yourWork: "Design and review", aiWork: "Implementation", hoursLow: 10, hoursLikely: 15, hoursHigh: 20 }], assumptions: [], exclusions: [] };
  const result = projectEconomics({ ...job, fixedBudgetUsd: 3000, platformFeePercent: 10, projectCostsUsd: 100 }, plan);
  expect(result.grossRates?.likely).toBe(200);
  expect(result.netRatesBeforeTax?.conservative).toBe(130);
  expect(projectEconomics({ ...job, fixedBudgetUsd: 3000 }, plan).netRatesBeforeTax).toBeNull();
  expect(() => projectEconomics(job, { ...plan, phases: [{ ...plan.phases[0]!, hoursLow: 30 }] })).toThrow();
});

test("canonical URLs preserve routing fragments and meaningful identifiers", () => {
  expect(jobId({ ...job, url: "https://example.com/#/jobs/1" })).not.toBe(jobId({ ...job, url: "https://example.com/#/jobs/2" }));
  expect(jobId({ ...job, url: "https://example.com/?ref=1" })).not.toBe(jobId({ ...job, url: "https://example.com/?ref=2" }));
});

test("closed rebuilt listings are excluded and refresh failures remain explicit", () => {
  expect(filterJob({...job, availability:"closed"},prefs).excluded).toContain("Listing is closed or removed");
  expect(filterJob({...job, refreshError:"HTTP 403"},prefs).unknowns).toContain("Refresh incomplete: HTTP 403");
});
