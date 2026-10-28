/**
 * scripts/test-dashboard-api.mjs
 *
 * End-to-end checks for the endpoints the dashboard (public/app) uses beyond
 * the feed: applications tracker, job match detail, and the /v1 mount on the
 * web server.
 *
 *   DATABASE_URL=postgres://postgres@localhost:5432/jobs_test \
 *     node scripts/test-dashboard-api.mjs
 *
 * Refuses to run unless DATABASE_URL points at localhost: it inserts and
 * deletes rows. Run `npm run migrate` against that database first.
 */
import { spawn } from 'node:child_process';

const url = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) {
  console.log('SKIP: DATABASE_URL must point at localhost (this test inserts/deletes rows).');
  process.exit(1);
}
const { query, closePool } = await import('../lib/db.mjs');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

const USER = '00000000-0000-4000-8000-00000000da5b';
const MARK = 'dashtest';
const PORT = 3998;

async function cleanup() {
  await query(`DELETE FROM applications WHERE user_id = $1`, [USER]);
  await query(`DELETE FROM user_job_interactions WHERE user_id = $1`, [USER]);
  await query(`DELETE FROM user_profiles WHERE user_id = $1`, [USER]);
  await query(`DELETE FROM jobs WHERE ats = $1`, [MARK]);
}

await cleanup();
const ids = [];
for (const [i, title] of ['Backend Engineer', 'Backend Engineer II', 'Software Engineer'].entries()) {
  const { rows } = await query(
    `INSERT INTO jobs (url, title, normalized_title, company, ats, role_family, canonical_role, description_clean,
                       workplace_type, employment_type, status, active, fingerprint, discovered, location)
     VALUES ($1,$2,lower($2),$3,$4,'SOFTWARE_ENGINEERING','BACKEND_ENGINEER','Build services in Java.','REMOTE','FULL_TIME','READY',TRUE,$5,NOW(),'Remote')
     RETURNING id`,
    [`https://example.test/dash/${i}`, title, `Dash Co ${i}`, MARK, `dash${String(i).padStart(12, '0')}`]
  );
  ids.push(String(rows[0].id));
}

const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'pipe'] });
let log = '';
server.stderr.on('data', d => { log += d; });
const base = `http://localhost:${PORT}`;
for (let i = 0; i < 60; i++) { try { await fetch(`${base}/v1/health`); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
const call = async (method, path, body) => {
  const res = await fetch(`${base}/v1${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};

try {
  let r = await fetch(`${base}/app/`);
  check('dashboard page is served at /app/', r.status === 200 && (await r.text()).includes('Rejekt.ai'));
  r = await fetch(`${base}/app/tracker`);
  check('deep links under /app fall back to the dashboard page', r.status === 200);

  let c = await call('GET', `/users/${USER}/jobs/${ids[0]}/match`);
  check('job detail works before a profile exists (match: null)', c.status === 200 && c.body.match === null && c.body.job.title === 'Backend Engineer', c.body);

  await call('PUT', `/users/${USER}/profile`, { current_title: 'Backend Engineer', total_experience_years: 3, current_country: 'US', full_name: 'Test User', email: 't@example.test' });
  await call('PUT', `/users/${USER}/target-roles`, { roles: [{ canonicalRole: 'BACKEND_ENGINEER', roleFamily: 'SOFTWARE_ENGINEERING' }] });
  await call('PUT', `/users/${USER}/skills`, { skills: [{ name: 'Java' }] });

  c = await call('GET', `/users/${USER}/profile`);
  check('profile keeps header fields and its own user_id', c.body.full_name === 'Test User' && c.body.user_id === USER, c.body);

  c = await call('GET', `/users/${USER}/jobs/${ids[0]}/match`);
  check('job detail returns description, score and breakdown', c.body.job.description && c.body.match.matchScore > 0 && c.body.match.components.role != null, c.body.match);
  check('job detail exposes the posting url', c.body.job.url === 'https://example.test/dash/0');

  c = await call('GET', `/users/${USER}/recommendations?limit=50&use_saved_search=false`);
  check('feed cards carry display fields (url, workplace, salary, skills)',
    c.body.jobs.length >= 3 && c.body.jobs.every(j => j.url && j.workplace && j.salary && j.skills), c.body.jobs[0]);

  c = await call('POST', `/users/${USER}/applications`, { jobId: ids[0] });
  check('POST application defaults to SAVED (201)', c.status === 201 && c.body.status === 'SAVED', c);
  const appId = c.body.id;
  c = await call('POST', `/users/${USER}/applications`, { jobId: ids[0], status: 'APPLIED' });
  check('posting the same job again updates it instead of duplicating', c.status === 200 && c.body.id === appId && c.body.status === 'APPLIED' && c.body.appliedAt, c);

  c = await call('GET', `/users/${USER}/recommendations?limit=50&use_saved_search=false`);
  check('an APPLIED job drops out of the feed', !c.body.jobs.some(j => j.jobId === ids[0]), c.body.jobs.map(j => j.jobId));

  c = await call('PATCH', `/users/${USER}/applications/${appId}`, { status: 'GHOSTED', notes: 'No reply after 3 weeks' });
  check('PATCH moves to GHOSTED and saves notes', c.body.status === 'GHOSTED' && c.body.notes === 'No reply after 3 weeks', c.body);
  c = await call('PATCH', `/users/${USER}/applications/${appId}`, { status: 'NOPE' });
  check('invalid status → 400', c.status === 400);
  c = await call('POST', `/users/${USER}/applications`, { jobId: 999999999 });
  check('unknown job → 404', c.status === 404);

  await call('POST', `/users/${USER}/applications`, { jobId: ids[1], status: 'INTERVIEWING' });
  c = await call('GET', `/users/${USER}/applications`);
  check('list returns counts per status', c.body.counts.GHOSTED === 1 && c.body.counts.INTERVIEWING === 1 && c.body.counts.OFFER === 0, c.body.counts);
  check('list rows include job title/company/url', c.body.applications.every(a => a.job.title && a.job.company && a.job.url));
  c = await call('GET', `/users/${USER}/applications?status=INTERVIEWING`);
  check('status filter works', c.body.applications.length === 1 && c.body.applications[0].status === 'INTERVIEWING');

  c = await call('GET', `/users/${USER}/jobs/${ids[1]}/match`);
  check('job detail reports the tracked status', c.body.application?.status === 'INTERVIEWING', c.body.application);

  c = await call('DELETE', `/users/${USER}/applications/${appId}`);
  check('DELETE removes an application', c.body.deleted === true);
  c = await call('DELETE', `/users/${USER}/applications/${appId}`);
  check('DELETE twice → 404', c.status === 404);
} finally {
  server.kill();
  await cleanup();
  await closePool();
  if (failures) console.log(log.slice(-2000));
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exitCode = failures ? 1 : 0;
