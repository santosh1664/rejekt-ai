/**
 * harvester/cc-index.mjs
 *
 * Fast Common Crawl harvester that reads the raw CDX index files from
 * data.commoncrawl.org with HTTP range requests, instead of the
 * index.commoncrawl.org query server (which rate-limits and then blocks an IP
 * after a few hundred requests).
 *
 * How it works, per crawl:
 *   1. GET  /cc-index/collections/{crawl}/indexes/cluster.idx   (~100 MB, sorted
 *      by SURT key; one line per ~3,000-record block: key, file, offset, length)
 *   2. Binary-search the blocks whose key range covers each ATS's SURT prefix
 *      (e.g. "com,bamboohr," for *.bamboohr.com).
 *   3. Range-GET each block from cdx-NNNNN.gz, gunzip it, and extract slugs
 *      from the record URLs.
 * A typical ATS needs 1–30 blocks per crawl, so 12 crawls take a few minutes.
 *
 * Output:
 *   harvester/data/ats-slugs.json       → bamboohr, recruitee, breezy, pinpoint,
 *                                          teamtailor, rippling, oraclecloud
 *   harvester/data/workday-tenants.json → workday (format read by workday.mjs)
 * Then validate + seed with:
 *   node --env-file=.env.local harvester/import-slugs.mjs [--dry-run]
 *   node --env-file=.env.local harvester/workday.mjs      [--dry-run]
 *
 * Usage:
 *   node harvester/cc-index.mjs [--crawls 12] [--ats bamboohr,oraclecloud] [--verbose]
 */

import fs   from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { parseArgs }     from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'https://data.commoncrawl.org';
const UA   = { 'User-Agent': 'rejekt-ai/1.0 (cc-index harvester)' };

const RESERVED = /^(www|app|api|blog|help|support|status|marketplace|career|careers|partners|docs|dev|staging|mail|static|assets|cdn|login|go|info|community|developers?|jobs|demo|try|get|learn|resources|academy|university|events|news|press|shop|store|admin|my|portal|auth|sso|email|t|link|links|click|track|marketing|hub|en|de|fr|nl|es|it|sv|da|no|fi|pl|pt|documentation|newsroom|trust|integrations|tt|security|privacy|legal|careers-page|feedback|changelog|roadmap|webinars?)$/;

function sub(host, dom) {
  if (!host.endsWith('.' + dom)) return null;
  const s = host.slice(0, -dom.length - 1);
  if (!s || s.includes('.') || RESERVED.test(s) || !/^[a-z0-9-]+$/.test(s)) return null;
  return s;
}
const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

// prefix = SURT key prefix; extract(URL) → key or null
export const ATS = {
  bamboohr:    { prefix: 'com,bamboohr,',      extract: u => sub(u.hostname, 'bamboohr.com') },
  recruitee:   { prefix: 'com,recruitee,',     extract: u => sub(u.hostname, 'recruitee.com') },
  breezy:      { prefix: 'hr,breezy,',         extract: u => sub(u.hostname, 'breezy.hr') },
  pinpoint:    { prefix: 'com,pinpointhq,',    extract: u => sub(u.hostname, 'pinpointhq.com') },
  teamtailor:  { prefix: 'com,teamtailor,',    extract: u => sub(u.hostname, 'teamtailor.com') },
  rippling:    { prefix: 'com,rippling,ats)/', extract: u => {
    if (u.hostname !== 'ats.rippling.com') return null;
    let p = u.pathname.split('/').filter(Boolean);
    if (p[0] && /^[a-z]{2}(-[A-Za-z0-9]{2,3})?$/.test(p[0])) p = p.slice(1);
    const s = p[0] && safeDecode(p[0]);
    return s && !/^(api|static|assets|robots\.txt|favicon\.ico|_next|jobs|careers?|rippling)$/i.test(s) && /^[A-Za-z0-9_.-]+$/.test(s) ? s.toLowerCase() : null;
  } },
  oraclecloud: { prefix: 'com,oraclecloud,',   extract: u => {
    if (!/\.oraclecloud\.com$/.test(u.hostname)) return null;
    const p = u.pathname.split('/');
    const i = p.findIndex(x => x.toLowerCase() === 'candidateexperience');
    if (i < 0) return null;
    const j = p.indexOf('sites', i);
    const site = j > 0 ? p[j + 1] : null;
    return site && /^[A-Za-z0-9_-]+$/.test(site) ? `${u.hostname}|${site}` : null;
  } },
  workday:     { prefix: 'com,myworkdayjobs,', extract: u => {
    const m = u.hostname.match(/^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/);
    if (!m) return null;
    let p = u.pathname.split('/').filter(Boolean);
    if (p[0] && /^[a-z]{2}-[A-Za-z]{2}$/.test(p[0])) p = p.slice(1);
    const s = p[0] && safeDecode(p[0]);
    if (!s || /^(wday|robots\.txt|favicon\.ico|sitemap.*|login|signin|job|jobs|cxs|\.well-known|assets|static|[a-z]{2})$/i.test(s)
        || !/^[A-Za-z0-9_.\-]+$/.test(s) || s.length > 80) return null;
    return `${m[1]}|${m[2]}|${s}`;
  } },
};

async function get(url, opts = {}, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...opts, headers: { ...UA, ...(opts.headers || {}) } });
      if (r.ok) return r;
      if (r.status === 404) return null;
      throw new Error(`HTTP ${r.status}`);
    } catch (err) {
      if (i === tries - 1) throw err;
      await new Promise(res => setTimeout(res, 3000 * (i + 1)));
    }
  }
}

