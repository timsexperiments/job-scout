import { desktopEnabled } from "./browser-desktop.ts";
import { browserDiagnostics } from "./browser-diagnostics.ts";
import type { Page, BrowserContext } from "playwright";
import { randomBytes } from "node:crypto";
import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { read,save,root } from "./io.ts";
import { RemoteAction,controlPage } from "./browser-control.ts";
import { AlertQueue } from "./notifications.ts";
const descriptorPath="data/remote-browser/pending.json";
export const HelpDescriptor=z.object({id:z.uuid(),port:z.number().int().min(1).max(65535),token:z.string().length(43),expiresAt:z.number()});
const manualContexts=new WeakSet<BrowserContext>();
export const humanControlling=(context:BrowserContext)=>manualContexts.has(context);
export async function pendingHelp(){const item=await read(descriptorPath,HelpDescriptor).catch(()=>null);return item && item.expiresAt>Date.now()?item:null;}
export async function helpRequest(item:z.infer<typeof HelpDescriptor>,path:string,body?:unknown){
 return fetch(`http://127.0.0.1:${item.port}${path}`,{headers:{Authorization:`Bearer ${item.token}`,"Content-Type":"application/json"},...(body===undefined?{}:{method:"POST",body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
}
export async function requestHumanHelp(options:{page:Page;source:string;reason:string;verify:()=>Promise<string|null>;notify?:boolean;timeoutMs?:number}) {
 if(!await Bun.file(resolve(root,"data/remote-browser/config.json")).exists())return false;
 const id=crypto.randomUUID(),token=randomBytes(32).toString("base64url"),expiresAt=Date.now()+(options.timeoutMs??2*3600000);
 let finish:(value:boolean)=>void=()=>{},complete=false,busy=false;
 const result=new Promise<boolean>(resolve=>{finish=resolve;});
 const context=options.page.context();manualContexts.add(context);
 let page=options.page;
 const popup=(p:Page)=>{
   const select=()=>{if(!p.isClosed() && /^https?:\/\//.test(p.url()))page=p;};
   p.on("framenavigated",frame=>{if(frame===p.mainFrame())select();});select();
   p.once("close",()=>{if(page===p)page=options.page;});
 };context.on("page",popup);
 const desktop=await desktopEnabled();
 const oldViewport=options.page.viewportSize();if(!desktop)await options.page.setViewportSize({width:1024,height:768});
 await options.page.bringToFront();
 const server=Bun.serve({hostname:"127.0.0.1",port:0,maxRequestBodySize:16384,async fetch(request){
 if(request.headers.get("authorization")!==`Bearer ${token}` || request.headers.has("origin"))return new Response(null,{status:403});
 if(complete)return new Response(null,{status:410});
 const path=new URL(request.url).pathname;
 try{
 if(request.method==="GET" && path==="/diagnostics")return Response.json({url:page.url().split("?")[0],events:browserDiagnostics(context)});
 if(request.method==="GET" && path==="/state")return Response.json({id,source:options.source,reason:options.reason,url:page.url(),expiresAt,transport:desktop?"novnc":"screenshots"});
 if(request.method==="GET" && path==="/frame")return new Response(new Uint8Array(await page.screenshot({type:"jpeg",quality:75,timeout:5000})),{headers:{"Content-Type":"image/jpeg"}});
 if(request.method!=="POST")return new Response(null,{status:404});
 if(busy)return Response.json({error:"Please wait for the current action."},{status:409});
 busy=true;try{
 if(path==="/action"){await controlPage(page,RemoteAction.parse(await request.json()));return Response.json({ok:true});}
 if(path==="/finish"){
 const {skip}=z.object({skip:z.boolean()}).parse(await request.json());
 if(!skip){const error=await options.verify();if(error)return Response.json({error},{status:409});}
 complete=true;setTimeout(()=>finish(!skip),100);return Response.json({ok:true});
 }
 return new Response(null,{status:404});
 }finally{busy=false;}
 }catch{return Response.json({error:"The browser changed. Refresh and try again."},{status:400});}
 }});
 const timer=setTimeout(()=>{complete=true;finish(false);},Math.max(1,expiresAt-Date.now()));
 const closed=()=>finish(false);options.page.once("close",closed);
 try{
 await save(descriptorPath,{id,token,port:server.port,expiresAt});
 if(options.notify!==false){const queue=new AlertQueue();try{queue.enqueue(options.source,`${options.reason}. Browser paused until ${new Date(expiresAt).toISOString()}.`);}finally{queue.close();}}
 return await result;
 }finally{
 clearTimeout(timer);server.stop(true);manualContexts.delete(context);context.off("page",popup);options.page.off("close",closed);
 if(!desktop && oldViewport && !options.page.isClosed())await options.page.setViewportSize(oldViewport).catch(()=>{});
 if((await pendingHelp())?.id===id || Date.now()>=expiresAt)await unlink(resolve(root,descriptorPath)).catch(()=>{});
 }
}
