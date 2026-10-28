/**
 * lib/job-import.mjs
 *
 * "Add a job by link": a user pastes a job URL → we detect the ATS, register
 * the company in `companies` (so every later scan keeps it fresh — each
 * pasted link grows coverage), scan that board now through the normal worker
 * pipeline, and return the stored job.
 *
 * Mirrors Tsenta's paste-a-link flow (docs/job-sourcing.md): recognized-but-
 * unscannable ATSes answer ATS_NOT_SUPPORTED instead of guessing.
 */
import { query } from './db.mjs';
import { detectAts } from './ats-detect.mjs';
import { isJobInCoverage } from './geo.mjs';
import { PROVIDERS, processCompany } from '../scanner/worker.mjs';

/** Comparable form of a job URL: host lowercased, no query/hash/trailing slash, no locale segment. */
export function canonicalJobUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/(apply|application|applications\/new|c\/new|apps\/new)\/?$/i, '').replace(/\/+$/, '');
    return `${u.hostname.toLowerCase()}${path}`.replace(/\/[a-z]{2}-[A-Z]{2}(?=\/)/, '');
  } catch { return String(url || ''); }
}

function prettySlug(slug) {
  return String(slug).split('/')[0].replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/** Find the pasted job among a board's jobs: exact canonical URL first, then the ATS job id inside the URL. */
export function findPastedJob(jobs, inputUrl, jobId) {
  const target = canonicalJobUrl(inputUrl);
  return jobs.find(j => canonicalJobUrl(j.url) === target)
    ?? (jobId ? jobs.find(j => String(j.url).includes(jobId) || String(j.raw?.id ?? '') === String(jobId)) : null)
    ?? null;
}

/**
 * @returns {Promise<{ ok: boolean, code?: string, message?: string, ats?: string|null,
 *   company?: {id:number,name:string,ats:string,slug:string,added:boolean},
 *   jobId?: string|null, scan?: object }>}
 */
export async function importJobByUrl(inputUrl, { verbose = false } = {}) {
  const det = detectAts(inputUrl);
  if (!det) return { ok: false, code: 'INVALID_URL', message: 'That isn\'t a valid http(s) link.' };
  if (!det.supported) {
    return {
      ok: false, code: 'ATS_NOT_SUPPORTED', ats: det.ats,
      message: det.ats
        ? `Jobs hosted on ${det.ats} can't be imported yet. Try the link to the company's application page.`
        : 'We don\'t recognize that job site yet. Try the link to the application page itself.',
    };
  }

  // Fetch the board with no company name so providers that know the real
  // name (Recruitee, Breezy, Rippling) can supply it.
  const probe = { id: null, name: null, ats: det.ats, slug: det.slug, meta: det.meta };
  let jobs;
  try {
    jobs = await PROVIDERS[det.ats](probe, { verbose });
  } catch (err) {
    return { ok: false, code: 'BOARD_UNREACHABLE', ats: det.ats, message: `Couldn't read that ${det.ats} job board (${err.message}).` };
  }

  const { rows: existing } = await query(`SELECT id, name, ats, slug, meta FROM companies WHERE ats = $1 AND slug = $2`, [det.ats, det.slug]);
  const name = existing[0]?.name || jobs.find(j => j.company)?.company || prettySlug(det.slug);
  const { rows } = await query(
    `INSERT INTO companies (name, ats, slug, meta, priority, active, discovered)
     VALUES ($1, $2, $3, $4, 3, TRUE, NOW())
     ON CONFLICT (ats, slug) DO UPDATE SET active = TRUE, scan_errors = 0,
       meta = CASE WHEN companies.meta = '{}'::jsonb THEN EXCLUDED.meta ELSE companies.meta END
     RETURNING id, name, ats, slug, meta`,
    [name, det.ats, det.slug, JSON.stringify(det.meta || {})]
  );
  const company = rows[0];
  for (const j of jobs) j.company = company.name;

  const pasted = findPastedJob(jobs, inputUrl, det.jobId);
  const scan = await processCompany(company, { prefetchedJobs: jobs, verbose });
  await query(`UPDATE companies SET last_scan = NOW() WHERE id = $1`, [company.id]);

  const base = { ats: det.ats, company: { ...company, added: !existing.length }, scan };
  if (scan.error) return { ok: false, code: 'SCAN_FAILED', message: scan.error, ...base };
  if (!pasted) {
    return { ok: true, code: 'NOT_FOUND_ON_BOARD', jobId: null,
      message: `Added ${company.name} (${jobs.length} open jobs), but that posting isn't on their board anymore.`, ...base };
  }
  if (!isJobInCoverage(pasted)) {
    return { ok: true, code: 'OUTSIDE_COVERAGE', jobId: null,
      message: `That job is outside the regions the scanner stores (US, Canada, EU and Australia). ${company.name}'s in-coverage jobs were added.`, ...base };
  }
  const { rows: found } = await query(`SELECT id FROM jobs WHERE company_id = $1 AND url = $2`, [company.id, pasted.url]);
  return { ok: true, code: found.length ? 'IMPORTED' : 'NOT_STORED', jobId: found[0] ? String(found[0].id) : null, ...base };
}
