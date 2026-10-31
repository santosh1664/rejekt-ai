/**
 * providers/workable.mjs
 * GET https://apply.workable.com/api/v3/accounts/{slug}/jobs
 * Public API — no auth needed.
 * Workable uses cursor-based pagination: response.nextCursor
 *
 * Request body (POST): { query: '', location: [], remote: [], department: [], worktype: [], limit: 10 }
 * Actually it's a POST to get jobs list.
 *
 * Alternative simpler GET:
 * GET https://{slug}.workable.com/spi/v3/jobs  (requires bearer token — not public)
 *
 * Use the public apply API instead:
 * POST https://apply.workable.com/api/v3/accounts/{slug}/jobs
 */
import { fetchJSON, normalizeLocation, sleep, INTER_REQUEST_DELAY_MS } from '../lib/http.mjs';

export const ATS    = 'workable';
const MAX_PAGES     = 50;

// Workable blocks an IP at roughly 60 requests/min (HTTP 429), no matter how many workers run,
// so every Workable request goes through a shared gate per host: 1 per WORKABLE_GAP_MS.
// apply.workable.com and jobs.workable.com are blocked separately, so a block on one must not stall the other.
const GAP_MS = +(process.env.WORKABLE_GAP_MS || 1100);
const hosts = new Map();   // host → { nextSlot, blockedUntil, backoff }
async function gate(h) {
  const now = Date.now(); const at = Math.max(now, h.nextSlot); h.nextSlot = at + GAP_MS;
  if (at > now) await sleep(at - now);
}
// A short 429 (Retry-After ≤ 10 min) pauses the host and the request is retried; each 429 in a row doubles
// the pause (1 → 2 → 4 … 10 min), a success resets it. A long one (apply.workable.com sends hours) marks the
// host blocked: its requests fail at once (429, so the company isn't penalized and is retried next run)
// instead of holding the Workable workers. Failing fast on short blocks too drained the whole queue in a minute.
async function workableJSON(url, opts) {
  const host = new URL(url).host;
  if (!hosts.has(host)) hosts.set(host, { nextSlot: 0, blockedUntil: 0, backoff: 60_000 });
  const h = hosts.get(host);
  const blocked = () => { if (Date.now() < h.blockedUntil) throw new Error(`HTTP 429 (${host} blocked, retry next run)`); };
  for (let attempt = 0; ; attempt++) {
    blocked();
    await gate(h);
    blocked();
    try { const data = await fetchJSON(url, { ...opts, retries: 0 }); h.backoff = 60_000; return data; }
    catch (err) {
      if (!/429/.test(err.message)) throw err;
      const retryAfter = +(err.message.match(/Retry-After (\d+)/)?.[1] || 0) * 1000;
      if (retryAfter > 600_000) { h.blockedUntil = Date.now() + retryAfter; throw err; }
      h.nextSlot = Math.max(h.nextSlot, Date.now() + Math.max(retryAfter, h.backoff)); h.backoff = Math.min(h.backoff * 2, 600_000);
      if (attempt >= 2) throw err;
    }
  }
}

// Companies from jobs.workable.com (slug = its 22-char company id, meta.companyId = uuid) have no
// apply.workable.com account name, so search that API by company name and keep only their own jobs.
async function fetchHosted(company, opts) {
  // One request: the company page lists all its jobs. Fall back to the name search only if it's cut short.
  const page = await workableJSON(`https://jobs.workable.com/api/v1/companies/${company.slug}`, { timeoutMs: 20_000 });
  if (page && Array.isArray(page.jobs) && page.jobs.length >= (page.totalSize || 0)) return page.jobs.map(j => normalizeHosted(j, company));
  return searchHosted(company, opts);
}

async function searchHosted(company, opts) {
  const { companyId, expected = 0 } = company.meta || {};
  const out = [];
  let token = null;
  for (let page = 0; page < 15; page++) {
    const q = new URLSearchParams({ query: company.name });
    if (token) q.set('pageToken', token);
    const data = await workableJSON(`https://jobs.workable.com/api/v1/jobs?${q}`, { timeoutMs: 20_000 });
    for (const j of data?.jobs || []) if (j.company?.id === companyId) out.push(normalizeHosted(j, company));
    token = data?.nextPageToken;
    if (!token || (expected && out.length >= expected)) break;
    await sleep(INTER_REQUEST_DELAY_MS);
  }
  return out;
}

function normalizeHosted(j, company) {
  const loc = (j.locations || []).find(l => l !== 'TELECOMMUTE') || [j.location?.city, j.location?.subregion, j.location?.countryName].filter(Boolean).join(', ');
  return {
    url: j.url, title: (j.title || '').trim(), company: company.name, location: normalizeLocation(loc),
    remote: j.workplace === 'remote' || (j.locations || []).includes('TELECOMMUTE') || /remote/i.test(loc), ats: ATS, posted_at: j.created || null,
    raw: { ...j, description: undefined, company: undefined },
  };
}

export async function fetchAll(company, opts = {}) {
  if (company.meta?.companyId) return fetchHosted(company, opts);
  const url  = `https://apply.workable.com/api/v3/accounts/${company.slug}/jobs`;
  const all  = [];
  let   cursor = null;
  let   pages  = 0;

  do {
    if (opts.verbose) console.error(`  → POST ${url} cursor=${cursor ?? 'start'}`);

    // Workable's API now rejects an explicit `limit` field ({"limit":"Not allowed"}) —
    // page size is fixed server-side; only pass the cursor token.
    const body = { query: '', location: [], remote: [], department: [], worktype: [] };
    if (cursor) body.token = cursor;

    const data = await workableJSON(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      timeoutMs: 20_000,
    });

    const results = data?.results ?? [];
    for (const raw of results) all.push(normalize(raw, company));

    cursor = data?.nextPage ?? data?.nextCursor ?? null;   // API returns `nextPage`; it was read as `nextCursor`, so only page 1 (10 jobs) was ever fetched
    pages++;

    if (cursor) await sleep(INTER_REQUEST_DELAY_MS);
  } while (cursor && pages < MAX_PAGES);

  return all;
}

function normalize(raw, company) {
  const loc = [raw.city, raw.state, raw.country].filter(Boolean).join(', ');
  return {
    url:       raw.url || `https://apply.workable.com/${company.slug}/j/${raw.shortcode}/`,
    title:     (raw.title || '').trim(),
    company:   company.name,
    location:  normalizeLocation(loc),
    remote:    raw.remote === true || /remote/i.test(loc),
    ats:       ATS,
    posted_at: raw.published_on || null,
    raw,
  };
}
