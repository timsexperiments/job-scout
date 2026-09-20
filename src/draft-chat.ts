import { z } from "zod";
import { resolve } from "node:path";
import { Draft, Profile, Job, verifyEvidence } from "./domain.ts";
import { infer } from "./connectors.ts";
import { read, save, root, log } from "./io.ts";
export const SavedDraft=Draft.extend({jobId:z.string().regex(/^[a-f0-9]{16}$/),url:z.url(),reviewRequired:z.literal(true),generatedAt:z.string()});
const Evidence=z.object({storyId:z.string(),quote:z.string().min(1).max(3000)});
const Edit=z.object({questionIndex:z.number().int().nonnegative(),answer:z.string().max(3000),evidence:z.array(Evidence).max(5)});
const Change=z.object({question:z.string(),before:z.string(),after:z.string()});
const Base=z.object({id:z.uuid(),user:z.string(),createdAt:z.string(),questionIndex:z.number().int().nonnegative().nullable().default(null),tools:z.array(z.string())});
const Turn=z.discriminatedUnion("state",[
 Base.extend({state:z.literal("running")}),
 Base.extend({state:z.literal("done"),reply:z.string(),changes:z.array(Change)}),
 Base.extend({state:z.literal("failed"),error:z.string()})
]);
const Session=z.object({turns:z.array(Turn),versions:z.array(z.object({id:z.uuid(),label:z.string(),createdAt:z.string()}))});
type Session=z.infer<typeof Session>;
const locks=new Set<string>();
export const chatBusy=(id?:string)=>id?locks.has(id):locks.size>0;
const sessionPath=(id:string)=>`drafts/chat/${id}.json`;
export const revisionOf=(draft:unknown)=>new Bun.CryptoHasher('sha256').update(JSON.stringify(draft)).digest('hex');
const getDraft=(id:string)=>read(`drafts/${id}.json`,SavedDraft);
async function sessionFor(id:string):Promise<Session>{
 const file=Bun.file(resolve(root,sessionPath(id)));
 return await file.exists()?read(sessionPath(id),Session):{turns:[],versions:[]};
}
export async function chatState(id:string){
 const session=await sessionFor(id);
 if(!locks.has(id)&&session.turns.some(turn=>turn.state==='running')){
  session.turns=session.turns.map(turn=>turn.state==='running'?{...turn,state:'failed',error:'Editing was interrupted by an app restart. Check the draft and version history before retrying.'}:turn);
  await save(sessionPath(id),session);
 }
 return {...session,revision:revisionOf(await getDraft(id))};
}
export const ChatInput=z.object({message:z.string().trim().min(1).max(4000),revision:z.string().regex(/^[a-f0-9]{64}$/),questionIndex:z.number().int().nonnegative().nullable().default(null)});
const Decision=z.discriminatedUnion('action',[
 z.object({action:z.literal('search_resume'),query:z.string().min(1).max(300)}),
 z.object({action:z.literal('read_experience'),id:z.string().max(150)}),
 z.object({action:z.enum(['read_resume','read_job'])}),
 z.object({action:z.literal('reply'),reply:z.string().min(1).max(2500),edits:z.array(Edit).max(50)})
]);
export function removeInternalReferences(text:string,profile:Profile){
 let clean=text;
 for(const story of profile.stories){
  const escaped=story.id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replaceAll('-','[-‐‑–—]');
  clean=clean.replace(new RegExp(`\\s*[\\[(]${escaped}[\\])]`,'g'),'');
 }
 return clean;
}
export function applyChatEdits(draft:z.infer<typeof SavedDraft>,edits:z.infer<typeof Edit>[],profile:Profile){
 const indices=new Set<number>();
 const updated=SavedDraft.parse(draft);
 for(const edit of edits){
  const current=updated.answers[edit.questionIndex];
  if(!current||indices.has(edit.questionIndex))throw new Error('The editor returned an invalid or repeated question. Your draft was not changed.');
  indices.add(edit.questionIndex);
  if(edit.evidence.length)verifyEvidence(edit.evidence,profile.stories);
  current.answer=removeInternalReferences(edit.answer,profile);
  for(const item of edit.evidence)if(!updated.evidence.some(existing=>existing.storyId===item.storyId&&existing.quote===item.quote))updated.evidence.push(item);
 }
 return SavedDraft.parse({...updated,generatedAt:new Date().toISOString()});
}
async function snapshot(id:string,draft:z.infer<typeof SavedDraft>,session:Session,label:string){
 const version={id:crypto.randomUUID(),label,createdAt:new Date().toISOString()};
 await save(`drafts/history/${id}/${version.id}.json`,draft);session.versions.push(version);
}
async function writeDraft(id:string,draft:z.infer<typeof SavedDraft>){
 await save(`drafts/${id}.json`,draft);
 await save(`drafts/${id}.md`,`# Application answers\n\n[Original application](${draft.url})\n\nReview required. Nothing has been submitted.\n\n${draft.answers.map(answer=>`## ${answer.question}\n\n${answer.answer||'Needs your answer or upload'}`).join('\n\n')}\n`);
}
export async function restoreDraft(id:string,versionId:string,revision:string){
 if(locks.has(id))throw new Error('Wait for the current edit to finish.');
 locks.add(id);
 try{
  const session=await sessionFor(id),current=await getDraft(id);
  if(revisionOf(current)!==revision)throw new Error('The draft changed. Refresh before restoring a version.');
  if(!session.versions.some(version=>version.id===versionId))throw new Error('Version not found');
  const restored=await read(`drafts/history/${id}/${versionId}.json`,SavedDraft);
  await snapshot(id,current,session,'Before restoring an earlier version');
  await writeDraft(id,{...restored,generatedAt:new Date().toISOString()});
  session.turns.push({id:crypto.randomUUID(),user:'Restore earlier version',createdAt:new Date().toISOString(),questionIndex:null,tools:[],state:'done',reply:'Restored the selected draft version.',changes:[]});
  await save(sessionPath(id),session);
 }finally{locks.delete(id);}
}
export async function startChat(id:string,job:Job,input:z.infer<typeof ChatInput>){
 if(locks.has(id))throw new Error('An edit is already running for this application.');
 locks.add(id);
 try{
  const draft=await getDraft(id);
  if(revisionOf(draft)!==input.revision)throw new Error('The draft changed. Reopen it before sending this message.');
  if(input.questionIndex!==null&&!draft.answers[input.questionIndex])throw new Error('Selected question not found');
  const session=await sessionFor(id),turn:z.infer<typeof Turn>={id:crypto.randomUUID(),user:input.message,createdAt:new Date().toISOString(),questionIndex:input.questionIndex,tools:[],state:'running'};
  session.turns.push(turn);await save(sessionPath(id),session);
  void runChat(id,job,input,draft,session,turn).catch(()=>log("draft_chat_failed",{jobId:id})).finally(()=>locks.delete(id));
 }catch(error){locks.delete(id);throw error;}
}
async function runChat(id:string,job:Job,input:z.infer<typeof ChatInput>,draft:z.infer<typeof SavedDraft>,session:Session,turn:z.infer<typeof Base>){
 try{
  const profile=await read('data/profile.json',Profile);
  const instructions=await Bun.file(resolve(root,'prompts/application-chat.md')).text();
  const skill=await Bun.file(resolve(root,'prompts/unslop.md')).text();
  const toolResults:{action:string;result:unknown}[]=[];
  const search=(query:string)=>{
   const tokens=query.toLowerCase().match(/[a-z0-9]{3,}/g)??[];
   return profile.stories.map(story=>({story,score:tokens.reduce((sum,token)=>sum+(JSON.stringify(story).toLowerCase().includes(token)?1:0),0)})).sort((a,b)=>b.score-a.score).slice(0,6).map(({story})=>({id:story.id,title:story.title,summary:story.summary}));
  };
  toolResults.push({action:'search_resume',result:search(input.message+' '+job.title)});
  turn.tools.push('Searched résumé experience');await save(sessionPath(id),session);
  for(let step=0;step<6;step++){
   const {decision}=await infer(z.object({decision:Decision}),'application_chat',instructions+'\n\nUnslop skill:\n'+skill+(step===5?'\nTool budget exhausted. Reply using the available evidence; do not request more tools.':''),{
    conversation:session.turns.slice(-9).map(t=>({user:t.user,questionIndex:t.questionIndex,...(t.state==='done'?{assistant:t.reply}:{})})),
    selectedQuestionIndex:input.questionIndex,job:{title:job.title,url:job.url,description:job.description.slice(0,18000)},
    draft:{answers:draft.answers.map((answer,index)=>({...answer,questionIndex:index})),evidence:draft.evidence},
    resume:{name:profile.name,fetchedAt:profile.fetchedAt},toolResults
   },{request:input.message});
   if(decision.action==='reply'){
    if(input.questionIndex!==null && decision.edits.some(edit=>edit.questionIndex!==input.questionIndex))throw new Error('The editor tried to change another question. No changes were saved.');
    for (const edit of decision.edits) {
      const question = draft.answers[edit.questionIndex];
      if (!question) throw new Error('The editor selected an invalid question.');
      const polished = await infer(z.object({answer:z.string().max(3000)}),'application_chat_unslop',
        'Polish the proposed application answer according to the actual user request and the supplied unslop skill. Preserve supported facts, ownership, quantitative qualifiers, and technical meaning. Keep the requested scope and length. Remove all internal resume IDs, citations, and editorial notes from the answer. Return only the answer text, not a conversation reply. Do not add experience, assumptions, or a cover letter. If asked for 80 words, aim for 70–90 words. Preserve helpful paragraph breaks.\n\n'+skill,
        {question:question.question,original:question.answer,proposed:edit.answer,evidence:edit.evidence.length?edit.evidence:draft.evidence}, {request:input.message});
      edit.answer = removeInternalReferences(polished.answer,profile);
    }
    const updated=applyChatEdits(draft,decision.edits,profile);
    const changes=decision.edits.flatMap(edit=>{const before=draft.answers[edit.questionIndex];return before&&before.answer!==edit.answer?[{question:before.question,before:before.answer,after:edit.answer}]:[];});
    if(changes.length){
     if(revisionOf(await getDraft(id))!==input.revision)throw new Error('The draft changed during editing. Your existing draft was kept. Please retry.');
     await snapshot(id,draft,session,'Before: '+input.message.slice(0,100));
     await writeDraft(id,updated);
    }
    const reply = changes.length && decision.reply.length > 500 ? 'Updated the selected answer'+(changes.length > 1 ? 's' : '')+'. Review the changes below; you can restore an earlier version.' : removeInternalReferences(decision.reply,profile);
    session.turns=session.turns.map(t=>t.id===turn.id?{...turn,state:'done',reply,changes}:t);
    await save(sessionPath(id),session);return;
   }
   let result:unknown;
   switch(decision.action){
    case 'search_resume':result=search(decision.query);break;
    case 'read_experience':result=profile.stories.find(story=>story.id===decision.id)??{error:'No record with that ID. Use search_resume.'};break;
    case 'read_resume':result={name:profile.name,text:profile.text,notes:profile.notes,fetchedAt:profile.fetchedAt};break;
    case 'read_job':result=job;break;

   }
   toolResults.push({action:decision.action,result});turn.tools.push(decision.action.replaceAll('_',' '));await save(sessionPath(id),session);
  }
  throw new Error('The editor used its lookup budget without answering. Your draft is unchanged. Try a more specific request.');
 }catch(error){
  session.turns=session.turns.map(t=>t.id===turn.id?{...turn,state:'failed',error:error instanceof Error?error.message:'Editing failed. Your prior draft is preserved.'}:t);
  await save(sessionPath(id),session);
 }
}
