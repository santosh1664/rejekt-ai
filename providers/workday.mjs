/**
 * providers/workday.mjs
 * POST https://{tenant}.{shard}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
 * No auth. Requires JSON body. Max 20/page.
 *
 * company.meta must contain: { tenant, shard, site }
 * Example: { tenant: 'nvidia', shard: 'wd5', site: 'NVIDIAExternalCareerSite' }
 *
 * Strategy: fetch with empty searchText to get ALL jobs (no keyword filter).
 * Workday returns up to 200 total per company before CDN throttling; cap at 10 pages.
 * opts.searchText narrows the board (job import uses it to find one posting past that cap).
 */
import { fetchJSON, normalizeLocation, sleep, INTER_REQUEST_DELAY_MS } from '../lib/http.mjs';

export const ATS    = 'workday';
const PAGE_SIZE     = 20;
const MAX_PAGES     = 10;

export async function fetchAll(company, opts = {}) {
  const { tenant, shard, site } = company.meta || {};
  if (!tenant || !shard || !site) {
    throw new Error(`Workday company ${company.name} missing meta.tenant/shard/site`);
  }

  const apiUrl = `https://${tenant}.${shard}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`;
  const seen   = new Map();   // externalPath → job (dedup across pages)
  let   offset = 0;
  let   total  = Infinity;

  for (let page = 0; page < MAX_PAGES && offset < total; page++) {
    if (opts.verbose) console.error(`  → POST ${apiUrl} offset=${offset}`);

    const data = await fetchJSON(apiUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ limit: PAGE_SIZE, offset, searchText: opts.searchText || '', appliedFacets: {} }),
      timeoutMs: 20_000,
    });

    if (!Array.isArray(data?.jobPostings)) break;
    if (page === 0) total = data.total ?? data.jobPostings.length;

    for (const raw of data.jobPostings) {
      const key = raw.externalPath || raw.title;
      if (!seen.has(key)) seen.set(key, normalize(raw, company, tenant, shard, site));
    }

    if (data.jobPostings.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    await sleep(INTER_REQUEST_DELAY_MS);
  }

  // Stopped at the page cap: the jobs past it weren't seen, which doesn't mean they're gone (freshness skips these)
  return Object.assign([...seen.values()], { truncated: seen.size < total && Number.isFinite(total) });
}

function normalize(raw, company, tenant, shard, site) {
  const loc = raw.locationsText || '';
  return {
    url:       raw.externalPath
                 ? `https://${tenant}.${shard}.myworkdayjobs.com/${site}${raw.externalPath}`   // externalPath is '/job/…'; the public page needs the site first
                 : '',
    title:     (raw.title || '').trim(),
    company:   company.name,
    location:  normalizeLocation(loc),
    remote:    /remote/i.test(loc),
    ats:       ATS,
    posted_at: postedAt(raw.postedOn),
    raw,
  };
}

// Workday gives relative text: "Posted Today", "Posted Yesterday", "Posted 3 Days Ago", "Posted 30+ Days Ago".
function postedAt(text) {
  const t = String(text || '').toLowerCase();
  const days = /today/.test(t) ? 0 : /yesterday/.test(t) ? 1 : +(t.match(/(\d+)\+?\s*day/) || [])[1];
  if (!Number.isFinite(days)) { const d = new Date(text); return isNaN(d) ? null : d.toISOString(); }
  return new Date(Date.now() - days * 864e5).toISOString();
}
