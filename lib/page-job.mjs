/**
 * lib/page-job.mjs
 *
 * Reads ONE job straight from its public page, for any job board: the
 * schema.org JobPosting JSON-LD that Workday, iCIMS, Taleo, Greenhouse,
 * LinkedIn and most career sites embed for Google Jobs, falling back to the
 * page's title/description meta tags. Used by "add a job by link"
 * (lib/job-import.mjs) when the board has no scannable API or the posting
 * isn't in what the API returns.
 */
import { fetchText } from './http.mjs';

const UA = 'Mozilla/5.0 (compatible; RejektBot/1.0; +job-import)';

const meta = (html, key) => html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i'))?.[1]
  ?? html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`, 'i'))?.[1] ?? null;
const unescapeHtml = s => String(s ?? '').replace(/&(amp|lt|gt|quot|#39|apos);/g, (_, c) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" })[c]);

/** Every JobPosting object inside the page's ld+json blocks (handles arrays and @graph). */
export function findJobPostings(html) {
  const out = [];
  const walk = n => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    const t = [].concat(n['@type'] || []);
    if (t.includes('JobPosting')) out.push(n);
    if (n['@graph']) walk(n['@graph']);
  };
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walk(JSON.parse(m[1].trim())); } catch { /* malformed block: skip */ }
  }
  return out;
}

function locationOf(p) {
  const places = [].concat(p.jobLocation || []);
  const text = places.map(l => {
    const a = l?.address || {};
    return [a.addressLocality, a.addressRegion, typeof a.addressCountry === 'object' ? a.addressCountry?.name : a.addressCountry].filter(Boolean).join(', ');
  }).filter(Boolean).join(' | ');
  return text || (p.applicantLocationRequirements ? [].concat(p.applicantLocationRequirements).map(r => r?.name).filter(Boolean).join(' | ') : '');
}

/** @returns {Promise<null | {title, company, location, remote, posted_at, description}>} */
export async function fetchJobFromPage(url) {
  let html;
  try { html = await fetchText(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, timeoutMs: 20_000 }); }
  catch { return null; }
  const p = findJobPostings(html)[0];
  if (p) {
    const location = locationOf(p);
    return {
      title: unescapeHtml(p.title || '').trim(),
      company: unescapeHtml(p.hiringOrganization?.name || '').trim() || null,
      location,
      remote: /TELECOMMUTE/i.test(p.jobLocationType || '') || /remote/i.test(location),
      posted_at: p.datePosted ? new Date(p.datePosted).toISOString() : null,
      description: p.description || '',
    };
  }
  const title = unescapeHtml(meta(html, 'og:title') || html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '').trim();
  const description = unescapeHtml(meta(html, 'og:description') || meta(html, 'description') || '');
  // ponytail: tag-only fallback gives a thin description; a user-pasted JD overrides it.
  return title ? { title, company: unescapeHtml(meta(html, 'og:site_name') || '').trim() || null, location: '', remote: false, posted_at: null, description } : null;
}
