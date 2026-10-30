/**
 * autoapply/account-create.mjs
 *
 * Detects when an ATS shows a login/sign-up wall instead of the application
 * form, creates or signs into an account using the user's email + ATS password,
 * then reads the OTP from linked Gmail to verify the email.
 *
 * Returns:
 *   { ok: true }          — landed on the application form (or already there)
 *   { ok: false, reason } — couldn't get past the wall
 */

import { waitForOTP, getGmailStatus } from '../lib/gmail.mjs';

/**
 * True when the page looks like a sign-in / create-account wall
 * rather than the actual application form.
 */
export async function isLoginWall(page) {
  // If we can see a file upload or first-name field, we're on the form already
  const hasFormFields = await page.locator('input[type=file], input[name*="first" i], input[placeholder*="first name" i]').count();
  if (hasFormFields) return false;

  // Presence of email+password inputs = login wall
  const hasEmail = await page.locator('input[type=email], input[name*="email" i], input[data-automation-id="email"], input[autocomplete="username"]').count();
  const hasPwd   = await page.locator('input[type=password]').count();
  if (hasEmail && hasPwd) return true;

  // "Sign in" / "Create account" link/button without form fields
  const hasSignIn = await page.locator('a, button').filter({ hasText: /sign[\s-]?in|log[\s-]?in|create account|sign up/i }).count();
  return !!hasSignIn;
}

const SIGN_IN_TEXTS   = /sign[\s-]?in|log[\s-]?in/i;
const CREATE_TEXTS    = /create (an? )?account|sign[\s-]?up|register/i;
const SUBMIT_TEXTS    = /continue|submit|next|sign[\s-]?in|log[\s-]?in|create|register/i;

/**
 * Try to create (or sign in to) an account on the current ATS page.
 *
 * @param {import('playwright-core').Page} page
 * @param {{ email: string, password: string, fullName?: string }} creds
 * @param {string | null} userId  — for OTP reading (may be null if Gmail not linked)
 */
export async function handleLoginWall(page, creds, userId) {
  const { email, password, fullName } = creds;
  const startedAt = new Date();

  // 1. If there's a "Create account" option, prefer it (so we get a fresh account)
  const createLink = page.locator('a, button').filter({ hasText: CREATE_TEXTS }).first();
  if (await createLink.count()) {
    await createLink.click();
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  }

  // 2. Try "Continue with Google" / "Sign in with Google" first (avoids password)
  const googleBtn = page.locator('a, button, [role=button]').filter({
    hasText: /continue with google|sign in with google|sign up with google/i,
  }).first();
  if (await googleBtn.count()) {
    // Clicking Google OAuth from Playwright opens a popup — we can't complete it
    // (Google blocks headless logins). Fall through to email/password flow.
    // Note: mark as NEEDS_YOU so the user can connect the ATS via browser manually.
    // Only skip if we have email+password to try email/password instead.
    if (!creds.password) {
      return { ok: false, reason: 'This site requires "Sign in with Google". Please apply to this job manually once and let the site remember you, then auto-apply will work on future applications.' };
    }
    // Try clicking "Sign in with email" / "Use email" link if present
    const emailLink = page.locator('a, button').filter({ hasText: /use email|sign in with email|continue with email/i }).first();
    if (await emailLink.count()) {
      await emailLink.click();
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }
  }

  // 2b. Fill the sign-in / create form
  const emailInput = page.locator('input[type=email], input[name*="email" i], input[data-automation-id="email"], input[autocomplete="username"]').first();
  const pwdInput   = page.locator('input[type=password]').first();

  if (!(await emailInput.count())) return { ok: false, reason: 'No email field found on login wall' };

  await emailInput.fill(email);

  // Some ATS platforms ask email first, then show password on the next screen
  if (!(await pwdInput.count())) {
    const cont = page.locator('button, input[type=submit]').filter({ hasText: /continue|next/i }).first();
    if (await cont.count()) {
      await cont.click();
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }
  }

  const pwdNow = page.locator('input[type=password]').first();
  if (await pwdNow.count()) await pwdNow.fill(password);

  // Optional: name fields (create account)
  if (fullName) {
    const nameParts = fullName.trim().split(/\s+/);
    const first = nameParts[0];
    const last = nameParts.slice(1).join(' ') || first;
    const firstName = page.locator('input[name*="first" i], input[placeholder*="first" i]').first();
    const lastName  = page.locator('input[name*="last" i], input[placeholder*="last" i]').first();
    if (await firstName.count()) await firstName.fill(first);
    if (await lastName.count()) await lastName.fill(last);
  }

  // 3. Submit
  const submitBtn = page.locator('button[type=submit], input[type=submit], button').filter({ hasText: SUBMIT_TEXTS }).first();
  if (!(await submitBtn.count())) return { ok: false, reason: 'No submit button on login page' };

  await Promise.all([
    page.waitForNavigation({ timeout: 15_000 }).catch(() => {}),
    submitBtn.click(),
  ]);
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

  // 4. OTP / email verification step?
  const needsOTP = await detectOTPField(page);
  if (needsOTP) {
    const otpCode = await resolveOTP(page, userId, email, startedAt);
    if (!otpCode) return { ok: false, reason: 'Email verification required but could not read OTP from Gmail (Gmail not linked or timed out)' };
    await fillOTP(page, otpCode);
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  }

  // 5. Check: are we now on the application form?
  const stillWall = await isLoginWall(page);
  if (stillWall) return { ok: false, reason: 'Still on login wall after sign-in attempt' };
  return { ok: true };
}

