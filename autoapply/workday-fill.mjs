/**
 * Workday ATS form filler.
 *
 * Workday uses a React SPA with data-automation-id attributes.
 * Forms are multi-step wizards: Contact Info → My Experience → Application
 * Questions → Self Identify → Review.
 *
 * Playwright ≥ 1.27 pierces open Shadow DOM automatically with CSS selectors.
 */
import { resolveAnswer, chooseOption } from './answers.mjs';
import { llmAnswer, llmChoose } from './llm-answers.mjs';
import { readVerifyLink } from '../lib/gmail.mjs';
import { fillStep, fillExperience, pressNext, stepName } from './workday-steps.mjs';

const SEL = {
  nextBtn:    '[data-automation-id="bottom-navigation-next-button"]',
  submitBtn:  '[data-automation-id="bottom-navigation-footer-button"]',
  firstName:  '[data-automation-id="legalNameSection_firstName"]',
  lastName:   '[data-automation-id="legalNameSection_lastName"]',
  email:      '[data-automation-id="email"]',
  phone:      '[data-automation-id="phone-number"]',
  city:       '[data-automation-id="addressSection_city"]',
  state:      '[data-automation-id="addressSection_stateCode"]',
  country:    '[data-automation-id="addressSection_countryCode"]',
  resumeUpload: '[data-automation-id="file-upload-input-ref"]',
  linkedIn:   '[data-automation-id="linkedInUrl"]',
  error:      '[data-automation-id="errorBanner"], [role="alert"]',
  spinner:    '[data-automation-id="pageLoader"]',
  stepTitle:  '[data-automation-id="formHeader"], h2, h1',
};

const SUCCESS_TEXT = /thank you for (applying|your application)|application (submitted|received)|successfully (applied|submitted)/i;

async function waitReady(page, timeout = 10_000) {
  await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {});
  await page.locator(SEL.spinner).waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(400);
}

async function typeField(page, selector, value) {
  const loc = page.locator(selector).first();
  if (!(await loc.count())) return false;
  await loc.click();
  await loc.fill(String(value));
  await page.waitForTimeout(100);
  return true;
}

async function fillTypeahead(page, selector, value) {
  const loc = page.locator(selector).first();
  if (!(await loc.count())) return false;
  await loc.fill(String(value).split(',')[0].trim());
  await page.waitForTimeout(800);
  const opt = page.locator('[role="option"]').first();
  if (await opt.count()) { await opt.click(); return true; }
  return false;
}

async function selectDrop(page, selector, label) {
  const loc = page.locator(selector).first();
  if (!(await loc.count())) return false;
  const tag = await loc.evaluate(el => el.tagName).catch(() => '');
  if (tag === 'SELECT') { await loc.selectOption({ label }).catch(() => {}); return true; }
  await loc.click();
  await page.waitForTimeout(400);
  const opt = page.locator(`[role="option"]:has-text("${label}"), li:has-text("${label}")`).first();
  if (await opt.count()) { await opt.click(); return true; }
  await page.keyboard.press('Escape').catch(() => {});
  return false;
}

