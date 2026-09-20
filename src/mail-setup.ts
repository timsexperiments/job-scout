import { resolve } from "node:path";
import { z } from "zod";
import { read, root, save, log } from "./io.ts";
import { SetupConfig, SetupSessions, sameSubnet, tokenMatches } from "./setup-auth.ts";
import { MailVault, SMTPInput, sendGoogleMail, alertRecipient, smtpErrorMessage, AlertQueue, flushAlerts } from "./notifications.ts";
export async function startMailSetup() {
  if (!(await Bun.file(resolve(root,"data/mail-setup/config.json")).exists())) return null;
  const config=await read("data/mail-setup/config.json",SetupConfig);
  if (Date.now()>=config.expiresAt) return null;
  const origin=`https://${config.address}:${config.port}`;
  const sessions=new SetupSessions(), attempts=new Map<string,{count:number;until:number}>();
  let redeeming=false, saving=false;
  const headers={"Cache-Control":"no-store", "Referrer-Policy":"no-referrer", "X-Content-Type-Options":"nosniff", "X-Frame-Options":"DENY", "Content-Security-Policy":"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"};
  const reply=(value:unknown,status=200,extra:Record<string,string>={})=>Response.json(value,{status,headers:{...headers,...extra}});
  const server=Bun.serve({hostname:config.address,port:config.port,maxRequestBodySize:4096,tls:{key:Bun.file(resolve(root,"data/mail-setup/key.pem")),cert:Bun.file(resolve(root,"data/mail-setup/cert.pem"))},
    async fetch(request,server) {
      try {
        const peer=server.requestIP(request)?.address;
        if (!peer || !sameSubnet(peer,config.address,config.netmask)) return reply({error:"LAN access only"},403);
        const url=new URL(request.url);
        if (request.headers.get("host")!==`${config.address}:${config.port}`) return reply({error:"Invalid host"},403);
        if (request.method==="GET" && ["/","/setup.js","/setup.css"].includes(url.pathname)) {
          const path=url.pathname==="/" ? "mail-setup.html" : url.pathname==="/setup.js" ? "mail-setup.js" : "mail-setup.css";
          return new Response(Bun.file(resolve(root,"web",path)),{headers});
        }
        const cookie=request.headers.get("cookie")?.split(";").map(part=>part.trim()).find(part=>part.startsWith("__Host-scoutSetup="))?.slice("__Host-scoutSetup=".length) ?? "";
        const session=sessions.get(cookie);
        if (request.method==="GET" && url.pathname==="/api/status") {
          if (!session) return reply({error:"Open your private setup link"},401);
          return reply({configured:await new MailVault().configured(),recipient:alertRecipient,csrf:session.csrf});
        }
        if (request.method!=="POST") return reply({error:"Not found"},404);
        if (request.headers.get("origin")!==origin || request.headers.get("content-type")!=="application/json") return reply({error:"Invalid origin or content type"},403);
        if (url.pathname==="/api/redeem") {
          const now=Date.now();
          for (const [key,value] of attempts) if (value.until<now) attempts.delete(key);
          const rate=attempts.get(peer) ?? {count:0,until:now+10*60000};rate.count++;attempts.set(peer,rate);
          if (rate.count>10) return reply({error:"Too many attempts. Try again later."},429);
          const input=z.object({token:z.string().max(100)}).safeParse(await request.json());
          if (!input.success || redeeming || !tokenMatches(input.data.token,config)) return reply({error:"Link expired, already used, or invalid"},401);
          redeeming=true;
          try {
            await save("data/mail-setup/config.json",{...config,consumed:true});config.consumed=true;
            const issued=sessions.create();
            return reply({csrf:issued.csrf,recipient:alertRecipient},200,{"Set-Cookie":`__Host-scoutSetup=${issued.token}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800`});
          } finally {redeeming=false;}
        }
        if (!session || request.headers.get("x-setup-csrf")!==session.csrf) return reply({error:"Setup session expired or invalid"},403);
        if (url.pathname==="/api/save") {
          if (saving) return reply({error:"A setup test is already running"},409);
          const input=SMTPInput.safeParse(await request.json());
          if (!input.success) return reply({error:"Enter a valid Google email and a 16-letter Google app password."},400);
          saving=true;
          try {
            await sendGoogleMail(input.data,"Job Scout: email alerts connected","This is your requested Job Scout setup test. Google SMTP accepted your configuration. Job Scout will email this address when browser collection encounters human verification, login requirements, rate limits, or access blocks. Those events do not necessarily indicate an account flag.\n\nThis setup used a local, single-use link. Your app password is not included in this message.");
            await new MailVault().save(input.data);
            const queue=new AlertQueue();try {queue.resetRetries();} finally {queue.close();}
            sessions.revoke(cookie);void flushAlerts();
            log("mail_setup_completed",{recipient:alertRecipient});
            return reply({ok:true,message:"Google accepted the test email. Alerts are enabled; check your inbox and spam folder."},200,{"Set-Cookie":"__Host-scoutSetup=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"});
          } catch (error) {return reply({error:smtpErrorMessage(error)},502);}
          finally {saving=false;}
        }
        return reply({error:"Not found"},404);
      } catch {return reply({error:"Request could not be processed"},400);}
    }
  });
  setTimeout(()=>server.stop(),Math.max(1,config.expiresAt-Date.now()+30*60000)).unref();
  log("mail_setup_available",{address:config.address,port:config.port,expiresAt:new Date(config.expiresAt).toISOString()});
  return server;
}
