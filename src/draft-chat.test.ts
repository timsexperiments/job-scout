import { test, expect } from "bun:test";
import { applyChatEdits, SavedDraft, ChatInput } from "./draft-chat.ts";
import { Profile } from "./domain.ts";
const draft=SavedDraft.parse({jobId:'0123456789abcdef',url:'https://example.com/job',reviewRequired:true,generatedAt:new Date().toISOString(),proposal:'',answers:[{question:'Why?',answer:'Original'},{question:'How?',answer:'Keep me'}],evidence:[],needsConfirmation:[]});
const profile=Profile.parse({name:'Example Candidate',fetchedAt:new Date().toISOString(),text:'',notes:[],stories:[]});
test('question edits preserve other answers and reject invalid targets',()=>{
 const changed=applyChatEdits(draft,[{questionIndex:0,answer:'Revised',evidence:[]}],profile);
 expect(changed.answers[0]?.answer).toBe('Revised');expect(changed.answers[1]).toEqual(draft.answers[1]);expect(draft.answers[0]?.answer).toBe('Original');
 expect(()=>applyChatEdits(draft,[{questionIndex:9,answer:'Bad',evidence:[]}],profile)).toThrow();
 expect(()=>applyChatEdits(draft,[{questionIndex:0,answer:'One',evidence:[]},{questionIndex:0,answer:'Two',evidence:[]}],profile)).toThrow();
});
test('chat rejects unsupported résumé citations and malformed requests',()=>{
 expect(()=>applyChatEdits(draft,[{questionIndex:0,answer:'Invented',evidence:[{storyId:'fake',quote:'Invented'}]}],profile)).toThrow();
 expect(ChatInput.safeParse({message:' ',revision:'x'}).success).toBe(false);
});

import { removeInternalReferences } from "./draft-chat.ts";
test('internal résumé IDs stay out of application prose',()=>{
 const withStory=Profile.parse({...profile,stories:[{id:'r1-support',title:'Support',url:'resume://experience/r1-support',summary:'Led support.',tags:[],details:[],qualifications:[]}]});
 expect(removeInternalReferences('Led support (r1‑support).',withStory)).toBe('Led support.');
 expect(removeInternalReferences('Led support [r1-support].',withStory)).toBe('Led support.');
});
