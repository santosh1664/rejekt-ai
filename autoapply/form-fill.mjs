/**
 * Fills a job application form in a real browser page (playwright-core).
 *
 * Works from labels, not from per-company selectors, so the same code reads
 * Greenhouse, Lever and Ashby forms (and plain HTML forms). It never solves
 * or works around a CAPTCHA: a visible challenge stops the application and
 * hands it to the person.
 */
import { resolveAnswer } from './answers.mjs';

/** Runs in the page: tags every visible control and describes it. */
function scanForm() {
  const visible = el => {
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return (r.width > 0 || r.height > 0 || el.type === 'file') && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const clean = t => String(t || '').replace(/\s+/g, ' ').replace(/\s*[*✱]\s*$/, ' *').trim();
  const textOf = el => (el ? el.innerText || el.textContent || '' : '');
  const reqClass = el => !!el && /(^|[\s_-])required/i.test(String(el.className || ''));
  const byIds = ids => ids.split(/\s+/).map(i => textOf(document.getElementById(i))).join(' ');
  // Returns [text, element] so the label's own "required" class can be read (Ashby).
  function labelOf(el) {
    const lb = el.getAttribute('aria-labelledby'); if (lb) { const t = byIds(lb).trim(); if (t) return [t, document.getElementById(lb.split(/\s+/)[0])]; }
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l && textOf(l).trim()) return [textOf(l), l]; }
    const wrap = el.closest('label'); if (wrap && textOf(wrap).trim()) return [textOf(wrap), wrap];
    if (el.getAttribute('aria-label')) return [el.getAttribute('aria-label'), null];
    let n = el.parentElement;
    for (let i = 0; i < 6 && n; i++, n = n.parentElement) {
      const l = [...n.querySelectorAll('label, legend, [class*="label" i], [class*="question" i]')].find(x => !x.contains(el) && textOf(x).trim());
      if (l) return [textOf(l), l];
    }
    return [el.placeholder || el.name || '', null];
  }
  function questionOf(el, members) {
    const fs = el.closest('fieldset'); const lg = fs?.querySelector('legend');
    if (lg && textOf(lg).trim()) return [textOf(lg), lg];
    const rg = el.closest('[role="radiogroup"], [role="group"]');
    if (rg) { const lb = rg.getAttribute('aria-labelledby'); if (lb) return [byIds(lb), document.getElementById(lb.split(/\s+/)[0])]; if (rg.getAttribute('aria-label')) return [rg.getAttribute('aria-label'), null]; }
    let n = el.parentElement;
    for (let i = 0; i < 7 && n; i++, n = n.parentElement) {
      if (members.filter(o => n.contains(o)).length < members.length) continue;
      const l = [...n.querySelectorAll('label, [class*="label" i], [class*="question" i], [class*="title" i], legend')]
        .find(x => !members.some(o => x.contains(o) || (o.id && x.htmlFor === o.id)) && textOf(x).trim());
      if (l) return [textOf(l), l];
    }
    return [el.name || '', null];
  }
  const starred = t => /[*✱](\s|$)/.test(t);

  const fields = []; let n = 0; const groups = new Map();
  // The application form is the one holding the resume upload or the most
  // fields; Ashby renders without a <form>, so fall back to the document.
  const score = f => f.querySelectorAll('input[type=file]').length * 100 + f.querySelectorAll('input, select, textarea').length;
  const form = [...document.forms].filter(f => score(f) >= 3).sort((a, b) => score(b) - score(a))[0] || document;
  for (const el of form.querySelectorAll('input, select, textarea')) {
    const type = (el.getAttribute('type') || el.tagName).toLowerCase();
    if (['hidden', 'submit', 'button', 'image', 'reset', 'search'].includes(type)) continue;
    if (type !== 'file' && !visible(el)) continue;
    if (el.closest('[aria-hidden="true"]') && type !== 'file') continue;
    const sameName = el.name ? [...form.querySelectorAll(`input[type="${type}"][name="${CSS.escape(el.name)}"]`)] : [el];
    if (type === 'radio' || (type === 'checkbox' && sameName.length > 1)) {
      const key = `${type}:${el.name}`;
      let g = groups.get(key);
      if (!g) {
        const [q, qEl] = questionOf(el, sameName);
        g = { id: `g${n++}`, tag: 'input', type, group: true, name: el.name, label: clean(q), required: reqClass(qEl) || starred(q), options: [] };
        groups.set(key, g); fields.push(g);
      }
      const oid = `${g.id}-${g.options.length}`;
      el.setAttribute('data-aa-id', oid);
      g.options.push({ label: clean(labelOf(el)[0]), value: el.value, id: oid });
      if (el.required || el.getAttribute('aria-required') === 'true') g.required = true;
      continue;
    }
    const id = `f${n++}`;
    el.setAttribute('data-aa-id', id);
    const [raw, lEl] = labelOf(el);
    let label = clean(raw);
    // Upload widgets often label the input "Attach"; the input's id says what it is.
    if (type === 'file' && !/resume|cv\b|cover/i.test(label)) label = `${label} (${el.id || el.name || 'file'})`;
    const f = {
      id, tag: el.tagName.toLowerCase(), type, name: el.name || '', label,
      required: el.required || el.getAttribute('aria-required') === 'true' || starred(raw) || reqClass(lEl),
      combobox: el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list',
      accept: el.getAttribute('accept') || '',
    };
    if (f.tag === 'select') f.options = [...el.options].map(o => ({ label: clean(o.textContent), value: o.value }));
    fields.push(f);
  }
  // Yes/No answered with a pair of buttons (Ashby).
  const pairs = new Map();
  for (const b of form.querySelectorAll('button[data-option], button[aria-pressed]')) {
    if (!/^(yes|no)$/i.test(textOf(b).trim()) || !visible(b)) continue;
    const box = b.parentElement;
    if (!pairs.has(box)) pairs.set(box, []);
    pairs.get(box).push(b);
  }
  for (const [, btns] of pairs) {
    if (btns.length < 2) continue;
    const [q, qEl] = questionOf(btns[0], btns);
    const g = { id: `g${n++}`, tag: 'button', type: 'buttons', group: true, name: '', label: clean(q), required: reqClass(qEl) || starred(q), options: [] };
    btns.forEach((b, i) => { const oid = `${g.id}-${i}`; b.setAttribute('data-aa-id', oid); g.options.push({ label: textOf(b).trim(), value: b.dataset.option || textOf(b).trim(), id: oid }); });
    fields.push(g);
  }
  return fields;
}