async function scanCustomFields(page) {
  return page.evaluate(() => {
    const SKIP_IDS = ['legalNameSection_firstName','legalNameSection_lastName','email','phone-number',
      'addressSection_city','addressSection_stateCode','addressSection_countryCode','linkedInUrl','file-upload-input-ref'];
    const clean = t => String(t || '').replace(/\s+/g, ' ').replace(/[*✱]\s*$/, '').trim();
    const vis = el => { const r = el.getBoundingClientRect(); return (r.width > 0 || r.height > 0) && getComputedStyle(el).display !== 'none'; };
    const labelOf = el => {
      if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l?.innerText) return clean(l.innerText); }
      const aria = el.getAttribute('aria-labelledby');
      if (aria) { const l = document.getElementById(aria.split(' ')[0]); if (l?.innerText) return clean(l.innerText); }
      const al = el.getAttribute('aria-label'); if (al) return clean(al);
      let n = el.parentElement;
      for (let i = 0; i < 6 && n; i++, n = n.parentElement) {
        const l = n.querySelector('label, legend, [class*="label" i]');
        if (l && !l.contains(el) && l.innerText?.trim()) return clean(l.innerText);
      }
      return el.placeholder || el.name || '';
    };
    const fields = [];
    for (const el of document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea')) {
      if (!vis(el)) continue;
      const aid = el.closest('[data-automation-id]')?.getAttribute('data-automation-id') || '';
      if (SKIP_IDS.some(s => aid.includes(s))) continue;
      const label = labelOf(el);
      if (!label) continue;
      const required = el.required || el.getAttribute('aria-required') === 'true' || /[*✱]/.test(label);
      const type = el.type || el.tagName.toLowerCase();
      const id = `wd-${fields.length}`;
      el.setAttribute('data-wf-id', id);
      const f = { id, label, required, type, tag: el.tagName.toLowerCase() };
      if (f.tag === 'select') f.options = [...el.options].map(o => ({ label: o.innerText.trim(), value: o.value })).filter(o => o.label && !/^(select|choose|--)/i.test(o.label));
      fields.push(f);
    }
    return fields;
  });
}

async function fillCustomField(page, field, ans, llmCtx) {
  const isChoice = field.tag === 'select' || ['radio', 'checkbox'].includes(field.type);
  if (isChoice && field.options?.length) {
    let label = ans.value?.option?.label || (typeof ans.value === 'string' ? ans.value : null);
    if (!label && llmCtx) label = await llmChoose(field.label, field.options, llmCtx).catch(() => null);
    if (!label) return false;
    const loc = page.locator(`[data-wf-id="${field.id}"]`);
    const opt = chooseOption(field.options, label);
    if (opt) { await loc.selectOption(opt.value).catch(() => {}); return true; }
    return false;
  }
  // Free text
  let value = typeof ans.value === 'string' ? ans.value : null;
  if (!value && llmCtx) value = await llmAnswer(field.label, llmCtx).catch(() => null);
  if (!value) return false;
  const loc = page.locator(`[data-wf-id="${field.id}"]`);
  await loc.fill(value).catch(() => {});
  return true;
}

