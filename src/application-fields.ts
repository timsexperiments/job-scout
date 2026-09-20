import type { Page } from "playwright";
import { z } from "zod";
import { ApplicationField } from "./domain.ts";

export async function collectApplicationFields(page: Page) {
  const fields: z.infer<typeof ApplicationField>[] = [];
  for (const frame of page.frames()) {
    if (!/^https?:/.test(frame.url())) continue;
    const raw = await frame.locator('input:not([type="hidden"]):not([type="submit"]):not([type="button"]),textarea,select,[role="combobox"],[role="textbox"]').evaluateAll(nodes => nodes.flatMap(node => {
      if (!(node instanceof HTMLElement) || !node.getClientRects().length) return [];
      const native = node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement;
      const labels = native ? Array.from(node.labels ?? []).map(label => label.textContent ?? '').join(' ') : '';
      const labelled = (node.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ');
      let label = (labels || node.getAttribute('aria-label') || labelled || node.closest('label')?.textContent || '').replace(/\s+/g,' ').trim().replace(/\s*\*$/, '');
      if (node instanceof HTMLInputElement && node.type === 'file' && /^(attach|upload)$/i.test(label)) label = (node.id || node.name || label).replace(/[_-]+/g,' ').replace(/^./, c => c.toUpperCase());
      if (!label || (node instanceof HTMLInputElement && ['password','search'].includes(node.type))) return [];
      const options = node instanceof HTMLSelectElement ? Array.from(node.options).map(option => option.textContent?.trim() ?? '').filter(Boolean) : [];
      return [{label,type:node.getAttribute('type') || node.getAttribute('role') || node.tagName.toLowerCase(),required:(native && node.required) || node.getAttribute('aria-required') === 'true',options,sourceUrl:document.location.href}];
    })).catch(() => []);
    fields.push(...z.array(ApplicationField).max(300).parse(raw));
  }
  return [...new Map(fields.map(field => [field.label.toLowerCase(), field])).values()];
}
