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
import { fetchJobFromPage } from './page-job.mjs';

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
  const target = canonicalJobUrl(inputUrl).toLowerCase();
  const id = jobId && String(jobId).toLowerCase();
  return jobs.find(j => canonicalJobUrl(j.url).toLowerCase() === target)
    ?? (id ? jobs.find(j => String(j.url).toLowerCase().includes(id) || String(j.raw?.id ?? '').toLowerCase() === id) : null)
    ?? null;
}

/**
 * Board path (supported ATS with a scannable API). @returns {Promise<{ ok: boolean, code?: string, message?: string, ats?: string|null,
 *   company?: {id:number,name:string,ats:string,slug:string,added:boolean},
 *   jobId?: string|null, scan?: object }>}
 */
async function importFromBoard(det, inputUrl, verbose) {

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

  let pasted = findPastedJob(jobs, inputUrl, det.jobId);
  // Workday lists only its first 200 postings; a bigger board (CVS has thousands) hides the pasted job,
  // so search the board for its requisition id, then for the title words in the URL.
  if (!pasted && det.ats === 'workday') {
    const titleSlug = new URL(inputUrl).pathname.split('/').filter(Boolean).pop().replace(/_[A-Za-z0-9-]+$/, '').replace(/-+/g, ' ');
    for (const searchText of [det.jobId, titleSlug].filter(Boolean)) {
      try {
        const hits = await PROVIDERS.workday(probe, { verbose, searchText });
        pasted = findPastedJob(hits, inputUrl, det.jobId);
        if (pasted) { jobs.push(pasted); break; }
      } catch { /* fall through to NOT_FOUND_ON_BOARD */ }
    }
  }
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

const tidy = t => String(t).replace(/<\/(p|li|div|h\d)>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();

/** Readable job details for the "Fetch JD" button: page JSON-LD, plain-text description. */
export async function previewJobByUrl(inputUrl) {
  const det = detectAts(inputUrl);
  if (!det) return { ok: false, code: 'INVALID_URL', message: 'That isn\'t a valid http(s) link.' };
  const page = await fetchJobFromPage(inputUrl);
  const base = { ats: det.ats, supported: det.supported };
  if (!page) return { ok: false, code: 'PAGE_UNREADABLE', message: 'Couldn\'t read that page. Paste the job description instead.', ...base };
  return { ok: true, ...base, title: page.title, company: page.company, location: page.location, description: tidy(page.description) };
}

/** Any-board path: read the job from its own page and store it under a per-host "manual" company. */
async function importFromPage(det, inputUrl, description) {
  const page = await fetchJobFromPage(inputUrl);
  const host = new URL(inputUrl).hostname.toLowerCase();
  if (!page && !description) {
    return { ok: false, code: 'PAGE_UNREADABLE', ats: det.ats,
      message: 'Couldn\'t read that page (it may need a login). Paste the job description and try again.' };
  }
  const slugTitle = decodeURIComponent(new URL(inputUrl).pathname.split('/').filter(Boolean).pop() || '').replace(/_[A-Za-z0-9-]+$/, '').replace(/[-_]+/g, ' ').trim();
  const title = page?.title || slugTitle || description.split('\n')[0].slice(0, 120);
  const companyName = page?.company || prettySlug(host.replace(/^(www|jobs|careers|apply)\./, '').split('.')[0]);
  const job = {
    url: inputUrl.split('#')[0], title, company: companyName, location: page?.location || '', remote: !!page?.remote,
    ats: det.ats || 'manual', posted_at: page?.posted_at || null,
    raw: { id: inputUrl, description: description || page?.description || '' },
  };
  if (!isJobInCoverage(job)) {
    return { ok: true, code: 'OUTSIDE_COVERAGE', jobId: null, ats: det.ats,
      message: 'That job is outside the regions the scanner stores (US, Canada, EU and Australia).' };
  }
  // active = FALSE keeps the scanner away: there is no board API to re-fetch, and an empty scan would close the job.
  const { rows } = await query(
    `INSERT INTO companies (name, ats, slug, meta, priority, active, discovered)
     VALUES ($1, 'manual', $2, '{}'::jsonb, 3, FALSE, NOW())
     ON CONFLICT (ats, slug) DO UPDATE SET slug = EXCLUDED.slug
     RETURNING id, name, ats, slug, meta`, [companyName, host]);
  const company = rows[0];
  job.company = company.name;
  const scan = await processCompany(company, { prefetchedJobs: [job] });
  if (scan.error) return { ok: false, code: 'SCAN_FAILED', message: scan.error, ats: det.ats, scan };
  const { rows: found } = await query(`SELECT id FROM jobs WHERE company_id = $1 AND url = $2`, [company.id, job.url]);
  return { ok: true, code: found.length ? 'IMPORTED' : 'NOT_STORED', jobId: found[0] ? String(found[0].id) : null, ats: det.ats, via: 'page', company: { ...company, added: false }, scan };
}

/**
 * Add a job by link, for any job board. Supported ATSes are read from their
 * board API; when the board can't be read or doesn't list the posting, or the
 * site isn't an API-backed ATS at all, the job is read from its page instead.
 * `description` (user-pasted) is the fallback text when the page has none.
 */
export async function importJobByUrl(inputUrl, { verbose = false, description = '' } = {}) {
  const det = detectAts(inputUrl);
  if (!det) return { ok: false, code: 'INVALID_URL', message: 'That isn\'t a valid http(s) link.' };
  const board = det.supported ? await importFromBoard(det, inputUrl, verbose) : null;
  if (board && !['NOT_FOUND_ON_BOARD', 'BOARD_UNREACHABLE'].includes(board.code)) return board;
  const page = await importFromPage(det, inputUrl, String(description || ''));
  return page.ok || !board ? page : board;
}