export async function fillWorkday(page, url, book, files, opts = {}) {
  const filled = [];
  const missing = [];
  const llmCtx = opts.llmContext || null;

  try {
    if (!opts.alreadyOnPage) { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }); await waitReady(page); }
    const reviewing = async () => /review/i.test(await stepName(page));
    let last = '';

    for (let step = 0; step < 10; step++) {
      await waitReady(page);
      await page.waitForTimeout(2500);                       // the SPA renders each step a moment after the URL settles
      const name = await stepName(page);

      if (await reviewing()) {
        if (!opts.submit) return { outcome: 'FILLED', filled, missing };
        await pressNext(page);                               // the footer button reads "Submit" on this page
        await waitReady(page, 20_000); await page.waitForTimeout(3000);
        const body = await page.locator('body').innerText().catch(() => '');
        if (SUCCESS_TEXT.test(body) || SUCCESS_TEXT.test(page.url())) return { outcome: 'SUBMITTED', filled, missing };
        const err = await page.locator(SEL.error).first().innerText().catch(() => '');
        return err ? { outcome: 'NEEDS_YOU', filled, missing, reason: err.slice(0, 200) }
                   : { outcome: 'FAILED', filled, missing, reason: 'Submitted, but no confirmation appeared. It may or may not have gone through, so check the company\'s email or portal before trying again.' };
      }
      if (name && name === last && step > 0) return { outcome: 'NEEDS_YOU', filled, missing, reason: `Workday would not leave the "${name}" step. Finish it on the company's site.` };
      last = name;

      if (/experience/i.test(name)) { const r = await fillExperience(page, llmCtx?.resumeSections || {}, files); filled.push(...r.filled); missing.push(...r.missing); }
      const r = await fillStep(page, book, llmCtx, { acceptConsent: !!opts.acceptConsent });
      filled.push(...r.filled); missing.push(...r.missing);
      if (missing.length) return { outcome: 'NEEDS_YOU', filled, missing, reason: `${missing.length} required field${missing.length === 1 ? '' : 's'} need${missing.length === 1 ? 's' : ''} your answer` };

      const hasCaptcha = await page.evaluate(() => [...document.querySelectorAll('iframe')].some(f => /recaptcha|hcaptcha|cloudflare/.test(f.src || '')));
      if (hasCaptcha) return { outcome: 'NEEDS_YOU', filled, missing, reason: 'A CAPTCHA appeared. Please complete it on the company\'s site.' };

      if (!(await pressNext(page))) return { outcome: 'NEEDS_YOU', filled, missing, reason: `Couldn't find the Continue button on "${name}". Finish it on the company's site.` };
      await waitReady(page);
      // Saving a step can take a while: wait for the step to change (or an error to show) before judging it.
      for (let t = 0; t < 10 && (await stepName(page)) === name && !(await page.locator(`${A('errorBanner')}, ${A('errorMessage')}`).count()); t++) await page.waitForTimeout(1500);
      await page.waitForTimeout(1500);
      const errs = (await page.locator(`${A('errorBanner')}, ${A('errorMessage')}, [role="alert"]`).allInnerTexts().catch(() => [])).map(t => t.replace(/\s+/g, ' ').trim()).filter(t => /error|invalid|required|must|enter/i.test(t) && !/success/i.test(t));
      if (errs.length && (await stepName(page)) === name) return { outcome: 'NEEDS_YOU', filled, missing, reason: `Workday says: ${errs.join(' · ').slice(0, 220)}` };
    }
    return { outcome: 'NEEDS_YOU', filled, missing, reason: "This Workday form has more steps than expected. Finish it on the company's site." };
  } catch (err) {
    return { outcome: 'FAILED', filled, missing, reason: err.message.split('\n')[0] };
  }
}

const A = id => `[data-automation-id="${id}"]`;
const FORM_SEL = `${A('legalNameSection_firstName')}, ${A('formHeader')}, ${A('bottom-navigation-next-button')}, ${A('bottom-navigation-footer-button')}`;
const inForm = page => page.locator(FORM_SEL).or(page.getByRole('heading', { name: /^(My Information|Contact Information)$/i })).count();
/** The form renders a few seconds after sign-in, so wait for it instead of checking once. */
const formAppears = (page, ms = 40_000) => page.locator(FORM_SEL).or(page.getByRole('heading', { name: /^(My Information|Contact Information)$/i })).first().waitFor({ timeout: ms }).then(() => true, () => false);

/** Workday's buttons are a transparent role=button overlay: a real click, then Enter if the page didn't move. */
async function pressWd(page, label) {
  const b = page.locator(`${A('click_filter')}[aria-label="${label}"]`).first();
  await b.scrollIntoViewIfNeeded().catch(() => {});
  await b.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(2500);
  if (await b.count() && await b.isVisible().catch(() => false)) { await b.focus().catch(() => {}); await page.keyboard.press('Enter'); }
}

/** Job page → Apply → Apply Manually. Each step waits for the next button, since the SPA hydrates late. */
async function openAccountStep(page) {
  await page.locator(`${A('adventureButton')}, ${A('viewButton')}`).first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
  if (await page.locator(A('viewButton')).count()) return 'applied';   // signed in and already applied
  for (const id of ['adventureButton', 'applyManually']) {
    const b = page.locator(A(id)).first();
    try { await b.waitFor({ state: 'visible', timeout: 15_000 }); } catch { return; }
    await b.click().catch(() => {});
    await page.waitForTimeout(1500);
  }
  await page.locator(`${A('signInContent')}, ${A('legalNameSection_firstName')}`).first().waitFor({ timeout: 15_000 }).catch(() => {});
}

