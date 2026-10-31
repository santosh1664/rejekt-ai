/**
 * lib/gmail.mjs  —  Gmail OAuth 2.0 + OTP reader
 *
 * Env vars:
 *   GOOGLE_CLIENT_ID       – OAuth 2.0 client ID
 *   GOOGLE_CLIENT_SECRET   – OAuth 2.0 client secret
 *   GOOGLE_REDIRECT_URI    – e.g. http://localhost:3000/v1/auth/gmail/callback
 *   TOKEN_ENCRYPTION_KEY   – 64 hex chars (32 bytes) for AES-256-GCM token encryption
 *                            Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * Security model:
 *   - access_token and refresh_token are encrypted with AES-256-GCM before storage
 *   - OAuth state is a random nonce stored in oauth_state table (not userId in URL)
 *   - Refresh tokens are never sent to the frontend
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { query } from './db.mjs';

const SCOPES        = 'https://www.googleapis.com/auth/gmail.readonly';
const TOKEN_URL     = 'https://oauth2.googleapis.com/token';
const GMAIL_BASE    = 'https://gmail.googleapis.com/gmail/v1/users/me';
const ALGO          = 'aes-256-gcm';
const STATE_TTL_MS  = 10 * 60 * 1000; // 10 minutes

// ─── Config ──────────────────────────────────────────────────────────────────

function cfg() {
  const id       = process.env.GOOGLE_CLIENT_ID;
  const secret   = process.env.GOOGLE_CLIENT_SECRET;
  const redirect = process.env.GOOGLE_REDIRECT_URI;
  if (!id || !secret || !redirect)
    throw new Error('Gmail OAuth not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI missing)');
  return { id, secret, redirect };
}

export function isGmailConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);
}

// ─── Encryption helpers (AES-256-GCM) ────────────────────────────────────────

function getEncKey() {
  const hex = process.env.TOKEN_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64)
    throw new Error('TOKEN_ENCRYPTION_KEY must be 64 hex chars. Generate: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  return Buffer.from(hex, 'hex');
}

function encrypt(plaintext) {
  if (!plaintext) return null;
  const key  = getEncKey();
  const iv   = randomBytes(12);                   // 96-bit IV for GCM
  const cipher = createCipheriv(ALGO, key, iv);
  const enc  = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag  = cipher.getAuthTag();
  // Format: iv(12B) + tag(16B) + ciphertext — all base64
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(blob) {
  if (!blob) return null;
  try {
    const key  = getEncKey();
    const buf  = Buffer.from(blob, 'base64');
    const iv   = buf.subarray(0, 12);
    const tag  = buf.subarray(12, 28);
    const enc  = buf.subarray(28);
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return null; // tampered or wrong key
  }
}

// ─── OAuth state nonce (single-use, 10-min TTL) ───────────────────────────────

export async function createOAuthState(userId) {
  const state = randomBytes(32).toString('hex');
  await query(
    `INSERT INTO oauth_state (state, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '10 minutes')`,
    [state, userId],
  );
  return state;
}

export async function consumeOAuthState(state) {
  const { rows } = await query(
    `DELETE FROM oauth_state WHERE state = $1 AND expires_at > NOW() RETURNING user_id`,
    [state],
  );
  return rows[0]?.user_id || null; // null = invalid / expired / already used
}

// ─── OAuth flow ───────────────────────────────────────────────────────────────

/** Returns the Google auth URL. State is a secure random nonce (not userId). */
export async function getAuthUrl(userId) {
  const { id, redirect } = cfg();
  const state = await createOAuthState(userId);
  const p = new URLSearchParams({
    client_id: id, redirect_uri: redirect,
    response_type: 'code', scope: SCOPES,
    access_type: 'offline', prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

/** Exchange auth code for tokens and store encrypted. Returns { email }. */
export async function exchangeCode(state, code, expectedUserId) {
  // Validate state nonce and get userId; it must be the logged-in user's own nonce
  const userId = await consumeOAuthState(state);
  if (!userId || userId !== expectedUserId) throw new Error('Invalid or expired OAuth state — please try connecting Gmail again');

  const { id, secret, redirect } = cfg();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: id, client_secret: secret, redirect_uri: redirect, grant_type: 'authorization_code' }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Google token exchange failed ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const expiry = data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null;

  // Fetch Gmail address
  const profRes = await fetch(`${GMAIL_BASE}/profile`, { headers: { Authorization: `Bearer ${data.access_token}` } });
  const prof = profRes.ok ? await profRes.json() : {};

  // Encrypt tokens before storing
  const encAccess  = encrypt(data.access_token);
  const encRefresh = data.refresh_token ? encrypt(data.refresh_token) : null;

  await query(
    `INSERT INTO user_gmail_tokens (user_id, access_token, refresh_token, expiry, gmail_email, connected_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,NOW(),NOW())
     ON CONFLICT (user_id) DO UPDATE
       SET access_token  = $2,
           refresh_token = COALESCE($3, user_gmail_tokens.refresh_token),
           expiry        = $4,
           gmail_email   = $5,
           updated_at    = NOW()`,
    [userId, encAccess, encRefresh, expiry, prof.emailAddress || null],
  );
  return { email: prof.emailAddress || null };
}

export async function getTokenRow(userId) {
  const { rows } = await query(`SELECT * FROM user_gmail_tokens WHERE user_id = $1`, [userId]);
  return rows[0] || null;
}

export async function getGmailStatus(userId) {
  const row = await getTokenRow(userId);
  if (!row) return { connected: false };
  return { connected: true, email: row.gmail_email, connectedAt: row.connected_at };
}

export async function disconnectGmail(userId) {
  await query(`DELETE FROM user_gmail_tokens WHERE user_id = $1`, [userId]);
}

/** Returns a fresh plaintext access_token, refreshing if needed. */
export async function getFreshToken(userId) {
  const row = await getTokenRow(userId);
  if (!row) throw new Error('Gmail not connected for this user');

  const needsRefresh = !row.expiry || new Date(row.expiry) < new Date(Date.now() + 60_000);
  const plainAccess  = decrypt(row.access_token);

  if (!needsRefresh && plainAccess) return plainAccess;

  const plainRefresh = decrypt(row.refresh_token);
  if (!plainRefresh) throw new Error('No refresh token — user must reconnect Gmail');

  const { id, secret } = cfg();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: plainRefresh, client_id: id, client_secret: secret }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Token refresh failed ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const expiry = data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null;
  const encAccess = encrypt(data.access_token);

  await query(
    `UPDATE user_gmail_tokens SET access_token=$2, expiry=$3, updated_at=NOW() WHERE user_id=$1`,
    [userId, encAccess, expiry],
  );
  return data.access_token;
}

// ─── OTP reading ──────────────────────────────────────────────────────────────

const OTP_RE = /\b(?:code|otp|pin|passcode|verification|one.?time)[:\s–\-]*([A-Z0-9]{4,8})\b|\b([0-9]{6})\b/gi;

function extractOTP(text) {
  OTP_RE.lastIndex = 0;
  let m;
  while ((m = OTP_RE.exec(text)) !== null) {
    const code = (m[1] || m[2] || '').trim();
    if (code.length >= 4) return code;
  }
  return null;
}

function b64dec(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

function extractPlainText(part) {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) return b64dec(part.body.data);
  if (part.parts) {
    for (const p of part.parts) {
      const t = extractPlainText(p);
      if (t) return t;
    }
  }
  return '';
}

export async function readLatestOTP(userId, { from, subjectContains, afterEpoch, maxAgeMinutes = 10 } = {}) {
  const token   = await getFreshToken(userId);
  const minTime = afterEpoch || Math.floor((Date.now() - maxAgeMinutes * 60_000) / 1000);
  const parts   = [`after:${minTime}`];
  if (from) parts.push(`from:${from}`);
  else parts.push(`(from:noreply OR from:no-reply OR from:verify OR from:donotreply OR subject:verify OR subject:otp OR subject:"your code" OR subject:verification)`);
  if (subjectContains) parts.push(`subject:${subjectContains}`);
  const q = parts.join(' ');

  const listRes = await fetch(`${GMAIL_BASE}/messages?${new URLSearchParams({ q, maxResults: '5' })}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!listRes.ok) throw new Error(`Gmail list failed ${listRes.status}`);
  const { messages = [] } = await listRes.json();

  for (const { id } of messages.slice(0, 3)) {
    const msgRes = await fetch(`${GMAIL_BASE}/messages/${id}?format=full`, { headers: { Authorization: `Bearer ${token}` } });
    if (!msgRes.ok) continue;
    const msg = await msgRes.json();
    const otp = extractOTP(extractPlainText(msg.payload)) || extractOTP(msg.snippet || '');
    if (otp) return otp;
  }
  return null;
}

export async function waitForOTP(userId, opts = {}) {
  const {
    from, subjectContains,
    after           = new Date(Date.now() - 5 * 60_000),
    maxAgeMinutes   = 10,
    maxWaitMs       = 90_000,
    pollIntervalMs  = 5_000,
  } = opts;
  const deadline   = Date.now() + maxWaitMs;
  const afterEpoch = Math.floor(after.getTime() / 1000);
  while (Date.now() < deadline) {
    const otp = await readLatestOTP(userId, { from, subjectContains, afterEpoch, maxAgeMinutes });
    if (otp) return otp;
    if (Date.now() + pollIntervalMs > deadline) break;
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }
  return null;
}

/** Newest verification/activation link (any HTML or plain part) from mail received after `afterEpoch`; null if none yet. */
export async function readVerifyLink(userId, { afterEpoch, hostPattern = /myworkday/i } = {}) {
  const token = await getFreshToken(userId);
  const q = `after:${afterEpoch} (verify OR activate OR confirm)`;
  const res = await fetch(`${GMAIL_BASE}/messages?${new URLSearchParams({ q, maxResults: '5' })}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Gmail list failed ${res.status}`);
  const text = p => (p.body?.data ? Buffer.from(p.body.data, 'base64url').toString('utf8') : '') + (p.parts || []).map(text).join('\n');
  for (const { id } of (await res.json()).messages || []) {
    const m = await fetch(`${GMAIL_BASE}/messages/${id}?format=full`, { headers: { Authorization: `Bearer ${token}` } });
    if (!m.ok) continue;
    const links = (text((await m.json()).payload).match(/https:\/\/[^\s"'<>)]+/g) || []).map(u => u.replace(/&amp;/g, '&'));
    const hit = links.find(u => hostPattern.test(u) && /verif|activate|confirm/i.test(u));
    if (hit) return hit;
  }
  return null;
}
