export const normalize = value => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export function allowedPage(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && url.hostname !== 'upwork.com' && !url.hostname.endsWith('.upwork.com'); } catch { return false; }
}
export function answerFor(label, draft) {
  const text = normalize(label);
  if (/password|social security|ssn|bank|credit card|disability|gender|ethnicity|veteran|race|consent|certif|signature|work authoriz|eligible to work/.test(text)) return null;
  const answer = draft.answers.find(item => normalize(item.question) === text);
  if (answer?.answer.trim()) return answer.answer;
  if (['cover letter', 'coverletter', 'proposal', 'application letter', 'additional information'].includes(text)) return draft.proposal || null;
  return null;
}
