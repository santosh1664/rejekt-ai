/**
 * lib/ats-detect.mjs
 *
 * Recognizes which ATS a job or careers URL belongs to and extracts what the
 * matching provider needs (slug / meta) plus the job's own id when present.
 * Used by "add a job by link" (lib/job-import.mjs) — the same idea as
 * Tsenta's paste-a-link flow, which recognizes ~45 ATS hosts and answers
 * ATS_NOT_SUPPORTED for the rest (see docs/job-sourcing.md).
 *
 *   detectAts('https://jobs.ashbyhq.com/legora/c3c6…')
 *   → { ats: 'ashby', supported: true, slug: 'legora', meta: {}, jobId: 'c3c6…' }
 *
 * Pure: no network or DB access.
 */

const lower = s => (s || '').toLowerCase();

/** Hosts we recognize but can't scan yet (no public, auth-free board API). */
const KNOWN_UNSUPPORTED = [
  [/(^|\.)icims\.com$/, 'icims'], [/(^|\.)taleo\.net$/, 'taleo'], [/(^|\.)(successfactors\.(com|eu)|sapsf\.(com|eu)|jobs\.hr\.cloud\.sap)$/, 'successfactors'],
  [/(^|\.)jobvite\.com$/, 'jobvite'], [/(^|\.)zohorecruit\.(com|in|eu)$/, 'zohorecruit'], [/(^|\.)paylocity\.com$/, 'paylocity'],
  [/(^|\.)ultipro\.com$/, 'ultipro'], [/(^|\.)adp\.com$/, 'adp'], [/(^|\.)dover\.com$/, 'dover'], [/(^|\.)gem\.com$/, 'gem'],
  [/(^|\.)eightfold\.ai$/, 'eightfold'], [/(^|\.)avature\.net$/, 'avature'], [/(^|\.)phenom\.com$/, 'phenom'],
  [/(^|\.)brassring\.com$/, 'brassring'], [/(^|\.)csod\.com$/, 'csod'], [/(^|\.)dayforcehcm\.com$/, 'dayforce'],
  [/(^|\.)gusto\.com$/, 'gusto'], [/(^|\.)careerplug\.com$/, 'careerplug'], [/(^|\.)wizehire\.com$/, 'wizehire'],
  [/(^|\.)personio\.(de|com)$/, 'personio'], [/(^|\.)apploi\.com$/, 'apploi'], [/(^|\.)(paycomonline|paycomdfw)\.net$/, 'paycom'],
  [/(^|\.)recruitingbypaycor\.com$/, 'paycor'], [/(^|\.)polymer\.co$/, 'polymer'], [/(^|\.)(applytojob|jazzhr)\.com$/, 'jazzhr'],
  [/(^|\.)linkedin\.com$/, 'linkedin'], [/(^|\.)indeed\.com$/, 'indeed'], [/(^|\.)naukri\.com$/, 'naukri'],
];

const RESERVED_SUBDOMAINS = new Set(['www', 'app', 'api', 'help', 'support', 'blog', 'jobs', 'careers', 'marketplace']);
const sub = (host, domain) => {
  const m = host.match(new RegExp(`^([a-z0-9-]+)\\.${domain.replace(/\./g, '\\.')}$`));
  return m && !RESERVED_SUBDOMAINS.has(m[1]) ? m[1] : null;
};

/**
 * @param {string} input
 * @returns {null | { ats: string, supported: boolean, slug?: string, meta?: object, jobId?: string|null, host: string }}
 *   null when the input isn't an http(s) URL.
 */
