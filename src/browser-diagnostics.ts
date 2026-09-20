import type { BrowserContext } from "playwright";
type Entry={at:string;kind:string;message:string};
const logs=new WeakMap<BrowserContext,Entry[]>();
function clean(text:string){return text.replace(/https?:\/\/[^\s"')]+/g,value=>{try{const u=new URL(value);return u.origin+(u.pathname.includes("/challenge-platform/")?"/cdn-cgi/challenge-platform/[redacted]":u.pathname);}catch{return '[URL]';}}).replace(/[A-Za-z0-9_-]{48,}/g,'[redacted]').slice(0,1000);}
export function watchBrowser(context:BrowserContext){
 const entries:Entry[]=[];logs.set(context,entries);
 const add=(kind:string,message:string)=>{entries.push({at:new Date().toISOString(),kind,message:clean(message)});if(entries.length>150)entries.shift();};
 context.on('console',message=>{if(['error','warning'].includes(message.type()))add('console',message.text());});
 context.on('weberror',error=>add('javascript',error.error().message));
 context.on('requestfailed',request=>add('request-failed',`${request.method()} ${request.url()} ${request.failure()?.errorText??''}`));
 context.on('response',response=>{if(response.status()>=400)add('http',`${response.status()} ${response.request().method()} ${response.url()}`);});
 context.on('page',page=>page.on('framenavigated',frame=>{if(frame===page.mainFrame())add('navigation',frame.url());}));
}
export const browserDiagnostics=(context:BrowserContext)=>logs.get(context)??[];
