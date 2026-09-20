import { RemoteLinks } from "./remote-links.ts";
import type { ServerWebSocket } from "bun";
import { resolve } from "node:path";
import { z } from "zod";
import { read,root,save,log } from "./io.ts";
import { SetupConfig,SetupSessions,sameSubnet,tokenMatches } from "./setup-auth.ts";
import { pendingHelp,helpRequest } from "./human-help.ts";
export { controlPage,RemoteAction } from "./browser-control.ts";
type VncPeer={cookie:string;id:string;upstream:WebSocket|null;queued:Uint8Array[];bytes:number;serial:Promise<void>};
export async function startRemoteBrowser() {
 if(!await Bun.file(resolve(root,"data/remote-browser/config.json")).exists())return null;
 const config=await read("data/remote-browser/config.json",SetupConfig);
 const origin=`https://${config.address}:${config.port}`,sessions=new SetupSessions();
 const headers={"Cache-Control":"no-store","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff","Content-Security-Policy":"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob: data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"};
 const reply=(v:unknown,status=200,extra:Record<string,string>={})=>Response.json(v,{status,headers:{...headers,...extra}});
 let redeeming=false;
 const attempts=new Map<string,{count:number;until:number}>();
 const peers=new Set<ServerWebSocket<VncPeer>>();
 const server=Bun.serve<VncPeer>({hostname:config.address,port:config.port,maxRequestBodySize:16384,tls:{key:Bun.file(resolve(root,"data/mail-setup/key.pem")),cert:Bun.file(resolve(root,"data/mail-setup/cert.pem"))},
 async fetch(request,server) {try {
 const peer=server.requestIP(request)?.address;
 if(!peer || !sameSubnet(peer,config.address,config.netmask) || request.headers.get("host")!==`${config.address}:${config.port}`) return reply({error:"LAN access only"},403);
 const path=new URL(request.url).pathname;
 if(request.method === "GET" && ["/dashboard", "/dashboard/"].includes(path)) return Response.redirect(`https://${config.address}:${z.coerce.number().int().min(1024).max(65535).parse(process.env.JOB_SCOUT_PORT ?? 4317)}/`,302);
 const assets:Record<string,string>={"/":"remote.html","/remote.js":"remote.js","/remote.css":"remote.css"};
 if(request.method==="GET" && assets[path]) return new Response(Bun.file(resolve(root,"web",assets[path])),{headers});
 const cookie=request.headers.get("cookie")?.split(";").map(v=>v.trim()).find(v=>v.startsWith("__Host-scoutRemote="))?.slice(19) ?? "";
 const session=sessions.get(cookie);
 if(request.method==="POST") {
 if(request.headers.get("origin")!==origin || request.headers.get("content-type")!=="application/json") return reply({error:"Invalid origin"},403);
 if(path==="/api/redeem") {
 const now=Date.now();for(const [ip,r] of attempts) if(r.until<now) attempts.delete(ip);
 const rate=attempts.get(peer)??{count:0,until:now+600000};attempts.set(peer,rate);if(++rate.count>10)return reply({error:"Too many attempts"},429);
 const input=z.object({token:z.string().max(100)}).parse(await request.json());
 const links = new RemoteLinks();
 let emailedLink = false;
 try { if (!redeeming) emailedLink = links.consume(input.token); } finally { links.close(); }
 if(redeeming || (!emailedLink && !tokenMatches(input.token,config))) return reply({error:"Link expired or already used. Use your unlocked phone or generate another link."},401);
 redeeming=true;try {if(!emailedLink){await save("data/remote-browser/config.json",{...config,consumed:true});config.consumed=true;}const issued=sessions.create();return reply({ok:true},200,{"Set-Cookie":`__Host-scoutRemote=${issued.token}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800`});}finally{redeeming=false;}
 }
 if(!session || request.headers.get("x-remote-csrf")!==session.csrf)return reply({error:"Unlock the remote browser first"},401);
 }

 if(!session)return reply({error:"Open your private link and tap Unlock"},401);
 if(path === "/dashboard" && request.method === "GET") return Response.redirect(origin + "/dashboard/", 302);
 if(path.startsWith("/dashboard/")) {
   const target = path.slice("/dashboard".length);
   const assets: Record<string,string> = { "/": "index.html", "/app.js": "app.js", "/style.css": "style.css" };
   if(request.method === "GET" && assets[target]) {
     let content = await Bun.file(resolve(root,"web",assets[target])).text();
     if(target === "/") content = content.replace('href="/style.css"','href="/dashboard/style.css"').replace('src="/app.js"','src="/dashboard/app.js"').replace('href="/"','href="/dashboard/"');
     return new Response(content,{headers:{...headers,"Content-Type":target === "/" ? "text/html" : target.endsWith(".js") ? "text/javascript" : "text/css"}});
   }
   if(!/^\/api\/(state|browser-coverage|stop|preferences|import|plan|status|command|draft\/[a-f0-9]{16})$/.test(target) || !["GET","POST"].includes(request.method)) return reply({error:"Not found"},404);
   const base = `http://127.0.0.1:${z.coerce.number().int().min(1024).max(65535).parse(process.env.JOB_SCOUT_PORT ?? 4317)}`;
   const upstream = await fetch(base + target, { method: request.method, redirect: "error", headers: { "Content-Type":"application/json", Origin:base, "X-Scout-Token":request.headers.get("x-scout-token") ?? "" }, ...(request.method === "POST" ? {body:await request.text()} : {}) });
   return new Response(upstream.body,{status:upstream.status,headers:{...headers,"Content-Type":"application/json"}});
 }
 if(request.method==="GET" && /^\/novnc\/(core|vendor)\/[a-zA-Z0-9_/.\-]+\.js$/.test(path)){
 const upstream=await fetch("http://127.0.0.1:46080/"+path.slice(7),{redirect:"error"});
 return new Response(upstream.body,{status:upstream.status,headers:{...headers,"Content-Type":"text/javascript"}});
 }
 const pending=await pendingHelp();
 if(request.method==="GET" && path==="/api/vnc"){
 if(request.headers.get("origin")!==origin || !pending || new URL(request.url).searchParams.get("id")!==pending.id)return reply({error:"Invalid desktop session"},403);
 const state=await helpRequest(pending,"/state");const info=z.object({transport:z.string()}).parse(await state.json());
 if(!state.ok || info.transport!=="novnc")return reply({error:"No desktop available"},409);
 if(server.upgrade(request,{data:{cookie,id:pending.id,upstream:null,queued:[],bytes:0,serial:Promise.resolve()}}))return;
 return reply({error:"WebSocket upgrade required"},400);
 }
 if(request.method==="GET" && path==="/api/state"){
 const response=pending?await helpRequest(pending,"/state").catch(()=>null):null;
 const help=response?.ok?await response.json():null;
 return reply({csrf:session.csrf,help,expiresAt:session.expires});
 }
 if(!["/api/frame","/api/action","/api/finish"].includes(path))return reply({error:"Not found"},404);
 if(!pending)return reply({error:"Nothing needs your attention."},409);
 if(request.method==="GET" && path==="/api/frame"){
 if(new URL(request.url).searchParams.get("id")!==pending.id)return reply({error:"This request has changed."},409);
 const frame=await helpRequest(pending,"/frame");return new Response(frame.body,{status:frame.status,headers:{...headers,"Content-Type":frame.headers.get("content-type")??"application/json"}});
 }
 if(request.method==="POST" && ["/api/action","/api/finish"].includes(path)){
 const input=z.object({id:z.uuid(),payload:z.unknown()}).parse(await request.json());
 if(input.id!==pending.id)return reply({error:"This request has changed. Refresh the page."},409);
 if(path==="/api/finish")for(const peer of peers)peer.close(1000,"Returning control");
 const response=await helpRequest(pending,path.replace("/api",""),input.payload);
 return new Response(response.body,{status:response.status,headers:{...headers,"Content-Type":"application/json"}});
 }
 return reply({error:"Not found"},404);
 }catch{return reply({error:"Request is no longer available. Refresh the page."},400);}},
 websocket:{
 maxPayloadLength:1048576,
 open(peer){peers.add(peer);const upstream=new WebSocket("ws://127.0.0.1:46080/websockify",["binary"]);upstream.binaryType="arraybuffer";peer.data.upstream=upstream;
 upstream.onopen=()=>{for(const item of peer.data.queued)upstream.send(item);peer.data.queued=[];peer.data.bytes=0;};
 upstream.onmessage=event=>{if(event.data instanceof ArrayBuffer)peer.send(event.data);};
 upstream.onerror=()=>peer.close(1011,"Desktop connection failed");upstream.onclose=()=>peer.close(1000,"Desktop disconnected");
 },
 message(peer,message){const data=typeof message==="string"?new TextEncoder().encode(message):new Uint8Array(message);peer.data.serial=peer.data.serial.then(async()=>{
 if(!peers.has(peer))return;
 if(!sessions.get(peer.data.cookie) || (await pendingHelp())?.id!==peer.data.id){peer.close(1008,"Access expired");return;}
 if(!peers.has(peer))return;
 const upstream=peer.data.upstream;if(upstream?.readyState===WebSocket.OPEN)upstream.send(data);else if(peer.data.bytes+data.length<=1048576){peer.data.queued.push(data);peer.data.bytes+=data.length;}else peer.close(1009,"Input queue full");
 }).catch(()=>peer.close(1011,"Desktop input failed"));
 },
 close(peer){peers.delete(peer);peer.data.upstream?.close();peer.data.queued=[];}
 }
 });
 const watchdog=setInterval(async()=>{const pending=await pendingHelp();for(const peer of peers)if(!sessions.get(peer.data.cookie)||pending?.id!==peer.data.id)peer.close(1008,"Request ended or access expired");},1000);
 log("remote_browser_started",{url:origin});
 return {active:()=>false,stop:async()=>{clearInterval(watchdog);for(const peer of peers)peer.close();server.stop(true);}};
}