/** A challenge the person has to complete. Invisible reCAPTCHA badges don't count. */
function findChallenge() {
  const shown = el => { const r = el.getBoundingClientRect(); return r.width > 30 && r.height > 30 && getComputedStyle(el).visibility !== 'hidden'; };
  const frames = [...document.querySelectorAll('iframe')].filter(f => {
    const src = f.src || ''; const title = f.title || '';
    if (/recaptcha\/(api2|enterprise)\/anchor/.test(src) && !/size=invisible/.test(src)) return shown(f);
    if (/recaptcha\/(api2|enterprise)\/bframe/.test(src)) return shown(f);
    if (/hcaptcha\.com/.test(src) || /hcaptcha/i.test(title)) return shown(f);
    if (/challenges\.cloudflare\.com/.test(src)) return shown(f);
    return false;
  });
  if (frames.length) return frames[0].src.includes('cloudflare') ? 'Cloudflare check' : /hcaptcha/.test(frames[0].src) ? 'hCaptcha' : 'reCAPTCHA';
  const widget = [...document.querySelectorAll('.h-captcha, .cf-turnstile, [data-captcha], #captcha, .captcha')].find(shown);
  return widget ? 'CAPTCHA' : null;
}

const SUCCESS_TEXT = /thank you for (applying|your (application|interest|submission))|thanks for applying|application (has been |was )?(submitted|received)|we.?ve received your application|successfully (applied|submitted)/i;
const SUCCESS_URL = /confirm|thank|success|submitted|\/thanks\b/i;

