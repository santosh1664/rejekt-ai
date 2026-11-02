/**
 * server.mjs
 *
 * Standalone web app for browsing scraped jobs. Serves a small JSON API
 * plus a static frontend — self-contained, no external product dependency.
 *
 * Usage:
 *   npm run web        (http://localhost:3000)
 */
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { query, slowQuery } from './lib/db.mjs';
import { getScanStatus, reapStaleRuns } from './lib/scan-status.mjs';
import { reapStuckApplications } from './autoapply/engine.mjs';
import { startScan, stopScans } from './lib/scan-control.mjs';
import { normalizeSkillName } from './lib/skills.mjs';
import { extractResumeSections } from './lib/resume-extract.mjs';
import { router as apiRouter } from './api/server.mjs';
import { readFileSync } from 'fs';
import * as auth from './lib/auth.mjs';
import { router as adminRouter } from './lib/admin.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();

// ─── Login ───────────────────────────────────────────────────────────────────
// rejekt.ai serves the login pages; after logging in you land on APP_URL (https://dashboard.rejekt.ai in
// production, /app/ locally). The session cookie is set for COOKIE_DOMAIN (.rejekt.ai) so both hosts see it.
const APP_URL  = process.env.APP_URL || '/app/';
const appBase  = /^https?:/.test(APP_URL) ? new URL(APP_URL).origin : '';
const appHost  = appBase && new URL(appBase).host;
const LOGIN    = `${process.env.SITE_URL || ''}/login`;
const siteUrl  = (req) => process.env.SITE_URL || `${req.protocol}://${req.get('host')}`;
// where to go after logging in: admins → the admin portal; users → a same-site path they were headed to, else the dashboard
const ADMIN_URL = `${appBase}/admin`;
const afterLogin = (next, user) => {
  const path = typeof next === 'string' && /^\/(?![/\\])/.test(next) && !/^\/(login|signup)/.test(next) ? next : null;
  if (user?.is_admin) return path?.startsWith('/admin') ? appBase + path : ADMIN_URL;
  return path && !path.startsWith('/admin') ? appBase + path : APP_URL;
};

// Who's asking (null when logged out)
app.use(async (req, res, next) => {
  try { req.user = await auth.userFromToken(auth.readCookie(req)); next(); } catch (e) { next(e); }
});

// A cross-site page can't make a logged-in browser change anything (SameSite=Lax already withholds the cookie)
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !origin) return next();
  const allowed = [req.get('host'), appHost, process.env.SITE_URL && new URL(process.env.SITE_URL).host].filter(Boolean);
  try { if (allowed.includes(new URL(origin).host)) return next(); } catch {}
  res.status(403).json({ error: 'Cross-site request blocked' });
});

const authJson = express.json({ limit: '10kb' });
const ip = (req) => req.ip || req.socket.remoteAddress;
const signedIn = (res, user, next) => auth.createSession(user.id).then(raw => {
  res.setHeader('Set-Cookie', auth.sessionCookie(raw));
  res.json({ redirect: afterLogin(next, user) });
});

