import { allowedPage, answerFor } from './matching.mjs';
let draft, scannedTabId, scannedUrl, matches = [];
const status = text => { document.getElementById('status').textContent = text; };
document.getElementById('file').addEventListener('change', async event => {
  try {
    const file = event.target.files[0]; if (!file || file.size > 1024 * 1024) throw new Error('Select a draft smaller than 1 MB.');
    const value = JSON.parse(await file.text());
    if (!value || typeof value.proposal !== 'string' || !Array.isArray(value.answers) || !value.answers.every(item => typeof item.question === 'string' && typeof item.answer === 'string')) throw new Error('This file is not a Job Scout application draft.');
    draft = value; matches = []; document.getElementById('matches').replaceChildren(); document.getElementById('fill').disabled = true; document.getElementById('scan').disabled = false; status('Draft loaded locally.');
  } catch (error) { draft = null; document.getElementById('scan').disabled = true; status(error.message); }
});
document.getElementById('scan').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !allowedPage(tab.url)) throw new Error('Use an ordinary application page. Upwork automation is disabled.');
    scannedTabId = tab.id; scannedUrl = tab.url;
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
      return [...document.querySelectorAll('input, textarea')].filter(field => field instanceof HTMLTextAreaElement || ['text', 'email', 'tel', 'url'].includes(field.type)).filter(field => !field.disabled && !field.readOnly && field.getClientRects().length).map(field => {
        const id = crypto.randomUUID(); field.dataset.jobScoutField = id;
        const label = [...(field.labels ?? [])].map(item => item.textContent.trim()).join(' ') || field.getAttribute('aria-label') || field.placeholder || field.name || '';
        return { id, label, occupied: Boolean(field.value.trim()) };
      });
    } });
    if (!Array.isArray(result?.result)) throw new Error('Could not read form fields.');
    matches = result.result.map(field => ({ ...field, answer: answerFor(field.label, draft) })).filter(item => item.answer && !item.occupied);
    const container = document.getElementById('matches'); container.replaceChildren();
    for (const match of matches) {
      const row = document.createElement('div'); const label = document.createElement('label'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = true; match.checkbox = checkbox;
      label.append(checkbox, document.createTextNode(' ' + match.label)); const text = document.createElement('textarea'); text.value = match.answer; text.setAttribute('aria-label', 'Answer for ' + match.label); match.text = text; row.append(label, text); container.append(row);
    }
    status(`${matches.length} empty field matches on ${new URL(tab.url).hostname}. Review before filling.`); document.getElementById('fill').disabled = !matches.length;
  } catch (error) { status(error.message); }
});
document.getElementById('fill').addEventListener('click', async () => {
  try {
    const tab = await chrome.tabs.get(scannedTabId);
    if (!allowedPage(tab.url) || tab.url !== scannedUrl) throw new Error('The page changed. Find matching fields again.');
    const selected = matches.filter(item => item.checkbox.checked).map(item => ({ id: item.id, label: item.label, value: item.text.value }));
    const [result] = await chrome.scripting.executeScript({ target: { tabId: scannedTabId }, args: [selected], func: values => {
      let filled = 0;
      for (const item of values) {
        const field = document.querySelector(`[data-job-scout-field="${CSS.escape(item.id)}"]`);
        if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) || field.value.trim() || field.disabled || field.readOnly) continue;
        if (field instanceof HTMLInputElement && !['text', 'email', 'tel', 'url'].includes(field.type)) continue;
        const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        if (!setter) continue;
        setter.call(field, item.value); field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true })); filled++;
      }
      return filled;
    } });
    status(`Filled ${result?.result ?? 0} fields. Review the page; nothing was submitted.`); document.getElementById('fill').disabled = true;
  } catch (error) { status(error.message); }
});