async function fillOne(page, field, ans, files) {
  const loc = page.locator(`[data-aa-id="${field.id}"]`);
  if (field.type === 'file') {
    const path = ans.key === 'coverLetterFile' ? files.coverLetter : ans.key === 'resumeFile' ? files.resume : null;
    if (!path) return false;
    await loc.setInputFiles(path);
    return true;
  }
  if (field.group) {
    const opt = ans.value?.option; if (!opt) return false;
    const target = page.locator(`[data-aa-id="${opt.id}"]`);
    if (field.type === 'buttons') await target.click();
    else await target.check({ force: true });
    return true;
  }
  if (field.combobox && ans.value?.option) {
    // A dropdown whose options were read by openCombobox(): open it again and click the one chosen.
    await loc.click();
    const list = await listboxFor(page, loc);
    await list.locator('[role="option"]').filter({ hasText: exactText(ans.value.option.label) }).first().click();
    return true;
  }
  if (field.tag === 'select') {
    const opt = ans.value?.option; if (!opt) return false;
    await loc.selectOption(opt.value);
    return true;
  }
  if (field.type === 'checkbox') {
    if (typeof ans.value !== 'boolean') return false;
    await loc.setChecked(ans.value, { force: true });
    return true;
  }
  if (ans.value === null) return false;
  if (!field.combobox) { await loc.fill(String(ans.value)); return true; }
  // Typeahead (Greenhouse location, school): type, then pick the matching suggestion.
  const typed = String(ans.value).split(',')[0].trim();
  await loc.fill(typed);
  await page.waitForTimeout(900);
  const list = await listboxFor(page, loc);
  const option = list.locator('[role="option"]').filter({ hasText: typed }).first();
  if (await option.count()) { await option.click(); return true; }
  await loc.press('Escape').catch(() => {});
  return false;
}