app.post('/auth/login', authJson, async (req, res) => {
  const { email, password, next } = req.body || {};
  if (auth.tooManyAttempts(`login:${ip(req)}:${auth.normEmail(email)}`)) return res.status(429).json({ error: 'Too many tries. Wait 15 minutes.' });
  const r = await auth.logIn(email, password);
  return r.error ? res.status(401).json(r) : signedIn(res, r.user, next);
});
app.post('/auth/signup', authJson, async (req, res) => {
  const { email, password, next } = req.body || {};
  if (auth.tooManyAttempts(`signup:${ip(req)}`)) return res.status(429).json({ error: 'Too many tries. Wait 15 minutes.' });
  const r = await auth.signUp(email, password);
  return r.error ? res.status(400).json(r) : signedIn(res, r.user, next);
});
app.post('/auth/logout', async (req, res) => {
  await auth.endSession(auth.readCookie(req));
  await auth.endSession(auth.readCookie(req, auth.ADMIN_COOKIE));   // logging out while "Open as user" ends both
  res.setHeader('Set-Cookie', [auth.sessionCookie('', { clear: true }), auth.sessionCookie('', { clear: true, name: auth.ADMIN_COOKIE })]);
  res.json({ redirect: LOGIN });
});
// Leave "Open as user": end that session and switch back to the admin's own
app.post('/auth/return', async (req, res) => {
  const adminRaw = auth.readCookie(req, auth.ADMIN_COOKIE);
  const admin = await auth.userFromToken(adminRaw);
  if (req.user?.impersonator_id) await auth.endSession(auth.readCookie(req));
  const back = admin?.is_admin;
  res.setHeader('Set-Cookie', [auth.sessionCookie('', { clear: true, name: auth.ADMIN_COOKIE }), auth.sessionCookie(back ? adminRaw : '', { clear: !back })]);
  res.json({ redirect: back ? `/admin#/users/${req.user?.id || ''}` : LOGIN });
});
app.post('/auth/forgot', authJson, async (req, res) => {
  if (auth.tooManyAttempts(`forgot:${ip(req)}`, 5)) return res.status(429).json({ error: 'Too many tries. Wait 15 minutes.' });
  await auth.startReset(req.body?.email, siteUrl(req));
  res.json({ ok: true });   // same answer whether or not the account exists
});
app.post('/auth/reset', authJson, async (req, res) => {
  const r = await auth.finishReset(req.body?.token, req.body?.password);
  res.status(r.error ? 400 : 200).json(r);
});
// Landing page "Request an invite" → admin portal, Invites
app.post('/auth/request-invite', authJson, async (req, res) => {
  if (auth.tooManyAttempts(`invite-request:${ip(req)}`, 5, 60 * 60_000)) return res.status(429).json({ error: 'Too many requests. Try again later.' });
  const email = auth.normEmail(req.body?.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return res.status(400).json({ error: 'Enter a valid email address.' });
  await query(`INSERT INTO invite_requests (email, note) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET note = COALESCE(EXCLUDED.note, invite_requests.note)`,
    [email, String(req.body?.note || '').trim().slice(0, 300) || null]);
  res.json({ ok: true });
});
app.get('/auth/me', (req, res) => req.user ? res.json(req.user) : res.status(401).json({ error: 'Not logged in' }));

// Login pages: one file, the path picks the form. Logged in already → straight to the dashboard.
app.get(['/login', '/signup', '/forgot', '/reset'], (req, res) => {
  if (req.user && ['/login', '/signup'].includes(req.path)) return res.redirect(afterLogin(req.query.next, req.user));
  res.sendFile(join(__dirname, 'public', 'login.html'));
});

// Terms, Privacy Policy, AI disclosure: public, one page (public/legal.html) picks the document by path
app.get(['/terms', '/privacy', '/ai'], (req, res) => res.sendFile(join(__dirname, 'public', 'legal.html')));

// The landing page: logged out on the main site; logged in → your dashboard (admins → the portal)
app.get('/', (req, res, next) => {
  if (appHost && req.get('host') === appHost) return next();          // dashboard.rejekt.ai/ is the dashboard
  if (req.user) return res.redirect(afterLogin(null, req.user));
  res.sendFile(join(__dirname, 'public', 'landing.html'));
});

// Everything else needs a session; scan controls need an admin.
const PUBLIC = /^\/(brand\/|favicon|login\.html$|landing\.html$|legal\.html$)/;
const ADMIN  = /^\/(admin|api\/scan-)/;
app.use((req, res, next) => {
  if (PUBLIC.test(req.path) || req.path === '/v1/health') return next();
  if (!req.user) {
    if (/^\/(v1|api)\//.test(req.path)) return res.status(401).json({ error: 'Log in first' });
    return res.redirect(`${LOGIN}?next=${encodeURIComponent(req.originalUrl)}`);
  }
  if (ADMIN.test(req.path) && !req.user.is_admin) return res.status(403).send('Admins only');
  next();
});

// The dashboard page, with the logged-in user written into it (it used to invent a random id in localStorage)
function sendApp(req, res) {
  if (req.user.is_admin) return res.redirect(ADMIN_URL);   // admins work in the admin portal ("Open as user" to see a user's dashboard)
  const me = JSON.stringify({ id: req.user.id, email: req.user.email, is_admin: req.user.is_admin,
                             impersonator: req.user.impersonator_email || null }).replace(/</g, '\\u003c');
  const html = readFileSync(join(__dirname, 'public', 'app', 'index.html'), 'utf8')
    .replace('<script>', `<script>window.RJ_USER = ${me};</script>\n<script>`);
  res.set('Cache-Control', 'no-store');   // always the current dashboard on reload or back/forward, never a stale copy
  res.type('html').send(html);
}
// dashboard.rejekt.ai/ is the dashboard itself; on the login site / goes to it
app.get('/', (req, res) => (appHost && req.get('host') === appHost ? sendApp(req, res) : res.redirect(APP_URL)));
app.use(express.static(join(__dirname, 'public'), { index: false }));

// Admin portal (admins only, see the gate above)
app.get('/admin', (req, res) => res.sendFile(join(__dirname, 'public', 'admin.html')));
app.use('/admin/api', adminRouter);

// Dashboard (public/app) talks to the REST API (api/server.mjs) on the same
// origin under /v1 — e.g. GET /v1/users/:id/recommendations. Express strips
// the /v1 prefix before handing the request to the API's own router.
app.use('/v1', (req, res) => { apiRouter(req, res); });
app.get(['/app', '/app/{*rest}'], (req, res, next) => {
  if (/\.[a-z0-9]+$/i.test(req.path)) return next(); // real files fall through to static
  sendApp(req, res);
});

// ─── Seniority bucket mapping ───────────────────────────────────────────────
// The frontend's Experience filter checkboxes still send the same 7 bucket
// values (careerLevels=SENIOR,LEAD,...) — unchanged. What changed is what
// each bucket matches against: the legacy `career_level` column is
// authoritative for nothing anymore (see lib/seniority.mjs); this expands
// each UI bucket into the new, more granular `seniority_level` values it
// should include. Buckets are kept 1:1 with the UI's existing
// checkboxes/labels so filter behavior doesn't regress — e.g. the UI's
// separate "Lead / Principal" and "Manager / Director" options stay distinct
// rather than merging into one broader tier. public/index.html mirrors this
// exact mapping as SENIORITY_TO_BUCKET for job-card display and profile-match
// scoring (see computeProfileMatch), since it renders/scores off
// job.seniority_level directly and needs the same bucket collapse.
const CAREER_LEVEL_TO_SENIORITY = {
  INTERN:    ['INTERN'],
  ENTRY:     ['ENTRY', 'JUNIOR'],
  MID:       ['MID'],
  SENIOR:    ['SENIOR', 'STAFF'],
  LEAD:      ['LEAD', 'PRINCIPAL'],
  MANAGER:   ['MANAGER', 'DIRECTOR'],
  EXECUTIVE: ['EXECUTIVE'],
};

// UI's degree filter checkboxes (BACHELOR/MASTER/PHD/ASSOCIATE) mapped to
// lib/education.mjs's canonical enum — see the Degree filter block below.
const DEGREE_LEVEL_TO_EDUCATION = {
  ASSOCIATE: 'ASSOCIATE',
  BACHELOR: 'BACHELORS',
  MASTER: 'MASTERS',
  PHD: 'DOCTORATE',
};

// ─── GET /api/meta — filter options + headline counts ──────────────────────
app.get('/api/meta', async (req, res) => {
  try {
    const [{ rows: cats }, { rows: atsList }, { rows: [totals] }, { rows: workplaceRows }] = await Promise.all([
      query(`SELECT category, COUNT(*) AS n FROM jobs WHERE active = TRUE GROUP BY category ORDER BY n DESC`),
      query(`SELECT ats, COUNT(*) AS n FROM jobs WHERE active = TRUE GROUP BY ats ORDER BY n DESC`),
      query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE remote) AS remote,
                    COUNT(DISTINCT company) AS companies
               FROM jobs WHERE active = TRUE`),
      query(`SELECT workplace_type, COUNT(*) AS n FROM jobs WHERE active = TRUE AND workplace_type IS NOT NULL GROUP BY workplace_type ORDER BY n DESC`),
    ]);
    res.json({ categories: cats, ats: atsList, totals, workplaceTypes: workplaceRows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/jobs — search + filter + paginate ─────────────────────────────
app.get('/api/jobs', async (req, res) => {
  try {
    const q           = (req.query.q || '').trim();
    const searchField = (req.query.searchField || 'both'); // 'title' | 'both'
    const categories  = (req.query.categories || '').split(',').map(c => c.trim()).filter(Boolean);
    const category    = (req.query.category || '').trim(); // backward compat
    const ats         = (req.query.ats || '').trim();
    const remote      = req.query.remote === 'true' ? true : req.query.remote === 'false' ? false : null;
    const page        = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize    = Math.min(50, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
    const offset      = (page - 1) * pageSize;

    // ── New ML filter params ──────────────────────────────────────────────────
    const careerLevels     = (req.query.careerLevels || '').split(',').map(s=>s.trim()).filter(Boolean);
    const employmentTypes  = (req.query.employmentTypes || '').split(',').map(s=>s.trim()).filter(Boolean);
    const workplaceTypes   = (req.query.workplaceTypes || '').split(',').map(s=>s.trim()).filter(Boolean);
    const sponsorship      = (req.query.sponsorship || '').trim();  // 'AVAILABLE' | 'NOT_AVAILABLE' | ...
    const degreeLevel      = (req.query.degreeLevel || '').trim();  // 'BACHELOR' | 'MASTER' | 'PHD'
    const salaryMin        = parseInt(req.query.salaryMin, 10) || null;
    const salaryMax        = parseInt(req.query.salaryMax, 10) || null;
    const minExpYears      = req.query.minExpYears !== undefined ? parseInt(req.query.minExpYears, 10) : null;
    const maxExpYears      = req.query.maxExpYears !== undefined ? parseInt(req.query.maxExpYears, 10) : null;
    const skills            = (req.query.skills || '').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
    const skillMatch        = req.query.skillMatch === 'all' ? 'all' : 'any'; // preserves legacy array-overlap ("any") default
    const postedWithin     = parseInt(req.query.postedWithin, 10) || null; // days

    const conditions = ['active = TRUE'];
    const params      = [];

    // ── Text search ───────────────────────────────────────────────────────────
    if (q) {
      if (searchField === 'title') {
        // Title Only: trigram ILIKE — uses idx_jobs_title_trgm
        params.push('%' + q + '%');
        conditions.push(`title ILIKE $${params.length}`);
      } else if (searchField === 'desc') {
        // Title + Description: GIN full-text — uses idx_jobs_title_desc_fts
        params.push(q);
        conditions.push(`to_tsvector('english', coalesce(title,'') || ' ' || coalesce(description,'')) @@ plainto_tsquery('english', $${params.length})`);
      } else {
        // Title & Company (default): GIN full-text — uses idx_jobs_fts
        params.push(q);
        conditions.push(`to_tsvector('english', coalesce(title,'') || ' ' || coalesce(company,'')) @@ plainto_tsquery('english', $${params.length})`);
      }
    }

    // ── Category ──────────────────────────────────────────────────────────────
    const cats = categories.length > 0 ? categories : (category ? [category] : []);
    if (cats.length > 0) {
      params.push(cats);
      conditions.push(`category = ANY($${params.length}::text[])`);
    }

    // ── ATS platform ──────────────────────────────────────────────────────────
    if (ats) {
      params.push(ats);
      conditions.push(`ats = $${params.length}`);
    }

    // ── Remote (legacy boolean) ───────────────────────────────────────────────
    if (remote !== null) {
      params.push(remote);
      conditions.push(`remote = $${params.length}`);
    }

    // ── Seniority (frontend calls this "career level"; see mapping above) ──────
    // UNKNOWN is intentionally never added to the expanded set here — selecting
    // a level is an explicit filter request, so jobs with no confident
    // classification correctly drop out, same as the old career_level behavior.
    // When no level is selected, this clause is skipped entirely and UNKNOWN
    // jobs still show up in the (unfiltered) results.
    if (careerLevels.length > 0) {
      const seniorityValues = [...new Set(careerLevels.flatMap(bucket => CAREER_LEVEL_TO_SENIORITY[bucket] || []))];
      if (seniorityValues.length > 0) {
        params.push(seniorityValues);
        conditions.push(`seniority_level = ANY($${params.length}::text[])`);
      }
    }

    // ── Employment type ───────────────────────────────────────────────────────
    if (employmentTypes.length > 0) {
      params.push(employmentTypes);
      conditions.push(`employment_type = ANY($${params.length}::text[])`);
    }

    // ── Workplace type ────────────────────────────────────────────────────────
    if (workplaceTypes.length > 0) {
      params.push(workplaceTypes);
      conditions.push(`workplace_type = ANY($${params.length}::text[])`);
    }

    // ── Visa sponsorship ──────────────────────────────────────────────────────
    if (sponsorship) {
      params.push(sponsorship);
      conditions.push(`sponsorship_status = $${params.length}`);
    }

    // ── Degree ────────────────────────────────────────────────────────────────
    // Reads jobs.education_level (lib/education.mjs), not the legacy
    // degree_required JSONB — nothing in the pipeline writes that column
    // anymore (it always carried requirement:'NOT_MENTIONED' regardless of
    // content, a placeholder that was never functional). UI checkbox values
    // (BACHELOR/MASTER/PHD/ASSOCIATE) are unchanged; mapped to the new
    // canonical enum (BACHELORS/MASTERS/DOCTORATE/ASSOCIATE) here.
    if (degreeLevel) {
      const educationLevel = DEGREE_LEVEL_TO_EDUCATION[degreeLevel];
      if (educationLevel) {
        params.push(educationLevel);
        conditions.push(`education_level = $${params.length}`);
      }
    }

    // ── Salary range ──────────────────────────────────────────────────────────
    if (salaryMin !== null) {
      params.push(salaryMin);
      conditions.push(`(salary_max_annual >= $${params.length} OR salary_min_annual >= $${params.length})`);
    }
    if (salaryMax !== null) {
      params.push(salaryMax);
      conditions.push(`(salary_min_annual <= $${params.length} OR salary_min_annual IS NULL)`);
    }

    // ── Experience years ──────────────────────────────────────────────────────
    if (minExpYears !== null && !isNaN(minExpYears)) {
      params.push(minExpYears);
      conditions.push(`(max_exp_years IS NULL OR max_exp_years >= $${params.length})`);
    }
    if (maxExpYears !== null && !isNaN(maxExpYears)) {
      params.push(maxExpYears);
      conditions.push(`(min_exp_years IS NULL OR min_exp_years <= $${params.length})`);
    }

    // ── Skills — reads normalized job_skills/skills, not the legacy skill_tags
    //    array (nothing in the pipeline writes that column anymore; see
    //    lib/db.mjs). skillMatch=any (default, preserves the old array-overlap
    //    "at least one" semantics) or skillMatch=all (every selected skill
    //    must be present). ──────────────────────────────────────────────────
    if (skills.length > 0) {
      const normalizedSkills = [...new Set(skills.map(normalizeSkillName))];
      params.push(normalizedSkills);
      if (skillMatch === 'all') {
        // A correlated per-row COUNT(DISTINCT ...) subquery here made the
        // planner drive off an unrelated index and re-run the subquery once
        // per active job (measured 14.7s on prod data). Computing the
        // qualifying job_id set once as a derived table and using IN instead
        // drops that to ~60ms (EXPLAIN ANALYZE verified).
        params.push(normalizedSkills.length);
        conditions.push(`id IN (
          SELECT js.job_id FROM job_skills js JOIN skills s ON s.id = js.skill_id
          WHERE s.normalized_name = ANY($${params.length - 1}::text[])
          GROUP BY js.job_id
          HAVING COUNT(DISTINCT s.normalized_name) = $${params.length}
        )`);
      } else {
        conditions.push(`EXISTS (
          SELECT 1 FROM job_skills js JOIN skills s ON s.id = js.skill_id
          WHERE js.job_id = jobs.id AND s.normalized_name = ANY($${params.length}::text[])
        )`);
      }
    }

    // ── Posted within N days ──────────────────────────────────────────────────
    if (postedWithin) {
      params.push(postedWithin);
      // posting date when known, else when we found it (see matching/recommend.mjs)
      conditions.push(`(posted_at >= NOW() - ($${params.length} * interval '1 day') OR (posted_at IS NULL AND discovered >= NOW() - ($${params.length} * interval '1 day')))`);
    }

    params.push(pageSize, offset);

    // Build match score expression for ranked search
    let matchScoreExpr = 'NULL::float';
    if (q) {
      const vecExpr = searchField === 'title'
        ? `to_tsvector('english', coalesce(title,''))`
        : searchField === 'desc'
          ? `to_tsvector('english', coalesce(title,'') || ' ' || coalesce(description,''))`
          : `to_tsvector('english', coalesce(title,'') || ' ' || coalesce(company,''))`;
      matchScoreExpr = `ts_rank(${vecExpr}, plainto_tsquery('english', $1))`;
    }

    const orderBy = q
      ? `ORDER BY match_score DESC, posted_at DESC NULLS LAST, discovered DESC`
      : `ORDER BY posted_at DESC NULLS LAST, discovered DESC`;

    const sql = `
      SELECT id, title, company, location, remote, ats, category, url, posted_at, discovered,
             seniority_level, employment_type, workplace_type, sponsorship_status,
             salary_min_annual, salary_max_annual, min_exp_years, max_exp_years,
             ${matchScoreExpr} AS match_score,
             COUNT(*) OVER() AS total_count
        FROM jobs
       WHERE ${conditions.join(' AND ')}
       ${orderBy}
       LIMIT $${params.length - 1} OFFSET $${params.length}
    `;

    const { rows } = await query(sql, params);
    const total = rows[0]?.total_count ? Number(rows[0].total_count) : 0;

    // Normalized skills, fetched for just this page's jobs and grouped by
    // importance. This is the authoritative source (job_skills ⋈ skills) —
    // the flat `skill_tags` field below is a compatibility projection
    // derived here at response time, not read from jobs.skill_tags (which
    // nothing in the pipeline writes anymore).
    const jobIds = rows.map(row => row.id);
    const skillsByJob = new Map();
    if (jobIds.length > 0) {
      const { rows: skillRows } = await query(
        `SELECT js.job_id, s.canonical_name, js.importance
           FROM job_skills js JOIN skills s ON s.id = js.skill_id
          WHERE js.job_id = ANY($1::bigint[])`,
        [jobIds]
      );
      for (const row of skillRows) {
        if (!skillsByJob.has(row.job_id)) {
          skillsByJob.set(row.job_id, { required: [], preferred: [], mentioned: [] });
        }
        const bucket = row.importance === 'REQUIRED' ? 'required' : row.importance === 'PREFERRED' ? 'preferred' : 'mentioned';
        skillsByJob.get(row.job_id)[bucket].push(row.canonical_name);
      }
    }

    res.json({
      jobs: rows.map(({ total_count, match_score, ...job }) => {
        const skillsForJob = skillsByJob.get(job.id) || { required: [], preferred: [], mentioned: [] };
        return {
          ...job,
          match_score: match_score != null ? Math.round(match_score * 10000) / 100 : null,
          skills: skillsForJob,
          // Compatibility-only: derived from normalized skills above, not persisted.
          skill_tags: [...skillsForJob.required, ...skillsForJob.preferred, ...skillsForJob.mentioned],
        };
      }),
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Scan stats API ─────────────────────────────────────────────────────────
// Returns scan history + per-ATS job discovery data for the dashboard.
const byHourCache = { rows: [], at: 0, busy: null };
app.get('/api/scan-stats', async (req, res) => {
  try {
    await reapStaleRuns().catch(() => {});
    // Recent scan runs
    const { rows: runs } = await query(`
      SELECT id, started_at, finished_at, status,
             companies_scanned, companies_errored,
             jobs_fetched, jobs_new, jobs_reactivated, jobs_closed,
             ROUND(EXTRACT(EPOCH FROM (COALESCE(finished_at, NOW()) - started_at))) AS elapsed_secs
        FROM scan_runs
       ORDER BY started_at DESC
       LIMIT 30
    `);

    // Jobs found per platform per hour, last 48h: computed in the background (it passes the pool's 30 s limit
    // while a scan loads the database) and cached for 10 min, so the runs table never waits on it
    if (Date.now() - byHourCache.at > 600_000 && !byHourCache.busy) {
      byHourCache.busy = slowQuery(`
        SELECT ats, DATE_TRUNC('hour', discovered) AS hour, COUNT(*) AS jobs_found
          FROM jobs WHERE discovered > NOW() - INTERVAL '48 hours'
         GROUP BY ats, hour ORDER BY hour ASC`)
        .then(rows => Object.assign(byHourCache, { rows, at: Date.now() }))
        .catch(e => console.error('[scan-stats] jobs per hour:', e.message))
        .finally(() => { byHourCache.busy = null; });
    }
    res.json({ runs, byHour: byHourCache.rows, byHourAt: byHourCache.at || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Live scanner state: running processes, per-platform progress, next scheduled run
app.get('/api/scan-status', async (_req, res) => {
  try { res.json({ ...(await getScanStatus()), ollama: await ollamaStatus() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Is Ollama serving, and is the resume-rewriting model installed?
async function ollamaStatus() {
  const url = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
  const model = process.env.OLLAMA_MODEL || 'qwen2.5:7b-instruct';
  try {
    const r = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(2000) });
    const names = ((await r.json()).models || []).map(m => m.name);
    return { running: true, model, modelInstalled: names.some(n => n === model || n.split(':')[0] === model) };
  } catch { return { running: false, model, modelInstalled: false }; }
}

// Start/stop scans. Spawns local processes, so it only answers requests from this machine.
app.post('/api/scan-control', express.json(), async (req, res) => {
  const ip = req.socket.remoteAddress || '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return res.status(403).json({ ok: false, message: 'Local access only' });
  const { action, target } = req.body || {};
  if (!['start', 'stop'].includes(action) || typeof target !== 'string') return res.status(400).json({ ok: false, message: 'Bad request' });
  try { res.json(await (action === 'start' ? startScan(target) : stopScans(target))); }
  catch (err) { res.status(500).json({ ok: false, message: err.message }); }
});



// ─── POST /api/parse-resume ──────────────────────────────────────────────────
// Accepts a multipart PDF/DOCX/TXT resume, extracts text, returns structured
// profile fields for the frontend to merge into localStorage profile.
app.post('/api/parse-resume', (req, res) => {
  const chunks = [];
  let boundary = '';
  const ct = req.headers['content-type'] || '';
  const bm = ct.match(/boundary=([^\s;]+)/);
  if (!bm) return res.status(400).json({ error: 'No multipart boundary' });
  boundary = bm[1];

  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    try {
      const buf = Buffer.concat(chunks);

      // ── Parse multipart body manually (avoid extra dep) ─────────
      const sep  = Buffer.from('--' + boundary);
      const parts = [];
      let pos = 0;
      while (pos < buf.length) {
        const start = buf.indexOf(sep, pos);
        if (start === -1) break;
        const headerStart = start + sep.length + 2; // skip \r\n
        const headerEnd   = buf.indexOf(Buffer.from('\r\n\r\n'), headerStart);
        if (headerEnd === -1) break;
        const headerStr = buf.slice(headerStart, headerEnd).toString();
        const bodyStart = headerEnd + 4;
        const end       = buf.indexOf(sep, bodyStart);
        if (end === -1) break;
        const bodyEnd = end - 2; // trim \r\n before next boundary
        parts.push({ header: headerStr, body: buf.slice(bodyStart, bodyEnd) });
        pos = end;
      }

      const filePart = parts.find(p => /name="resume"/.test(p.header));
      if (!filePart) return res.status(400).json({ error: 'No resume file found' });

      const fnMatch = filePart.header.match(/filename="([^"]+)"/);
      const filename = fnMatch ? fnMatch[1].toLowerCase() : 'resume';
      const bodyBuf  = filePart.body;

      // ── Extract raw text ─────────────────────────────────────────
      let text = '';
      if (filename.endsWith('.pdf')) {
        const { createRequire } = await import('module');
        const req2 = createRequire(import.meta.url);
        // pdf-parse v2 exports the PDFParse class instead of a default
        // function (v1's `pdfParse(buffer)` shape) — the API changed under us.
        const { PDFParse } = req2('pdf-parse');
        const parser = new PDFParse({ data: bodyBuf });
        const parsed = await parser.getText();
        text = parsed.text;
      } else if (filename.endsWith('.docx') || filename.endsWith('.doc')) {
        const { createRequire } = await import('module');
        const req2 = createRequire(import.meta.url);
        const mammoth = req2('mammoth');
        const result  = await mammoth.extractRawText({ buffer: bodyBuf });
        text = result.value;
      } else {
        text = bodyBuf.toString('utf8');
      }

      // ── Field extraction ─────────────────────────────────────────
      const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

      // Name: first non-empty line that looks like a name (2-4 words, Title
      // Case or ALL CAPS, allowing middle initials/hyphens/apostrophes).
      //
      // Section headers like "Professional Summary" are themselves valid
      // 2-4-word Title Case lines with nothing else on them, so without an
      // explicit exclusion list a resume whose real name line doesn't match
      // (all-caps names are common, and used to fail the old lowercase-only
      // pattern) falls through and incorrectly latches onto the next
      // matching line — the summary heading — instead of the name.
      const NAME_EXCLUDE = /^(professional|career|executive|personal)?\s*(summary|profile|objective)$|^about\s*me$|^(work|professional|relevant)?\s*experience$|^education$|^skills?$|^technical\s*skills$|^certifications?$|^projects?$|^contact(\s*information)?$|^references?$|^resume|^curriculum\s*vitae|^cv$/i;
      const NAME_CANDIDATE = /^[A-Z][A-Za-z'.-]*(\s+[A-Z][A-Za-z'.-]*){1,3}$/;
      let name = '';
      for (const ln of lines.slice(0, 8)) {
        if (NAME_EXCLUDE.test(ln)) continue;
        if (ln.includes('@') || /\d/.test(ln)) continue; // skip email/phone/date lines
        if (NAME_CANDIDATE.test(ln)) { name = ln; break; }
      }

      // Email
      const emailM = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
      const email = emailM ? emailM[0] : '';

      // Phone
      const phoneM = text.match(/(\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/);
      const phone = phoneM ? phoneM[0] : '';

      // LinkedIn
      const liM = text.match(/linkedin\.com\/in\/[\w\-]+/i);
      const linkedin = liM ? liM[0] : '';

      // GitHub
      const ghM = text.match(/github\.com\/[\w\-]+/i);
      const github = ghM ? ghM[0] : '';

      // Location: common city/state patterns
      const locM = text.match(/([A-Z][a-z]+(?:[ ][A-Z][a-z]+)*),\s*([A-Z]{2})(,?\s*United States)?/);
      const location = locM ? `${locM[1]}, ${locM[2]}` : '';

      // Work auth
      let workAuth = '';
      const authText = text.toLowerCase();
      if (/\bopt\b|\bcpt\b/.test(authText))       workAuth = 'opt';
      else if (/\bh[\-]?1b\b/.test(authText))     workAuth = 'h1b';
      else if (/\bgreen card\b|\blpr\b/.test(authText)) workAuth = 'green_card';
      else if (/\bead\b/.test(authText))           workAuth = 'ead';
      else if (/\btn visa\b/.test(authText))       workAuth = 'tn';
      else if (/\bu\.?s\.?\s*citizen/.test(authText)) workAuth = 'us_citizen';

      // Experience years
      let expYears = '';
      const yrM = text.match(/(\d+)\+?\s*years?\s*(?:of\s*)?(?:professional\s*)?experience/i);
      if (yrM) {
        const n = parseInt(yrM[1]);
        if (n <= 1) expYears = '0';
        else if (n <= 3) expYears = '2';
        else if (n <= 6) expYears = '4';
        else if (n <= 10) expYears = '7';
        else expYears = '11';
      }

      // Current/target title: first job title line near the top
      const titlePatterns = [
        /software engineer/i, /data engineer/i, /ml engineer/i, /backend engineer/i,
        /frontend engineer/i, /full.?stack/i, /devops/i, /data scientist/i,
        /product manager/i, /engineering manager/i,
      ];
      let title = '';
      for (const ln of lines.slice(0, 20)) {
        if (titlePatterns.some(p => p.test(ln)) && ln.length < 60) { title = ln; break; }
      }

      // Summary: paragraph that starts with name or "Summary" / "Professional"
      let summary = '';
      const summIdx = lines.findIndex(l => /^(professional\s*)?summary$/i.test(l) || /^about me$/i.test(l));
      if (summIdx >= 0 && lines[summIdx+1]) {
        summary = lines.slice(summIdx+1, summIdx+5).join(' ').slice(0, 500);
      }

      // Skills: look for common skill keywords
      const SKILL_LISTS = {
        languages:  ['python','java','javascript','typescript','go','rust','c\\+\\+','c#','scala','kotlin','sql','r','swift'],
        frameworks: ['react','angular','vue','spring','spring boot','fastapi','django','flask','langchain','langgraph','express','next\\.?js','node'],
        databases:  ['postgresql','postgres','mysql','mongodb','redis','dynamodb','chromadb','pinecone','sqlite','snowflake','bigquery'],
        tools:      ['docker','kubernetes','git','github actions','jenkins','ci/cd','jira','terraform','ansible','webpack','vite'],
        cloud:      ['aws','gcp','azure','s3','ec2','lambda','ecs','fargate','cloudwatch','cloud run','bigquery'],
        soft:       ['agile','scrum','technical leadership','cross-functional','communication'],
      };
      const skills2 = {};
      const textLow = text.toLowerCase();
      Object.entries(SKILL_LISTS).forEach(([cat, terms]) => {
        skills2[cat] = terms.filter(t => new RegExp('\\b' + t + '\\b').test(textLow))
                            .map(t => t.replace(/\\/g,'').replace(/\b\w/g, c => c.toUpperCase()));
      });

      // Certifications: common cert patterns
      const certPatterns = [
        /aws certified[\w\s,\-–]+/gi,
        /google cloud[\w\s,\-–]*certified[\w\s,\-–]*/gi,
        /microsoft certified[\w\s,\-–]+/gi,
        /cka\b|ckad\b/gi,
        /pmp\b/gi,
      ];
      const certs = [];
      certPatterns.forEach(pat => {
        const matches = [...text.matchAll(pat)];
        matches.forEach(m => {
          const certName = m[0].trim().slice(0, 80);
          if (!certs.some(c => c.name === certName)) certs.push({ name: certName, issuer: '', year: '' });
        });
      });

      // `text` + `sections` feed the dashboard's resume profiles
      // (POST /v1/users/:id/resume-profiles/:pid/import-resume); the flat
      // fields above stay for the legacy job board page.
      res.json({ name, email, phone, linkedin, github, location, workAuth, expYears, title, summary, skills2, certs,
        filename, text: text.slice(0, 100_000), sections: extractResumeSections(text) });
    } catch (err) {
      console.error('parse-resume error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
  req.on('error', err => res.status(500).json({ error: err.message }));
});

app.listen(PORT, () => {
  console.log(`\n🌐  Job board running at http://localhost:${PORT}`);
  console.log(`🧭  Dashboard at http://localhost:${PORT}/app`);
  console.log(`🛡   Admin portal (scans, users, …) at http://localhost:${PORT}/admin\n`);
  // Applications left mid-flight by a restart or a dead run become FAILED ("Try again") instead of spinning forever.
  const reap = () => reapStuckApplications().then(n => n && console.log(`[apply] ${n} interrupted application(s) moved to Failed`)).catch(() => {});
  reap(); setInterval(reap, 60_000);
  // Fill the job-match cache for recently active people, so the first page after a restart isn't the slow one.
  query(`SELECT DISTINCT user_id FROM resume_profiles WHERE updated_at > NOW() - INTERVAL '30 days' LIMIT 5`)
    .then(({ rows }) => Promise.all(rows.map(r => fetch(`http://localhost:${PORT}/v1/users/${r.user_id}/recommendations?limit=6`).catch(() => {}))))
    .catch(() => {});
});
