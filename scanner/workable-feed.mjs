/**
 * scanner/workable-feed.mjs — Workable's public XML feed of every job (www.workable.com/boards/workable.xml,
 * ~170k jobs, ~900 MB, ~30 s), streamed and parsed job by job.
 *
 * Adds the companies we don't scan one by one: jobs from Workable companies we already scan are skipped
 * (matched by job code or company name), so those keep their per-company scan and nothing is duplicated.
 * The rest are grouped by company name into companies with meta.feed (slug "feed/<name>"), which get their
 * jobs only from here. Workable allows about one download an hour (429 otherwise): one per scan run.
 */
import { query } from '../lib/db.mjs';
import { normalizeLocation } from '../lib/http.mjs';
import { isJobInCoverage } from '../lib/geo.mjs';

const FEED_URL = process.env.WORKABLE_FEED_URL || 'https://www.workable.com/boards/workable.xml';
// <country> is an ISO code; spelled out, or "IN" (India) reads as Indiana, "ID" as Idaho, "PA" as Pennsylvania…
const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });
const countryName = (code) => { try { return countryNames.of(code.toUpperCase()) || code; } catch { return code; } };
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const field = (xml, tag) => xml.match(new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>)?\\s*</${tag}>`))?.[1]?.trim() ?? '';

/** Yields each <job>…</job> block of the feed as a string, without holding the file in memory. */
async function* jobBlocks(res) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buf.indexOf('</job>')) !== -1) {
      const start = buf.indexOf('<job>');
      if (start !== -1 && start < end) yield buf.slice(start, end);
      buf = buf.slice(end + 6);
    }
  }
}

export function parseJob(xml) {
  const url = field(xml, 'url');
  const loc = [field(xml, 'city'), field(xml, 'state'), field(xml, 'country') && countryName(field(xml, 'country'))].filter(Boolean).join(', ');
  const date = new Date(field(xml, 'date'));
  return {
    code: url.split('/').pop().toUpperCase(),
    companyName: field(xml, 'company'),
    job: {
      url, title: field(xml, 'title'), company: field(xml, 'company'), location: normalizeLocation(loc),
      remote: field(xml, 'remote') === 'true' || /remote/i.test(loc), ats: 'workable',
      posted_at: isNaN(date) ? null : date.toISOString(),
      // ponytail: descriptions are kept in memory until the run processes them; capped so ~100k jobs fit
      raw: { id: field(xml, 'referencenumber'), description: field(xml, 'description').slice(0, 30_000) },
    },
  };
}

/** @returns {Promise<Array<{company, jobs}>>} feed-only companies (upserted) with their jobs */
export async function loadWorkableFeed({ verbose } = {}) {
  const started = Date.now();
  const res = await fetch(FEED_URL, { headers: { 'User-Agent': 'rejekt-ai/1.0' } });
  if (!res.ok) throw new Error(`Workable feed HTTP ${res.status}${res.headers.get('retry-after') ? ` (Retry-After ${res.headers.get('retry-after')}s)` : ''}`);

  // What we already scan per company: their job codes, and their names
  const { rows: known } = await query(`
    SELECT c.name, (c.meta ? 'feed') AS feed, j.url FROM companies c
      LEFT JOIN jobs j ON j.company_id = c.id AND j.active
     WHERE c.ats = 'workable'`);
  const knownCodes = new Set(known.map(r => r.url?.match(/\/j\/([A-Z0-9]+)/i)?.[1]?.toUpperCase()).filter(Boolean));
  const scannedNames = new Set(known.filter(r => !r.feed).map(r => norm(r.name)));

  const byCompany = new Map();
  let total = 0, kept = 0;
  for await (const xml of jobBlocks(res)) {
    total++;
    const { code, companyName, job } = parseJob(xml);
    if (!companyName || !job.url || !job.title || knownCodes.has(code) || scannedNames.has(norm(companyName))) continue;
    if (!isJobInCoverage(job)) continue;
    const key = norm(companyName);
    if (!byCompany.has(key)) byCompany.set(key, { name: companyName, jobs: [] });
    byCompany.get(key).jobs.push(job);
    kept++;
  }

  const groups = [...byCompany.entries()];
  const { rows: companies } = await query(`
    INSERT INTO companies (name, ats, slug, meta, discovered)
    SELECT n, 'workable', s, '{"feed": true}'::jsonb, NOW() FROM unnest($1::text[], $2::text[]) AS t(n, s)
    ON CONFLICT (ats, slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id, name, ats, slug, meta, active`,
    [groups.map(([, g]) => g.name), groups.map(([key]) => `feed/${key.replace(/ /g, '-')}`)]);
  const bySlug = new Map(companies.map(c => [c.slug, c]));

  console.error(`   📰  Workable feed: ${total.toLocaleString()} jobs in ${((Date.now() - started) / 1000).toFixed(0)}s, ` +
    `${kept.toLocaleString()} new-to-us in our regions from ${groups.length.toLocaleString()} companies`);
  return groups
    .map(([key, g]) => ({ company: bySlug.get(`feed/${key.replace(/ /g, '-')}`), jobs: g.jobs }))
    .filter(x => x.company?.active);
}

// Self-check: node scanner/workable-feed.mjs --check
if (process.argv[1]?.endsWith('workable-feed.mjs') && process.argv.includes('--check')) {
  const { job, code, companyName } = parseJob(`<job><title><![CDATA[ Engineer ]]></title><date><![CDATA[Wed, 28 Oct 2026 10:24:17 UTC]]></date>
    <referencenumber><![CDATA[F44ED9E40A]]></referencenumber><url><![CDATA[https://apply.workable.com/j/F44ED9E40A]]></url>
    <company><![CDATA[Acme]]></company><city><![CDATA[Austin]]></city><state><![CDATA[TX]]></state><country><![CDATA[US]]></country>
    <remote><![CDATA[true]]></remote><description><![CDATA[<p>Hi</p>]]></description>`);
  console.assert(code === 'F44ED9E40A' && companyName === 'Acme' && job.title === 'Engineer' && job.remote === true, 'parse');
  console.assert(job.posted_at === '2026-10-28T10:24:17.000Z' && job.raw.description === '<p>Hi</p>', 'date/description');
  console.assert(job.location.includes('United States'), 'country spelled out');
  console.log('ok', job.location);
}
