import { chromium } from "playwright";
import { z } from "zod";
import { read } from "./io.ts";
export async function desktopEnabled(){return (await read("runtime.json",z.object({browserTransport:z.enum(["playwright","novnc"]).default("playwright")}))).browserTransport==="novnc";}
export async function connectDesktop(){
 const version=z.object({webSocketDebuggerUrl:z.string()}).parse(await(await fetch("http://127.0.0.1:49222/json/version",{signal:AbortSignal.timeout(5000)})).json());
 const url=new URL(version.webSocketDebuggerUrl);url.hostname="127.0.0.1";url.port="49222";
 const browser=await chromium.connectOverCDP(url.href,{timeout:10000});
 const context=browser.contexts()[0];if(!context){await browser.close();throw Error("Desktop browser has no context");}
 return {context,close:()=>browser.close()};
}