export function detectAts(input) {
  let u;
  try { u = new URL(String(input).trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = lower(u.hostname);
  const parts = u.pathname.split('/').filter(Boolean);
  const ok = (ats, slug, jobId = null, meta = {}) => ({ ats, supported: true, slug, meta, jobId: jobId || null, host });

  // Greenhouse: boards.greenhouse.io/{slug}/jobs/{id}, job-boards(.eu).greenhouse.io/…, embed?for={slug}&token={id}
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    const forParam = u.searchParams.get('for');
    if (forParam) return ok('greenhouse', lower(forParam), u.searchParams.get('token'));
    if (parts[0] && parts[0] !== 'embed') return ok('greenhouse', lower(parts[0]), parts[1] === 'jobs' ? parts[2] : null);
  }
  // Lever: jobs.lever.co/{slug}/{uuid}  (also jobs.eu.lever.co)
  if (/^jobs(\.eu)?\.lever\.co$/.test(host) && parts[0]) return ok('lever', lower(parts[0]), parts[1]);
  // Ashby: jobs.ashbyhq.com/{slug}/{uuid}
  if (host === 'jobs.ashbyhq.com' && parts[0]) return ok('ashby', lower(parts[0]), parts[1]);
  // SmartRecruiters: jobs.smartrecruiters.com/{Company}/{id-slug}
  if (host === 'jobs.smartrecruiters.com' && parts[0]) return ok('smartrecruiters', lower(parts[0]), parts[1]?.split('-')[0]);
  // Workable: apply.workable.com/{slug}/j/{shortcode}
  if (host === 'apply.workable.com' && parts[0] && parts[0] !== 'api') return ok('workable', lower(parts[0]), parts[1] === 'j' ? parts[2] : null);
  // BambooHR: {slug}.bamboohr.com/careers/{id}
  { const s = sub(host, 'bamboohr.com'); if (s) return ok('bamboohr', s, parts[0] === 'careers' && /^\d+$/.test(parts[1] || '') ? parts[1] : null); }
  // Workday: {tenant}.{shard}.myworkdayjobs.com/{locale?}/{site}/job/…/{title}_{reqId}
  { const m = host.match(/^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/);
    if (m) {
      const p = /^[a-z]{2}-[A-Z]{2}$/.test(parts[0] || '') ? parts.slice(1) : parts;
      const site = p[0];
      if (site) {
        const last = p[p.length - 1] || '';
        const req = p.includes('job') ? (last.match(/_([A-Za-z0-9-]+)$/)?.[1] ?? null) : null;
        return ok('workday', `${m[1]}/${site}`, req, { tenant: m[1], shard: m[2], site });
      }
    } }
  // Recruitee: {slug}.recruitee.com/o/{offer-slug}
  { const s = sub(host, 'recruitee.com'); if (s) return ok('recruitee', s, parts[0] === 'o' ? parts[1] : null); }
  // Breezy: {slug}.breezy.hr/p/{id}-{title}
  { const s = sub(host, 'breezy.hr'); if (s) return ok('breezy', s, parts[0] === 'p' ? parts[1]?.split('-')[0] : null); }
  // Pinpoint: {slug}.pinpointhq.com/{lang}/postings/{uuid}
  { const s = sub(host, 'pinpointhq.com'); if (s) { const i = parts.indexOf('postings'); return ok('pinpoint', s, i >= 0 ? parts[i + 1] : null); } }
  // Rippling: ats.rippling.com/{locale?}/{slug}/jobs/{uuid}
  if (host === 'ats.rippling.com') {
    const p = /^[a-z]{2}-[A-Z]{2}$/.test(parts[0] || '') ? parts.slice(1) : parts;
    if (p[0]) return ok('rippling', lower(p[0]), p[1] === 'jobs' ? p[2] : null);
  }
  // Teamtailor: {slug}.teamtailor.com/jobs/{id}-{title}
  { const s = sub(host, 'teamtailor.com'); if (s) return ok('teamtailor', s, parts[0] === 'jobs' ? parts[1]?.split('-')[0] : null); }
  // Oracle Cloud HCM: {host}/hcmUI/CandidateExperience/{lang}/sites/{site}/job/{id}
  if (/\.oraclecloud\.com$/.test(host)) {
    const i = parts.indexOf('sites');
    const site = i >= 0 ? parts[i + 1] : null;
    if (site) {
      const j = parts.indexOf('job');
      return ok('oraclecloud', `${host}/${site}`, j >= 0 ? parts[j + 1] : null, { host, site });
    }
  }

  for (const [re, ats] of KNOWN_UNSUPPORTED) if (re.test(host)) return { ats, supported: false, host };
  // Ashby/Greenhouse-style hosts we know but couldn't parse (e.g. a bare
  // jobs.ashbyhq.com) and every unknown site land here.
  return { ats: null, supported: false, host };
}

/** Names of every ATS the scanner can fetch from — for UI copy and docs. */
export const SUPPORTED_ATS = ['greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters', 'workable', 'bamboohr',
  'recruitee', 'breezy', 'pinpoint', 'rippling', 'teamtailor', 'oraclecloud'];
