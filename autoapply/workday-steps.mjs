/**
 * Workday application pages, one step at a time.
 *
 * Every Workday question sits in a `formField-<id>` container. We scan the visible ones, work out
 * what kind of control each holds (text, radio group, dropdown, type-ahead, checkbox, date),
 * answer it from the profile (resolveAnswer) or the local model (llmChoose / llmAnswer), fill it,
 * and press "Save and Continue". Fields that already hold a value are left alone.
 */
import { resolveAnswer, chooseOption } from './answers.mjs';
import { llmAnswer, llmChoose } from './llm-answers.mjs';

const A = id => `[data-automation-id="${id}"]`;
const localToday = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10); };
const pause = (page, ms) => page.waitForTimeout(ms);

/** Visible form fields on the current step, each tagged data-wf-id so they can be found again. */
export async function scanFields(page) {
  return page.evaluate(() => {
    const clean = t => String(t || '').replace(/\s+/g, ' ').trim();
    const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const out = [];
    for (const box of document.querySelectorAll('[data-automation-id^="formField-"]')) {
      if (box.parentElement?.closest('[data-automation-id^="formField-"]') || !vis(box)) continue;
      const id = box.getAttribute('data-automation-id').replace('formField-', '');
      const labelEl = box.querySelector('label, legend, [data-automation-id="fieldLabel"]');
      let label = clean(labelEl?.innerText || box.innerText.split('\n')[0]);
      const required = /\*/.test(label) || !!box.querySelector('[aria-required="true"], [required]');
      label = label.replace(/\*/g, '').trim();
      let kind = null; let options = []; let value = '';
      if (box.querySelector('input[type=file]')) kind = 'file';
      else if (box.querySelector('[data-automation-id="multiSelectContainer"]')) {
        kind = 'typeahead';
        value = clean([...box.querySelectorAll('[data-automation-id="selectedItem"]')].map(e => e.innerText).join(', '));
      } else if (box.querySelector('input[type=radio]')) {
        kind = 'radio';
        options = [...box.querySelectorAll('input[type=radio]')].map(r => {
          const l = box.querySelector(`label[for="${CSS.escape(r.id)}"]`) || r.closest('label');
          return { label: clean(l?.innerText || r.value), value: r.id };
        });
        value = options.find((_, i) => box.querySelectorAll('input[type=radio]')[i].checked)?.label || '';
      } else if (box.querySelector('button[aria-haspopup="listbox"]')) {
        kind = 'dropdown';
        value = clean(box.querySelector('button[aria-haspopup="listbox"]').innerText).replace(/^select one$/i, '');
      } else if (box.querySelectorAll('input[type=checkbox]').length > 1) {
        kind = 'checkgroup';   // "check one of the boxes below" (disability form)
        const cbs = [...box.querySelectorAll('input[type=checkbox]')];
        options = cbs.map(r => { const l = box.querySelector(`label[for="${CSS.escape(r.id)}"]`) || r.closest('label'); return { label: clean(l?.innerText || r.value), value: r.id }; });
        value = options.find((_, i) => cbs[i].checked)?.label || '';
      } else if (box.querySelector('input[type=checkbox]')) {
        kind = 'checkbox';
        value = box.querySelector('input[type=checkbox]').checked ? 'checked' : '';
      } else if (box.querySelector('textarea')) { kind = 'textarea'; value = box.querySelector('textarea').value; }
      else if (box.querySelector('[data-automation-id^="dateSection"]')) { kind = 'date'; value = [...box.querySelectorAll('input')].map(i => i.value).join(''); }
      else if (box.querySelector('input')) { kind = 'text'; value = box.querySelector('input').value; }
      if (!kind || !label) continue;
      box.setAttribute('data-wf-id', `wf-${out.length}`);
      out.push({ wf: `wf-${out.length}`, id, label, kind, required, options, value });
    }
    return out;
  });
}

