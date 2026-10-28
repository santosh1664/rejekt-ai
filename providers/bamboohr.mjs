/**
 * providers/bamboohr.mjs
 * GET https://{slug}.bamboohr.com/jobs/embed2.php
 *   → HTML page (not JSON) — fall back to JSON endpoint
 * GET https://api.bamboohr.com/api/gateway.php/{slug}/v1/applicant_tracking/job_openings
 *   → requires API key (not public)
 *
 * Public approach: scrape the embed2.php JSON feed:
 * GET https://{slug}.bamboohr.com/careers/list  → JSON array of jobs
 *
 * BambooHR also exposes:
 * GET https://{slug}.bamboohr.com/careers        → HTML page
 * GET https://{slug}.bamboohr.com/careers/list   → JSON: [{id, jobOpeningName, location, ...}]
 */
import { fetchJSON, normalizeLocation } from '../lib/http.mjs';

export const ATS = 'bamboohr';

export async function fetchAll(company, opts = {}) {
  const url = `https://${company.slug}.bamboohr.com/careers/list`;
  if (opts.verbose) console.error(`  → GET ${url}`);

  const data = await fetchJSON(url, {
    headers: { 'User-Agent': 'rejekt-ai/2.0' },
    timeoutMs: 20_000,
  });

  // Response is a JSON array directly
  const jobs = Array.isArray(data) ? data : (data?.result ?? []);
  return jobs.map((j) => normalize(j, company));
}

function normalize(raw, company) {
  const loc = raw.location?.city
    ? `${raw.location.city}${raw.location.state ? ', ' + raw.location.state : ''}`
    : raw.location?.label || '';

  return {
    url:       `https://${company.slug}.bamboohr.com/careers/${raw.id}`,
    title:     (raw.jobOpeningName || raw.title || '').trim(),
    company:   company.name,
    location:  normalizeLocation(loc),
    remote:    raw.isRemote === true || /remote/i.test(loc),
    ats:       ATS,
    posted_at: raw.datePosted || null,
    raw,
  };
}
