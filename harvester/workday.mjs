/**
 * harvester/workday.mjs
 *
 * Bulk-discovers Workday employers and seeds them with the { tenant, shard, site }
 * meta that providers/workday.mjs needs.
 *
 * Workday boards live at  https://{tenant}.{shard}.myworkdayjobs.com/{locale?}/{site}/…
 * (and sometimes https://{shard}.myworkdaysite.com/recruiting/{tenant}/{site}/…),
 * so the generic CDX slug extractor in commoncrawl.mjs can't handle them.
 *
 * Pipeline:
 *   1. Candidates — from harvester/data/workday-tenants.json (default; produced
 *      by a Common Crawl sweep), or --harvest to re-pull them from CDX now.
 *   2. Validate  — POST /wday/cxs/{tenant}/{site}/jobs with limit 1; a board is
 *      live if it returns a jobPostings array. Records total open jobs.
 *      When a tenant has several sites, every site is tried (most-crawled first);
 *      use --one-site-per-tenant to keep only the best live one.
 *   3. Upsert    — companies(name, ats='workday', slug='{tenant}/{site}', meta).
 *      Existing rows get meta filled in only if it's empty.
 *
 * Usage:
 *   node --env-file=.env.local harvester/workday.mjs [--harvest] [--indexes 8]
 *        [--dry-run] [--min-jobs 1] [--min-hits 1] [--limit N]
 *        [--one-site-per-tenant] [--skip-validation] [--verbose]
 *
 *   --dry-run          validate and write harvester/data/workday-live.json, no DB writes
 *   --min-hits N       ignore candidate sites seen in fewer than N crawled URLs
 *   --min-jobs N       only seed boards with at least N open jobs (default 1)
 */

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs }     from 'node:util';
import { fetchJSON, fetchText, sleep } from '../lib/http.mjs';

const HERE        = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE   = path.join(HERE, 'data', 'workday-tenants.json');
const LIVE_FILE   = path.join(HERE, 'data', 'workday-live.json');
const CDX_BASE    = 'https://index.commoncrawl.org';
const CONCURRENCY = 12;

const SKIP_SITE = /^(wday|robots\.txt|favicon\.ico|sitemap.*|login|signin|job|jobs|cxs|\.well-known|assets|static)$/i;

// ─── Candidate extraction (shared by --harvest and the browser sweep) ────────

export function extractWorkday(url) {
  let m = url.match(/^https?:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com(?::\d+)?\/([^?#]*)/i);
  if (m) {
    let parts = m[3].split('/').filter(Boolean);
    if (parts[0] && /^[a-z]{2}-[A-Za-z]{2}$/.test(parts[0])) parts = parts.slice(1);
    const site = parts[0] && safeDecode(parts[0]);
    if (!site || SKIP_SITE.test(site) || !/^[A-Za-z0-9_.\-]+$/.test(site) || site.length > 80) return null;
    return { tenant: m[1].toLowerCase(), shard: m[2].toLowerCase(), site };
  }
  m = url.match(/^https?:\/\/(wd\d+)\.myworkdaysite\.com\/(?:[a-z]{2}-[A-Za-z]{2}\/)?recruiting\/([a-z0-9-]+)\/([A-Za-z0-9_.\-]+)/i);
  if (m) return { tenant: m[2].toLowerCase(), shard: m[1].toLowerCase(), site: m[3] };
  return null;
}

function safeDecode(s) { try { return decodeURIComponent(s); } catch { return s; } }

async function harvestFromCdx(indexCount, verbose) {
  const collections = await fetchJSON(`${CDX_BASE}/collinfo.json`, { timeoutMs: 20_000 });
  const ids  = collections.slice(0, indexCount).map(c => c.id);
  const hits = new Map();   // "tenant|shard|site" → count

  for (const id of ids) {
    for (const host of ['myworkdayjobs.com', 'myworkdaysite.com']) {
      const base = `${CDX_BASE}/${id}-index?url=${host}&matchType=domain&output=json`;
      let pages = 1;
      try { pages = (await fetchJSON(`${base}&showNumPages=true`, { timeoutMs: 60_000 })).pages || 1; } catch {}
      for (let p = 0; p < pages; p++) {
        let text = '';
        try { text = await fetchText(`${base}&fl=url&page=${p}`, { timeoutMs: 120_000 }); }
        catch (err) { if (!String(err.message).includes('404')) console.error(`  ✗ ${id} ${host} p${p}: ${err.message}`); continue; }
        for (const line of text.split('\n')) {
          if (!line) continue;
          let url; try { url = JSON.parse(line).url; } catch { continue; }
          const c = url && extractWorkday(url);
          if (c) { const k = `${c.tenant}|${c.shard}|${c.site}`; hits.set(k, (hits.get(k) || 0) + 1); }
        }
        if (verbose) console.error(`   ${id} ${host} page ${p + 1}/${pages}`);
        await sleep(500);
      }
    }
  }
  return toTenantList(hits, ids);
}

function toTenantList(hits, indexes) {
  const byTenant = new Map();
  for (const [k, n] of hits) {
    const [tenant, shard, site] = k.split('|');
    if (!byTenant.has(tenant)) byTenant.set(tenant, { tenant, shards: {}, sites: {} });
    const t = byTenant.get(tenant);
    t.shards[shard] = (t.shards[shard] || 0) + n;
    t.sites[site]   = (t.sites[site]   || 0) + n;
  }
  const tenants = [...byTenant.values()].map(t => ({
    tenant: t.tenant,
    shard:  Object.entries(t.shards).sort((a, b) => b[1] - a[1])[0][0],
    sites:  Object.entries(t.sites).sort((a, b) => b[1] - a[1]).map(([site, hits]) => ({ site, hits })),
  })).sort((a, b) => a.tenant.localeCompare(b.tenant));
  return { generatedAt: new Date().toISOString(), source: 'commoncrawl-cdx', indexes, tenants };
}

// ─── Validation ──────────────────────────────────────────────────────────────

async function probe(tenant, shard, site) {
  const url = `https://${tenant}.${shard}.myworkdayjobs.com/wday/cxs/${tenant}/${encodeURIComponent(site)}/jobs`;
  try {
    const data = await fetchJSON(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body:    JSON.stringify({ limit: 1, offset: 0, searchText: '', appliedFacets: {} }),
      timeoutMs: 15_000,
      retries:   1,
    });
    if (!Array.isArray(data?.jobPostings)) return null;
    return { total: data.total ?? data.jobPostings.length };
  } catch { return null; }
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  }));
}

