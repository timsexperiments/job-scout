import { expect, test } from "bun:test";
import { Source, allowedURL, listingURL, barrier, Decision } from "./browser-policy.ts";
import { extractJob, PageEvidence } from "./browser-extract.ts";
const source = Source.parse({ id:"test", name:"Test", seeds:["https://jobs.example.com"], hosts:["jobs.example.com"], listingPattern:"^/jobs/[0-9]+$" });
test("browser navigation stays within configured public listing hosts", () => {
  expect(listingURL("https://jobs.example.com/jobs/123",source)).toBe(true);
  for (const url of ["http://jobs.example.com/jobs/123","https://jobs.example.com.evil.test/jobs/123","https://me:secret@jobs.example.com/jobs/123","https://jobs.example.com:444/jobs/123","https://127.0.0.1/jobs/123"]) expect(allowedURL(url,source)).toBe(false);
  expect(listingURL("https://jobs.example.com/apply",source)).toBe(false);
});
test("browser stops on challenges and rejects unsupported agent actions", () => {
  expect(barrier("Verify you are human", "Jobs", 200)).toBeTruthy();
  expect(barrier("", "Jobs", 429)).toBeTruthy();
  expect(Decision.safeParse({ action:"submit", selector:"form" }).success).toBe(false);
  expect(Decision.safeParse({ action:"click", index:-1 }).success).toBe(false);
});
function page(text:string, jsonld:unknown[] = []) {return PageEvidence.parse({url:"https://jobs.example.com/jobs/1",title:"Engineer",heading:"Software Engineer, Part-time",text,jsonld,collectedAt:new Date().toISOString()});}
test("pay comes from job evidence and estimated market rates remain unknown", () => {
  const text = "Compensation: $150 per hour. Work remotely from the United States.\n" + "Build reliable integrations with AI coding tools. ".repeat(5);
  expect(extractJob(page(text),"Test")?.hourlyUsd).toEqual({min:150,max:150});
  expect(extractJob(page(text.replace("Compensation:","Est. market")),"Test")?.hourlyUsd).toBeNull();
});
test("closed and expired jobs do not enter candidates", () => {
  expect(extractJob(page("This job is closed. ".repeat(20)),"Test")).toBeNull();
  expect(extractJob(page("Build integrations. ".repeat(20),[{"@type":"JobPosting",validThrough:"2020-01-01"}]),"Test")).toBeNull();
});

test("Upwork job pay excludes client history and handles multiline rates and fixed budgets",()=>{
 const base={url:"https://www.upwork.com/jobs/Test_~123/",title:"Role - Category",heading:"",jsonld:[],collectedAt:"2026-09-18T12:00:00Z"};
 const text="Role - Category\nRole\nPosted 6 hours ago\n\nWorldwide\nSummary\nBuild and maintain a production integration with clear acceptance criteria and API documentation.\nLess than 30 hrs/week\nHourly\n$20.00\n\n-\n\n$80.00\n\nHourly\nAbout the client\n$300.00 /hr avg hourly rate paid\nClient's recent history\nFixed-price $5000.00";
 const job=extractJob({...base,text},"Upwork");expect(job?.hourlyUsd).toEqual({min:20,max:80});expect(job?.fixedBudgetUsd).toBeNull();expect(job?.description).not.toContain("avg hourly");expect(job?.title).toBe("Role");expect(job?.postedAt).toBe("2026-09-18T06:00:00.000Z");
 const fixed=extractJob({...base,text:text.replace("$20.00\n\n-\n\n$80.00\n\nHourly","$1,500.00\n\nFixed-price")},"Upwork");expect(fixed?.fixedBudgetUsd).toBe(1500);expect(fixed?.hourlyUsd).toBeNull();
 const unknown=extractJob({...base,text:text.replace("$20.00\n\n-\n\n$80.00\n\nHourly","")},"Upwork");expect(unknown?.hourlyUsd).toBeNull();expect(unknown?.payText).toBe("Not stated");
});

test("board related-job sections cannot supply pay or hide the current employment type",()=>{
 const job=extractJob({url:"https://weworkremotely.com/remote-jobs/example",title:"Engineer",heading:"Engineer",jsonld:[],collectedAt:"2026-09-18T12:00:00Z",text:"Engineer\nBuild useful software and maintain production APIs with clear documentation, automated tests, and regular collaboration with the engineering team.\nAbout the job\nJob type\n Full-Time\nRelated Jobs\nDifferent employer\nCompensation: USD $500/hour"},"We Work Remotely");
 expect(job?.kind).toBe("full_time");expect(job?.hourlyUsd).toBeNull();expect(job?.description).not.toContain("Different employer");
});

test("scrape schema rejects invalid URLs, dates, and application fields",()=>{
 const valid=page("Build integrations. ".repeat(20));
 expect(PageEvidence.safeParse({...valid,url:"javascript:alert(1)"}).success).toBe(false);
 expect(PageEvidence.safeParse({...valid,collectedAt:"yesterday"}).success).toBe(false);
 expect(PageEvidence.safeParse({...valid,applicationFields:[{label:"",type:"text",required:true,options:[],sourceUrl:valid.url}]}).success).toBe(false);
});
test("application questions and form metadata survive extraction",()=>{
 const original=page("Build integrations. ".repeat(20));
 const fields=[{label:"Why are you interested?",type:"textarea",required:true,options:[],sourceUrl:original.url}];
 const job=extractJob({...original,applicationFields:fields},"Test");
 expect(job?.applicationQuestions).toEqual(["Why are you interested?"]);
 expect(job?.applicationFields).toEqual(fields);
 expect(job?.questionsCheckedAt).toBe(original.collectedAt);
 expect(extractJob(original,"Test")?.questionsCheckedAt).toBeNull();
});