const exactText = t => new RegExp(`^\\s*${String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');

/** The listbox a combobox controls, or the page when it doesn't say. */
async function listboxFor(page, loc) {
  const id = await loc.getAttribute('aria-controls') || await loc.getAttribute('aria-owns');
  return id ? page.locator(`[id="${id}"]`) : page.locator('body');
}

/** Open a dropdown-style combobox and read its options (React selects on Greenhouse). */
async function openCombobox(page, field) {
  const loc = page.locator(`[data-aa-id="${field.id}"]`);
  try {
    await loc.click({ timeout: 3000 });
    await page.waitForTimeout(350);
    const list = await listboxFor(page, loc);
    const labels = (await list.locator('[role="option"]').allInnerTexts()).map(t => t.trim()).filter(Boolean);
    await loc.press('Escape').catch(() => {});
    // A long list (countries, schools) or "No options" is a typeahead: leave it to typing.
    if (!labels.length || labels.length > 40 || /no options/i.test(labels[0])) return null;
    return labels.map(l => ({ label: l, value: l }));
  } catch { return null; }
}

/**
 * Open the form, fill it, and either stop (submit: false) or submit.
 *
 * @param {import('playwright-core').Page} page
 * @param {string} url
 * @param {object} book            buildAnswerBook()
 * @param {{ resume: string, coverLetter?: string }} files  paths on disk
 * @param {{ submit?: boolean, acceptConsent?: boolean, screenshotPath?: string, timeoutMs?: number }} opts
 * @returns {Promise<{ outcome: 'FILLED'|'SUBMITTED'|'NEEDS_YOU'|'FAILED', filled: object[], missing: object[], reason?: string, confirmation?: string }>}
 */
export async function fillApplication(page, url, book, files, opts = {}) {
  const timeout = opts.timeoutMs ?? 30_000;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

  // Some boards show the description first with an "Apply" button.
  const applyBtn = page.locator('a, button').filter({ hasText: /^\s*apply( for this job| now)?\s*$/i }).first();
  if (await applyBtn.count() && !(await page.locator('input[type=file]').count())) {
    await applyBtn.click().catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  }

  let challenge = await page.evaluate(findChallenge);
  if (challenge) return { outcome: 'NEEDS_YOU', filled: [], missing: [], reason: `${challenge} on the form` };

  const fields = await page.evaluate(scanForm);
  if (!fields.some(f => f.type === 'file') && !fields.some(f => /e-?mail/i.test(f.label))) {
    return { outcome: 'FAILED', filled: [], missing: [], reason: 'No application form found on the page' };
  }

  const filled = []; const missing = [];
  for (const field of fields) {
    if (field.combobox && !field.options) {
      const options = await openCombobox(page, field);
      if (options) { field.options = options; field.tag = 'select'; field.dropdown = true; }
    }
    const ans = resolveAnswer(field, book, { acceptConsent: !!opts.acceptConsent });
    let ok = false;
    try { ok = await fillOne(page, field, ans, files); } catch (err) { ok = false; ans.error = err.message.split('\n')[0]; }
    const shown = ans.value?.option ? ans.value.option.label : ans.value;
    if (ok) filled.push({ label: field.label, key: ans.key, value: field.type === 'file' ? (ans.key === 'resumeFile' ? 'resume.pdf' : 'cover-letter.pdf') : shown, source: ans.source });
    else if (field.required) {
      missing.push({ label: field.label, key: ans.key, type: field.group ? field.type : field.tag === 'select' ? 'select' : field.type,
        options: (field.options || []).map(o => o.label).filter(Boolean).slice(0, 30), wanted: ans.wanted ?? null, error: ans.error });
    }
  }
  if (opts.screenshotPath) await page.screenshot({ path: opts.screenshotPath, fullPage: true }).catch(() => {});

  if (missing.length) return { outcome: 'NEEDS_YOU', filled, missing, reason: `${missing.length} required question${missing.length === 1 ? '' : 's'} need${missing.length === 1 ? 's' : ''} your answer` };
  if (!opts.submit) return { outcome: 'FILLED', filled, missing };

  const submit = page.locator('button[type=submit], input[type=submit], button').filter({ hasText: /submit/i }).first();
  const target = (await submit.count()) ? submit : page.locator('button[type=submit], input[type=submit]').first();
  if (!(await target.count())) return { outcome: 'FAILED', filled, missing, reason: 'No submit button found' };
  const before = page.url();
  await Promise.all([
    page.waitForNavigation({ timeout: 15_000 }).catch(() => {}),
    target.click(),
  ]);
  await page.waitForTimeout(1500);

  challenge = await page.evaluate(findChallenge);
  if (challenge) return { outcome: 'NEEDS_YOU', filled, missing, reason: `${challenge} appeared after submitting; finish it in the browser` };
  const body = await page.locator('body').innerText().catch(() => '');
  const m = body.match(SUCCESS_TEXT);
  if (m || (page.url() !== before && SUCCESS_URL.test(page.url()))) {
    return { outcome: 'SUBMITTED', filled, missing, confirmation: m ? m[0] : page.url() };
  }
  const errors = await page.locator('[aria-invalid="true"], [role="alert"], .error, .field-error, .error-message').allInnerTexts().catch(() => []);
  const errText = errors.map(t => t.trim()).filter(Boolean).slice(0, 5);
  if (errText.length) return { outcome: 'NEEDS_YOU', filled, missing, reason: `The form reported: ${errText.join(' · ')}` };
  return { outcome: 'FAILED', filled, missing, reason: 'Submitted, but no confirmation appeared' };
}

export { scanForm, findChallenge };
