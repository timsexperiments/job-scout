import { z } from "zod";
export const Source = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/), name: z.string(), enabled: z.boolean().default(true),
  seeds: z.array(z.url()).min(1), hosts: z.array(z.string()).min(1),
  listingPattern: z.string(), searchSelector: z.string().optional(), query: z.string().optional(),
  nextSelector: z.string().optional(), maxPages: z.number().int().min(1).max(10).default(2),
  maxListings: z.number().int().min(1).max(50).default(8),
});
export type Source = z.infer<typeof Source>;
export const BrowserConfig = z.object({ sources: z.array(Source), delayMs: z.number().int().min(500).max(30000).default(1500), maxSteps: z.number().int().min(1).max(100).default(20) });
export function allowedURL(raw: string, source: Source): boolean {
  try { const url = new URL(raw); return url.protocol === "https:" && !url.username && !url.password && !url.port && source.hosts.includes(url.hostname); } catch { return false; }
}
export function listingURL(raw: string, source: Source): boolean {
  return allowedURL(raw, source) && new RegExp(source.listingPattern).test(new URL(raw).pathname);
}
export function barrier(text: string, title: string, status: number): string | null {
  if ([401, 403, 429].includes(status)) return `Access restricted (HTTP ${status})`;
  if (/just a moment|access denied|verify (?:that )?you are human|robot check|security verification/i.test(title)) return "Human verification required";
  if (/verify (?:that )?you are human|complete the captcha|unusual traffic|checking your browser/i.test(text.slice(0, 3000))) return "Human verification required";
  if (text.length < 2500 && /sign in to (?:view|continue)|log in to (?:view|continue)/i.test(text)) return "Login required";
  return null;
}
export const Decision = z.discriminatedUnion("action", [
  z.object({ action: z.literal("click"), index: z.number().int().nonnegative() }),
  z.object({ action: z.literal("scroll") }), z.object({ action: z.literal("next") }),
  z.object({ action: z.literal("stop") }),
]);
