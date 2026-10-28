/**
 * providers/lever.mjs
 * GET https://api.lever.co/v0/postings/{slug}?mode=json&limit=250&skip=N
 * No auth. Paginates until empty array returned.
 *
 * Pagination uses `skip`, not `offset` — `offset` is silently ignored by the
 * API, which just re-returns page 1 every time (looks like pagination is
 * working since a full page keeps coming back, but it's the same page).
 */
import { fetchJSON, normalizeLocation, sleep, INTER_REQUEST_DELAY_MS } from '../lib/http.mjs';

export const ATS   = 'lever';
const PAGE_SIZE    = 250;
const MAX_PAGES    = 10;   // safety cap: 2500 jobs per company

export async function fetchAll(company, opts = {}) {
  const base = `https://api.lever.co/v0/postings/${company.slug}?mode=json&limit=${PAGE_SIZE}`;
  const all  = [];
  let   skip = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    if (opts.verbose) console.error(`  → GET ${base}&skip=${skip}`);

    const data = await fetchJSON(`${base}&skip=${skip}`);
    if (!Array.isArray(data) || data.length === 0) break;

    for (const raw of data) all.push(normalize(raw, company));
    if (data.length < PAGE_SIZE) break;

    skip += PAGE_SIZE;
    await sleep(INTER_REQUEST_DELAY_MS);
  }

  return all;
}

function normalize(raw, company) {
  const loc = raw.categories?.location || raw.categories?.allLocations?.[0] || '';
  return {
    url:       raw.hostedUrl || `https://jobs.lever.co/${company.slug}/${raw.id}`,
    title:     (raw.text || '').trim(),
    company:   company.name,
    location:  normalizeLocation(loc),
    remote:    /remote/i.test(loc),
    ats:       ATS,
    posted_at: raw.createdAt ? new Date(raw.createdAt).toISOString() : null,
    raw,
  };
}
