/**
 * Seeds companies from job URLs (e.g. a Tsenta feed dump), using lib/ats-detect.mjs.
 * Input files: a Tsenta tool-result JSON ({result:{jobs:[{url,companyName}]}}) or a plain
 * array of {url, companyName}.
 * Usage: node --env-file=.env.local harvester/import-from-urls.mjs [--dry-run] file...
 */
import fs from 'node:fs';
import { detectAts } from '../lib/ats-detect.mjs';

const dry = process.argv.includes('--dry-run');
const found = new Map();
for (const f of process.argv.slice(2).filter(a => !a.startsWith('--'))) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const job of j.result?.jobs ?? j) {
    const d = detectAts(job.url);
    if (!d?.supported || !d.slug) continue;
    const key = `${d.ats}|${d.slug}`;
    if (!found.has(key)) found.set(key, { name: job.companyName, ats: d.ats, slug: d.slug, meta: d.meta || {} });
  }
}
const rows = [...found.values()];
const by = {}; for (const r of rows) by[r.ats] = (by[r.ats] || 0) + 1;
console.error(`${rows.length} boards`, by);
if (dry) process.exit(0);

const { query, closePool } = await import('../lib/db.mjs');
let inserted = 0;
for (const r of rows) {
  const { rows: o } = await query(
    `INSERT INTO companies (name, ats, slug, meta, discovered) VALUES ($1,$2,$3,$4,NOW())
     ON CONFLICT (ats, slug) DO NOTHING RETURNING id`, [r.name, r.ats, r.slug, JSON.stringify(r.meta)]);
  inserted += o.length;
}
console.error(`inserted ${inserted}, already known ${rows.length - inserted}`);
await closePool?.();
