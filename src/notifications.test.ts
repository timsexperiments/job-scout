import { test, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seal,unseal,SMTPInput,AlertQueue,MailVault,classifyBlock } from "./notifications.ts";
import { tokenMatches,hashToken,sameSubnet,SetupSessions,SetupConfig } from "./setup-auth.ts";
const credentials=SMTPInput.parse({email:"test@example.com",appPassword:"abcd efgh ijkl mnop"});
test("mail vault encrypts, authenticates, and restricts credential files",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"scout-mail-test-"));
  try {const vault=new MailVault(directory);await vault.save(credentials);expect(await vault.load()).toEqual(credentials);expect((await readFile(join(directory,"smtp.enc.json"),"utf8")).includes(credentials.appPassword)).toBe(false);expect((await stat(join(directory,"key"))).mode&0o777).toBe(0o600);const key=randomBytes(32),encrypted=seal(credentials,key);expect(()=>unseal({...encrypted,tag:randomBytes(16).toString("base64")},key)).toThrow();}finally{await rm(directory,{recursive:true,force:true});}
});
test("alert queue deduplicates, backs off failures, and re-alerts after a day",()=>{
  const queue=new AlertQueue(":memory:"), now=Date.now();
  try {queue.enqueue("Upwork","CAPTCHA",now);queue.enqueue("Upwork","CAPTCHA",now+1);const item=queue.pending(now+1)[0];expect(item).toBeDefined();if(!item)throw new Error("Expected alert");queue.failed(item.id,0,now);expect(queue.pending(now+1000)).toHaveLength(0);queue.resetRetries();expect(queue.pending(now+1000)).toHaveLength(1);queue.sent(item.id,now);queue.enqueue("Upwork","CAPTCHA",now+2000);expect(queue.pending(now+2000)).toHaveLength(0);queue.enqueue("Upwork","CAPTCHA",now+86400001);expect(queue.pending(now+86400001)).toHaveLength(1);}finally{queue.close();}
});
test("magic links expire, cannot replay after consumption, and issue expiring sessions",()=>{
  const token=randomBytes(32).toString("base64url"),now=Date.now();
  const config=SetupConfig.parse({address:"192.168.4.10",netmask:"255.255.252.0",port:4318,tokenHash:hashToken(token),expiresAt:now+1000,consumed:false,fingerprint:"test"});
  expect(tokenMatches(token,config,now)).toBe(true);expect(tokenMatches(token,{...config,consumed:true},now)).toBe(false);expect(tokenMatches(token,config,now+1000)).toBe(false);expect(tokenMatches("invalid",config,now)).toBe(false);
  const sessions=new SetupSessions(),session=sessions.create(now);expect(sessions.get(session.token,now)?.csrf).toBe(session.csrf);expect(sessions.get(session.token,now+30*60000)).toBeNull();
});
test("LAN boundary respects netmask and access blocks do not imply account flags",()=>{
  expect(sameSubnet("192.168.5.9","192.168.4.10","255.255.252.0")).toBe(true);expect(sameSubnet("192.168.8.9","192.168.4.10","255.255.252.0")).toBe(false);expect(sameSubnet("8.8.8.8","192.168.4.10","255.255.252.0")).toBe(false);
  expect(classifyBlock(["Access restricted (HTTP 403). Use browser-login for manual sign-in, then rerun."])).toBe("Site access blocked; account status unknown");expect(classifyBlock(["Human verification required"])).toBe("CAPTCHA or human verification required");
});
