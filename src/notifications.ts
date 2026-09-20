import { RemoteLinks } from "./remote-links.ts";
import { SetupConfig } from "./setup-auth.ts";
import { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, rename, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import nodemailer from "nodemailer";
import { z } from "zod";
import { root, log, read } from "./io.ts";
export const alertSender = process.env.JOB_SCOUT_ALERT_SENDER ?? "";
export const alertRecipient = process.env.JOB_SCOUT_ALERT_RECIPIENT ?? "";
export const SMTPInput = z.object({ email: z.email().max(254), appPassword: z.string().transform(value => value.replace(/\s/g, "")).pipe(z.string().regex(/^[a-zA-Z]{16}$/)) });
export type SMTPInput = z.infer<typeof SMTPInput>;
const Envelope = z.object({ iv: z.string(), tag: z.string(), ciphertext: z.string() });
export function seal(input: SMTPInput, key: Buffer) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(input), "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}
export function unseal(input: unknown, key: Buffer): SMTPInput {
  const value = Envelope.parse(input), cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv,"base64"));
  cipher.setAuthTag(Buffer.from(value.tag,"base64"));
  return SMTPInput.parse(JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.ciphertext,"base64")), cipher.final()]).toString("utf8")));
}
export class MailVault {
  constructor(private directory = resolve(root,"data/mail")) {}
  async configured() { return Bun.file(resolve(this.directory,"smtp.enc.json")).exists(); }
  async save(input: SMTPInput) {
    await mkdir(this.directory,{recursive:true,mode:0o700}); await chmod(this.directory,0o700);
    const keyPath = resolve(this.directory,"key");
    try { await writeFile(keyPath,randomBytes(32),{flag:"wx",mode:0o600}); } catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error; }
    const key = await readFile(keyPath);
    const path = resolve(this.directory,"smtp.enc.json");
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary,JSON.stringify(seal(SMTPInput.parse(input),key)),{mode:0o600}); await rename(temporary,path);
  }
  async load() { return unseal(JSON.parse(await readFile(resolve(this.directory,"smtp.enc.json"),"utf8")),await readFile(resolve(this.directory,"key"))); }
}
const Alert = z.object({ id:z.string(), source:z.string(), reason:z.string(), firstSeen:z.number(), lastSeen:z.number(), attempts:z.number() });
export class AlertQueue {
  private db: Database;
  constructor(path = resolve(root,"data/notifications.sqlite")) {
    this.db = new Database(path); this.db.run("PRAGMA busy_timeout=5000"); this.db.run("PRAGMA journal_mode=WAL");
    this.db.run("CREATE TABLE IF NOT EXISTS alerts(id TEXT PRIMARY KEY,source TEXT NOT NULL,reason TEXT NOT NULL,firstSeen INTEGER NOT NULL,lastSeen INTEGER NOT NULL,sentAt INTEGER NOT NULL DEFAULT 0,pending INTEGER NOT NULL DEFAULT 1,attempts INTEGER NOT NULL DEFAULT 0,nextAttempt INTEGER NOT NULL DEFAULT 0)");
  }
  enqueue(source:string,reason:string,now=Date.now()) {
    const id = new Bun.CryptoHasher("sha256").update(`${source}:${reason}`).digest("hex");
    this.db.query(`INSERT INTO alerts(id,source,reason,firstSeen,lastSeen) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET lastSeen=excluded.lastSeen, pending=CASE WHEN alerts.pending=1 OR excluded.lastSeen-alerts.sentAt>=86400000 THEN 1 ELSE 0 END`).run(id,source,reason,now,now);
  }
  pending(now=Date.now()) {return z.array(Alert).parse(this.db.query("SELECT id,source,reason,firstSeen,lastSeen,attempts FROM alerts WHERE pending=1 AND attempts<5 AND nextAttempt<=? ORDER BY firstSeen LIMIT 20").all(now));}
  sent(id:string,now=Date.now()) {this.db.query("UPDATE alerts SET pending=0,sentAt=?,attempts=0,nextAttempt=0 WHERE id=?").run(now,id);}
  failed(id:string,attempts:number,now=Date.now()) {this.db.query("UPDATE alerts SET attempts=attempts+1,nextAttempt=? WHERE id=?").run(now+Math.min(3600000,300000*2**attempts),id);}
  resetRetries() {this.db.run("UPDATE alerts SET attempts=0,nextAttempt=0 WHERE pending=1");}
  close() {this.db.close();}
}
export function classifyBlock(notes:string[]):string {
  const text=notes.join(" ");
  if (/verification|captcha/i.test(text)) return "CAPTCHA or human verification required";
  if (/login|HTTP 401/i.test(text.replace(/Use browser-login.*$/gm,""))) return "Login required";
  if (/HTTP 429/.test(text)) return "Site rate limit reached";
  return "Site access blocked; account status unknown";
}
export function enqueueBlock(source:string,notes:string[]) {
  const queue=new AlertQueue();try {queue.enqueue(source.slice(0,120),classifyBlock(notes));} finally {queue.close();}
}
function transport(input:SMTPInput) {
  return nodemailer.createTransport({host:"smtp.gmail.com",port:465,secure:true,auth:{user:input.email,pass:input.appPassword},tls:{minVersion:"TLSv1.2",rejectUnauthorized:true},connectionTimeout:15000,greetingTimeout:15000,socketTimeout:20000,logger:false,debug:false,disableFileAccess:true,disableUrlAccess:true});
}
export async function sendGoogleMail(input:SMTPInput,subject:string,text:string) {
  if (!z.email().safeParse(alertSender).success || !z.email().safeParse(alertRecipient).success) throw new Error("Configure JOB_SCOUT_ALERT_SENDER and JOB_SCOUT_ALERT_RECIPIENT in .env");
  const client=transport(input);
  try {await client.sendMail({from:{name:"Job Scout",address:alertSender},replyTo:alertSender,to:alertRecipient,subject,text,disableFileAccess:true,disableUrlAccess:true});}
  finally {client.close();}
}
export function smtpErrorMessage(error:unknown):string {
  const result=z.object({code:z.string()}).safeParse(error);
  return result.success && result.data.code === "EAUTH" ? "Google rejected the sign-in. Check the account and app password; your account may not permit app passwords." : "Could not send through Google SMTP. Check the connection and app-password settings, then retry.";
}
let flushing=false;
export async function flushAlerts() {
  if (flushing) return;
  flushing=true;
  let queue:AlertQueue|null=null;
  try {
    const vault=new MailVault();if (!(await vault.configured())) return;
    queue=new AlertQueue();const pending=queue.pending();if (!pending.length) return;
    const input=await vault.load();
    const remote=await read("data/remote-browser/config.json",SetupConfig).catch(()=>null);
    let phoneHelp = "";
    if (remote) {
      const links = new RemoteLinks();
      try {
        const issued = links.issue();
        phoneHelp = `On your home Wi-Fi, open this fresh private link and tap Unlock this phone:\nhttps://${remote.address}:${remote.port}/#${issued.token}\n\nThis single-use link expires at ${new Date(issued.expiresAt).toISOString()}. Phone access lasts 30 minutes after unlocking. The page shows the current request, if one is still waiting. Complete verification, then tap Done. The browser waits up to two hours while the Mac is awake.`;
      } finally { links.close(); }
    }
    const body=["Job Scout needs your attention.",phoneHelp,"",...pending.map(item=>`${item.source}: ${item.reason}\nLast observed: ${new Date(item.lastSeen).toISOString()}`),"","A CAPTCHA or HTTP access block does not establish that your account was flagged or suspended.",...(remote?[]:["On your Mac, open http://127.0.0.1:4317, choose the source, and select Open source for manual login. Complete verification yourself, close that window, and retry collection."]),"No application was submitted. Repeated identical blocks are limited to one alert per source/reason per 24 hours."].join("\n\n");
    try {await sendGoogleMail(input,"Job Scout: browser access needs attention",body);for (const item of pending) queue.sent(item.id);log("notification_sent",{alerts:pending.length});}
    catch (error) {for (const item of pending) queue.failed(item.id,item.attempts);log("notification_failed",{message:smtpErrorMessage(error)});}
  } catch {log("notification_failed",{message:"Local mail configuration or queue could not be read"});}
  finally {queue?.close();flushing=false;}
}
