import { expect, test } from "bun:test";
import { draftApplication } from "./analysis.ts";
import { Job, Preferences, Profile } from "./domain.ts";
test("application drafting refuses to report success without captured questions",async()=>{
 const job=Job.parse({url:"https://example.com/jobs/1",source:"Test",title:"Engineer",company:"Test",description:"A software role",kind:"part_time"});
 const profile=Profile.parse({name:"Example Candidate",fetchedAt:new Date().toISOString(),text:"",notes:[],stories:[]});
 const preferences=Preferences.parse({minimumHourlyUsd:135,maximumWeeklyHours:null,location:null,remoteOnly:null,keywords:[],maxAgeDays:30,shortlistSize:10});
 await expect(draftApplication(job,profile,preferences,[])).rejects.toThrow("No application questions have been captured");
});

import { protectApplicationFacts } from "./application-facts.ts";
test("application editors cannot broaden or lose protected résumé facts",()=>{
 const phrase="approximately 40% of test requests without manual review";
 const original=`I designed a support agent resolving ${phrase}.`;
 const protectedText=protectApplicationFacts(original,[phrase]);
 expect(protectedText.text).toContain('[SCOUT_FACT_0]');
 expect(protectedText.restore('I led the design of an agent resolving [SCOUT_FACT_0].')).toContain(phrase);
 expect(protectedText.restore('I built an agent that eliminated engineer involvement.')).toBe(original);
 expect(()=>protectApplicationFacts(original,['invented fact'])).toThrow();
});
