/**
 * Seeds companies from the harvested-companies workbook, pre-converted to JSON rows:
 * [ats, slug, host, site, boardUrl, hits, otherSites]. Names are derived from slugs.
 * Usage: node --env-file=.env.local harvester/import-xlsx-json.mjs rows.json [--dry-run]
 */
import fs from 'node:fs';

const rows = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const pretty = s => s.replace(/[-_.]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();

const out = new Map();
for (const [ats, slug, host, site] of rows) {
  const key = `${ats}|${slug}`;
  if (out.has(key)) continue;
  let meta = {}, name;
  if (ats === 'workday') {
    const [tenant] = slug.split('/'); const shard = host.split('.')[1];
    meta = { tenant, shard, site }; name = pretty(tenant);
  } else if (ats === 'oraclecloud') { meta = { host, site }; name = pretty(host.split('.')[0]); }
  else name = pretty(slug);
  out.set(key, { name, ats, slug, meta });
}
const list = [...out.values()];
console.error(`${list.length} unique boards`);
if (process.argv.includes('--dry-run')) process.exit(0);

const { query, closePool } = await import('../lib/db.mjs');
const have = new Set((await query('SELECT ats, slug FROM companies')).rows.map(r => `${r.ats}|${r.slug.toLowerCase()}`));
const todo = list.filter(x => !have.has(`${x.ats}|${x.slug.toLowerCase()}`));
console.error(`${list.length - todo.length} already known (case-insensitive), inserting ${todo.length}`);
let inserted = 0;
for (let i = 0; i < todo.length; i += 1000) {
  const b = todo.slice(i, i + 1000);
  const { rows: o } = await query(
    `INSERT INTO companies (name, ats, slug, meta, discovered)
     SELECT n, a, s, m::jsonb, NOW() FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS t(n, a, s, m)
     ON CONFLICT (ats, slug) DO NOTHING RETURNING id`,
    [b.map(x => x.name), b.map(x => x.ats), b.map(x => x.slug), b.map(x => JSON.stringify(x.meta))]);
  inserted += o.length;
}
console.error(`inserted ${inserted}, already known ${list.length - inserted}`);
await closePool?.();
