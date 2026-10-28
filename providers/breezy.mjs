/**
 * providers/breezy.mjs
 * GET https://{slug}.breezy.hr/json
 * No auth. Returns a JSON array of published positions (no description).
 * Verified live 2026-10-23 (motivosity): published_date matches the posted
 * time Tsenta shows for the same job.
 */
import { fetchJSON, normalizeLocation } from '../lib/http.mjs';

export const ATS = 'breezy';

export async function fetchAll(company, opts = {}) {
  const url = `https://${company.slug}.breezy.hr/json`;
  if (opts.verbose) console.error(`  → GET ${url}`);
  const data = await fetchJSON(url, { timeoutMs: 20_000 });
  return (Array.isArray(data) ? data : []).map(j => normalize(j, company));
}

function placeName(l) {
  if (!l) return '';
  if (l.city || l.state) return [l.city, l.state?.id || l.state?.name, l.country?.id === 'US' ? null : l.country?.name].filter(Boolean).join(', ');
  return l.name || l.country?.name || '';
}

function normalize(raw, company) {
  const locs = (raw.locations?.length ? raw.locations : [raw.location]).filter(Boolean);
  const remote = locs.some(l => l.is_remote) || /remote/i.test(raw.location?.name || '');
  const loc = locs.map(placeName).filter(Boolean).join('; ');
  const country = raw.location?.country?.id || null;
  return {
    url:       raw.url || `https://${company.slug}.breezy.hr/p/${raw.friendly_id}`,
    title:     (raw.name || '').trim(),
    company:   company.name || raw.company?.name,
    location:  normalizeLocation(remote && !/remote/i.test(loc) ? `${loc} (Remote)`.trim() : loc),
    remote,
    ats:       ATS,
    posted_at: raw.published_date || null,
    countryCode: country,
    raw: { ...raw, employment_type: raw.type?.name || null },
  };
}