async function listCrawls(n) {
  const html = await (await get(`${BASE}/crawl-data/index.html`)).text();
  return [...new Set(html.match(/CC-MAIN-20\d\d-\d\d/g))].sort().reverse().slice(0, n);
}

async function loadClusterIdx(crawl) {
  const r = await get(`${BASE}/cc-index/collections/${crawl}/indexes/cluster.idx`);
  if (!r) return null;
  const text = await r.text();
  const idx = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const [k, file, off, len] = line.split('\t');
    idx.push([k.split(' ')[0], file, +off, +len]);
  }
  return idx;
}

function blocksFor(idx, prefix) {
  let lo = 0, hi = idx.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (idx[m][0] < prefix) lo = m + 1; else hi = m; }
  const out = [];
  for (let i = Math.max(0, lo - 1); i < idx.length && (i < lo || idx[i][0].startsWith(prefix)); i++) out.push(idx[i]);
  return out;
}

async function readBlock(crawl, [, file, off, len]) {
  const r = await get(`${BASE}/cc-index/collections/${crawl}/indexes/${file}`,
    { headers: { Range: `bytes=${off}-${off + len - 1}` } });
  return zlib.gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8');
}

async function main() {
  const { values: f } = parseArgs({ options: {
    crawls:  { type: 'string', default: '12' },
    ats:     { type: 'string' },
    verbose: { type: 'boolean', default: false },
  } });
  const wanted = f.ats ? f.ats.split(',').map(s => s.trim().toLowerCase()) : Object.keys(ATS);
  const hits = Object.fromEntries(wanted.map(a => [a, new Map()]));
  const crawls = await listCrawls(+f.crawls);
  console.error(`🌐  ${crawls.length} crawls: ${crawls.at(-1)} … ${crawls[0]}`);

  for (const crawl of crawls) {
    const idx = await loadClusterIdx(crawl).catch(err => { console.error(`  ✗ ${crawl} cluster.idx: ${err.message}`); return null; });
    if (!idx) continue;
    const tasks = wanted.flatMap(a => blocksFor(idx, ATS[a].prefix).map(b => [a, b]));
    let done = 0;
    const queue = [...tasks];
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const [a, b] = queue.shift();
        let text = '';
        try { text = await readBlock(crawl, b); } catch (err) { console.error(`  ✗ ${crawl} ${b[1]}@${b[2]}: ${err.message}`); }
        const { prefix, extract } = ATS[a];
        for (const line of text.split('\n')) {
          if (!line.startsWith(prefix)) continue;
          const js = line.indexOf('{');
          if (js < 0) continue;
          let u; try { u = new URL(JSON.parse(line.slice(js)).url); } catch { continue; }
          const key = extract(u);
          if (key) hits[a].set(key, (hits[a].get(key) || 0) + 1);
        }
        if (f.verbose) console.error(`   ${crawl} ${++done}/${tasks.length}`);
      }
    }));
    console.error(`   ✓ ${crawl}  ` + wanted.map(a => `${a}:${hits[a].size}`).join('  '));
  }

  fs.mkdirSync(path.join(HERE, 'data'), { recursive: true });
  const meta = { generatedAt: new Date().toISOString(), source: 'commoncrawl cdx (data.commoncrawl.org range reads)', crawls };

  const slugAts = wanted.filter(a => a !== 'workday');
  if (slugAts.length) {
    const ats = {};
    for (const a of slugAts) {
      ats[a] = [...hits[a]].sort((x, y) => y[1] - x[1]).map(([k, n]) =>
        a === 'oraclecloud' ? { host: k.split('|')[0], site: k.split('|')[1], hits: n } : { slug: k, hits: n });
    }
    const file = path.join(HERE, 'data', 'ats-slugs.json');
    fs.writeFileSync(file, JSON.stringify({ ...meta, ats }, null, 1));
    console.error(`📄  ${path.relative(process.cwd(), file)}  ` + slugAts.map(a => `${a}:${ats[a].length}`).join('  '));
  }

  if (wanted.includes('workday')) {
    const byTenant = new Map();
    for (const [k, n] of hits.workday) {
      const [tenant, shard, site] = k.split('|');
      if (!byTenant.has(tenant)) byTenant.set(tenant, { shards: new Map(), sites: new Map() });
      const t = byTenant.get(tenant);
      t.shards.set(shard, (t.shards.get(shard) || 0) + n);
      // merge case variants of a site id, keeping the most-seen spelling
      const lk = site.toLowerCase();
      const e = t.sites.get(lk) || { n: 0, v: new Map() };
      e.n += n; e.v.set(site, (e.v.get(site) || 0) + n); t.sites.set(lk, e);
    }
    const tenants = [...byTenant].map(([tenant, t]) => ({
      tenant,
      shard: [...t.shards].sort((a, b) => b[1] - a[1])[0][0],
      sites: [...t.sites.values()].sort((a, b) => b.n - a.n)
        .map(e => ({ site: [...e.v].sort((a, b) => b[1] - a[1])[0][0], hits: e.n })),
    })).sort((a, b) => a.tenant.localeCompare(b.tenant));
    const file = path.join(HERE, 'data', 'workday-tenants.json');
    fs.writeFileSync(file, JSON.stringify({ ...meta, indexes: crawls, tenants }, null, 1));
    console.error(`📄  ${path.relative(process.cwd(), file)}  workday tenants:${tenants.length}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err); process.exit(1); });
}
