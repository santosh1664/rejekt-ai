/**
 * lib/auth.mjs — email + password accounts, cookie sessions, password reset. No dependencies:
 * scrypt and random tokens come from node:crypto. Tables: db/migrate-auth.mjs.
 *
 * Env:
 *   APP_URL        where a logged-in user lands, e.g. https://dashboard.rejekt.ai   (default /app/)
 *   SITE_URL       the login site, e.g. https://rejekt.ai                           (default: same host)
 *   COOKIE_DOMAIN  e.g. .rejekt.ai so the session works on both hosts               (default: host-only)
 *   RESEND_API_KEY, RESEND_FROM   password-reset email (without a key the link is printed to the server log)
 */
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { query } from './db.mjs';

const scrypt = promisify(crypto.scrypt);
export const COOKIE = 'rj_session';
const SESSION_DAYS = 30;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');
export const normEmail = (e) => String(e || '').trim().toLowerCase();

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = await scrypt(password, salt, 64, { N: 16384 });
  return `scrypt$16384$${salt}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  const [kind, N, salt, hash] = String(stored).split('$');
  if (kind !== 'scrypt' || !hash) return false;
  const got = await scrypt(password, salt, 64, { N: +N });
  const want = Buffer.from(hash, 'base64url');
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

export function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < 10) return 'Use at least 10 characters.';
  if (password.length > 200) return 'That password is too long.';
  return null;
}

// ─── Sessions ────────────────────────────────────────────────────────────────

/** impersonatorId: an admin's "Open as user" session (1 hour, doesn't count as the user logging in) */
export async function createSession(userId, { impersonatorId = null } = {}) {
  const raw = token();
  await query(`INSERT INTO sessions (token_hash, user_id, expires_at, impersonator_id)
               VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 hour'), $4)`,
    [sha256(raw), userId, impersonatorId ? 1 : SESSION_DAYS * 24, impersonatorId]);
  if (!impersonatorId) await query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [userId]);
  return raw;
}

export async function userFromToken(raw) {
  if (!raw) return null;
  const { rows } = await query(`
    SELECT u.id, u.email, u.is_admin, s.impersonator_id, a.email AS impersonator_email
      FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN users a ON a.id = s.impersonator_id
     WHERE s.token_hash = $1 AND s.expires_at > NOW() AND u.disabled_at IS NULL`, [sha256(raw)]);
  return rows[0] || null;
}

export const endSession = (raw) => raw ? query(`DELETE FROM sessions WHERE token_hash = $1`, [sha256(raw)]) : null;

export function readCookie(req, name = COOKIE) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export const ADMIN_COOKIE = 'rj_admin';   // the admin's own session, kept while they "Open as user"

export function sessionCookie(value, { clear = false, name = COOKIE } = {}) {
  const domain = process.env.COOKIE_DOMAIN;
  return [
    `${name}=${clear ? '' : encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
    clear ? 'Max-Age=0' : `Max-Age=${SESSION_DAYS * 86400}`,
    domain && `Domain=${domain}`,
    (domain || process.env.COOKIE_SECURE === '1') && 'Secure',   // production runs on https; localhost doesn't
  ].filter(Boolean).join('; ');
}

// ─── Accounts ────────────────────────────────────────────────────────────────

/** Invite-only: the email must have an unused invite. The account takes the invite's user_id if it has one. */
export async function signUp(email, password) {
  email = normEmail(email);
  const problem = passwordProblem(password);
  if (problem) return { error: problem };
  const { rows: [invite] } = await query(`SELECT * FROM invites WHERE email = $1 AND used_at IS NULL`, [email]);
  if (!invite) return { error: "This email isn't invited yet." };
  const { rows: [taken] } = await query(`SELECT 1 FROM users WHERE email = $1`, [email]);
  if (taken) return { error: 'An account with this email already exists. Log in instead.' };
  const { rows: [user] } = await query(`
    INSERT INTO users (id, email, password_hash, is_admin) VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4)
    RETURNING id, email, is_admin`, [invite.user_id, email, await hashPassword(password), invite.is_admin]);
  await query(`UPDATE invites SET used_at = NOW() WHERE email = $1`, [email]);
  return { user };
}

export async function logIn(email, password) {
  const { rows: [u] } = await query(`SELECT id, email, is_admin, password_hash, disabled_at FROM users WHERE email = $1`, [normEmail(email)]);
  // same work and the same answer whether or not the email exists
  const ok = await verifyPassword(String(password || ''), u?.password_hash || 'scrypt$16384$x$' + 'A'.repeat(86));
  if (ok && u?.disabled_at) return { error: 'This account is disabled. Contact support.' };
  return ok && u ? { user: { id: u.id, email: u.email, is_admin: u.is_admin } } : { error: 'Wrong email or password.' };
}

// ─── Password reset ──────────────────────────────────────────────────────────

/** A one-time reset link (1 hour by default; an admin can make a longer one to send by hand) */
export async function resetLink(userId, siteUrl, hours = 1) {
  const raw = token();
  await query(`INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 hour'))`, [sha256(raw), userId, hours]);
  return `${siteUrl}/reset?token=${raw}`;
}