/**
 * Get past Workday's account wall: job page → Apply → Apply Manually → create an account
 * (or sign in when one exists), confirming the e-mail through the user's Gmail when asked.
 * Leaves the page on the first step of the application form. Never logs the password.
 */
export async function workdayAuth(page, jobUrl, creds, userId) {
  const wait = ms => page.waitForTimeout(ms);
  await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await waitReady(page);
  if ((await openAccountStep(page)) === 'applied') return { ok: false, applied: true, reason: 'You already applied to this job on Workday.' };
  if (await inForm(page)) return { ok: true };
  if (!(await page.locator(A('signInContent')).count())) return { ok: false, reason: "Couldn't find Workday's sign-in step. Apply on the company's site." };

  const since = Math.floor(Date.now() / 1000) - 5;
  const signIn = async () => {
    if (!(await page.locator(A('signInSubmitButton')).count())) await page.locator(A('signInLink')).first().click().catch(() => {});
    await wait(1500);
    await page.fill(A('email'), creds.email); await page.fill(A('password'), creds.password);
    await pressWd(page, 'Sign In');
    await waitReady(page, 15_000); await wait(2500);
    await formAppears(page);
  };

  // 1. create the account
  await page.fill(A('email'), creds.email);
  await page.fill(A('password'), creds.password);
  if (await page.locator(A('verifyPassword')).count()) await page.fill(A('verifyPassword'), creds.password);
  const box = page.locator(A('createAccountCheckbox')).first();
  if (await box.count()) await box.check({ force: true }).catch(() => box.click({ force: true }));
  await pressWd(page, 'Create Account');
  await waitReady(page, 15_000); await wait(3000);
  if (await formAppears(page)) return { ok: true };
  // Workday often sends a freshly created account back to a standalone sign-in page: sign in with it.
  if (await page.locator(`${A('email')}, ${A('password')}`).count() && !(await page.locator(A('verifyPassword')).count())) {
    await signIn();
    if (await formAppears(page, 15_000)) return { ok: true };
    // The standalone page signs in but may land on the job posting: walk Apply → Apply Manually again.
    await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }); await waitReady(page);
    if ((await openAccountStep(page)) === 'applied') return { ok: false, applied: true, reason: 'You already applied to this job on Workday.' };
    if (await formAppears(page)) return { ok: true };
  }

  const body = async () => (await page.locator('body').innerText().catch(() => '')).toLowerCase();
  // 2. account already exists → sign in
  // Only Workday's own error banner counts: the page itself always says "Already have an account? Sign In".
  const alerts = (await page.locator(`${A('errorMessage')}, ${SEL.error}`).allInnerTexts().catch(() => [])).join(' ').toLowerCase();
  if (/already|exists|in use/.test(alerts)) {
    await signIn();
    return (await inForm(page)) ? { ok: true } : { ok: false, reason: 'Workday would not sign in. The account may use a different password. Reset it on the company site.' };
  }
  // 3. new account that needs its e-mail confirmed → open the link from Gmail, then sign in
  let link = null;
  for (let i = 0; i < 12 && !link; i++) { await wait(5000); link = await readVerifyLink(userId, { afterEpoch: since }).catch(() => null); }
  if (!link) return { ok: false, reason: "Workday asked to confirm the new account's email, but the link never reached your Gmail. Check Gmail is connected, then try again." };
  await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30_000 }); await waitReady(page);
  await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }); await waitReady(page);
  if ((await openAccountStep(page)) === 'applied') return { ok: false, applied: true, reason: 'You already applied to this job on Workday.' };
  if (!(await inForm(page))) await signIn();
  return (await inForm(page)) ? { ok: true } : { ok: false, reason: 'Account created and confirmed, but Workday did not open the application. Try again.' };
}
