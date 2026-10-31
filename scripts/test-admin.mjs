/**
 * Admin portal check against a running server (creates and then deletes throwaway accounts).
 *   node --env-file=.env.local scripts/test-admin.mjs [http://localhost:3100]
 */
import assert from 'node:assert/strict';
import { query, closePool } from '../lib/db.mjs';
import { signUp } from '../lib/auth.mjs';

const BASE = process.argv[2] || 'http://localhost:3000';
const stamp = Date.now(), PASS = 'correct horse battery';
const ADMIN = `admin-test-${stamp}@example.com`, USER = `user-test-${stamp}@example.com`;
const cookiesOf = (res) => Object.fromEntries((res.headers.getSetCookie?.() || []).map(c => c.split(';')[0].split('=')).map(([k, ...v]) => [k, v.join('=')]));
const jar = (o) => Object.entries(o).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ');
async function call(path, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(BASE + path, { method, redirect: 'manual', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.clone().json(); } catch {}
  return { res, status: res.status, data };
}
const login = async (email) => cookiesOf((await call('/auth/login', { method: 'POST', body: { email, password: PASS } })).res);
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log('  ✓', name); };

try {
  for (const [email, admin] of [[ADMIN, true], [USER, false]]) {
    await query(`INSERT INTO invites (email, is_admin) VALUES ($1, $2)`, [email, admin]);
    assert.ok((await signUp(email, PASS)).user);
  }
  const adminC = await login(ADMIN), userC = await login(USER);
  const A = jar(adminC), U = jar(userC);
  const { data: me } = await call('/auth/me', { cookie: U });

  await check('non-admins get 403 on the portal and its API', async () => {
    assert.equal((await call('/admin', { cookie: U })).status, 403);
    assert.equal((await call('/admin/api/overview', { cookie: U })).status, 403);
  });
  await check('logged out: portal redirects to login', async () => assert.equal((await call('/admin')).status, 302));
  await check('admins log in to the portal, and the dashboard sends them there', async () => {
    const l = await call('/auth/login', { method: 'POST', body: { email: ADMIN, password: PASS } });
    assert.match(l.data.redirect, /\/admin$/);
    const u = await call('/auth/login', { method: 'POST', body: { email: USER, password: PASS, next: '/admin' } });
    assert.equal(u.data.redirect, process.env.APP_URL || '/app/');            // users never get sent to the portal
    const d = await call('/app/', { cookie: A }); assert.equal(d.status, 302); assert.match(d.res.headers.get('location'), /\/admin$/);
    const lp = await call('/login', { cookie: A }); assert.match(lp.res.headers.get('location'), /\/admin$/);
  });
  await check('the scan log lives in the portal: status and runs load for admins', async () => {
    assert.equal((await call('/api/scan-status', { cookie: A })).status, 200);
    assert.equal((await call('/api/scan-stats', { cookie: A })).status, 200);
  });
  await check('overview loads with health, states and attention list', async () => {
    const { status, data } = await call('/admin/api/overview', { cookie: A });
    assert.equal(status, 200); for (const k of ['users', 'states', 'attention', 'runs', 'jobs']) assert.ok(k in data, k);
    const { rows: [c] } = await query(`SELECT count(*) FILTER (WHERE NOT is_admin)::int users FROM users`);
    assert.equal(data.users.total, c.users, 'admins are not counted as users');
  });
  await check('users list and user detail (no ATS password exposed)', async () => {
    const list = await call('/admin/api/users?q=' + encodeURIComponent(USER), { cookie: A });
    assert.equal(list.data[0].email, USER);
    const d = await call('/admin/api/users/' + me.id, { cookie: A });
    assert.equal(d.status, 200); assert.ok(!JSON.stringify(d.data).includes('ats_password"'));
  });
  await check('reset link works', async () => {
    const r = await call(`/admin/api/users/${me.id}/action`, { method: 'POST', cookie: A, body: { action: 'reset-link' } });
    assert.match(r.data.link, /\/reset\?token=/);
  });
  await check('pause and resume auto-apply', async () => {
    for (const action of ['pause-auto', 'resume-auto']) assert.equal((await call(`/admin/api/users/${me.id}/action`, { method: 'POST', cookie: A, body: { action } })).status, 200);
    const d = await call('/admin/api/users/' + me.id, { cookie: A }); assert.equal(d.data.user.auto_apply, true);
    await call(`/admin/api/users/${me.id}/action`, { method: 'POST', cookie: A, body: { action: 'pause-auto' } });
  });
  await check('disable blocks login and ends sessions; enable restores', async () => {
    await call(`/admin/api/users/${me.id}/action`, { method: 'POST', cookie: A, body: { action: 'disable' } });
    assert.equal((await call('/auth/me', { cookie: U })).status, 401);
    const l = await call('/auth/login', { method: 'POST', body: { email: USER, password: PASS } });
    assert.equal(l.status, 401); assert.match(l.data.error, /disabled/);
    await call(`/admin/api/users/${me.id}/action`, { method: 'POST', cookie: A, body: { action: 'enable' } });
    assert.equal((await call('/auth/login', { method: 'POST', body: { email: USER, password: PASS } })).status, 200);
  });
  await check("an admin can't disable or demote themself", async () => {
    const { data: a } = await call('/auth/me', { cookie: A });
    assert.equal((await call(`/admin/api/users/${a.id}/action`, { method: 'POST', cookie: A, body: { action: 'disable' } })).status, 400);
    assert.equal((await call(`/admin/api/users/${a.id}/action`, { method: 'POST', cookie: A, body: { action: 'remove-admin' } })).status, 400);
  });
  await check("other admins can't be opened as a user", async () => {
    const { data: a } = await call('/auth/me', { cookie: A });
    assert.equal((await call(`/admin/api/users/${a.id}/action`, { method: 'POST', cookie: A, body: { action: 'impersonate' } })).status, 400);
  });
  await check('Open as user → their dashboard with a banner → Back to admin', async () => {
    const r = await call(`/admin/api/users/${me.id}/action`, { method: 'POST', cookie: A, body: { action: 'impersonate' } });
    assert.equal(r.status, 200); const c = { ...adminC, ...cookiesOf(r.res) }; assert.ok(c.rj_admin && c.rj_session !== adminC.rj_session);
    const as = await call('/auth/me', { cookie: jar(c) });
    assert.equal(as.data.email, USER); assert.equal(as.data.impersonator_email, ADMIN);
    const page = await (await call('/app/', { cookie: jar(c) })).res.text(); assert.ok(page.includes(`"impersonator":"${ADMIN}"`));
    assert.equal((await call('/admin', { cookie: jar(c) })).status, 403);              // no portal while acting as the user
    assert.equal((await call(`/v1/users/${me.id}/profile`, { cookie: jar(c) })).status !== 403, true);
    const back = await call('/auth/return', { method: 'POST', cookie: jar(c) });
    const c2 = { ...c, ...cookiesOf(back.res) };
    assert.match(back.data.redirect, /^\/admin#\/users\//);
    assert.equal((await call('/auth/me', { cookie: jar(c2) })).data.email, ADMIN);
    assert.equal((await call('/auth/me', { cookie: `rj_session=${cookiesOf(r.res).rj_session}` })).status, 401);   // that session is gone
  });
  await check('applications list and filters', async () => {
    for (const s of ['', 'FAILED', 'NEEDS_YOU', 'STUCK']) assert.equal((await call('/admin/api/applications?state=' + s, { cookie: A })).status, 200);
    assert.equal((await call('/admin/api/applications?q=engineer', { cookie: A })).status, 200);
  });
  await check('company search and job lookup', async () => {
    const c = await call('/admin/api/companies?q=stripe', { cookie: A }); assert.equal(c.status, 200); assert.ok(Array.isArray(c.data));
    const { rows: [j] } = await query(`SELECT id FROM jobs WHERE active LIMIT 1`);
    const f = await call('/admin/api/jobs/find?q=' + j.id, { cookie: A }); assert.equal(f.data[0].id, String(j.id));
  });
  await check('landing-page invite requests show in Invites; inviting handles them', async () => {
    const email = `request-test-${stamp}@example.com`;
    await fetch(BASE + '/auth/request-invite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, note: 'data roles' }) });
    let { data } = await call('/admin/api/invites', { cookie: A });
    assert.equal(data.requests.find(r => r.email === email)?.note, 'data roles');
    assert.equal((await call('/admin/api/invites', { method: 'POST', cookie: A, body: { email } })).status, 200);
    ({ data } = await call('/admin/api/invites', { cookie: A }));
    assert.ok(!data.requests.some(r => r.email === email)); assert.ok(data.invites.some(i => i.email === email));
  });
  await check('invite create + revoke', async () => {
    const email = `invite-test-${stamp}@example.com`;
    assert.equal((await call('/admin/api/invites', { method: 'POST', cookie: A, body: { email } })).status, 200);
    assert.equal((await call('/admin/api/invites/' + encodeURIComponent(email), { method: 'DELETE', cookie: A })).status, 200);
    assert.equal((await call('/admin/api/invites', { method: 'POST', cookie: A, body: { email: USER } })).status, 400);   // already has an account
  });
  await check('system page', async () => {
    const s = await call('/admin/api/system', { cookie: A }); assert.equal(s.status, 200); assert.equal(s.data.db.ok, true);
  });
  await check('every action above is in the audit log', async () => {
    const a = (await call('/admin/api/audit', { cookie: A })).data.filter(r => r.admin_email === ADMIN).map(r => r.action);
    for (const x of ['reset-link', 'pause-auto', 'resume-auto', 'disable', 'enable', 'impersonate', 'invite', 'revoke-invite']) assert.ok(a.includes(x), x);
  });
  console.log(`\nall ${passed} checks passed`);
} finally {
  await query(`DELETE FROM admin_audit WHERE admin_email = $1`, [ADMIN]);
  await query(`DELETE FROM auto_apply_settings WHERE user_id IN (SELECT id FROM users WHERE email = ANY($1))`, [[ADMIN, USER]]);
  await query(`DELETE FROM users WHERE email = ANY($1)`, [[ADMIN, USER]]);
  await query(`DELETE FROM invites WHERE email LIKE '%-test-${stamp}@example.com'`);
  await query(`DELETE FROM invite_requests WHERE email LIKE '%-test-${stamp}@example.com'`);
  await closePool();
}
