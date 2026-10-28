/**
 * providers/smartrecruiters.mjs
 * GET https://api.smartrecruiters.com/v1/companies/{slug}/postings
 * Public API — no auth. Paginated with offset.
 *
 * Response: { content: [{id, name, location, releasedDate, ...}], totalFound, offset, limit }
 */
import { fetchJSON, normalizeLocation, sleep, INTER_REQUEST_DELAY_MS } from '../lib/http.mjs';

export const ATS    = 'smartrecruiters';
const PAGE_SIZE     = 100;
const MAX_PAGES     = 20;   // 2000 jobs max per company

export async function fetchAll(company, opts = {}) {
  const base = `https://api.smartrecruiters.com/v1/companies/${company.slug}/postings?limit=${PAGE_SIZE}`;
  const all  = [];
  let   offset = 0;
  let   total  = Infinity;

  for (let page = 0; page < MAX_PAGES && offset < total; page++) {
    const url = `${base}&offset=${offset}`;
    if (opts.verbose) console.error(`  → GET ${url}`);

    const data = await fetchJSON(url, {
      headers: { 'User-Agent': 'rejekt-ai/2.0' },
    });

    const items = data?.content ?? [];
    if (page === 0) total = data?.totalFound ?? items.length;

    for (const raw of items) all.push(normalize(raw, company));
    if (items.length < PAGE_SIZE) break;

    offset += PAGE_SIZE;
    await sleep(INTER_REQUEST_DELAY_MS);
  }

  return all;
}

function normalize(raw, company) {
  const city    = raw.location?.city    || '';
  const region  = raw.location?.region  || '';
  const country = raw.location?.country || '';
  const loc     = [city, region, country].filter(Boolean).join(', ');

  return {
    url:       `https://jobs.smartrecruiters.com/${company.slug}/${raw.id}`,
    title:     (raw.name || '').trim(),
    company:   company.name,
    location:  normalizeLocation(loc),
    remote:    raw.location?.remote === true || /remote/i.test(loc),
    ats:       ATS,
    posted_at: raw.releasedDate || null,
    raw,
  };
}
