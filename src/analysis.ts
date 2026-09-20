import { protectApplicationFacts } from "./application-facts.ts";
import { resolve } from "node:path";
import { root } from "./io.ts";
import { z } from "zod";
import { Assessment, Draft, Job, Preferences, Profile, WorkPlan, projectEconomics, jobId, selectEvidence, verifyEvidence, verifyJobEvidence } from "./domain.ts";
import { infer } from "./connectors.ts";

function context(job: Job, profile: Profile) {
  const stories = selectEvidence(job, profile);
  if (!stories.length) throw new Error("No experience records available");
  const requirements = [job.title, ...job.description.split(/\n+|(?<=[.!?])\s+/)].filter(Boolean).slice(0, 60);
  return { stories, requirements };
}
export async function assessJob(job: Job, profile: Profile, preferences: z.infer<typeof Preferences>) {
  const { stories, requirements } = context(job, profile);
  const schema = Assessment.omit({ evidence: true, workPlan: true }).extend({ planUseful: z.boolean(), evidence: z.array(z.object({
    storyId: z.enum(stories.map(story => story.id)), requirementIndex: z.number().int().min(0).max(requirements.length - 1),
  })).min(1).max(5) });
  const result = await infer(schema, "job_match", `Assess TECHNICAL FIT ONLY for a part-time software consulting opportunity. Score 0-100 as a subjective fit estimate, not a hiring probability. Compare actual job requirements with the supplied resume and experience records. Do not confuse AI content rating with building software. Missing documentation is not evidence of inability. Do not compare a fixed budget to an hourly rate or estimate financial suitability here. Unknown eligibility remains unknown. Use requirement indices and story IDs. Set planUseful true for a bounded deliverable or fixed-price project; false for open-ended staff augmentation. Keep the summary to two sentences, and reasons and gaps to at most three concise items each.`, {
    job: { title: job.title, description: job.description, kind: job.kind },
    requirements: requirements.map((text, index) => ({ index, text })),
    resumeOverview: profile.text, notes: profile.notes, stories,
  });
  const workPlan = job.fixedBudgetUsd !== null ? await infer(WorkPlan, "delivery_plan", `Estimate a delivery plan for an experienced software engineer who uses AI CODING TOOLS to write the code for every project. This is how he delivers work; the finished product need not contain AI. Estimate only his active human time: scoping and design, explaining tasks to the coding AI, reviewing and integrating generated code, testing, client communication, and revisions. AI runtime is excluded. Documentation does not remove design or review work. Return exactly six phases, one each for discovery/design, directing AI implementation, code review/integration, testing/deployment, client communication, and revisions/handoff. yourWork and aiWork must describe concrete tasks in plain sentences, NOT hour counts. hoursLow/hoursLikely/hoursHigh are ordered positive human effort estimates and may be fractions. Base effort on the stated scope; do not inflate or shrink hours to meet the rate target. Include key assumptions and exclusions.`, { job, deliveryStyle: "The candidate designs the solution, directs coding agents, reviews their changes, and validates delivery. AI coding agents implement the code.", preferences: { maximumWeeklyHours: preferences.maximumWeeklyHours } }) : null;
  const evidence = result.evidence.map(item => {
    const story = stories.find(story => story.id === item.storyId);
    const requirementQuote = requirements[item.requirementIndex];
    if (!story || requirementQuote === undefined) throw new Error("Model returned an invalid evidence reference");
    return { storyId: story.id, quote: story.summary, requirementQuote };
  });
  const assessment = Assessment.parse({ ...result, workPlan, evidence });
  verifyEvidence(evidence, stories); verifyJobEvidence(job, evidence);
  if (job.fixedBudgetUsd !== null && !assessment.workPlan) throw new Error("Fixed-price projects require an effort plan");
  if (assessment.workPlan) projectEconomics(job, assessment.workPlan);
  return assessment;
}
export async function draftApplication(job: Job, profile: Profile, preferences: z.infer<typeof Preferences>, questions: string[]) {
  if (!questions.length) throw new Error("No application questions have been captured for this job yet. Refresh the application page before preparing answers.");
  const { stories } = context(job, profile);
  const schema = z.object({ evidence: z.array(z.object({ storyId: z.enum(stories.map(story => story.id)) })).min(1).max(3) });
  const selected = await infer(schema, "application_evidence", "Select up to three experience records most relevant to this opportunity. Return only their identifiers. Select actual past experience, not the job requirements.", { job, stories });
  const evidence = [...new Set(selected.evidence.map(item => item.storyId))].map(id => {
    const story = stories.find(item => item.id === id);
    if (!story) throw new Error("Model returned an invalid evidence reference");
    return { storyId: story.id, quote: story.summary };
  });
  verifyEvidence(evidence, stories);
  const written = questions.map((question,index) => ({ question, key:String(index) })).filter(item => {
    const field = job.applicationFields.find(field => field.label === item.question);
    return (field?.type === "textarea" || /^(why|how|what|describe|tell|a non-engineer)|(?:relevant|similar|previous).*experience/i.test(item.question)) && !/gender|race|ethnicity|disability|veteran|citizenship|authorized to work|salary|availability/i.test(item.question);
  });
  const drafted = new Map<string,string>();
  if (written.length) {
    const schema = z.object({ answer: z.string().min(1).max(3000) });
    const skill = await Bun.file(resolve(root,"prompts/unslop.md")).text();
    const writer = await Bun.file(resolve(root,"prompts/application-writer.md")).text();
    const editor = await Bun.file(resolve(root,"prompts/application-editor.md")).text();
    const briefFile = Bun.file(resolve(root,`prompts/jobs/${jobId(job)}.json`));
    const brief = await briefFile.exists() ? z.object({ purpose:z.string(), answers:z.array(z.object({question:z.string(),draft:z.string(),requiredPhrases:z.array(z.string()).default([])})) }).parse(await briefFile.json()) : null;
    for (const question of written) {
      const scenario = /prototype|you have|would you|how would|scenario|two weeks/i.test(question.question);
      const context = { job: { title: job.title, description: job.description.slice(0,24000) }, evidence: scenario ? [] : evidence, question: question.question, answerType: scenario ? "Hypothetical scenario. Describe proposed actions only. No résumé claims or metrics." : "Role interest or experience. Every past-tense claim must match the evidence." };
      const format = "\nReturn one answer to this one question in the answer field. There are no question keys in this call.";
      const reference = brief?.answers.find(item => item.question === question.question);
      const initial = reference ? {answer:reference.draft} : await infer(schema, "application_answer", writer + format + "\n\nWriting skill:\n" + skill, context);
      const protectedText = reference ? protectApplicationFacts(reference.draft,reference.requiredPhrases) : null;
      const editInstruction = reference
        ? "Lightly edit this reviewed application answer for plain, natural writing using the supplied unslop skill. Preserve every factual qualifier and the technical decisions. Do not add any claims, technologies, assumptions, requirements, or examples. Preserve its structure, paragraph count, and length within 10 percent. Do not replace concrete checks with generic labels. Keep the distinction between designed, led, and implemented. Do not add a cover letter or résumé bullets. Keep each [SCOUT_FACT_N] marker exactly as written, in its appropriate sentence. Those markers represent protected factual phrases and must not be paraphrased, expanded, or removed. Return only the edited answer in the answer field."
        : editor + format;
      const result = await infer(schema, "application_edit", editInstruction + "\n\nWriting skill:\n" + skill, reference ? {question:question.question,reviewedDraft:protectedText?.text ?? initial.answer} : {...context,draft:initial.answer});
      drafted.set(question.key,protectedText ? protectedText.restore(result.answer) : result.answer);
    }
    if (drafted.size !== written.length) throw new Error("The model did not answer every written question. Please try preparing the draft again.");
  }
  const name = profile.name.trim().split(/\s+/);
  const answers = questions.map((question,index) => {
    const known = /^first name$/i.test(question) && name.length > 1 ? name[0] ?? "" : /^last name$/i.test(question) && name.length > 1 ? name.slice(1).join(" ") : "";
    return { question, answer: drafted.get(String(index)) ?? known };
  });
  const proposal = ""; // The application form is the deliverable; do not invent a cover letter.

  return Draft.parse({ proposal, answers, evidence, needsConfirmation: [
    "Review the résumé excerpts and drafted question answers for accuracy before use.",
    "Confirm availability, scope, rate, and whether the client permits AI coding tools.",
    ...answers.filter(item => !item.answer).slice(0, 6).map(item => `Answer needed: ${item.question.slice(0, 350)}`),
  ] });
}