// ─── Naming ──────────────────────────────────────────────────────────────────

function prettyName(tenant, site) {
  // Tenant ids are usually the brand ("nvidia", "capitalone"); fall back to the site id.
  const base = /^(external|careers?|jobs?|en|global|search)$/i.test(tenant) ? site : tenant;
  return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { values: f } = parseArgs({ options: {
    harvest:               { type: 'boolean', default: false },
    indexes:               { type: 'string',  default: '8' },
    'dry-run':             { type: 'boolean', default: false },
    'min-jobs':            { type: 'string',  default: '1' },
    'min-hits':            { type: 'string',  default: '1' },
    limit:                 { type: 'string' },
    'one-site-per-tenant': { type: 'boolean', default: false },
    'skip-validation':     { type: 'boolean', default: false },
    verbose:               { type: 'boolean', default: false },
  } });

  let data;
  if (f.harvest) {
    console.error(`🌐  Harvesting Workday tenants from the last ${f.indexes} Common Crawl indexes…`);
    data = await harvestFromCdx(+f.indexes, f.verbose);
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 1));
    console.error(`   wrote ${data.tenants.length} tenants → ${path.relative(process.cwd(), DATA_FILE)}`);
  } else {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }

  const minHits = +f['min-hits'], minJobs = +f['min-jobs'];
  let tenants = data.tenants
    .map(t => ({ ...t, sites: t.sites.filter(s => s.hits >= minHits) }))
    .filter(t => t.sites.length);
  if (f.limit) tenants = tenants.slice(0, +f.limit);
  console.error(`🔎  ${tenants.length} tenants / ${tenants.reduce((a, t) => a + t.sites.length, 0)} candidate sites`);

  const live = [];
  let done = 0;
  await pool(tenants, CONCURRENCY, async (t) => {
    for (const { site, hits } of t.sites) {
      if (f['skip-validation']) { live.push({ tenant: t.tenant, shard: t.shard, site, hits, total: null }); if (f['one-site-per-tenant']) break; continue; }
      const r = await probe(t.tenant, t.shard, site);
      if (r && r.total >= minJobs) {
        live.push({ tenant: t.tenant, shard: t.shard, site, hits, total: r.total });
        if (f.verbose) console.error(`   ✓ ${t.tenant}.${t.shard}/${site}  (${r.total} jobs)`);
        if (f['one-site-per-tenant']) break;
      }
    }
    if (++done % 100 === 0) console.error(`   …${done}/${tenants.length} tenants checked, ${live.length} live boards`);
  });

  live.sort((a, b) => (b.total ?? 0) - (a.total ?? 0));
  fs.writeFileSync(LIVE_FILE, JSON.stringify({ checkedAt: new Date().toISOString(), boards: live }, null, 1));
  console.error(`✅  ${live.length} live boards → ${path.relative(process.cwd(), LIVE_FILE)}`);

  if (f['dry-run']) return;

  const { query, closePool } = await import('../lib/db.mjs');
  let inserted = 0, existing = 0;
  for (const b of live) {
    const meta = { tenant: b.tenant, shard: b.shard, site: b.site };
    try {
      const { rows } = await query(
        `INSERT INTO companies (name, ats, slug, meta, discovered)
              VALUES ($1, 'workday', $2, $3, NOW())
         ON CONFLICT (ats, slug) DO UPDATE
            SET meta = CASE WHEN companies.meta = '{}'::jsonb OR companies.meta IS NULL
                            THEN EXCLUDED.meta ELSE companies.meta END
         RETURNING (xmax = 0) AS inserted`,
        [prettyName(b.tenant, b.site), `${b.tenant}/${b.site}`, JSON.stringify(meta)]
      );
      rows[0]?.inserted ? inserted++ : existing++;
    } catch (err) { console.error(`  ✗ upsert ${b.tenant}/${b.site}: ${err.message}`); }
  }
  console.error(`   inserted ${inserted}, already known ${existing}`);
  await closePool?.();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err); process.exit(1); });
}
