/**
 * providers/greenhouse.mjs
 * GET https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true
 * No auth. Returns all open jobs. No pagination (single response).
 */
import { fetchJSON, normalizeLocation } from '../lib/http.mjs';

export const ATS = 'greenhouse';

export async function fetchAll(company, opts = {}) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${company.slug}/jobs?content=true`;
  if (opts.verbose) console.error(`  → GET ${url}`);

  const data = await fetchJSON(url, {
    headers: { 'User-Agent': 'rejekt-ai/2.0' },
  });

  if (!Array.isArray(data?.jobs)) return [];
  return data.jobs.map((j) => normalize(j, company));
}

// Generic office labels some companies use for distributed/remote-first
// hiring — not an actual location, so prefer more specific data when seen.
const GENERIC_LOCATION_LABELS = new Set([
  'distributed', 'hybrid', 'remote', 'flexible', 'in-office', 'various',
  'multiple locations', 'anywhere',
]);

function pickLocation(raw) {
  // Some boards attach a structured "Job Posting Location" custom field
  // (e.g. ["Los Angeles, US"]) that's far more reliable than location.name.
  const meta = Array.isArray(raw.metadata)
    ? raw.metadata.find(m => /location/i.test(m?.name || '') && m?.value)
    : null;
  if (meta) {
    const v = Array.isArray(meta.value) ? meta.value.join('; ') : meta.value;
    if (v) return String(v);
  }

  const primary = (raw.location?.name || '').trim();
  if (primary && !GENERIC_LOCATION_LABELS.has(primary.toLowerCase())) return primary;

  // location.name is a generic placeholder — the office(s) actually assigned
  // to the req are more specific (e.g. "Los Angeles, CA" instead of "Distributed").
  if (Array.isArray(raw.offices) && raw.offices.length > 0) {
    const names = raw.offices.map(o => o?.name).filter(Boolean);
    if (names.length > 0) return names.join('; ');
  }

  return primary;
}

function normalize(raw, company) {
  const loc = pickLocation(raw);
  return {
    url:       raw.absolute_url || '',
    title:     (raw.title || '').trim(),
    company:   company.name,
    location:  normalizeLocation(loc),
    remote:    /remote/i.test(loc),
    ats:       ATS,
    posted_at: raw.updated_at || null,
    raw,
  };
}
