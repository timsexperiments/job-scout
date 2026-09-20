import type { Page } from "playwright";
import { z } from "zod";
export const RemoteAction=z.discriminatedUnion("kind",[
 z.object({kind:z.literal("pointer"),phase:z.enum(["down","move","up"]),x:z.number().min(0).max(1023),y:z.number().min(0).max(767)}),
 z.object({kind:z.literal("text"),text:z.string().max(2000)}),
 z.object({kind:z.literal("key"),key:z.enum(["Enter","Tab","Backspace","Escape","ControlOrMeta+A"])}),
 z.object({kind:z.literal("scroll"),dy:z.number().min(-1500).max(1500)}),
 z.object({kind:z.literal("back")}),z.object({kind:z.literal("reload")})
]);
export async function controlPage(page:Page,action:z.infer<typeof RemoteAction>) {
 switch(action.kind) {
 case "pointer": await page.mouse.move(action.x,action.y); if(action.phase==="down") await page.mouse.down();if(action.phase==="up") await page.mouse.up();return;
 case "text": await page.keyboard.insertText(action.text);return;
 case "key": await page.keyboard.press(action.key);return;
 case "scroll": await page.mouse.wheel(0,action.dy);return;
 case "back": await page.goBack({waitUntil:"domcontentloaded",timeout:10000}).catch(()=>{});return;
 case "reload": await page.reload({waitUntil:"domcontentloaded",timeout:10000}).catch(()=>{});return;
 default: {const exhaustive:never=action;return exhaustive;}
 }
}
