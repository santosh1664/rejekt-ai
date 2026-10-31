/**
 * lib/admin.mjs — the admin portal's API (/admin/api/*), mounted by server.mjs behind the admin check.
 * Every change an admin makes is written to admin_audit. Page: public/admin.html.
 *
 * The rule for "fix anything a user hits": an admin can open the dashboard as that user (Open as user,
 * 1-hour session, bannered, audited, never another admin), and for everything else there's a direct action here.
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, batchTouchCompanies } from './db.mjs';
import * as auth from './auth.mjs';
import { getScanStatus } from './scan-status.mjs';
import { llmConfig } from './llm.mjs';
import { isGmailConfigured } from './gmail.mjs';
import { skipApplication, saveSettings, reapStuckApplications } from '../autoapply/engine.mjs';
import { processCompany } from '../scanner/worker.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const UUID = /^[0-9a-f-]{36}$/i;
export const router = express.Router();
router.use(express.json({ limit: '50kb' }));

const audit = (req, action, target, detail = null) => query(
  `INSERT INTO admin_audit (admin_id, admin_email, action, target, detail) VALUES ($1, $2, $3, $4, $5)`,
  [req.user.id, req.user.email, action, target == null ? null : String(target), detail && JSON.stringify(detail)]);
const bad = (res, error, code = 400) => res.status(code).json({ error });
const siteUrl = (req) => process.env.SITE_URL || `${req.protocol}://${req.get('host')}`;
// a stuck application: the server stopped while it was being prepared or sent (same rule as reapStuckApplications)
const STUCK = `((a.source <> 'auto' AND a.apply_state IN ('QUEUED','PREPARED','SUBMITTING') AND a.updated_at < NOW() - INTERVAL '1 minute')
            OR (a.source = 'auto' AND a.apply_state = 'SUBMITTING' AND a.updated_at < NOW() - INTERVAL '15 minutes'))`;

// ─── Overview: health + everything that needs someone ───────────────────────

router.get('/overview', async (req, res) => {
  const [users, states, today, failed, stuck, needsYou, runs, invites, scan] = await Promise.all([
    query(`SELECT count(*)::int total, count(*) FILTER (WHERE last_login_at > NOW() - INTERVAL '7 days')::int active7d,
                  count(*) FILTER (WHERE disabled_at IS NOT NULL)::int disabled FROM users`),
    query(`SELECT COALESCE(apply_state, status) state, count(*)::int n FROM applications GROUP BY 1 ORDER BY 2 DESC`),
    query(`SELECT count(*)::int n FROM applications WHERE submitted_at > NOW() - INTERVAL '24 hours'`),
    query(`SELECT a.id, a.user_id, u.email, a.job_snapshot->>'company' company, a.job_snapshot->>'title' title,
                  a.apply_detail->>'reason' reason, a.updated_at
             FROM applications a LEFT JOIN users u ON u.id = a.user_id
            WHERE a.apply_state = 'FAILED' ORDER BY a.updated_at DESC LIMIT 20`),
    query(`SELECT count(*)::int n FROM applications a WHERE ${STUCK}`),
    query(`SELECT u.email, a.user_id, count(*)::int n FROM applications a LEFT JOIN users u ON u.id = a.user_id
            WHERE a.apply_state = 'NEEDS_YOU' GROUP BY 1, 2 ORDER BY 3 DESC`),
    query(`SELECT id, started_at, finished_at, status, companies_scanned, companies_errored, jobs_new, jobs_closed
             FROM scan_runs ORDER BY started_at DESC LIMIT 5`),
    query(`SELECT count(*)::int n FROM invites WHERE used_at IS NULL`),
    getScanStatus().catch(e => ({ error: e.message })),
  ]);

  const attention = [];
  if (stuck.rows[0].n) attention.push({ level: 'bad', text: `${stuck.rows[0].n} application(s) stuck mid-send`, fix: 'release-stuck', fixLabel: 'Release them' });
  if (failed.rows.length) attention.push({ level: 'bad', text: `${failed.rows.length} failed application(s)`, link: '#/applications?state=FAILED', fixLabel: 'Review' });
  for (const r of needsYou.rows) attention.push({ level: 'warn', text: `${r.email || r.user_id} has ${r.n} application(s) waiting on them (Needs you)`, link: `#/users/${r.user_id}`, fixLabel: 'Open user' });
  const last = runs.rows[0];
  if (last?.status === 'failed') attention.push({ level: 'bad', text: `Last scan run #${last.id} failed`, link: '#/scans', fixLabel: 'Scans' });
  if (scan.schedule?.overdue) attention.push({ level: 'bad', text: 'The scheduled scan is overdue', fix: 'scan-all', fixLabel: 'Scan all now' });
  // Did the last completed run reach each platform? ("scanned in the last 4 h" sinks to 0 between runs by design)
  const done = runs.rows.find(r => r.status === 'completed');
  if (done && !(scan.processes || []).length) {
    const { rows: cover } = await query(`
      SELECT ats, count(*)::int total, count(*) FILTER (WHERE last_scan >= $1)::int reached
        FROM companies WHERE active GROUP BY ats`, [done.started_at]);
    const behind = cover.map(c => ({ ...c, pct: Math.round(100 * c.reached / c.total) })).filter(c => c.pct < 90).sort((a, b) => a.pct - b.pct);
    if (behind.length) attention.push({ level: 'warn', link: '#/scans', fixLabel: 'Scans',
      text: `Last run (#${done.id}) didn't reach every company: ${behind.map(c => `${c.ats} ${c.pct}%`).join(', ')}` });
  }

  res.json({
    users: users.rows[0], states: states.rows, submittedToday: today.rows[0].n, failed: failed.rows,
    stuck: stuck.rows[0].n, runs: runs.rows, pendingInvites: invites.rows[0].n,
    jobs: scan.jobs, scanning: (scan.processes || []).length > 0, schedule: scan.schedule, attention,
  });
});

router.post('/overview/action', async (req, res) => {
  if (req.body?.action === 'release-stuck') {
    const n = await reapStuckApplications();
    await audit(req, 'release-stuck', null, { released: n });
    return res.json({ message: `Released ${n} stuck application(s); they show as failed with "Try again".` });
  }
  bad(res, 'Unknown action');
});

// ─── Users ───────────────────────────────────────────────────────────────────

const USER_ROW = `
  SELECT u.id, u.email, u.is_admin, u.created_at, u.last_login_at, u.disabled_at,
         p.full_name, p.current_title, COALESCE(s.enabled, FALSE) auto_apply,
         (g.user_id IS NOT NULL) gmail, g.gmail_email,
         (SELECT count(*)::int FROM sessions x WHERE x.user_id = u.id AND x.expires_at > NOW() AND x.impersonator_id IS NULL) sessions,
         (SELECT count(*)::int FROM applications a WHERE a.user_id = u.id) apps,
         (SELECT count(*)::int FROM applications a WHERE a.user_id = u.id AND a.apply_state = 'NEEDS_YOU') needs_you,
         (SELECT count(*)::int FROM applications a WHERE a.user_id = u.id AND a.apply_state = 'FAILED') failed,
         (SELECT count(*)::int FROM applications a WHERE a.user_id = u.id AND a.submitted_at IS NOT NULL) submitted
    FROM users u
    LEFT JOIN user_profiles p ON p.user_id = u.id
    LEFT JOIN auto_apply_settings s ON s.user_id = u.id
    LEFT JOIN user_gmail_tokens g ON g.user_id = u.id`;

router.get('/users', async (req, res) => {
  const q = `%${String(req.query.q || '').trim().toLowerCase()}%`;
  const { rows } = await query(`${USER_ROW} WHERE u.email LIKE $1 OR lower(COALESCE(p.full_name, '')) LIKE $1
                                 ORDER BY u.last_login_at DESC NULLS LAST, u.created_at DESC LIMIT 200`, [q]);
  res.json(rows);
});

router.get('/users/:id', async (req, res) => {
  if (!UUID.test(req.params.id)) return bad(res, 'Not found', 404);
  const id = req.params.id;
  const { rows: [user] } = await query(`${USER_ROW} WHERE u.id = $1`, [id]);
  if (!user) return bad(res, 'Not found', 404);
  const [profile, resumes, lanes, settings, apps, history] = await Promise.all([
    // never the stored ATS password: only whether one is set
    query(`SELECT full_name, email, phone, current_title, total_experience_years, current_city, current_state, current_country,
                  work_authorization, needs_sponsorship, open_to_work, (ats_password IS NOT NULL) has_ats_password, updated_at
             FROM user_profiles WHERE user_id = $1`, [id]),
    query(`SELECT id, name, is_default, updated_at FROM resume_profiles WHERE user_id = $1 ORDER BY updated_at DESC`, [id]).catch(() => ({ rows: [] })),
    query(`SELECT id, name, enabled FROM auto_apply_lanes WHERE user_id = $1`, [id]).catch(() => ({ rows: [] })),
    query(`SELECT * FROM auto_apply_settings WHERE user_id = $1`, [id]),
    query(`SELECT a.id, a.status, a.apply_state, a.source, a.attempts, a.updated_at, a.submitted_at,
                  a.job_snapshot->>'company' company, a.job_snapshot->>'title' title, a.apply_detail->>'reason' reason
             FROM applications a WHERE a.user_id = $1 ORDER BY a.updated_at DESC LIMIT 200`, [id]),
    query(`SELECT created_at, admin_email, action, detail FROM admin_audit WHERE target = $1 ORDER BY created_at DESC LIMIT 30`, [id]),
  ]);
  res.json({ user, profile: profile.rows[0] || null, resumes: resumes.rows, lanes: lanes.rows,
             settings: settings.rows[0] || null, applications: apps.rows, history: history.rows });
});

router.post('/users/:id/action', async (req, res) => {
  const id = req.params.id, action = req.body?.action;
  if (!UUID.test(id)) return bad(res, 'Not found', 404);
  const { rows: [target] } = await query(`SELECT id, email, is_admin, disabled_at FROM users WHERE id = $1`, [id]);
  if (!target) return bad(res, 'Not found', 404);
  const self = id === req.user.id;
  const done = async (message, extra = {}) => { await audit(req, action, id, { email: target.email, ...extra.audit }); res.json({ message, ...extra.body }); };

  switch (action) {
    case 'reset-link': {
      const link = await auth.resetLink(id, siteUrl(req), 24);
      return done('Reset link made. It works once, for 24 hours. Send it to the user.', { body: { link } });
    }
    case 'signout': {
      const { rowCount } = await query(`DELETE FROM sessions WHERE user_id = $1 AND impersonator_id IS NULL`, [id]);
      return done(`Signed out of ${rowCount} session(s).`);
    }
    case 'disable':
      if (self) return bad(res, "You can't disable your own account.");
      await query(`UPDATE users SET disabled_at = NOW() WHERE id = $1`, [id]);
      await query(`DELETE FROM sessions WHERE user_id = $1`, [id]);
      return done('Account disabled and signed out everywhere.');
    case 'enable':
      await query(`UPDATE users SET disabled_at = NULL WHERE id = $1`, [id]);
      return done('Account enabled.');
    case 'make-admin':
      await query(`UPDATE users SET is_admin = TRUE WHERE id = $1`, [id]);
      return done('Now an admin.');
    case 'remove-admin':
      if (self) return bad(res, "You can't remove your own admin access.");
      await query(`UPDATE users SET is_admin = FALSE WHERE id = $1`, [id]);
      return done('No longer an admin.');
    case 'pause-auto':
      await saveSettings(id, { enabled: false });
      return done('Auto-apply paused for this user.');
    case 'resume-auto':
      await saveSettings(id, { enabled: true });
      return done('Auto-apply turned back on for this user.');
    case 'impersonate': {
      if (target.is_admin) return bad(res, "Other admins can't be opened as a user.");
      if (target.disabled_at) return bad(res, 'Enable the account first.');
      const raw = await auth.createSession(id, { impersonatorId: req.user.id });
      // keep the admin's own session to come back to (server.mjs /auth/return)
      res.setHeader('Set-Cookie', [auth.sessionCookie(auth.readCookie(req), { name: auth.ADMIN_COOKIE }), auth.sessionCookie(raw)]);
      return done(`Opening the dashboard as ${target.email}.`, { body: { redirect: process.env.APP_URL || '/app/' } });
    }
  }
  bad(res, 'Unknown action');
});

// ─── Applications ────────────────────────────────────────────────────────────

router.get('/applications', async (req, res) => {
  const where = [], params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (req.query.state === 'STUCK') where.push(STUCK);
  else if (req.query.state) add(`COALESCE(a.apply_state, a.status) = ?`, req.query.state);
  if (UUID.test(req.query.user || '')) add(`a.user_id = ?`, req.query.user);
  if (req.query.q) { params.push(`%${String(req.query.q).toLowerCase()}%`);
    where.push(`(lower(a.job_snapshot->>'company') LIKE $${params.length} OR lower(a.job_snapshot->>'title') LIKE $${params.length})`); }
  const { rows } = await query(`
    SELECT a.id, a.user_id, u.email, a.status, a.apply_state, a.source, a.attempts, a.updated_at, a.submitted_at,
           a.job_snapshot->>'company' company, a.job_snapshot->>'title' title, a.apply_detail->>'reason' reason
      FROM applications a LEFT JOIN users u ON u.id = a.user_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY a.updated_at DESC LIMIT 300`, params);
  res.json(rows);
});

router.get('/applications/:id', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return bad(res, 'Not found', 404);
  const { rows: [app] } = await query(`
    SELECT a.id, a.user_id, u.email, a.status, a.apply_state, a.source, a.attempts, a.created_at, a.updated_at, a.submitted_at,
           a.application_url, a.notes, a.apply_detail, a.answers, a.job_snapshot - 'description' AS job
      FROM applications a LEFT JOIN users u ON u.id = a.user_id WHERE a.id = $1`, [req.params.id]);
  if (!app) return bad(res, 'Not found', 404);
  const { rows: events } = await query(`SELECT created_at, kind, from_status, to_status, detail FROM application_events
                                         WHERE application_id = $1 ORDER BY created_at DESC LIMIT 100`, [req.params.id]);
  res.json({ ...app, events });
});

router.post('/applications/:id/action', async (req, res) => {
  const { rows: [app] } = await query(`SELECT id, user_id FROM applications WHERE id = $1`, [String(req.params.id).replace(/\D/g, '') || 0]);
  if (!app) return bad(res, 'Not found', 404);
  if (req.body?.action === 'skip') {
    const r = await skipApplication(app.user_id, String(app.id));
    if (r?.error) return bad(res, r.error);
    await audit(req, 'skip-application', app.user_id, { applicationId: app.id });
    return res.json({ message: 'Skipped. It no longer waits on the user.' });
  }
  bad(res, 'Unknown action');
});

// ─── Companies & jobs ────────────────────────────────────────────────────────

router.get('/companies', async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (q.length < 2) return res.json([]);
  const { rows } = await query(`
    SELECT c.id, c.name, c.ats, c.slug, c.active, c.last_scan, c.scan_errors, c.meta,
           (SELECT count(*)::int FROM jobs j WHERE j.company_id = c.id AND j.active) active_jobs
      FROM companies c WHERE lower(c.name) LIKE $1 OR lower(c.slug) LIKE $1
     ORDER BY c.active DESC, c.name LIMIT 50`, [`%${q}%`]);
  res.json(rows);
});

router.post('/companies/:id/action', async (req, res) => {
  const { rows: [c] } = await query(`SELECT id, name, ats, slug, meta, active FROM companies WHERE id = $1`, [+req.params.id || 0]);
  if (!c) return bad(res, 'Not found', 404);
  const action = req.body?.action;
  const done = async (message, detail = {}) => { await audit(req, `company-${action}`, `company:${c.id}`, { name: c.name, ats: c.ats, ...detail }); res.json({ message }); };
  if (action === 'activate')   { await query(`UPDATE companies SET active = TRUE, scan_errors = 0 WHERE id = $1`, [c.id]); return done('Turned on; it is scanned from the next run.'); }
  if (action === 'deactivate') { await query(`UPDATE companies SET active = FALSE WHERE id = $1`, [c.id]); return done('Turned off; it is no longer scanned.'); }
  if (action === 'clear-errors') { await query(`UPDATE companies SET scan_errors = 0 WHERE id = $1`, [c.id]); return done('Error count cleared.'); }
  if (action === 'rescan') {
    if (c.meta?.feed || c.meta?.companyId) return bad(res, 'This Workable company gets its jobs from the Workable feed, which every scan run reads. It can\'t be scanned on its own.');
    const r = await Promise.race([processCompany(c, {}), new Promise(ok => setTimeout(() => ok({ error: 'Took longer than 2 minutes' }), 120_000))]);
    if (r.error) { await audit(req, 'company-rescan', `company:${c.id}`, { name: c.name, error: r.error }); return bad(res, `Scan failed: ${r.error}`); }
    await batchTouchCompanies([c.id], []);
    return done(`Scanned: ${r.fetched} jobs on the board, ${r.newJobs} new or changed, ${r.unchanged ?? 0} unchanged.`, { fetched: r.fetched, newJobs: r.newJobs });
  }
  bad(res, 'Unknown action');
});

router.get('/jobs/find', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);
  const { rows } = await query(`
    SELECT j.id, j.title, j.company, j.location, j.url, j.ats, j.active, j.closed_at, j.last_seen, j.missed_scans, j.discovered, j.company_id
      FROM jobs j WHERE ${/^\d+$/.test(q) ? 'j.id = $1::bigint' : 'j.url = $1'} LIMIT 5`, [q]);
  res.json(rows);
});

router.post('/jobs/:id/action', async (req, res) => {
  const id = +req.params.id || 0, action = req.body?.action;
  const sql = { close: `UPDATE jobs SET active = FALSE, closed_at = NOW() WHERE id = $1`,
                reopen: `UPDATE jobs SET active = TRUE, closed_at = NULL, missed_scans = 0, last_seen = NOW() WHERE id = $1` }[action];
  if (!sql) return bad(res, 'Unknown action');
  const { rowCount } = await query(sql, [id]);
  if (!rowCount) return bad(res, 'Not found', 404);
  await audit(req, `job-${action}`, `job:${id}`);
  res.json({ message: action === 'close' ? 'Job closed; it no longer shows to users.' : 'Job reopened; it shows to users again.' });
});

// ─── Invites ─────────────────────────────────────────────────────────────────

router.get('/invites', async (req, res) => {
  const [invites, requests] = await Promise.all([
    query(`SELECT i.*, u.email AS linked_email FROM invites i LEFT JOIN users u ON u.id = i.user_id ORDER BY i.created_at DESC LIMIT 300`),
    query(`SELECT email, note, created_at FROM invite_requests WHERE handled_at IS NULL ORDER BY created_at DESC LIMIT 300`),
  ]);
  res.json({ invites: invites.rows, requests: requests.rows });
});

// "Request an invite" from the landing page: inviting handles it; Dismiss hides it
router.post('/invite-requests/:email/dismiss', async (req, res) => {
  const { rowCount } = await query(`UPDATE invite_requests SET handled_at = NOW() WHERE email = $1 AND handled_at IS NULL`, [auth.normEmail(req.params.email)]);
  if (!rowCount) return bad(res, 'No open request for that email.', 404);
  await audit(req, 'dismiss-invite-request', auth.normEmail(req.params.email));
  res.json({ message: 'Request dismissed.' });
});

router.post('/invites', async (req, res) => {
  const email = auth.normEmail(req.body?.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad(res, 'Enter a valid email.');
  const userId = req.body?.user_id || null;
  if (userId && !UUID.test(userId)) return bad(res, 'The user ID should look like 8206aab9-6217-…');
  const { rows: [exists] } = await query(`SELECT 1 FROM users WHERE email = $1`, [email]);
  if (exists) return bad(res, 'That email already has an account.');
  await query(`INSERT INTO invites (email, user_id, is_admin) VALUES ($1, $2, $3)
               ON CONFLICT (email) DO UPDATE SET user_id = EXCLUDED.user_id, is_admin = EXCLUDED.is_admin, used_at = NULL`,
    [email, userId, !!req.body?.is_admin]);
  await query(`UPDATE invite_requests SET handled_at = NOW() WHERE email = $1`, [email]);
  await audit(req, 'invite', email, { is_admin: !!req.body?.is_admin, user_id: userId });
  res.json({ message: `Invited. They can sign up at ${siteUrl(req)}/signup with ${email}.` });
});

router.delete('/invites/:email', async (req, res) => {
  const { rowCount } = await query(`DELETE FROM invites WHERE email = $1 AND used_at IS NULL`, [auth.normEmail(req.params.email)]);
  if (!rowCount) return bad(res, 'No unused invite for that email.', 404);
  await audit(req, 'revoke-invite', auth.normEmail(req.params.email));
  res.json({ message: 'Invite revoked.' });
});

// ─── System + audit ──────────────────────────────────────────────────────────

router.get('/system', async (req, res) => {
  const t = Date.now();
  const db = await query(`SELECT pg_size_pretty(pg_database_size(current_database())) size, version() version`)
    .then(r => ({ ok: true, ms: Date.now() - t, ...r.rows[0] })).catch(e => ({ ok: false, error: e.message }));
  const llm = llmConfig();
  // the last error-looking lines of the server log
  let errors = [];
  try {
    const lines = fs.readFileSync(path.join(ROOT, 'logs', 'server.log'), 'utf8').split('\n').slice(-3000);
    errors = lines.filter(l => /error|exception|failed|✗|💥/i.test(l) && !/ETIMEDOUT/.test(l)).slice(-40);
  } catch {}
  res.json({
    node: process.version, uptimeMin: Math.round(process.uptime() / 60), db,
    llm: { provider: llm.provider, model: llm.model, keySet: llm.provider === 'ollama' || !!llm.apiKey },
    email: { resend: !!process.env.RESEND_API_KEY, from: process.env.RESEND_FROM || null },
    gmailOAuth: isGmailConfigured(),
    urls: { app: process.env.APP_URL || '/app/', site: process.env.SITE_URL || null, cookieDomain: process.env.COOKIE_DOMAIN || null },
    errors,
  });
});

router.get('/audit', async (req, res) => {
  const { rows } = await query(`SELECT created_at, admin_email, action, target, detail FROM admin_audit ORDER BY created_at DESC LIMIT 300`);
  res.json(rows);
});
