/**
 * providers/dover.mjs
 * The public API behind Dover's own careers pages, no auth:
 *   GET https://app.dover.com/api/v1/careers-page/{clientId}/jobs               → { results: [{ id, title, locations, workplace_type }], next }
 *   GET https://app.dover.com/api/v1/inbound/application-portal-job/{jobId}     → description, compensation, visa_support, created
 * The list has no description, so each job costs one more request (companies here have a handful of jobs).
 * company.slug is Dover's client id (a UUID), not the name in the apply URL; the apply URL works with any name in that spot.
 * Verified live 2026-11-02 (Akomi). Internal API, not documented by Dover: if it changes, the scan shows errors for this ATS.
 */
import { fetchJSON, normalizeLocation, sleep, INTER_REQUEST_DELAY_MS } from '../lib/http.mjs';

export const ATS = 'dover';
const API = 'https://app.dover.com/api/v1';

export async function fetchAll(company, opts = {}) {
  const list = [];
  for (let url = `${API}/careers-page/${company.slug}/jobs`, pages = 0; url && pages < 10; pages++) {
    if (opts.verbose) console.error(`  → GET ${url}`);
    const page = await fetchJSON(url, { timeoutMs: 20_000 });
    list.push(...(page?.results || []).filter(j => j.is_published !== false && !j.is_sample));
    url = page?.next || null;
  }
  const jobs = [];
  for (const j of list) {
    await sleep(INTER_REQUEST_DELAY_MS);
    const d = await fetchJSON(`${API}/inbound/application-portal-job/${j.id}`, { timeoutMs: 20_000 }).catch(() => null);
    if (d && (d.active === false || d.is_private)) continue;
    jobs.push(normalize(j, d || {}, company));
  }
  return jobs;
}

export function money(c) {
  if (!c || (!c.lower_bound && !c.upper_bound)) return '';
  const per = { YEARLY: 'yearly', HOURLY: 'hourly', MONTHLY: 'monthly' }[c.salary_range_type] || 'yearly';
  return `Salary: ${c.currency_code || 'USD'} ${c.lower_bound ?? ''} - ${c.upper_bound ?? ''} ${per}`.replace(/\s+/g, ' ');
}

function normalize(j, d, company) {
  const places = (j.locations?.length ? j.locations : d.locations || []).map(l => l.name || l.location_option?.display_name).filter(Boolean);
  const remote = (j.workplace_type || d.workplace_type) === 'REMOTE';
  const loc = places.join('; ') || d.location || '';
  const sections = [d.user_provided_description, money(d.compensation), d.visa_support ? 'Visa sponsorship is available.' : ''].filter(Boolean);
  return {
    url:       `https://app.dover.com/apply/${company.slug}/${j.id}`,
    title:     (j.title || d.title || '').trim(),
    company:   company.name || d.client_name,
    location:  normalizeLocation(remote ? (loc ? `${loc} (Remote)` : 'Remote') : loc),
    remote,
    ats:       ATS,
    posted_at: d.created ? new Date(d.created).toISOString() : null,
    countryCode: j.locations?.[0]?.location_option?.country || null,
    raw: { ...d, description: sections.join('\n') },
  };
}
