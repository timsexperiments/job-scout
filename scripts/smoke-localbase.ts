import { assessJob, draftApplication } from "../src/analysis.ts";
import { Job, Preferences, Profile, projectEconomics } from "../src/domain.ts";
import { log, read, save } from "../src/io.ts";
import { modelId } from "../src/connectors.ts";

const profile = await read("data/profile.json", Profile);
const preferences = await read("preferences.json", Preferences);
const job = Job.parse({
  title: "TEST FIXTURE: Workflow automation and API integration", company: "Synthetic validation fixture", source: "test-fixture",
  url: "https://example.com/test-fixture", kind: "freelance", remote: true,
  description: "Build a small CRM integration that imports new customers from an existing REST API and sends staff a Slack notification. Use TypeScript. Client will supply documented API endpoints, a sandbox, credentials, and hosting. Deliver tested code, setup instructions, and a handoff session. No production data migration or ongoing support is included.",
  payText: "$5,000 fixed-price TEST ONLY", fixedBudgetUsd: 5000, platformFeePercent: 10, projectCostsUsd: 100,
});
const assessment = await assessJob(job, profile, preferences);
if (!assessment.workPlan) throw new Error("Expected a project plan");
const draft = await draftApplication(job, profile, preferences, ["What relevant integration experience do you have?"]);
await save("reports/integration-check.json", { synthetic: true, notARealOpportunity: true, model: await modelId(), checkedAt: new Date().toISOString(), job, assessment, economics: projectEconomics(job, assessment.workPlan), draft });
log("integration_passed", { model: await modelId(), evidenceRecords: assessment.evidence.length, phases: assessment.workPlan.phases.length, proposalCharacters: draft.proposal.length });
