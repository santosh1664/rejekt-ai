/**
 * providers/oraclecloud.mjs
 * Oracle Fusion Cloud HCM "Candidate Experience" career sites.
 *
 * GET https://{host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions
 *       ?onlyData=true&expand=requisitionList.secondaryLocations
 *       &finder=findReqs;siteNumber={site},limit=25,offset={n},sortBy=POSTING_DATES_DESC
 * No auth — the same endpoint the public career site calls. Verified live
 * 2026-10-23 on jpmc.fa.oraclecloud.com / CX_1002 (7,242 jobs, 25 per page).
 *
 * company.slug = "{host}/{site}"  (e.g. "jpmc.fa.oraclecloud.com/CX_1002")
 * company.meta = { host, site }   (preferred when present)
 *
 * Large tenants list thousands of reqs, so pages are fetched newest-first
 * and capped (ORACLE_MAX_JOBS, default 1,000). The list carries a
 * short description only; PostedDate is date-only.
 */
import { fetchJSON, normalizeLocation, sleep, INTER_REQUEST_DELAY_MS } from '../lib/http.mjs';

export const ATS = 'oraclecloud';
// The API serves up to 200 per page in about the time it takes for 25 (1.6s vs 1.1s, measured), so 8x fewer requests.
const PAGE_SIZE = 200;
const MAX_PAGES = Math.ceil(parseInt(process.env.ORACLE_MAX_JOBS || '1000', 10) / PAGE_SIZE);

export function oracleTarget(company) {
  const [slugHost, slugSite] = String(company.slug || '').split('/');
  const host = company.meta?.host || slugHost;
  const site = company.meta?.site || slugSite;
  if (!host || !site) throw new Error(`Oracle Cloud company ${company.name} needs meta.host + meta.site (or slug "host/site")`);
  return { host, site };
}

export async function fetchAll(company, opts = {}) {
  const { host, site } = oracleTarget(company);
  const seen = new Map();
  let total = Infinity;
  for (let page = 0; page < MAX_PAGES && page * PAGE_SIZE < total; page++) {
    const offset = page * PAGE_SIZE;
    const url = `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions` +
      `?onlyData=true&expand=requisitionList.secondaryLocations` +
      `&finder=findReqs;siteNumber=${encodeURIComponent(site)},limit=${PAGE_SIZE},offset=${offset},sortBy=POSTING_DATES_DESC`;
    if (opts.verbose) console.error(`  → GET ${url}`);
    const data = await fetchJSON(url, { timeoutMs: 25_000 });
    const block = data?.items?.[0];
    const reqs = block?.requisitionList || [];
    if (page === 0) total = block?.TotalJobsCount ?? reqs.length;
    for (const r of reqs) if (!seen.has(r.Id)) seen.set(r.Id, normalize(r, company, host, site));
    if (reqs.length < PAGE_SIZE) break;
    await sleep(INTER_REQUEST_DELAY_MS);
  }
  return [...seen.values()];
}

function normalize(r, company, host, site) {
  const locs = [r.PrimaryLocation, ...(r.secondaryLocations || []).map(s => s.Name)].filter(Boolean);
  const loc = locs.join('; ');
  const workplace = `${r.WorkplaceType || ''} ${r.WorkplaceTypeCode || ''}`;
  const remote = /remote/i.test(workplace) || /remote/i.test(loc);
  return {
    url:       `https://${host}/hcmUI/CandidateExperience/en/sites/${site}/job/${r.Id}`,
    title:     (r.Title || '').trim(),
    company:   company.name,
    location:  normalizeLocation(loc),
    remote,
    ats:       ATS,
    posted_at: r.PostedDate ? new Date(`${r.PostedDate}T00:00:00Z`).toISOString() : null,
    countryCode: r.PrimaryLocationCountry || null,
    raw: { id: r.Id, ...r, description: r.ShortDescriptionStr || '' },
  };
}
