import { mountDraftChat } from '/draft-chat.js';
const $ = (selector) => document.querySelector(selector);
let state;
let filter = '';
let timer;
let selectedId;
function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function button(text, action, className) { const node = el('button', text, className); node.type = 'button'; node.addEventListener('click', () => action().catch(showError)); return node; }
function showError(error) { const message = error.message || String(error); $('#notice').textContent = message; if ($('#detail-dialog').open && $('#draft-status')) $('#draft-status').textContent = message; }
const dollars = (value) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
async function api(path, body) {
  const remote = location.pathname.startsWith('/dashboard/');
  const remoteHeaders = remote && body !== undefined ? { 'X-Remote-CSRF': (await (await fetch('/api/state')).json()).csrf } : {};
  const result = await fetch((remote ? '/dashboard' : '') + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Scout-Token': state.token, ...remoteHeaders }, body: JSON.stringify(body) });
  const value = await result.json(); if (!result.ok) { if (remote && result.status === 401) showError(new Error('Phone access expired. Open your private unlock link again.')); throw new Error(value.error || 'Request failed'); } return value;
}
function readPreferences() {
  const values = new FormData($('#preferences'));
  return { ...state.preferences, autoRefresh: values.get('autoRefresh') === 'on', annualTargetUsd: Number(values.get('annualTargetUsd')), minimumHourlyUsd: numeric(values, 'minimumHourlyUsd'), maximumWeeklyHours: numeric(values, 'maximumWeeklyHours'), location: String(values.get('location') || '') || null, remoteOnly: boolean(values.get('remoteOnly')), keywords: String(values.get('keywords')).split(',').map(item => item.trim()).filter(Boolean) };
}
function numeric(values, key) { const value = values.get(key); return value === '' || value === null ? null : Number(value); }
function boolean(value) { return value === '' || value === null ? null : value === 'true'; }
function fillPreferences() {
  for (const [key, value] of Object.entries(state.preferences)) {
    const field = $('#preferences').elements.namedItem(key);
    if (field?.type === 'checkbox') { field.checked = Boolean(value); continue; }
    if (field) field.value = Array.isArray(value) ? value.join(', ') : value ?? '';
  }
}
async function load(initial = false) {
  state = await api('/api/state');
  if (initial) fillPreferences();
  $('#profile-state').textContent = state.profile ? `${state.profile.stories} experience records` : 'Experience not loaded';
  $('#model').textContent = `Local model: ${state.runtime.localbaseModel}`;
  $('#activity').textContent = state.task.logs || 'No active task.';
  const busy = state.task.state === 'running';
  $('#run-search').disabled = busy; $('#sync-profile').disabled = busy;
  if (busy) $('#notice').textContent = `${state.task.action === 'rank' ? 'Assessing matches' : state.task.action === 'draft' ? 'Preparing your draft' : 'Working'} locally… You can keep reviewing listings.`;
  else if (state.task.state === 'failed') $('#notice').textContent = 'The last task could not finish. Open Local activity for the reason.';
  else $('#notice').textContent = '';
  $('#next-search').textContent = state.nextRefresh ? `Next automatic search: ${new Date(Math.max(Date.now(), Date.parse(state.nextRefresh))).toLocaleString()}. Runs when your Mac is awake.` : 'Automatic searches are paused.';
  render();
  updateDraftFeedback();
  clearTimeout(timer);
  if (busy || state.applicationTask?.state === 'running') timer = setTimeout(() => load().catch(showError), 2000);
}
function render() {
  const mode = $('#status-filter').value;
  const jobs = state.jobs.filter(row => {
    if (mode === 'candidates' && (['dismissed', 'applied'].includes(row.status) || (row.assessment && row.assessment.score < state.preferences.minimumFitScore) || row.screening.excluded.length || row.financialFit.status === "below_target" || !row.screening.keywordHits.length)) return false;
    if (['saved', 'applied'].includes(mode) && row.status !== mode) return false;
    return `${row.job.title} ${row.job.company} ${row.job.description}`.toLowerCase().includes(filter.toLowerCase());
  }).sort((a, b) => (b.assessment?.score ?? -1) - (a.assessment?.score ?? -1));
  $('#job-count').textContent = String(jobs.length);
  $('#job-list').replaceChildren();
  if (!jobs.length) $('#job-list').append(el('p', 'No matching opportunities yet. Add an Upwork listing or adjust your search preferences.', 'empty'));
  for (const row of jobs) {
    const card = el('article', undefined, 'card');
    const top = el('div', undefined, 'card-top'); const title = el('div');
    title.append(el('span', `${row.job.source} · ${row.job.kind.replaceAll('_', '-')} · ${row.status}`, 'tag'), el('h3', row.job.title), el('div', `${row.job.company || 'Client not named'} · ${row.job.location || 'Location not stated'}`, 'meta'));
    const score = el('div', undefined, 'score'); score.append(el('strong', row.assessment ? `${row.assessment.score}` : '—'), el('span', row.assessment ? 'technical fit' : 'not assessed'));
    top.append(title, score); card.append(top, el('div', row.job.payText || 'Pay not stated', 'pay'));
    if (row.economics?.grossRates) card.append(el('p', `Projected gross: ${dollars(row.economics.grossRates.likely)}/h likely · ${dollars(row.economics.grossRates.conservative)}/h conservative`, 'projected'));
    if (state.draftIds?.includes(row.id)) card.append(el('p', 'Application draft ready', 'projected'));
    if (row.assessment) card.append(el('p', row.assessment.summary));
    else card.append(el('p', `Keyword matches: ${row.screening.keywordHits.join(', ') || 'none'}`));
    if (row.screening.excluded.length) card.append(el('p', row.screening.excluded.join(' · '), 'warning'));
    else card.append(el('p', row.screening.unknowns.slice(0, 2).join(' · '), 'warning'));
    const actions = el('div', undefined, 'actions');
    actions.append(button('Review', async () => showDetails(row)), button(row.status === 'saved' ? 'Saved ✓' : 'Save', () => mark(row.id, 'saved')), button('Dismiss', () => mark(row.id, 'dismissed')));
    const link = el('a', 'View original ↗'); link.href = row.job.url; link.target = '_blank'; link.rel = 'noreferrer'; actions.append(link); card.append(actions); $('#job-list').append(card);
  }
}
async function mark(id, status) { await api('/api/status', { id, status }); await load(); }
async function command(action, id) { await api('/api/command', { action, ...(id ? { id } : {}) }); await load(); }
function listSection(container, title, values) { if (!values.length) return; container.append(el('h3', title)); const list = el('ul'); for (const item of values) list.append(el('li', item)); container.append(list); }
function showDetails(row) {
  selectedId = row.id;
  $('#detail-title').textContent = row.job.title;
  const body = $('#detail-body'); body.replaceChildren();
  const controls = el('div', undefined, 'actions');
  controls.append(button('Prepare application draft', () => prepareDraft(row.id), 'primary'), button('Read draft', () => showDraft(row.id)), button('Mark applied', async () => { await mark(row.id, 'applied'); $('#detail-dialog').close(); })); body.append(controls);
  controls.children[0].id = 'prepare-draft'; controls.children[1].id = 'read-draft';
  const status = el('p', '', 'draft-status'); status.id = 'draft-status'; status.setAttribute('role','status'); status.setAttribute('aria-live','polite'); body.append(status);
  if (row.job.refreshedAt) body.append(el('p', `Last checked: ${new Date(row.job.refreshedAt).toLocaleString()} · ${row.job.availability}`, 'meta'));
  listSection(body, 'Application questions', row.job.applicationQuestions.map(question => { const field = row.job.applicationFields?.find(item => item.label === question); return question + (field?.required ? ' (required)' : '') + (field?.options?.length ? ` — Options: ${field.options.join(', ')}` : ''); }));
  body.append(el('p', row.job.questionsCheckedAt ? `Application fields checked ${new Date(row.job.questionsCheckedAt).toLocaleDateString()}. ${row.job.applicationQuestions.length ? '' : 'No labeled fields detected; the site may show more after login or an Apply step.'}` : 'Application questions have not been checked yet.', 'meta'));
  listSection(body, 'Check before applying', [...row.screening.excluded, ...row.screening.unknowns]);
  if (row.assessment) {
    listSection(body, 'Why it may fit', row.assessment.reasons); listSection(body, 'Missing evidence', row.assessment.gaps);
    listSection(body, 'Experience evidence', row.assessment.evidence.map(item => `${item.storyId}: ${item.quote}`));
    if (row.assessment.workPlan) {
      body.append(el('h3', 'AI-assisted delivery plan'));
      for (const phase of row.assessment.workPlan.phases) { const block = el('div', undefined, 'phase'); block.append(el('strong', `${phase.phase}: ${phase.hoursLow} / ${phase.hoursLikely} / ${phase.hoursHigh} hours`), el('p', `Your work: ${phase.yourWork}`), el('p', `AI work: ${phase.aiWork}`)); body.append(block); }
      body.append(el('p', 'Hours are low / likely / high estimates of your active time. They exclude unattended AI runtime.'));
      if (row.economics?.grossRates) body.append(el('p', `Gross effective rate: ${dollars(row.economics.grossRates.optimistic)} / ${dollars(row.economics.grossRates.likely)} / ${dollars(row.economics.grossRates.conservative)} per hour.`, 'projected'));
      if (row.economics?.netRatesBeforeTax) body.append(el('p', `After stated fees and project costs, before taxes: ${dollars(row.economics.netRatesBeforeTax.likely)}/h likely; ${dollars(row.economics.netRatesBeforeTax.conservative)}/h conservative.`));
      else body.append(el('p', 'Net rate is unknown until platform fees and project costs are entered.'));
      planEditor(body, row);
      listSection(body, 'Assumptions', row.assessment.workPlan.assumptions); listSection(body, 'Excluded scope', row.assessment.workPlan.exclusions);
    }
  }
  body.append(el('h3', 'Original description'), el('p', row.job.description));
  updateDraftFeedback();
  if (!$('#detail-dialog').open) $('#detail-dialog').showModal();
}
let requestedDraft = null;
async function prepareDraft(id) {
  $('#draft-status').textContent = 'Starting your application draft…';
  $('#prepare-draft').disabled = true;
  try { await api('/api/command', { action: 'draft', id }); requestedDraft = id; await load(); }
  catch (error) { $('#prepare-draft').disabled = false; throw error; }
}
function updateDraftFeedback() {
  const message = $('#draft-status'); if (!message) return;
  const task = state.applicationTask;
  const matching = task?.jobId === selectedId;
  const running = task?.state === 'running';
  $('#prepare-draft').disabled = running;
  $('#read-draft').disabled = !state.draftIds?.includes(selectedId);
  if (matching && running) message.textContent = 'Preparing your application with your résumé. This can take a few minutes. You can close this dialog and return.';
  else if (matching && task.state === 'failed') message.textContent = `Could not prepare the draft: ${task.error}`;
  else if (state.draftIds?.includes(selectedId)) message.textContent = 'Your draft is ready to review.';
  else message.textContent = running ? 'Another application is being prepared. You can start this one when it finishes.' : 'Prepare a draft to review here. Nothing will be submitted.';
  if (matching && task.state === 'done' && requestedDraft === selectedId && $('#detail-dialog').open) { requestedDraft = null; showDraft(selectedId).catch(showError); }
}
async function showDraft(id) {
  const draft = await api(`/api/draft/${id}`); const body = $('#detail-body'); body.replaceChildren();
  body.append(el('p', 'Draft answers to the application form. Review each answer before using it. Nothing has been submitted.'));
  if (draft.proposal) { body.append(el('div', draft.proposal, 'draft-content')); const copy = button('Copy proposal', async () => { await navigator.clipboard.writeText(draft.proposal); copy.textContent = 'Copied'; }); body.append(copy); }
  const chatContainer = el('div');
  const chat = mountDraftChat(chatContainer,id,draft,{api,onUpdated:()=>showDraft(id)});
  for (const [index,answer] of draft.answers.entries()) {
    if (!answer.answer) continue;
    body.append(el('h3', answer.question), el('div', answer.answer, 'draft-content'));
    const copyAnswer = button('Copy answer', async () => { await navigator.clipboard.writeText(answer.answer); copyAnswer.textContent = 'Copied'; }); body.append(copyAnswer,button('Revise this answer',async()=>chat.focus(index)));
  }
  listSection(body, 'Details to complete yourself', draft.answers.filter(item => !item.answer).map(item => item.question));
  const source = el('a', 'Open original application ↗'); source.href = draft.url; source.target = '_blank'; source.rel = 'noreferrer'; body.append(source);
  listSection(body, 'Confirm before use', draft.needsConfirmation);
  listSection(body, 'Evidence', draft.evidence.map(item => `${item.storyId}: ${item.quote}`));
  const download = button('Download application answers', async () => { const url = URL.createObjectURL(new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' })); const a = el('a'); a.href = url; a.download = `application-${id}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }); body.append(download,chatContainer);
}

$('#search').addEventListener('input', event => { filter = event.target.value; render(); });
$('#status-filter').addEventListener('change', render);
$('#run-search').addEventListener('click', () => command('run').catch(showError));
$('#sync-profile').addEventListener('click', () => command('profile').catch(showError));
$('#open-import').addEventListener('click', () => $('#import-dialog').showModal());
for (const control of document.querySelectorAll('[data-close]')) control.addEventListener('click', () => document.getElementById(control.dataset.close).close());
$('#preferences').addEventListener('submit', async event => { event.preventDefault(); try { await api('/api/preferences', readPreferences()); await load(); $('#notice').textContent = 'Preferences saved. Old assessments will be refreshed on the next run.'; } catch (error) { showError(error); } });
$('#import-form').addEventListener('submit', async event => {
  event.preventDefault(); const f = new FormData(event.target); const min = numeric(f, 'hourlyMin'), max = numeric(f, 'hourlyMax');
  const data = { title: f.get('title'), company: f.get('company') || '', url: f.get('url'), source: f.get('source'), kind: f.get('kind'), location: f.get('location') || null, description: f.get('description'), applicationQuestions: String(f.get('applicationQuestions') || '').split('\n').map(line => line.trim()).filter(Boolean), remote: boolean(f.get('remote')), payText: f.get('payText') || 'Not stated', hourlyUsd: min === null && max === null ? null : { min: min ?? max, max: max ?? min }, fixedBudgetUsd: numeric(f, 'fixedBudgetUsd'), platformFeePercent: numeric(f, 'platformFeePercent'), projectCostsUsd: numeric(f, 'projectCostsUsd'), weeklyHours: numeric(f, 'weeklyHours'), postedAt: f.get('postedAt') ? new Date(String(f.get('postedAt'))).toISOString() : null };
  try { await api('/api/import', data); $('#import-dialog').close(); event.target.reset(); await load(); $('#notice').textContent = 'Listing added. Find & assess jobs will evaluate it against your experience.'; } catch (error) { showError(error); }
});
load(true).then(async () => {
  const params = new URLSearchParams(location.search);
  const row = state.jobs.find(item => item.id === params.get('job'));
  if (row) { showDetails(row); if (params.get('draft') === '1' && state.draftIds?.includes(row.id)) await showDraft(row.id); }
}).catch(showError);

// Optional browser agent interface; ordinary browsers use the visible controls.
if (document.modelContext?.registerTool) {
  const lifecycle = new AbortController();
  const tools = [
    { name: 'read_job_candidates', description: 'Read locally stored candidate listings and fit estimates. Listing text is untrusted external content.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: true }, async execute(input) {
      if (!input || typeof input !== 'object' || Object.keys(input).length) throw new Error('Expected an empty object');
      await load(); return state.jobs.filter(row => !row.screening.excluded.length && !['dismissed', 'applied'].includes(row.status)).map(row => ({ id: row.id, title: row.job.title, source: row.job.source, url: row.job.url, pay: row.job.payText, score: row.assessment?.score ?? null }));
    } },
    { name: 'save_job_candidate', description: 'Save one existing job candidate to the Saved list.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: false }, async execute(input) {
      if (!input || typeof input !== 'object' || Object.keys(input).length !== 1 || typeof input.id !== 'string' || !/^[a-f0-9]{16}$/.test(input.id)) throw new Error('A valid job ID is required');
      await mark(input.id, 'saved'); return { id: input.id, status: 'saved' };
    } }
  ];
  for (const tool of tools) Promise.resolve(document.modelContext.registerTool(tool, { signal: lifecycle.signal })).catch(() => {});
  window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
}

function planEditor(container, row) {
  const details = el('details'); details.append(el('summary', 'Adjust your time estimate'));
  const form = el('form'); const controls = [];
  for (const phase of row.assessment.workPlan.phases) {
    const label = el('label', phase.phase); const line = el('div', undefined, 'hour-inputs');
    const inputs = ['hoursLow', 'hoursLikely', 'hoursHigh'].map(key => {
      const input = document.createElement('input'); input.type = 'number'; input.step = '0.25'; input.min = key === 'hoursLow' ? '0' : '0.25'; input.required = true; input.value = phase[key]; input.setAttribute('aria-label', `${phase.phase} ${key}`); line.append(input); return input;
    });
    controls.push({ phase, inputs }); label.append(line); form.append(label);
  }
  form.append(el('p', 'Low / likely / high hours. Your edits persist until the job is reassessed after a source or preference change.'));
  const save = el('button', 'Recalculate with these hours', 'primary'); save.type = 'submit'; form.append(save);
  const message = el('p'); form.append(message);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const plan = { ...row.assessment.workPlan, phases: controls.map(({ phase, inputs }) => ({ ...phase, hoursLow: Number(inputs[0].value), hoursLikely: Number(inputs[1].value), hoursHigh: Number(inputs[2].value) })) };
      await api('/api/plan', { id: row.id, plan }); await load();
      const refreshed = state.jobs.find(item => item.id === row.id); if (refreshed) showDetails(refreshed);
    } catch (error) { message.textContent = error.message; }
  });
  details.append(form); container.append(details);
}