const OPEN_OPTS = '[role="listbox"]:not([data-automation-id="selectedItemList"]) [role="option"], [data-automation-id="promptOption"]:not([data-automation-id="selectedItem"] *)';
const optionsOf = async page => page.evaluate(sel => [...document.querySelectorAll(sel)]
  .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
  .map((e, i) => ({ label: String(e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim(), value: String(i) })).filter(o => o.label), OPEN_OPTS);

const clickOption = async (page, label) => {
  const all = page.locator(OPEN_OPTS);
  const n = await all.count();
  for (let i = 0; i < n; i++) {
    const t = ((await all.nth(i).innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    if (t && t.toLowerCase() === String(label).toLowerCase() && await all.nth(i).isVisible().catch(() => false)) { await all.nth(i).click(); return true; }
  }
  return false;
};

/** Open a dropdown / type-ahead and read its choices (needed before the model can pick one). */
async function readChoices(page, box, f) {
  if (f.kind === 'dropdown') await box.locator('button[aria-haspopup="listbox"]').first().click();
  else { await box.locator(`${A('multiselectInputContainer')} input, ${A('multiSelectContainer')} input`).first().click(); }
  await pause(page, 900);
  const opts = await optionsOf(page);
  return opts;
}

async function fillField(page, f, ans) {
  const box = page.locator(`[data-wf-id="${f.wf}"]`);
  const val = typeof ans === 'string' ? ans : ans?.label;
  if (val === undefined || val === null || val === '') return false;
  switch (f.kind) {
    case 'text': case 'textarea':
      await box.locator('input, textarea').first().fill(String(val)); await box.locator('input, textarea').first().blur().catch(() => {}); return true;
    case 'date': {
      const d = /^\d{4}-\d{2}-\d{2}$/.test(val) ? val : localToday();
      // Workday's date is segmented (MM / DD / YYYY) and moves to the next segment by itself:
      // focus the first segment and type every digit in one go.
      const segs = { Month: d.slice(5, 7), Day: d.slice(8, 10), Year: d.slice(0, 4) };
      const first = box.locator('[data-automation-id="dateSectionMonth-input"], [data-automation-id="dateSectionDay-input"], [data-automation-id="dateSectionYear-input"]').first();
      if (!(await first.count())) return false;
      let digits = '';
      for (const k of ['Month', 'Day', 'Year']) if (await box.locator(`[data-automation-id="dateSection${k}-input"]`).count()) digits += segs[k];
      await first.evaluate(e => { e.scrollIntoView({ block: 'center' }); e.focus(); });
      await page.keyboard.type(digits, { delay: 60 });
      return true;
    }
    case 'checkgroup':
    case 'radio': {
      const opt = f.options.find(o => o.label.toLowerCase() === String(val).toLowerCase()) || chooseOption(f.options, val);
      if (!opt) return false;
      const input = box.locator(`input[id="${String(opt.value).replace(/"/g, '\\"')}"]`).first();
      await box.locator(`label[for="${String(opt.value).replace(/"/g, '\\"')}"]`).first().click({ timeout: 4000 }).catch(() => {});
      if (!(await input.isChecked().catch(() => false))) await input.check({ force: true }).catch(() => {});
      return input.isChecked().catch(() => false);
    }
    case 'checkbox': {
      const c = box.locator('input[type=checkbox]').first();
      if (/^(yes|true|checked)$/i.test(String(val))) await c.check({ force: true }).catch(() => {}); return true;
    }
    case 'dropdown': {
      const btn = box.locator('button[aria-haspopup="listbox"]').first();
      await btn.click(); await pause(page, 700);
      if (!(await optionsOf(page)).length) { await btn.click(); await pause(page, 700); }   // it was still open, so the click closed it
      if (!(await clickOption(page, val))) {
        const opt = chooseOption(await optionsOf(page), val);
        if (!opt || !(await clickOption(page, opt.label))) { await page.keyboard.press('Escape'); return false; }
      }
      await pause(page, 300); return true;
    }
    case 'typeahead': {
      const input = box.locator(`${A('multiselectInputContainer')} input, ${A('multiSelectContainer')} input`).first();
      await input.click(); await input.fill(String(val).split(',')[0].trim()); await pause(page, 1200); await page.keyboard.press('Enter'); await pause(page, 900);
      if ((await box.locator(A('selectedItem')).count())) return true;
      const opts = await optionsOf(page);
      const opt = chooseOption(opts, val) || opts[0];
      if (opt && await clickOption(page, opt.label)) { await pause(page, 500); return true; }
      await page.keyboard.press('Escape'); return false;
    }
    default: return false;
  }
}

/** Decide the answer for one field: profile rules first, then the model. */
async function answerFor(page, f, book, ctx, opts) {
  const box = page.locator(`[data-wf-id="${f.wf}"]`);
  if (f.kind === 'date') return { pick: /today|date|signed/i.test(f.label) ? localToday() : null, source: 'today', key: 'date' };
  // "Please check one of the boxes below" on the disability form: let the label say what it is about
  const label = (f.options || []).some(o => /disabilit/i.test(o.label)) && !/disabilit/i.test(f.label) ? `${f.label} (disability)` : f.label;
  const field = { label, type: ['radio', 'checkgroup'].includes(f.kind) ? 'radio' : f.kind === 'checkbox' ? 'checkbox' : f.kind === 'textarea' ? 'textarea' : 'text',
    tag: ['dropdown', 'typeahead'].includes(f.kind) ? 'select' : 'input', options: f.options, required: f.required };
  let choices = f.options;
  if (['dropdown', 'typeahead'].includes(f.kind)) { choices = await readChoices(page, box, f); field.options = choices; }
  const ans = resolveAnswer(field, book, { acceptConsent: !!opts.acceptConsent });
  let pick = ans.value?.option?.label || (typeof ans.value === 'string' ? ans.value : typeof ans.value === 'boolean' ? (ans.value ? 'Yes' : 'No') : null);
  let source = pick ? ans.source : null;
  if (['dropdown', 'typeahead'].includes(f.kind)) await page.keyboard.press('Escape').catch(() => {});
  // Workday wants a bare number and just the city name; names and extras the profile doesn't hold stay empty.
  const L = f.label.toLowerCase();
  if (/phone number/.test(L)) pick = String(book.phone || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '') || null;
  else if (/^city\b/.test(L)) pick = book.city || null;
  else if (/middle|suffix|preferred|address line [2-9]|extension|county/.test(L)) pick = null;
  else if (!pick && f.required && choices?.length && ctx) { pick = await llmChoose(f.label, choices, ctx).catch(() => null); source = 'llm'; }
  else if (!pick && f.required && !choices?.length && ctx && ['text', 'textarea'].includes(f.kind)) { pick = await llmAnswer(f.label, ctx).catch(() => null); source = 'llm'; }
  return { pick, source: pick ? source || 'profile' : null, key: ans.key };
}

const stepName = async page => ((await page.locator(A('progressBarActiveStep')).first().innerText().catch(() => '')) || '').replace(/current step \d+ of \d+/i, '').replace(/\s+/g, ' ').trim();

/** Real click on Workday's footer button, falling back to Enter on its overlay. */
export async function pressNext(page) {
  const btn = page.locator(`${A('pageFooterNextButton')}, ${A('bottom-navigation-next-button')}`).first();
  if (!(await btn.count())) return false;
  const label = ((await btn.innerText().catch(() => '')) || 'Save and Continue').trim();
  const overlay = page.locator(`${A('click_filter')}[aria-label="${label}"]`).first();
  const target = (await overlay.count()) ? overlay : btn;
  await target.scrollIntoViewIfNeeded().catch(() => {});
  await target.click({ timeout: 5000 }).catch(() => btn.click({ force: true }).catch(() => {}));
  return true;
}

/** Fill every field on the current step. Returns { filled, missing, step }. */
export async function fillStep(page, book, ctx, opts = {}) {
  const filled = []; const missing = [];
  const step = await stepName(page);
  const seen = new Set();
  // Two passes: an answer can reveal follow-up questions (e.g. "Yes" opens "Which location?").
  for (let pass = 0; pass < 2; pass++) {
  const fields = (await scanFields(page)).filter(f => !seen.has(f.label + f.id));
  for (const f of fields) {
    seen.add(f.label + f.id);
    if (f.kind === 'file') continue;                       // the resume is attached by the caller
    if (f.value && f.kind === 'date') { if (!/today|date|signed/i.test(f.label)) continue; }
    else if (f.value && ['radio', 'checkgroup'].includes(f.kind)) {
      const p = resolveAnswer({ label: f.label, type: 'radio', tag: 'input', options: f.options }, book, { acceptConsent: !!opts.acceptConsent });
      const want = p.value?.option?.label;
      if (!want || want === f.value) continue;           // nothing definite to correct
    } else if (f.value && f.kind === 'dropdown' && !/degree|school|fieldOfStudy/i.test(f.id)) {
      const ch = await readChoices(page, page.locator(`[data-wf-id="${f.wf}"]`), f); await page.keyboard.press('Escape').catch(() => {});
      const want = resolveAnswer({ label: f.label, type: 'text', tag: 'select', options: ch }, book, { acceptConsent: !!opts.acceptConsent }).value?.option?.label;
      if (!want || want === f.value) continue;
    } else if (f.value && f.kind !== 'checkbox') continue;   // already has an answer (country, phone type…)
    if (/extension/i.test(f.label)) continue;
    let r;
    try { r = await answerFor(page, f, book, ctx, opts); } catch { r = { pick: null }; }
    let ok = false;
    if (r.pick) ok = await fillField(page, f, r.pick).catch(() => false);
    if (ok) filled.push({ label: f.label, key: r.key || 'llm', value: String(r.pick).slice(0, 100), source: r.source || 'llm' });
    else if (f.required) missing.push({ label: f.label, key: r.key, type: f.kind === 'textarea' ? 'textarea' : f.options?.length ? 'select' : 'text', options: f.options.map(o => o.label).slice(0, 20) });
  }
  if (!fields.length) break;
  await pause(page, 800);
  }
  return { filled, missing, step };
}

export { stepName };

// ── My Experience: resume, work history, education, skills, websites ─────────────────────────

const ym = v => { const m = String(v || '').match(/^(\d{4})(?:-(\d{2}))?/); return m ? { y: m[1], m: m[2] || '01' } : null; };

async function fillDate(page, box, value) {
  const d = ym(value); if (!d) return false;
  const month = box.locator(A('dateSectionMonth-input')).first(); const year = box.locator(A('dateSectionYear-input')).first();
  // Segments advance by themselves: focus the first one present and type all digits (year-only dates exist).
  const first = (await month.count()) ? month : year;
  if (!(await first.count())) return false;
  await first.evaluate(e => { e.scrollIntoView({ block: 'center' }); e.focus(); });
  await page.keyboard.type(((await month.count()) ? d.m : '') + d.y, { delay: 60 });
  return true;
}

const panelField = (page, id) => page.locator(`[data-automation-id="formField-${id}"]`).last();

async function setText(page, id, value) {
  if (!value) return false;
  const box = panelField(page, id); if (!(await box.count())) return false;
  const input = box.locator('input:not([type=checkbox]), textarea').first();
  await input.fill(String(value)); await input.blur().catch(() => {}); return true;
}

/** Click the section's Add / Add Another button. `which` indexes Workday's add-buttons in page order. */
async function clickAdd(page, which) {
  // The section's button keeps its position and turns into "Add Another" after the first entry.
  const before = await page.locator('[data-automation-id^="formField-"]').count();
  const btn = page.locator(A('add-button')).nth(which.index);
  await btn.scrollIntoViewIfNeeded().catch(() => {}); await btn.click(); await pause(page, 1800);
  return (await page.locator('[data-automation-id^="formField-"]').count()) > before;
}

async function typeAheadPick(page, id, value) {
  const box = panelField(page, id); if (!(await box.count()) || !value) return false;
  const kind = (await box.locator('button[aria-haspopup="listbox"]').count()) ? 'dropdown' : 'typeahead';
  await box.evaluate(e => e.setAttribute('data-wf-id', 'x'));
  return fillField(page, { wf: 'x', kind }, value).catch(() => false);
}

export async function fillExperience(page, sections, files) {
  const filled = []; const missing = [];
  // 1. Resume: Workday reads it and often fills the history itself.
  const up = page.locator('input[type=file]').first();
  if (files?.resume && await up.count()) {
    await up.setInputFiles(files.resume); await pause(page, 7000);
    filled.push({ label: 'Resume/CV', key: 'resumeFile', value: 'resume.pdf', source: 'profile' });
  }
  const hasWork = () => page.getByText(/^Work Experience \d+$/).count();
  const hasEdu = () => page.getByText(/^Education \d+$/).count();

  // 2. Work history
  if (!(await hasWork())) {
    const jobs = (sections.experience || []).slice(0, 4);
    for (let i = 0; i < jobs.length; i++) {
      const j = jobs[i];
      if (!(await clickAdd(page, { index: 0 }))) break;
      await setText(page, 'jobTitle', j.title); await setText(page, 'companyName', j.company); await setText(page, 'location', j.location);
      const cur = panelField(page, 'currentlyWorkHere').locator('input[type=checkbox]').first();
      if (j.current && await cur.count()) await cur.check({ force: true }).catch(() => {});
      await fillDate(page, panelField(page, 'startDate'), j.startDate);
      if (!j.current) await fillDate(page, panelField(page, 'endDate'), j.endDate || j.startDate);
      await setText(page, 'roleDescription', (j.bullets || []).join('\n').slice(0, 1800));
      filled.push({ label: `Work Experience: ${j.title} at ${j.company}`, key: 'experience', value: j.company, source: 'profile' });
    }
  }
  // 3. Education
  if (!(await hasEdu())) {
    const eds = (sections.education || []).slice(0, 2);
    for (let i = 0; i < eds.length; i++) {
      const e = eds[i];
      if (!(await clickAdd(page, { index: 1 }))) break;
      for (const [id, v] of [['schoolName', e.school], ['school', e.school]]) if (await panelField(page, id).count()) await setText(page, id, v);
      if (await panelField(page, 'degree').count()) await typeAheadPick(page, 'degree', e.degree);
      if (await panelField(page, 'fieldOfStudy').count()) await typeAheadPick(page, 'fieldOfStudy', e.field);
      if (await panelField(page, 'gradeAverage').count()) await setText(page, 'gradeAverage', e.gpa);
      for (const id of ['firstYearAttended', 'startDate']) if (await panelField(page, id).count()) await fillDate(page, panelField(page, id), e.startDate);
      for (const id of ['lastYearAttended', 'endDate']) if (await panelField(page, id).count()) await fillDate(page, panelField(page, id), e.endDate);
      filled.push({ label: `Education: ${e.degree}, ${e.school}`, key: 'education', value: e.school, source: 'profile' });
    }
  }
  // 3b. Degrees already on the page (resume parse or an earlier draft): match them to the profile, in order
  const degBoxes = page.locator(A('formField-degree'));
  for (let i = 0; i < Math.min(await degBoxes.count(), (sections.education || []).length); i++) {
    const want = sections.education[i].degree; const box = degBoxes.nth(i);
    const now = ((await box.locator('button[aria-haspopup="listbox"]').first().innerText().catch(() => '')) || '').trim();
    if (!want || !(await box.locator('button[aria-haspopup="listbox"]').count())) continue;
    await box.locator('button[aria-haspopup="listbox"]').first().click(); await pause(page, 700);
    const opt = chooseOption(await optionsOf(page), want);
    if (opt && opt.label !== now) { await clickOption(page, opt.label); filled.push({ label: `Degree ${i + 1}`, key: 'degree', value: opt.label, source: 'profile' }); }
    else await page.keyboard.press('Escape');
    await pause(page, 300);
  }
  // 4. Skills: the first dozen (skipped when the resume parse or an earlier run already added some)
  const skillBox = page.locator(`${A('formField-skills')} input`).first();
  if (await skillBox.count() && !(await page.locator(`${A('formField-skills')} ${A('selectedItem')}`).count())) {
    const skills = (sections.skills || []).flatMap(g => g.items || []).slice(0, 12);
    let n = 0;
    for (const sk of skills) {
      await skillBox.evaluate(e => { e.scrollIntoView({ block: 'center' }); e.focus(); });
      await page.keyboard.type(sk.replace(/\s*\d+$/, ''), { delay: 20 }); await pause(page, 1100);
      await page.keyboard.press('Enter'); await pause(page, 500);
      n++;
    }
    if (n) filled.push({ label: 'Skills', key: 'skills', value: `${n} skills`, source: 'profile' });
  }
  return { filled, missing };
}
