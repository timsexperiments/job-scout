import { z } from "zod";
import { Job, ListingUrl, ApplicationField, hourlyPay } from "./domain.ts";
export const PageEvidence = z.object({ url: ListingUrl, title: z.string().max(2000), heading: z.string().max(2000), text: z.string().max(1000000), jsonld: z.array(z.unknown()).max(500), collectedAt: z.iso.datetime({ offset: true }), applicationFields: z.array(ApplicationField).max(300).optional() });
export type PageEvidence = z.infer<typeof PageEvidence>;
function applicationData(page: PageEvidence) {
  const fields = page.applicationFields ?? [];
  const block = page.text.match(/(?:You will be asked to answer the following questions|Screening questions)[^\n]*\n([\s\S]*?)(?=\n(?:Skills|Activity on this job|About the client|Required skills)|$)/i)?.[1] ?? "";
  const questions = block.split(/\n+/).map(line => line.replace(/^\s*\d+[.)]\s*/, "").trim()).filter(line => line.length > 5 && line.length <= 1000);
  return { availability: "listed", refreshedAt: page.collectedAt, refreshError: null, applicationFields: fields, applicationQuestions: [...new Set([...fields.map(field => field.label), ...questions])], questionsCheckedAt: page.applicationFields ? page.collectedAt : null };
}
const Structured = z.object({ "@type": z.union([z.string(), z.array(z.string())]), title: z.string().optional(), hiringOrganization: z.object({ name: z.string() }).optional(), employmentType: z.union([z.string(), z.array(z.string())]).optional(), datePosted: z.string().optional(), validThrough: z.string().optional() });
function postings(values: unknown[]): z.infer<typeof Structured>[] {
  return values.flatMap(value => {
    if (Array.isArray(value)) return postings(value);
    const record = z.record(z.string(), z.unknown()).safeParse(value);
    if (!record.success) return [];
    const parsed = Structured.safeParse(value);
    const current = parsed.success && [parsed.data["@type"]].flat().includes("JobPosting") ? [parsed.data] : [];
    return [...current, ...postings(Array.isArray(record.data["@graph"]) ? record.data["@graph"] : [])];
  });
}
export function extractJob(page: PageEvidence, source: string): Job | null {
  if(source==="Upwork")return extractUpwork(page);
  const structured = postings(page.jsonld)[0];
  if (/no longer accepting applications|this job (?:has been|is) (?:closed|removed)|position has been filled/i.test(page.text)) return null;
  if (structured?.validThrough && Date.parse(structured.validThrough) < Date.now()) return null;
  const title = structured?.title || page.heading || page.title;
  if (!title || page.text.length < 150) return null;
  const listingText = page.text.split(/\n(?:Similar Jobs|Explore similar jobs|Apply for this job|Related Jobs)\n/i)[0] ?? page.text;
  const lines = listingText.split(/\n/).map(line => line.trim()).filter(Boolean);
  const payLines = lines.filter((line, index) => /\$|USD/.test(line) && /salary|compensation|pay|budget|fixed|hour|\/hr|\/h\b/i.test(lines.slice(Math.max(0,index-1),index+2).join(" "))).slice(0, 6);
  const payText = payLines.join(" · ") || "Not stated";
  // Board estimates are not client offers. Fixed budgets remain unknown unless
  // someone confirms a scope and amount; preserve the original pay wording.
  const estimated = /\best\.|estimated|estimate/i.test(payText);
  const hourly = estimated ? null : hourlyPay(payText, /United States|U\.S\.|USA/.test(page.text) ? "United States" : null);
  const employment = [structured?.employmentType ?? []].flat().join(" ") + " " + title + " " + (listingText.match(/(?:Employment Type|Job type)\s*\n+([^\n]+)/i)?.[1] ?? "");
  const kind = /part[ _-]time/i.test(employment) ? "part_time" : /full[ _-]time/i.test(employment) ? "full_time" : /fractional|contract/i.test(employment) ? "contract" : "unknown";
  const posted = structured?.datePosted ? Date.parse(structured.datePosted) : NaN;
  return Job.parse({ ...applicationData(page), url: page.url, source, title, company: structured?.hiringOrganization?.name ?? "", description: listingText.slice(0, 60000), kind,
    payText, hourlyUsd: hourly, postedAt: Number.isFinite(posted) ? new Date(posted).toISOString() : null });
}

function extractUpwork(page:PageEvidence):Job|null {
 const text=(page.text.split(/\nAbout the client\n|\nClient's recent history/i)[0]??page.text).trim();
 if(/this job (?:has been|is) (?:closed|removed)|no longer accepting applications/i.test(text))return null;
 const lines=text.split(/\n+/).map(s=>s.trim()).filter(Boolean);
 const title=page.heading||lines[1]||page.title;if(!title||text.length<150)return null;
 const range=text.match(/\$([\d,]+(?:\.\d+)?)\s*[-–]\s*\$([\d,]+(?:\.\d+)?)\s*\n\s*Hourly\b/i);
 const fixed=text.match(/\$([\d,]+(?:\.\d+)?)\s*\n\s*Fixed-price\b/i);
 const amount=(value:string)=>Number(value.replaceAll(",",""));
 const hourly=range?.[1]&&range[2]?{min:amount(range[1]),max:amount(range[2])}:null;
 const budget=fixed?.[1]?amount(fixed[1]):null;
 const payText=hourly?`USD $${hourly.min}–$${hourly.max}/hour`:budget?`USD $${budget} fixed-price`:"Not stated";
 const relative=text.match(/\nPosted\s+(?:(\d+)\s+(minute|hour|day|week)s?\s+ago|(yesterday))/i);
 let postedAt:string|null=null;const collected=Date.parse(page.collectedAt);
 if(relative&&Number.isFinite(collected)){const count=relative[3]?1:Number(relative[1]);const unit=relative[3]?"day":relative[2];const factor=unit==="minute"?60000:unit==="hour"?3600000:unit==="week"?604800000:86400000;postedAt=new Date(collected-count*factor).toISOString();}
 return Job.parse({...applicationData(page),url:page.url,source:"Upwork",title,company:"",description:text,kind:/full[ -]time/i.test(title)?"full_time":"freelance",payText,hourlyUsd:hourly,fixedBudgetUsd:budget,postedAt,location:/\nWorldwide\n/.test(text)?"Worldwide":null});
}
