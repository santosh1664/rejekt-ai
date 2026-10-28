/**
 * providers/recruitee.mjs
 * GET https://{slug}.recruitee.com/api/offers
 * No auth. Returns every published offer in one response: { offers: [...] }.
 * Verified live 2026-10-23 (8westconsulting): published_at matches the posted
 * time Tsenta shows for the same job to the second.
 */
import { fetchJSON, normalizeLocation } from '../lib/http.mjs';

export const ATS = 'recruitee';

export async function fetchAll(company, opts = {}) {
  const url = `https://${company.slug}.recruitee.com/api/offers`;
  if (opts.verbose) console.error(`  → GET ${url}`);
  const data = await fetchJSON(url, { timeoutMs: 20_000 });
  const offers = Array.isArray(data?.offers) ? data.offers : [];
  return offers.filter(o => !o.status || o.status === 'published').map(o => normalize(o, company));
}

/** "2026-10-23 13:27:46 UTC" → ISO 8601 */
export function recruiteeDate(value) {
  if (!value) return null;
  const d = new Date(String(value).replace(' UTC', 'Z').replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function normalize(raw, company) {
  const place = [raw.city, raw.state_code || raw.state_name, raw.country].filter(Boolean).join(', ');
  const loc = raw.remote && !raw.city ? 'Remote' : (place || raw.location || '');
  return {
    url:       raw.careers_url || `https://${company.slug}.recruitee.com/o/${raw.slug}`,
    title:     (raw.title || '').trim(),
    company:   company.name || raw.company_name,
    location:  normalizeLocation(raw.remote ? `${loc}${loc && loc !== 'Remote' ? ' (Remote)' : ''}` : loc),
    remote:    raw.remote === true,
    ats:       ATS,
    posted_at: recruiteeDate(raw.published_at || raw.created_at),
    countryCode: raw.country_code || null,
    raw: { ...raw, description: [raw.description, raw.requirements].filter(Boolean).join('\n') },
  };
}
