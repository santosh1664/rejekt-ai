/**
 * providers/rippling.mjs
 * GET https://api.rippling.com/platform/api/ats/v1/board/{slug}/jobs
 *   → [{ uuid, name, url, department, workLocation }]   (no dates/descriptions)
 * GET https://api.rippling.com/platform/api/ats/v1/board/{slug}/jobs/{uuid}
 *   → detail: createdOn, workLocations[], employmentType, description{company, role}
 * No auth. Verified live 2026-10-23 (aalo-atomics: 83 jobs).
 *
 * The list has no posted date or description, so details are fetched with
 * small concurrency. MAX_DETAILS caps cost per board; jobs beyond the cap
 * are still stored from the list data.
 */
import { fetchJSON, normalizeLocation, sleep, INTER_REQUEST_DELAY_MS } from '../lib/http.mjs';

export const ATS = 'rippling';
const API = 'https://api.rippling.com/platform/api/ats/v1/board';
const MAX_DETAILS = parseInt(process.env.RIPPLING_MAX_DETAILS || '300', 10);
const DETAIL_CONCURRENCY = 4;

export async function fetchAll(company, opts = {}) {
  const listUrl = `${API}/${encodeURIComponent(company.slug)}/jobs`;
  if (opts.verbose) console.error(`  → GET ${listUrl}`);
  const list = await fetchJSON(listUrl, { timeoutMs: 20_000 });
  const items = Array.isArray(list) ? list : [];

  const details = new Map();
  const queue = items.slice(0, MAX_DETAILS);
  const workers = Array.from({ length: DETAIL_CONCURRENCY }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        details.set(item.uuid, await fetchJSON(`${listUrl}/${item.uuid}`, { timeoutMs: 20_000 }));
      } catch (err) {
        if (opts.verbose) console.error(`  ⚠ rippling detail ${item.uuid}: ${err.message}`);
      }
      await sleep(INTER_REQUEST_DELAY_MS);
    }
  });
  await Promise.all(workers);

  return items.map(item => normalize(item, details.get(item.uuid), company));
}

function normalize(item, detail, company) {
  const locs = detail?.workLocations?.length ? detail.workLocations : [item.workLocation?.label].filter(Boolean);
  const loc = locs.join('; ');
  const description = detail?.description
    ? Object.values(detail.description).filter(v => typeof v === 'string').join('\n')
    : '';
  return {
    url:       item.url || detail?.url || `https://ats.rippling.com/${company.slug}/jobs/${item.uuid}`,
    title:     (item.name || detail?.name || '').trim(),
    company:   company.name || detail?.companyName,
    location:  normalizeLocation(loc),
    remote:    /remote/i.test(loc),
    ats:       ATS,
    posted_at: detail?.createdOn ? new Date(detail.createdOn).toISOString() : null,
    raw: {
      id: item.uuid, department: item.department?.label || detail?.department?.name || null,
      employment_type: detail?.employmentType?.id || null, payRangeDetails: detail?.payRangeDetails || [],
      description,
    },
  };
}
