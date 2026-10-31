/**
 * Login + route protection check against a running server (creates and then deletes a throwaway account).
 *   node --env-file=.env.local scripts/test-auth.mjs [http://localhost:3100]
 */
import assert from 'node:assert/strict';
import { query, closePool } from '../lib/db.mjs';
import { startReset } from '../lib/auth.mjs';

const BASE = process.argv[2] || 'http://localhost:3000';
const EMAIL = `auth-test-${Date.now()}@example.com`;
const PASS = 'correct horse battery';
const OTHER = '00000000-0000-4000-8000-000000000000';
const req = (path, { method = 'GET', body, cookie, headers = {} } = {}) => fetch(BASE + path, {
  method, redirect: 'manual',
  headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
  body: body ? JSON.stringify(body) : undefined,
});
const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log('  ✓', name); };

try {
  await check('logged out: dashboard redirects to /login with next', async () => {
    const r = await req('/app/'); assert.equal(r.status, 302); assert.match(r.headers.get('location'), /\/login\?next=%2Fapp%2F/);
  });
  await check('logged out: API answers 401', async () => {
    assert.equal((await req(`/v1/users/${OTHER}/profile`)).status, 401);
    assert.equal((await req('/api/jobs')).status, 401);
  });
  await check('logged out: admin portal redirects to login; old /scan-log is gone', async () => {
    assert.equal((await req('/admin')).status, 302);
    assert.notEqual((await req('/scan-log')).status, 200);
  });
  await check('landing page is public; invite requests are validated', async () => {
    const r = await req('/'); assert.equal(r.status, 200); assert.match(await r.text(), /Get rejected less/);
    assert.equal((await req('/auth/request-invite', { method: 'POST', body: { email: 'not-an-email' } })).status, 400);
    assert.equal((await req('/auth/request-invite', { method: 'POST', body: { email: EMAIL, note: 'backend' } })).status, 200);
  });
  await check('login page and logo are public', async () => {
    assert.equal((await req('/login')).status, 200); assert.equal((await req('/brand/rejekt-logo.png')).status, 200);
  });
  await check('sign-up without an invite is refused', async () => {
    const r = await req('/auth/signup', { method: 'POST', body: { email: EMAIL, password: PASS } });
    assert.equal(r.status, 400); assert.match((await r.json()).error, /invited/);
  });

  await query(`INSERT INTO invites (email) VALUES ($1)`, [EMAIL]);
  await check('short password is refused', async () => {
    assert.equal((await req('/auth/signup', { method: 'POST', body: { email: EMAIL, password: 'short' } })).status, 400);
  });
  let cookie, me;
  await check('invited sign-up logs in and goes to the dashboard', async () => {
    const r = await req('/auth/signup', { method: 'POST', body: { email: EMAIL, password: PASS } });
    assert.equal(r.status, 200); cookie = cookieOf(r); assert.match(cookie, /^rj_session=/);
    assert.match(r.headers.get('set-cookie'), /HttpOnly/); assert.match(r.headers.get('set-cookie'), /SameSite=Lax/);
    assert.equal((await r.json()).redirect, process.env.APP_URL || '/app/');
  });
  await check('the invite can only be used once', async () => {
    assert.equal((await req('/auth/signup', { method: 'POST', body: { email: EMAIL, password: PASS } })).status, 400);
  });
  await check('/auth/me returns the account', async () => {
    me = await (await req('/auth/me', { cookie })).json(); assert.equal(me.email, EMAIL); assert.equal(me.is_admin, false);
  });
  await check('dashboard page carries the logged-in user', async () => {
    const r = await req('/app/', { cookie }); assert.equal(r.status, 200);
    assert.ok((await r.text()).includes(`window.RJ_USER = {"id":"${me.id}"`));
  });
  await check('own data: allowed', async () => {
    const s = (await req(`/v1/users/${me.id}/profile`, { cookie })).status; assert.ok(s !== 401 && s !== 403, `got ${s}`);
  });
  await check("someone else's data: 403", async () => {
    assert.equal((await req(`/v1/users/${OTHER}/profile`, { cookie })).status, 403);
    assert.equal((await req(`/v1/users/${OTHER}/applications`, { method: 'POST', cookie, body: {} })).status, 403);
  });
  await check('admin portal and scan controls: admins only', async () => {
    assert.equal((await req('/admin', { cookie })).status, 403);
    assert.equal((await req('/api/scan-status', { cookie })).status, 403);
    assert.equal((await req('/api/scan-control', { method: 'POST', cookie, body: { action: 'start', target: 'scheduled' } })).status, 403);
  });
  await check('cross-site POST is blocked', async () => {
    const r = await req('/auth/logout', { method: 'POST', cookie, headers: { Origin: 'https://evil.example' } }); assert.equal(r.status, 403);
  });
  await check('no allow-any-origin CORS header', async () => {
    assert.equal((await req(`/v1/users/${me.id}/profile`, { cookie })).headers.get('access-control-allow-origin'), null);
  });
  await check('next= only follows same-site paths', async () => {
    const ok = await req('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASS, next: '/app/#/jobs' } });
    assert.match((await ok.json()).redirect, /\/app\/#\/jobs$/);
    const evil = await req('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASS, next: '//evil.example' } });
    assert.equal((await evil.json()).redirect, process.env.APP_URL || '/app/');
  });
  await check('logged in: the landing page sends you to the dashboard', async () => {
    const r = await req('/', { cookie }); assert.equal(r.status, 302); assert.equal(r.headers.get('location'), process.env.APP_URL || '/app/');
  });
  await check('logged in: /login goes straight to the dashboard', async () => {
    const r = await req('/login', { cookie }); assert.equal(r.status, 302); assert.equal(r.headers.get('location'), process.env.APP_URL || '/app/');
  });
  await check('wrong password: 401, same message as unknown email', async () => {
    const a = await req('/auth/login', { method: 'POST', body: { email: EMAIL, password: 'wrong password!' } });
    const b = await req('/auth/login', { method: 'POST', body: { email: 'nobody@example.com', password: 'wrong password!' } });
    assert.equal(a.status, 401); assert.equal((await a.json()).error, (await b.json()).error);
  });
  await check('log out ends the session', async () => {
    assert.equal((await req('/auth/logout', { method: 'POST', cookie })).status, 200);
    assert.equal((await req('/auth/me', { cookie })).status, 401);
  });
  await check('password reset: link works once, old sessions end', async () => {
    const login = await req('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASS } }); const c2 = cookieOf(login);
    let link; const log = console.log; console.log = (m) => { link = String(m).match(/token=(\S+)/)?.[1]; };
    const key = process.env.RESEND_API_KEY; delete process.env.RESEND_API_KEY;
    try { await startReset(EMAIL, BASE); } finally { console.log = log; if (key) process.env.RESEND_API_KEY = key; }
    assert.ok(link, 'reset link printed');
    assert.equal((await req('/auth/reset', { method: 'POST', body: { token: link, password: 'a brand new password' } })).status, 200);
    assert.equal((await req('/auth/reset', { method: 'POST', body: { token: link, password: 'another new password' } })).status, 400);
    assert.equal((await req('/auth/me', { cookie: c2 })).status, 401);
    assert.equal((await req('/auth/login', { method: 'POST', body: { email: EMAIL, password: 'a brand new password' } })).status, 200);
  });
  console.log(`\nall ${passed} checks passed`);
} finally {
  await query(`DELETE FROM users WHERE email = $1`, [EMAIL]);
  await query(`DELETE FROM invites WHERE email = $1`, [EMAIL]);
  await query(`DELETE FROM invite_requests WHERE email = $1`, [EMAIL]);
  await closePool();
}