async function detectOTPField(page) {
  // Look for OTP/code input: short numeric or masked inputs, or text like "check your email"
  const otpInput = await page.locator('input[autocomplete="one-time-code"], input[inputmode="numeric"][maxlength], input[name*="otp" i], input[name*="code" i], input[placeholder*="code" i], input[placeholder*="otp" i]').count();
  if (otpInput) return true;
  const bodyText = await page.locator('body').innerText().catch(() => '');
  return /check your email|verify your email|we sent (a |an )?code|enter.{0,20}code|one.?time/i.test(bodyText);
}

async function detectOTPFieldNow(page) { return detectOTPField(page); }

async function resolveOTP(page, userId, email, startedAt) {
  if (!userId) return null;
  try {
    const status = await getGmailStatus(userId);
    if (!status.connected) return null;
  } catch { return null; }

  // Wait up to 90 seconds for the OTP email to arrive
  return waitForOTP(userId, { after: startedAt, maxWaitMs: 90_000, pollIntervalMs: 5_000 });
}

async function fillOTP(page, code) {
  // Try a single input first
  const single = page.locator('input[autocomplete="one-time-code"], input[inputmode="numeric"], input[name*="otp" i], input[name*="code" i]').first();
  if (await single.count()) {
    await single.fill(code);
  } else {
    // Segmented inputs (one digit per box)
    const boxes = await page.locator('input[maxlength="1"]').all();
    if (boxes.length >= 4) {
      for (let i = 0; i < Math.min(boxes.length, code.length); i++) {
        await boxes[i].fill(code[i]);
      }
    }
  }
  // Submit
  const submitBtn = page.locator('button[type=submit], button').filter({ hasText: /verify|confirm|continue|submit/i }).first();
  if (await submitBtn.count()) {
    await Promise.all([
      page.waitForNavigation({ timeout: 15_000 }).catch(() => {}),
      submitBtn.click(),
    ]);
  } else {
    await page.keyboard.press('Enter');
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  }
}

/**
 * High-level helper: navigate to formUrl and handle any login wall.
 * Returns { ok, reason? }.
 */
export async function ensureOnForm(page, formUrl, creds, userId) {
  await page.goto(formUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

  // Some boards show a description page with an Apply button
  const applyBtn = page.locator('a, button').filter({ hasText: /^\s*apply( for this job| now)?\s*$/i }).first();
  if (await applyBtn.count() && !(await page.locator('input[type=file]').count())) {
    await applyBtn.click().catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  }

  const wall = await isLoginWall(page);
  if (!wall) return { ok: true };

  if (!creds?.email) {
    return { ok: false, reason: 'Login wall detected but no email configured. Connect your Google account in Settings.' };
  }
  if (!creds?.password) {
    return { ok: false, reason: 'Login wall detected but no ATS password set. Add one in Settings, or the site may require Google Sign-In manually.' };
  }
  return handleLoginWall(page, creds, userId);
}
