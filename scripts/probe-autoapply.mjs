/**
 * Auto-apply health check per job platform: opens live postings and fills their application forms with
 * made-up test answers, and NEVER submits (fillApplication with submit: false). Workday and Oracle stop at
 * their account sign-in, which this check doesn't go past (that would create real accounts).
 *
 *   node --env-file=.env.local scripts/probe-autoapply.mjs [--ats bamboohr] [--per 2] [--shots <dir>]
 *
 * Per platform it prints: where the form was (or why not), fields found, filled, and required ones it
 * couldn't answer. FILLED = auto-apply would have been able to send it.
 */
import { parseArgs } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { query, slowQuery, closePool } from '../lib/db.mjs';
import { getBrowser, closeBrowser, renderResumePDF } from '../lib/resume-render.mjs';
import { fillApplication, scanForm } from '../autoapply/form-fill.mjs';
import { buildAnswerBook } from '../autoapply/answers.mjs';
import { applyUrlFor, FILLABLE_ATS } from '../autoapply/engine.mjs';

const { values: f } = parseArgs({ options: { ats: { type: 'string' }, per: { type: 'string', default: '2' }, shots: { type: 'string' } } });

// a made-up applicant: nothing here is a real person's data
const SECTIONS = {
  personal: { fullName: 'Test Person', email: 'rejekt.autoapply.test@example.com', phone: '+1 512 555 0100', city: 'Austin', state: 'TX', country: 'United States',
              linkedin: 'https://www.linkedin.com/in/test-person', github: '', portfolio: '', address: '100 Test St', zip: '78701' },
  summary: 'Software engineer.',
  experience: [{ company: 'Example Co', title: 'Software Engineer', startDate: '2020-01', endDate: '', current: true, bullets: ['Built things.'] }],
  education: [{ school: 'Example University', degree: 'B.S.', field: 'Computer Science', endDate: '2019-05' }],
  skills: ['JavaScript'],
  applicationDefaults: { authorizedToWork: true, needsSponsorship: false, over18: true, canRelocate: true, inPersonOk: true, startImmediately: true, citizenship: 'United States' },
};

const ACCOUNT_WALL = new Set(['workday', 'oraclecloud']);

const dir = await mkdtemp(join(tmpdir(), 'probe-autoapply-'));
const files = { resume: join(dir, 'Test_Person_Resume.pdf'), coverLetter: null };
await writeFile(files.resume, await renderResumePDF('<!doctype html><body style="font:12pt Arial"><h1>Test Person</h1><p>Software Engineer</p></body>'));
const browser = await getBrowser();
if (!browser) { console.error('No browser: install Chrome or set CHROME_PATH'); process.exit(1); }

const { rows: platforms } = await query(`SELECT DISTINCT ats FROM companies WHERE active ORDER BY ats`);
const list = platforms.map(r => r.ats).filter(a => !f.ats || a === f.ats);
const summary = [];

for (const ats of list) {
  const jobs = await recentJobs(ats, +f.per);
  for (const job of jobs) {
    const formUrl = applyUrlFor({ url: job.url, ats, slug: job.slug, rawId: job.raw_id });
    const target = formUrl || job.url;      // platforms auto-apply doesn't take yet: try the posting itself
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    let r;
    try {
      r = await fillApplication(page, target, buildAnswerBook(SECTIONS, { company: job.company, title: job.title }), files,
        { submit: false, timeoutMs: 30_000, screenshotPath: f.shots ? join(f.shots, `${ats}-${job.id}.png`) : undefined,
          // same as the engine: the AI answers required questions with no saved answer
          llmContext: { job: { company: job.company, title: job.title }, resumeSections: SECTIONS } });
      if (r.outcome === 'FAILED' && ACCOUNT_WALL.has(ats)) {
        const fields = await page.evaluate(scanForm).catch(() => []);
        r.reason = `account sign-in wall (${fields.length} fields): handled by its own sign-in step, not tested here`;
        r.outcome = 'ACCOUNT';
      }
    } catch (e) { r = { outcome: 'ERROR', reason: e.message.split('\n')[0].slice(0, 140), filled: [], missing: [] }; }
    finally { await page.close().catch(() => {}); }
    const row = { ats, enabled: FILLABLE_ATS.includes(ats), job: job.id, company: job.company, outcome: r.outcome,
                  filled: r.filled?.length || 0, missing: (r.missing || []).map(m => m.label).slice(0, 4), reason: r.reason || '', url: target };
    summary.push(row);
    console.log(`${ats.padEnd(16)} ${row.enabled ? 'on ' : 'off'} ${r.outcome.padEnd(9)} filled ${String(row.filled).padStart(2)}  ${row.missing.length ? 'missing: ' + row.missing.join(' | ') : ''} ${row.reason}`);
    console.log(`${''.padEnd(21)}${job.company} · ${target}`);
  }
}

console.log('\nper platform:');
for (const ats of list) {
  const r = summary.filter(x => x.ats === ats);
  const ok = r.filter(x => x.outcome === 'FILLED').length;
  console.log(`  ${ats.padEnd(16)} ${FILLABLE_ATS.includes(ats) ? 'enabled ' : 'disabled'}  filled ${ok}/${r.length}  ${[...new Set(r.map(x => x.outcome))].join(', ')}`);
}
await closeBrowser(); await closePool(); process.exit(0);

// recent open postings in the US, from different active companies (companies first: cheap even mid-scan)
async function recentJobs(ats, n) {
  const ids = (await slowQuery(`SELECT id FROM companies WHERE ats = $1 AND active ORDER BY random() LIMIT 40`, [ats])).map(r => r.id);
  const rows = await slowQuery(`
    SELECT DISTINCT ON (j.company_id) j.id, j.url, j.company, j.title, c.slug, j.raw->>'id' AS raw_id
      FROM jobs j JOIN companies c ON c.id = j.company_id
     WHERE j.company_id = ANY($1::int[]) AND j.active
       AND (j.location ILIKE '%United States%' OR j.location ~ ', [A-Z]{2}$' OR j.location ILIKE '%remote%')
     ORDER BY j.company_id, j.discovered DESC`, [ids]);
  return rows.sort(() => Math.random() - 0.5).slice(0, n);
}
