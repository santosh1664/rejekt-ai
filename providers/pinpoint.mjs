/**
 * providers/pinpoint.mjs
 * GET https://{slug}.pinpointhq.com/postings.json
 * No auth. Returns { data: [...] } with descriptions and structured
 * compensation/workplace fields. No posted date is exposed.
 * Verified live 2026-10-23 (collab).
 */
import { fetchJSON, normalizeLocation } from '../lib/http.mjs';

export const ATS = 'pinpoint';

export async function fetchAll(company, opts = {}) {
  const url = `https://${company.slug}.pinpointhq.com/postings.json`;
  if (opts.verbose) console.error(`  → GET ${url}`);
  const data = await fetchJSON(url, { timeoutMs: 20_000 });
  return (Array.isArray(data?.data) ? data.data : []).map(p => normalize(p, company));
}

function normalize(raw, company) {
  const l = raw.location || {};
  const loc = [l.city || l.name, l.province].filter(Boolean).join(', ');
  const remote = raw.workplace_type === 'remote';
  const comp = raw.compensation_visible && (raw.compensation_minimum || raw.compensation_maximum)
    ? `Salary: ${raw.compensation_currency || ''} ${raw.compensation_minimum ?? ''} - ${raw.compensation_maximum ?? ''} ${raw.compensation_frequency || ''}`.replace(/\s+/g, ' ')
    : '';
  const sections = [
    raw.description,
    raw.key_responsibilities && `<h3>${raw.key_responsibilities_header || 'Key Responsibilities'}</h3>${raw.key_responsibilities}`,
    raw.skills_knowledge_expertise && `<h3>${raw.skills_knowledge_expertise_header || 'Skills'}</h3>${raw.skills_knowledge_expertise}`,
    raw.benefits && `<h3>${raw.benefits_header || 'Benefits'}</h3>${raw.benefits}`,
    comp,
  ].filter(Boolean);
  return {
    url:       raw.url || `https://${company.slug}.pinpointhq.com${raw.path}`,
    title:     (raw.title || '').trim(),
    company:   company.name,
    location:  normalizeLocation(remote ? (loc ? `${loc} (Remote)` : 'Remote') : loc),
    remote,
    ats:       ATS,
    posted_at: null,
    raw: { ...raw, description: sections.join('\n') },
  };
}
