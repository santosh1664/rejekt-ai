/**
 * providers/ashby.mjs
 * GET https://api.ashbyhq.com/posting-api/job-board/{slug}
 * No auth. Returns all listed jobs.
 */
import { fetchJSON, normalizeLocation } from '../lib/http.mjs';

export const ATS = 'ashby';

export async function fetchAll(company, opts = {}) {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${company.slug}`;
  if (opts.verbose) console.error(`  → GET ${url}`);

  const data = await fetchJSON(url, { timeoutMs: 20_000 });

  const jobs = (data?.jobs || []).filter((j) => j.isListed !== false);
  return jobs.map((j) => normalize(j, company));
}

function resolveRemote(raw) {
  // workplaceType wins over isRemote (Ashby bug: isRemote:true even on Hybrid)
  const wt = (raw.workplaceType || '').toLowerCase();
  if (wt === 'remote') return true;
  if (wt === 'onsite' || wt === 'hybrid') return false;
  return raw.isRemote === true;
}

function normalize(raw, company) {
  const remote = resolveRemote(raw);
  const loc    = raw.location || raw.locationName || '';
  return {
    url:       raw.jobUrl || '',
    title:     (raw.title || '').trim(),
    company:   company.name,
    location:  normalizeLocation(loc),
    remote,
    ats:       ATS,
    posted_at: raw.publishedDate || null,
    raw,
  };
}
