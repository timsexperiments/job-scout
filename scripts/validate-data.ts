import { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { Job, canonicalUrl } from "../src/domain.ts";
import { PageEvidence } from "../src/browser-extract.ts";
import { root, save } from "../src/io.ts";

const db = new Database(resolve(root,"data/jobs.sqlite"), { readonly: true });
const rows = z.array(z.object({id:z.string(),job:z.string()})).parse(db.query("SELECT id,job FROM jobs").all());
db.close();
const failures: {record:string;issues:string[]}[] = [];
const warnings: {id:string;title:string;issues:string[]}[] = [];
const seen = new Set<string>();
let validJobs=0, jobsWithQuestions=0, questions=0, checked=0, validEvidence=0;
for (const row of rows) {
  let input: unknown;
  try {input=JSON.parse(row.job);} catch {failures.push({record:row.id,issues:["Invalid JSON"]});continue;}
  const parsed=Job.safeParse(input);
  if(!parsed.success){failures.push({record:row.id,issues:parsed.error.issues.map(issue=>`${issue.path.join('.')}: ${issue.message}`)});continue;}
  validJobs++;
  const job=parsed.data, issues:string[]=[];
  const url=canonicalUrl(job.url);if(seen.has(url))issues.push("Duplicate canonical URL");seen.add(url);
  if(job.refreshError)issues.push(`Refresh incomplete: ${job.refreshError}`);
  if(job.availability === "closed")issues.push("Listing closed or removed");
  if(!job.questionsCheckedAt)issues.push("Application fields not yet checked");else checked++;
  if(job.applicationQuestions.length){jobsWithQuestions++;questions+=job.applicationQuestions.length;}
  if(!job.company)issues.push("Company/client not captured");
  if(job.kind==="unknown")issues.push("Employment type unknown");
  if(job.payText==="Not stated")issues.push("Advertised pay unknown");
  if(/no longer accepting|position has been filled|this job is closed/i.test(job.description))issues.push("Possible closed listing; verify source");
  if(issues.length)warnings.push({id:row.id,title:job.title,issues});
}
for(const name of await readdir(resolve(root,"data/browser-evidence"))) {
  if(!name.endsWith('.json'))continue;
  try {const result=PageEvidence.safeParse(await Bun.file(resolve(root,"data/browser-evidence",name)).json());if(result.success)validEvidence++;else failures.push({record:`evidence/${name}`,issues:result.error.issues.map(issue=>`${issue.path.join('.')}: ${issue.message}`)});}
  catch {failures.push({record:`evidence/${name}`,issues:["Unreadable evidence JSON"]});}
}
const summary={generatedAt:new Date().toISOString(),totalJobs:rows.length,validJobs,validEvidence,jobsWithQuestions,questions,fieldsChecked:checked,invalidRecords:failures.length};
await save("reports/data-validation.json",{...summary,failures,warnings});
await save("reports/data-validation.md",`# Job data validation\n\n${validJobs}/${rows.length} saved jobs pass Zod validation. ${validEvidence} evidence files pass. ${failures.length} invalid records.\n\n${checked} jobs checked for application fields; ${jobsWithQuestions} contain questions (${questions} total). Unchecked or inaccessible forms are not treated as having no questions.\n\n## Data gaps\n\n${warnings.map(row=>`- ${row.title}: ${row.issues.join('; ')}`).join('\n')}\n\n## Invalid records\n\n${failures.map(row=>`- ${row.record}: ${row.issues.join('; ')}`).join('\n')||'None.'}\n`);
console.log(JSON.stringify(summary));
if(failures.length)process.exitCode=1;
