/**
 * harvester/dover.mjs: finds Dover (app.dover.com) companies and seeds them for the scanner.
 * Dover's public jobs list is keyed by a client id, but the pages Common Crawl saw are /apply/{name}/{jobId}.
 * So: collect job ids from the crawl's index (same range-read approach as cc-index.mjs), ask Dover which company
 * each belongs to, keep the companies with open jobs, and insert them as ats='dover', slug = client id.
 *
 *   node --env-file=.env.local harvester/dover.mjs [--crawls 2] [--limit 500] [--dry-run]
 */
import zlib from 'node:zlib';
import { parseArgs } from 'node:util';
import { fetchJSON } from '../lib/http.mjs';

const BASE = 'https://data.commoncrawl.org';
const PREFIX = 'com,dover,app)/apply/';
const UA = { 'User-Agent': 'rejekt-ai/1.0 (dover harvester)' };
const API = 'https://app.dover.com/api/v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const get = async (url, headers = {}, tries = 3) => {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url, { headers: { ...UA, ...headers } }); if (r.ok) return r; if (r.status === 404) return null; throw new Error(`HTTP ${r.status}`); }
    catch (err) { if (i === tries - 1) throw err; await new Promise(r => setTimeout(r, 3000 * (i + 1))); }
  }
};

async function jobIdsFromCrawl(crawl) {
  const text = await (await get(`${BASE}/cc-index/collections/${crawl}/indexes/cluster.idx`)).text();
  const idx = text.split('\n').filter(Boolean).map(l => { const [k, file, off, len] = l.split('\t'); return [k.split(' ')[0], file, +off, +len]; });
  let lo = 0, hi = idx.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (idx[m][0] < PREFIX) lo = m + 1; else hi = m; }
  const blocks = [];
  for (let i = Math.max(0, lo - 1); i < idx.length && (i < lo || idx[i][0].startsWith(PREFIX)); i++) blocks.push(idx[i]);
  const ids = new Set();
  for (const [, file, off, len] of blocks) {
    const r = await get(`${BASE}/cc-index/collections/${crawl}/indexes/${file}`, { Range: `bytes=${off}-${off + len - 1}` });
    for (const line of zlib.gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8').split('\n')) {
      if (!line.startsWith(PREFIX)) continue;
      const js = line.indexOf('{'); if (js < 0) continue;
      try { const id = new URL(JSON.parse(line.slice(js)).url).pathname.split('/')[3]; if (UUID.test(id || '')) ids.add(id); } catch {}
    }
  }
  console.error(`   ✓ ${crawl}: ${blocks.length} blocks, ${ids.size} job ids`);
  return ids;
}

async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); })); }

async function main() {
  const { values: f } = parseArgs({ options: { crawls: { type: 'string', default: '2' }, limit: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } } });
  const html = await (await get(`${BASE}/crawl-data/index.html`)).text();
  const crawls = [...new Set(html.match(/CC-MAIN-20\d\d-\d\d/g))].sort().reverse().slice(0, +f.crawls);
  console.error(`🌐  ${crawls.join(', ')}`);
  const jobIds = new Set();
  for (const c of crawls) for (const id of await jobIdsFromCrawl(c).catch(err => { console.error(`  ✗ ${c}: ${err.message}`); return []; })) jobIds.add(id);

  // job id → company; one job per company is enough, so skip ids of companies already found
  const clients = new Map();
  const todo = [...jobIds].slice(0, f.limit ? +f.limit : undefined);
  let done = 0;
  await pool(todo, 8, async (id) => {
    const d = await fetchJSON(`${API}/inbound/application-portal-job/${id}`, { headers: UA, timeoutMs: 15_000, retries: 1 }).catch(() => null);
    if (d?.client_id && !clients.has(d.client_id)) clients.set(d.client_id, d.client_name || '');
    if (++done % 500 === 0) console.error(`   …${done}/${todo.length} jobs, ${clients.size} companies`);
  });
  console.error(`🏢  ${clients.size} companies from ${todo.length} job ids`);

  const live = [];
  await pool([...clients], 8, async ([id, name]) => {
    const d = await fetchJSON(`${API}/careers-page/${id}/jobs`, { headers: UA, timeoutMs: 15_000, retries: 1 }).catch(() => null);
    if (d?.count > 0) live.push({ id, name: name || id, jobs: d.count });
  });
  live.sort((a, b) => b.jobs - a.jobs);
  console.error(`✅  ${live.length} with open jobs (${live.reduce((n, c) => n + c.jobs, 0)} jobs)`);
  if (f['dry-run']) return console.log(live.slice(0, 15));

  const { query, closePool } = await import('../lib/db.mjs');
  let inserted = 0;
  for (const c of live) {
    const { rows } = await query(
      `INSERT INTO companies (name, ats, slug, meta, discovered) VALUES ($1, 'dover', $2, '{}', NOW())
       ON CONFLICT (ats, slug) DO NOTHING RETURNING id`, [c.name, c.id]);
    inserted += rows.length;
  }
  console.error(`   inserted ${inserted}, already known ${live.length - inserted}`);
  await closePool?.();
}

main().catch(err => { console.error(err); process.exit(1); });
