/**
 * Fills a job application form in a real browser page (playwright-core).
 *
 * Works from labels, not from per-company selectors, so the same code reads
 * Greenhouse, Lever and Ashby forms (and plain HTML forms). It never solves
 * or works around a CAPTCHA: a visible challenge stops the application and
 * hands it to the person.
 *
 * LLM fallback: when a required field has no known answer, the configured
 * cloud LLM (OpenRouter / Anthropic / HF) is called to generate one from the
 * resume + job context. Pass opts.llmContext = { job, resumeSections } to
 * enable it.
 */
import { resolveAnswer, chooseOption } from './answers.mjs';
import { llmAnswer, llmChoose } from './llm-answers.mjs';

function scanForm() {
  const visible = el => {
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return (r.width > 0 || r.height > 0 || el.type === 'file') && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const clean = t => String(t || '').replace(/\s+/g, ' ').replace(/\s*[*✱]\s*$/, ' *').trim();
  const textOf = el => (el ? el.innerText || el.textContent || '' : '');
  const reqClass = el => !!el && /(^|[\s_-])required/i.test(String(el.className || ''));
  const byIds = ids => ids.split(/\s+/).map(i => textOf(document.getElementById(i))).join(' ');
  function labelOf(el) {
    const lb = el.getAttribute('aria-labelledby'); if (lb) { const t = byIds(lb).trim(); if (t) return [t, document.getElementById(lb.split(/\s+/)[0])]; }
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l && textOf(l).trim()) return [textOf(l), l]; }
    const wrap = el.closest('label'); if (wrap && textOf(wrap).trim()) return [textOf(wrap), wrap];
    if (el.getAttribute('aria-label')) return [el.getAttribute('aria-label'), null];
    // No proper label: the nearest label-like text BEFORE the field, in widening blocks. (Taking the first one in
    // the block labelled Breezy's resume/name/email fields with the first custom question below them.)
    let n = el.parentElement;
    for (let i = 0; i < 6 && n; i++, n = n.parentElement) {
      const near = [...n.querySelectorAll('label, legend, h1, h2, h3, h4, h5, h6, [class*="label" i], [class*="question" i]')]   // Breezy: <h3>question</h3><textarea>
        .filter(x => !x.contains(el) && textOf(x).trim());
      const before = near.filter(x => x.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
      // a checkbox's text sits after it ("☐ I agree…"), anything else's before it
      const l = /checkbox|radio/.test(el.type) ? near.find(x => !before.includes(x)) || before[before.length - 1] : before[before.length - 1];
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
  const fields = []; let n = 0; const groups = new Map(), blocks = new Map();
  const score = f => f.querySelectorAll('input[type=file]').length * 100 + f.querySelectorAll('input, select, textarea').length;
  const form = [...document.forms].filter(f => score(f) >= 3).sort((a, b) => score(b) - score(a))[0] || document;
  for (const el of form.querySelectorAll('input, select, textarea')) {
    const type = (el.getAttribute('type') || el.tagName).toLowerCase();
    if (['hidden', 'submit', 'button', 'image', 'reset', 'search'].includes(type)) continue;
    if (type !== 'file' && !visible(el)) continue;
    if (el.closest('[aria-hidden="true"]') && type !== 'file') continue;
    let sameName = el.name ? [...form.querySelectorAll(`input[type="${type}"][name="${CSS.escape(el.name)}"]`)] : [el];
    // Ashby names every checkbox of one question differently (GCP, AWS, AZURE): the question's own block is the group
    let blockKey = null;
    if (type === 'checkbox' && sameName.length === 1) {
      const blk = el.closest('fieldset, [role="group"], [class*="field-entry" i], [class*="fieldEntry"]');
      const boxes = blk ? [...blk.querySelectorAll('input[type="checkbox"]')].filter(visible) : [];
      if (boxes.length > 1) { sameName = boxes; if (!blocks.has(blk)) blocks.set(blk, blocks.size); blockKey = blocks.get(blk); }
    }
    if (type === 'radio' || (type === 'checkbox' && sameName.length > 1)) {
      const key = blockKey !== null ? `box:${blockKey}` : `${type}:${el.name}`;
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
    if (type === 'file' && !/resume|cv\b|cover/i.test(label)) label = `${label} (${el.id || el.name || 'file'})`;
    const f = {
      id, tag: el.tagName.toLowerCase(), type, name: el.name || '', label,
      required: el.required || el.getAttribute('aria-required') === 'true' || (!(type === 'file' && !/resume|cv\b|cover/i.test(raw)) && (starred(raw) || reqClass(lEl))),
      combobox: el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list',
      accept: el.getAttribute('accept') || '',
    };
    if (f.tag === 'select') f.options = [...el.options].map(o => ({ label: clean(o.textContent), value: o.value }));
    fields.push(f);
  }
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

// Cookie banners cover fields and the Submit button. Choose the privacy-preserving option (reject / only necessary),
// else close the banner; never accept tracking on the person's behalf.
const COOKIE_SCOPE = '[class*="cookie" i]:visible, [id*="cookie" i]:visible, [class*="consent" i]:visible, [id*="consent" i]:visible, [aria-label*="cookie" i]:visible';
const COOKIE_NO = /^\s*(reject( all)?( cookies)?|decline( all)?( cookies)?|deny( all)?|refuse( all)?|(use |allow )?(only )?(strictly )?(necessary|essential)( cookies)?( only)?|continue without accepting|close|×|✕)\s*$/i;
async function dismissCookieBanner(page) {
  const scope = page.locator(COOKIE_SCOPE);
  if (!(await scope.count().catch(() => 0))) return;
  const btn = scope.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: COOKIE_NO }).first();
  const close = scope.locator('button[aria-label*="close" i]:visible, button[aria-label*="dismiss" i]:visible').first();
  const target = (await btn.count()) ? btn : (await close.count()) ? close : null;
  if (target) { await target.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(400); }
}

// labels of the fields the form itself marks invalid (aria-invalid, or a visible field error)
function invalidFields(page) {
  return page.evaluate(() => {
    const label = el => { const id = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`); return (id?.innerText || el.getAttribute('aria-label') || el.name || '').replace(/\s+/g, ' ').trim().slice(0, 60); };
    return [...new Set([...document.querySelectorAll('[aria-invalid="true"]')].map(label).filter(Boolean))].slice(0, 5);
  }).catch(() => []);
}

const APPLY_TEXT = /^\s*(apply( now| for this (job|position|role)| to (this )?(job|position))?|i.?m interested|skicka ansökan|ansök( nu)?|jetzt bewerben|bewerben|postuler|solliciteer( nu)?)\s*$/i;
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
    const picks = ans.value?.options || (ans.value?.option ? [ans.value.option] : []);   // a checkbox group can take several
    if (!picks.length) return false;
    for (const opt of picks) {
      const target = page.locator(`[data-aa-id="${opt.id}"]`);
      if (field.type === 'buttons') await target.click();
      else await target.check({ force: true });
    }
    return true;
  }
  if (field.combobox && ans.value?.option) {
    await loc.click();
    const list = await listboxFor(page, loc);
    await list.locator(OPTION).filter({ hasText: exactText(ans.value.option.label) }).first().click();
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
  // Search-as-you-type dropdowns (react-select: Greenhouse's Country and Location): fill() sets the text without
  // the key events that open the menu, so type it; then take the visible option that matches the most of the answer.
  const [first, ...rest] = String(ans.value).split(',').map(t => t.trim()).filter(Boolean);
  // a state code ("TX") is listed by name ("Texas") in most of these dropdowns
  for (const typed of [first, STATE_NAMES[first.toUpperCase()]].filter(Boolean)) {
    await loc.click().catch(() => {});
    await loc.fill('');
    await loc.pressSequentially(typed, { delay: 30 });
    await page.waitForTimeout(1500);
    const list = await listboxFor(page, loc);
    const options = list.locator(OPTION).filter({ hasText: new RegExp(typed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') });
    const texts = (await options.allInnerTexts()).map(t => t.trim()).slice(0, 10);
    if (!texts.length) continue;
    // the exact option wins ("United States", not "United States Minor Outlying Islands"); else the one matching most of the answer
    const exact = texts.findIndex(t => t.toLowerCase() === typed.toLowerCase());
    const score = t => rest.filter(r => t.toLowerCase().includes(r.toLowerCase()) || t.toLowerCase().includes(STATE_NAMES[r.toUpperCase()] || '\u0000')).length;
    const best = exact >= 0 ? exact : texts.reduce((b, t, i) => (score(t) > score(texts[b]) ? i : b), 0);
    await options.nth(best).click();
    return true;
  }
  await loc.press('Escape').catch(() => {});
  return false;
}

// Only options actually shown: a page can carry hidden option lists (Greenhouse's phone country picker has 244)
// (older react-select, e.g. Pinpoint, marks options only with the class react-select__option)
const OPTION = '[role="option"]:visible, [class*="select__option"]:visible';
const STATE_NAMES = { AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado', CT: 'connecticut', DE: 'delaware',
  FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho', IL: 'illinois', IN: 'indiana', IA: 'iowa', KS: 'kansas', KY: 'kentucky', LA: 'louisiana',
  ME: 'maine', MD: 'maryland', MA: 'massachusetts', MI: 'michigan', MN: 'minnesota', MS: 'mississippi', MO: 'missouri', MT: 'montana', NE: 'nebraska',
  NV: 'nevada', NH: 'new hampshire', NJ: 'new jersey', NM: 'new mexico', NY: 'new york', NC: 'north carolina', ND: 'north dakota', OH: 'ohio',
  OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania', RI: 'rhode island', SC: 'south carolina', SD: 'south dakota', TN: 'tennessee', TX: 'texas',
  UT: 'utah', VT: 'vermont', VA: 'virginia', WA: 'washington', WV: 'west virginia', WI: 'wisconsin', WY: 'wyoming', DC: 'district of columbia' };
const exactText = t => new RegExp(`^\\s*${String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');

async function listboxFor(page, loc) {
  const id = await loc.getAttribute('aria-controls') || await loc.getAttribute('aria-owns');
  return id ? page.locator(`[id="${id}"]`) : page.locator('body');
}

async function openCombobox(page, field) {
  const loc = page.locator(`[data-aa-id="${field.id}"]`);
  try {
    await loc.click({ timeout: 3000 });
    await page.waitForTimeout(350);
    const list = await listboxFor(page, loc);
    const labels = (await list.locator(OPTION).allInnerTexts()).map(t => t.trim()).filter(Boolean);
    await loc.press('Escape').catch(() => {});
    if (!labels.length || labels.length > 40 || /no options/i.test(labels[0])) return null;
    return labels.map(l => ({ label: l, value: l }));
  } catch { return null; }
}

async function tryLLMFill(page, field, book, llmCtx, files) {
  if (['resumeFile', 'coverLetterFile', 'otherFile'].includes(field.type) || field.type === 'file') return { ok: false };
  if (field.type === 'checkbox' && !field.group) return { ok: false };
  // "What cloud services have you built in?" (GCP / AWS / Azure): tick every option the resume itself mentions;
  // none mentioned: leave it for the person
  if (field.type === 'checkbox' && field.group && field.options?.length) {
    const have = JSON.stringify(llmCtx?.resumeSections || {}).toLowerCase();
    const mentioned = field.options.filter(o => { const t = o.label.toLowerCase().trim(); return t.length >= 2 && new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(have); });
    if (mentioned.length) {
      try { const ok = await fillOne(page, field, { key: 'llm', value: { options: mentioned }, source: 'profile' }, files); return { ok, value: mentioned.map(o => o.label).join(', ') }; }
      catch { return { ok: false }; }
    }
    return { ok: false };   // nothing here is on the resume and there is no "none" box: ticking one would claim experience, so it goes to "Needs you"
  }
  const isChoice = field.tag === 'select' || field.type === 'radio' || field.type === 'buttons' || (field.type === 'checkbox' && field.group);
  if (isChoice && field.options?.length) {
    const chosenLabel = await llmChoose(field.label, field.options, llmCtx).catch(() => null);
    if (!chosenLabel) return { ok: false };
    const opt = chooseOption(field.options, chosenLabel);
    if (!opt) return { ok: false };
    try { const ok = await fillOne(page, field, { key: 'llm', value: { option: opt }, source: 'llm' }, files); return { ok, value: opt.label }; }
    catch { return { ok: false }; }
  }
  const text = await llmAnswer(field.label, llmCtx).catch(() => null);
  if (!text) return { ok: false };
  try { const ok = await fillOne(page, field, { key: 'llm', value: text, source: 'llm' }, files); return { ok, value: text }; }
  catch { return { ok: false }; }
}

// Greenhouse emails a security code to the applicant before it accepts Submit: eight boxes (security-input-0…7)
// under "enter the 8-character code to confirm you're a human". The code is in the applicant's own inbox.
const CODE_BOXES = 'input[id^="security-input"]:visible, input[aria-label*="security code" i]:visible';
async function securityCodeBoxes(page) {
  const named = page.locator(CODE_BOXES);
  if (await named.count().catch(() => 0) >= 4) return named;
  const text = await page.locator('body').innerText().catch(() => '');
  if (!/security code|verification code was sent/i.test(text)) return null;
  const singles = page.locator('input[maxlength="1"]:visible');
  return (await singles.count().catch(() => 0)) >= 6 ? singles : null;
}
/**
 * If the form is asking for the emailed code: read it (opts.readCode, from the applicant's linked Gmail) and type it in.
 * Returns null when there is no code step, { ok: true } once typed, or { ok: false, reason } to hand back to the person.
 */
async function enterSecurityCode(page, opts, since, step) {
  const boxes = await securityCodeBoxes(page);
  if (!boxes) return null;
  step('The form asked for the security code it emailed');
  const got = opts.readCode ? await opts.readCode({ since }) : { reason: "Reading the applicant's email isn't set up" };
  if (!got?.code) return { ok: false, reason: got?.reason || "The form emailed a security code that couldn't be read. Open the application, enter the code from your email and send it." };
  step('Read the security code from the inbox');
  const n = await boxes.count();
  if (n >= got.code.length) { for (let i = 0; i < got.code.length; i++) await boxes.nth(i).fill(got.code[i]); }
  else await boxes.first().fill(got.code);
  await page.waitForTimeout(800);
  return { ok: true };
}

export async function fillApplication(page, url, book, files, opts = {}) {
  const timeout = opts.timeoutMs ?? 30_000;
  if (!opts.alreadyOnPage) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    // The form can sit behind an Apply button on the posting. Click it unless an email field already shows
    // (BambooHR's posting carries a hidden file input, so "no file input yet" never clicked there).
    const applyBtn = page.locator('a:visible, button:visible').filter({ hasText: APPLY_TEXT }).first();
    if (await applyBtn.count() && !(await page.locator('input[type=email]:visible, input[name*="email" i]:visible, input[id*="email" i]:visible').count())) {
      await applyBtn.click().catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      // in-page forms (BambooHR, Teamtailor) draw a moment after the click, after the network is already quiet
      await page.locator('input[type=email]:visible, input[name*="email" i]:visible, input[type=file]').first().waitFor({ timeout: 8000 }).catch(() => {});
    }
  }
  await dismissCookieBanner(page);
  let challenge = await page.evaluate(findChallenge);
  if (challenge) return { outcome: 'NEEDS_YOU', filled: [], missing: [], reason: `${challenge} on the form` };
  const fields = await page.evaluate(scanForm);
  if (!fields.some(f => f.type === 'file') && !fields.some(f => /e-?mail/i.test(f.label))) {
    return { outcome: 'FAILED', filled: [], missing: [], reason: 'No application form found on the page' };
  }
  const step = (text, data) => opts.onStep?.(text, data), shot = label => opts.onShot?.(page, label);   // the admin's view of the attempt
  step('Opened the form', { fields: fields.length });
  const filled = []; const missing = [];
  for (let i = 0; i < fields.length; i++) {
    let field = fields[i];
    // The form redrew part of itself (Pinpoint rebuilds Street/City/State/Zip after Country): scan again and
    // re-attach the fields still to fill to the new elements, by label and kind, in order.
    if (!(await page.locator(`[data-aa-id="${field.id}"]`).count())) {
      const fresh = await page.evaluate(scanForm), used = new Set();
      for (let j = i; j < fields.length; j++) {
        const m = fresh.find(x => !used.has(x.id) && x.label === fields[j].label && x.type === fields[j].type && x.tag === fields[j].tag);
        if (m) { used.add(m.id); fields[j] = { ...m, options: fields[j].options ?? m.options }; }
      }
      field = fields[i];
    }
    if (field.combobox && !field.options) {
      const options = await openCombobox(page, field);
      if (options) { field.options = options; field.tag = 'select'; field.dropdown = true; }
    }
    const ans = resolveAnswer(field, book, { acceptConsent: !!opts.acceptConsent });
    let ok = false;
    try { ok = await fillOne(page, field, ans, files); } catch (err) { ok = false; ans.error = err.message.split('\n')[0]; }
    // LLM fallback for required unknown fields
    if (!ok && field.required && ans.value === null && opts.llmContext) {
      const llmResult = await tryLLMFill(page, field, book, opts.llmContext, files);
      if (llmResult.ok) { filled.push({ label: field.label, key: 'llm', value: llmResult.value, source: 'llm' }); continue; }
    }
    const shown = ans.value?.option ? ans.value.option.label : ans.value;
    if (ok) filled.push({ label: field.label, key: ans.key, value: field.type === 'file' ? (ans.key === 'resumeFile' ? 'resume.pdf' : 'cover-letter.pdf') : shown, source: ans.source });
    else if (field.required) {
      missing.push({ label: field.label, key: ans.key, type: field.group ? field.type : field.tag === 'select' ? 'select' : field.type,
        options: (field.options || []).map(o => o.label).filter(Boolean).slice(0, 30), wanted: ans.wanted ?? null, error: ans.error });
    }
  }
  if (opts.screenshotPath) await page.screenshot({ path: opts.screenshotPath, fullPage: true }).catch(() => {});
  step(`Filled ${filled.length} of ${fields.length} fields`, { missing: missing.map(m => m.label) });
  if (missing.length) return { outcome: 'NEEDS_YOU', filled, missing, reason: `${missing.length} required question${missing.length === 1 ? '' : 's'} need${missing.length === 1 ? 's' : ''} your answer` };
  if (!opts.submit) return { outcome: 'FILLED', filled, missing };
  const submit = page.locator('button[type=submit], input[type=submit], button').filter({ hasText: /submit/i }).first();
  const target = (await submit.count()) ? submit : page.locator('button[type=submit], input[type=submit]').first();
  if (!(await target.count())) return { outcome: 'FAILED', filled, missing, reason: 'No submit button found' };
  // A disabled Submit means the form hasn't accepted every answer. Clicking it only waited 30 s and failed with
  // "locator.click: Timeout" (Workable keeps it disabled until every field validates).
  const startedAt = Date.now();
  const early = await enterSecurityCode(page, opts, startedAt - 60_000, step);
  if (early && !early.ok) return { outcome: 'NEEDS_YOU', filled, missing, reason: early.reason };
  const usable = async () => (await target.isEnabled().catch(() => false)) && (await target.getAttribute('aria-disabled').catch(() => null)) !== 'true';
  if (!(await usable())) { await page.waitForTimeout(3000); }
  if (!(await usable())) {
    const bad = await invalidFields(page);
    return { outcome: 'NEEDS_YOU', filled, missing,
      reason: `The form kept its Submit button disabled, so it didn't accept every answer${bad.length ? ` (check: ${bad.join(', ')})` : ''}. Open the application to finish it.` };
  }
  await target.scrollIntoViewIfNeeded().catch(() => {});
  await dismissCookieBanner(page);   // banners often sit over the bottom of the page, where Submit is
  const before = page.url();
  await shot('Before submitting'); step('Clicking Submit');
  try {
    await Promise.all([page.waitForNavigation({ timeout: 15_000 }).catch(() => {}), target.click({ timeout: 10_000 })]);
  } catch (err) {
    // the click didn't happen, so nothing was sent: safe to hand back
    return { outcome: 'NEEDS_YOU', filled, missing,
      reason: /intercepts pointer events/.test(err.message) ? 'Something on the page covered the Submit button. Open the application and send it yourself.'
        : "The Submit button never became clickable. Open the application and send it yourself." };
  }
  await page.waitForTimeout(1500);
  if (!early) {
    // Submit was accepted as a first step and the form now wants the emailed code: type it and send again
    const late = await enterSecurityCode(page, opts, startedAt - 30_000, step);
    if (late && !late.ok) { await shot('Waiting for the security code'); return { outcome: 'NEEDS_YOU', filled, missing, reason: late.reason }; }
    if (late?.ok) {
      const again = page.locator('button[type=submit], input[type=submit], button').filter({ hasText: /submit/i }).first();
      await shot('Before submitting with the code'); step('Clicking Submit with the code');
      await Promise.all([page.waitForNavigation({ timeout: 15_000 }).catch(() => {}), again.click({ timeout: 10_000 }).catch(() => {})]);
      await page.waitForTimeout(2000);
    }
  }
  const body = await page.locator('body').innerText().catch(() => '');
  // what the page looked like after Submit, for the admin: a screenshot, the fields it marks invalid, and its text
  const done = async res => { await shot('After submitting'); return { ...res, page: { url: page.url(), invalid: await invalidFields(page), text: body.replace(/\s+/g, ' ').trim().slice(0, 400) } }; };
  challenge = await page.evaluate(findChallenge);
  if (challenge) return done({ outcome: 'NEEDS_YOU', filled, missing, reason: `${challenge} appeared after submitting; finish it in the browser` });
  const m = body.match(SUCCESS_TEXT);
  if (m || (page.url() !== before && SUCCESS_URL.test(page.url()))) return done({ outcome: 'SUBMITTED', filled, missing, confirmation: m ? m[0] : page.url() });
  const errors = await page.locator('[aria-invalid="true"], [role="alert"], .error, .field-error, .error-message').allInnerTexts().catch(() => []);
  const errText = errors.map(t => t.trim()).filter(Boolean).slice(0, 5);
  if (errText.length) return done({ outcome: 'NEEDS_YOU', filled, missing, reason: `The form reported: ${errText.join(' · ')}` });
  return done({ outcome: 'FAILED', filled, missing, reason: `Submitted, but no confirmation appeared. It may or may not have gone through, so check the company's email or portal before trying again. The page said: ${body.replace(/\s+/g, ' ').trim().slice(0, 160)}` });
}

export { scanForm, findChallenge };
