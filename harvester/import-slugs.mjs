/**
 * harvester/import-slugs.mjs
 *
 * Validates and seeds harvested company slugs for the "subdomain" ATSs and
 * Oracle Cloud HCM, from harvester/data/ats-slugs.json (produced by an
 * Internet Archive / Common Crawl sweep).
 *
 *   bamboohr    {slug}.bamboohr.com/careers/list        JSON array | {result}
 *   recruitee   {slug}.recruitee.com/api/offers         {offers: []}
 *   breezy      {slug}.breezy.hr/json                   []
 *   pinpoint    {slug}.pinpointhq.com/postings.json     {data: []}
 *   rippling    api.rippling.com/…/board/{slug}/jobs    []
 *   teamtailor  {slug}.teamtailor.com/jobs.rss          RSS
 *   oraclecloud {host}/hcmRestApi/…recruitingCEJobRequisitions?siteNumber={site}
 *               slug "{host}/{site}", meta { host, site }
 *
 * A slug is "live" when its endpoint answers with the shape the provider
 * parses. --min-jobs (default 1) drops boards that are live but empty.
 *
 * Usage:
 *   node --env-file=.env.local harvester/import-slugs.mjs [--ats bamboohr]
 *        [--dry-run] [--min-jobs 1] [--min-hits 1] [--limit N] [--concurrency 16] [--verbose]
 *
 *   --dry-run   validate only; writes harvester/data/ats-live.json, no DB writes
 */

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs }     from 'node:util';
import { fetchJSON, fetchText } from '../lib/http.mjs';

const HERE      = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(HERE, 'data', 'ats-slugs.json');
const LIVE_FILE = path.join(HERE, 'data', 'ats-live.json');
const UA        = { 'User-Agent': 'rejekt-ai/2.0' };

// Each probe returns the number of open jobs, or null when the board isn't live.
const PROBES = {
  bamboohr: async (s) => {
    const d = await fetchJSON(`https://${s}.bamboohr.com/careers/list`, { headers: UA, timeoutMs: 15_000, retries: 1 });
    const jobs = Array.isArray(d) ? d : d?.result;
    return Array.isArray(jobs) ? jobs.length : null;
  },
  recruitee: async (s) => {
    const d = await fetchJSON(`https://${s}.recruitee.com/api/offers`, { headers: UA, timeoutMs: 15_000, retries: 1 });
    return Array.isArray(d?.offers) ? d.offers.filter(o => !o.status || o.status === 'published').length : null;
  },
  breezy: async (s) => {
    const d = await fetchJSON(`https://${s}.breezy.hr/json`, { headers: UA, timeoutMs: 15_000, retries: 1 });
    return Array.isArray(d) ? d.length : null;
  },
  pinpoint: async (s) => {
    const d = await fetchJSON(`https://${s}.pinpointhq.com/postings.json`, { headers: UA, timeoutMs: 15_000, retries: 1 });
    return Array.isArray(d?.data) ? d.data.length : null;
  },
  rippling: async (s) => {
    const d = await fetchJSON(`https://api.rippling.com/platform/api/ats/v1/board/${encodeURIComponent(s)}/jobs`, { headers: UA, timeoutMs: 15_000, retries: 1 });
    return Array.isArray(d) ? d.length : null;
  },
  teamtailor: async (s) => {
    const x = await fetchText(`https://${s}.teamtailor.com/jobs.rss`, { headers: UA, timeoutMs: 15_000, retries: 1 });
    return /<rss[\s>]/i.test(x) ? (x.match(/<item[\s>]/gi) || []).length : null;
  },
  oraclecloud: async (_s, e) => {
    const url = `https://${e.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions` +
      `?onlyData=true&finder=findReqs;siteNumber=${encodeURIComponent(e.site)},limit=1,offset=0`;
    const d = await fetchJSON(url, { headers: UA, timeoutMs: 20_000, retries: 1 });
    const block = d?.items?.[0];
    return block ? (block.TotalJobsCount ?? (block.requisitionList || []).length) : null;
  },
};

function slugOf(ats, e) { return ats === 'oraclecloud' ? `${e.host}/${e.site}` : e.slug; }

function prettyName(ats, e) {
  let base = e.slug || e.host?.split('.')[0] || '';
  return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}

async function main() {
  const { values: f } = parseArgs({ options: {
    ats:         { type: 'string' },
    'dry-run':   { type: 'boolean', default: false },
    'min-jobs':  { type: 'string',  default: '1' },
    'min-hits':  { type: 'string',  default: '1' },
    limit:       { type: 'string' },
    concurrency: { type: 'string',  default: '16' },
    verbose:     { type: 'boolean', default: false },
  } });

  const data   = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const atsList = Object.keys(data.ats).filter(a => !f.ats || a === f.ats.toLowerCase());
  const minJobs = +f['min-jobs'], minHits = +f['min-hits'];
  const live   = {};

  for (const ats of atsList) {
    const probe = PROBES[ats];
    if (!probe) { console.error(`  ✗ no probe for ${ats}`); continue; }
    let entries = data.ats[ats].filter(e => (e.hits ?? 1) >= minHits);
    if (f.limit) entries = entries.slice(0, +f.limit);
    console.error(`\n🔎  [${ats}] validating ${entries.length} candidates…`);
    live[ats] = [];
    let done = 0;
    await pool(entries, +f.concurrency, async (e) => {
      let jobs = null;
      try { jobs = await probe(e.slug, e); } catch {}
      if (jobs !== null && jobs >= minJobs) {
        live[ats].push({ ...e, jobs });
        if (f.verbose) console.error(`   ✓ ${slugOf(ats, e)}  (${jobs} jobs)`);
      }
      if (++done % 200 === 0) console.error(`   …${done}/${entries.length}, ${live[ats].length} live`);
    });
    live[ats].sort((a, b) => b.jobs - a.jobs);
    console.error(`   ✅ ${live[ats].length} live boards with ≥${minJobs} job(s)`);
  }

  fs.writeFileSync(LIVE_FILE, JSON.stringify({ checkedAt: new Date().toISOString(), ats: live }, null, 1));
  console.error(`\nWrote ${path.relative(process.cwd(), LIVE_FILE)}`);
  if (f['dry-run']) return;

  const { query, closePool } = await import('../lib/db.mjs');
  for (const [ats, rows] of Object.entries(live)) {
    let inserted = 0, existing = 0;
    for (const e of rows) {
      const meta = ats === 'oraclecloud' ? { host: e.host, site: e.site } : {};
      try {
        const { rows: r } = await query(
          `INSERT INTO companies (name, ats, slug, meta, discovered)
                VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (ats, slug) DO UPDATE
              SET meta = CASE WHEN companies.meta = '{}'::jsonb OR companies.meta IS NULL
                              THEN EXCLUDED.meta ELSE companies.meta END
           RETURNING (xmax = 0) AS inserted`,
          [prettyName(ats, e), ats, slugOf(ats, e), JSON.stringify(meta)]
        );
        r[0]?.inserted ? inserted++ : existing++;
      } catch (err) { console.error(`  ✗ upsert ${ats}/${slugOf(ats, e)}: ${err.message}`); }
    }
    console.error(`   [${ats}] inserted ${inserted}, already known ${existing}`);
  }
  await closePool?.();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err); process.exit(1); });
}