export async function startReset(email, siteUrl) {
  const { rows: [u] } = await query(`SELECT id, email FROM users WHERE email = $1`, [normEmail(email)]);
  if (!u) return;                      // the page says the same thing either way
  const link = await resetLink(u.id, siteUrl);
  await sendEmail({ to: u.email, subject: 'Reset your Rejekt.ai password', log: `password reset link: ${link}`,
    text: `Someone asked to reset the password for this account.\n\nSet a new one here (the link works for 1 hour):\n${link}\n\nIf it wasn't you, ignore this email.` });
}

/** "You're invited": a sign-up link with the email filled in */
export function sendInvite(email, siteUrl) {
  const link = `${siteUrl}/signup?email=${encodeURIComponent(email)}`;
  return sendEmail({ to: email, subject: "You're invited to Rejekt.ai", log: `invite link: ${link}`,
    text: `You're invited to Rejekt.ai.\n\nRejekt.ai finds fresh jobs that fit you, tailors your resume for each one, and can apply for you on the rules you set.\n\nCreate your account here, using this email address (${email}):\n${link}\n\nIf you weren't expecting this, you can ignore this email.` });
}

/** Transactional email through Resend. Without RESEND_API_KEY it only logs (log: what to print instead). */
export async function sendEmail({ to, subject, text, log }) {
  // reserved test domains (the test suites' throwaway accounts) never really get mail: bounces hurt the sender domain
  if (/@(example\.(com|org|net)|[^@]+\.(test|example|invalid|localhost))$/i.test(to)) { console.log(`[auth] test address, not emailed to ${to}: ${log || subject}`); return { ok: true, test: true }; }
  if (!process.env.RESEND_API_KEY) { console.log(`[auth] no RESEND_API_KEY, not emailed to ${to}: ${log || subject}`); return { ok: false, error: 'Email is not set up (RESEND_API_KEY)' }; }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    // replies go to the support inbox (support@rejekt.ai, a Zoho alias), not to the no-reply sender
    body: JSON.stringify({ from: process.env.RESEND_FROM || 'Rejekt.ai <no-reply@rejekt.ai>', to, subject, text,
      reply_to: process.env.SUPPORT_EMAIL || 'support@rejekt.ai' }),
  });
  if (res.ok) return { ok: true };
  const error = `${res.status} ${(await res.text()).slice(0, 200)}`;
  console.error(`[auth] email to ${to} failed: ${error}`);
  return { ok: false, error };
}

export async function finishReset(raw, password) {
  const problem = passwordProblem(password);
  if (problem) return { error: problem };
  const { rows: [r] } = await query(`
    UPDATE password_resets SET used_at = NOW()
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW() RETURNING user_id`, [sha256(String(raw || ''))]);
  if (!r) return { error: 'This reset link has expired or was already used. Ask for a new one.' };
  await query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [await hashPassword(password), r.user_id]);
  await query(`DELETE FROM sessions WHERE user_id = $1`, [r.user_id]);   // log out everywhere
  return { ok: true };
}

// ─── Brute force ─────────────────────────────────────────────────────────────
// ponytail: in-memory, per server process; move to Postgres/Redis if there's ever more than one server
const attempts = new Map();   // key → [timestamps]
export function tooManyAttempts(key, max = 10, windowMs = 15 * 60_000) {
  const now = Date.now();
  const list = (attempts.get(key) || []).filter(t => now - t < windowMs);
  list.push(now);
  attempts.set(key, list);
  return list.length > max;
}
