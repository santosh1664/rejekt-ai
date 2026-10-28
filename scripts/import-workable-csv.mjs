// node --env-file=.env.local scripts/import-workable-csv.mjs <file.csv>   (columns: company_name, workable_slug, workable_company_id, public_job_count)
import { readFileSync } from 'node:fs';
import { query, closePool } from '../lib/db.mjs';

const rows = readFileSync(process.argv[2], 'utf8').trim().split(/\r?\n/);
const head = splitCsv(rows.shift()); const col = n => head.indexOf(n);
let added = 0, seen = 0;
for (const line of rows) {
  const f = splitCsv(line); const name = f[col('company_name')]; const slug = f[col('workable_slug')];
  if (!name || !slug) continue; seen++;
  const meta = { companyId: f[col('workable_company_id')], expected: +f[col('public_job_count')] || 0, website: f[col('company_website')] || null };
  const r = await query(`INSERT INTO companies (name, ats, slug, meta, discovered) VALUES ($1,'workable',$2,$3,NOW()) ON CONFLICT (ats, slug) DO NOTHING RETURNING id`, [name, slug, JSON.stringify(meta)]);
  added += r.rowCount;
}
console.log(`CSV rows: ${seen}  newly added: ${added}`);
await closePool();

function splitCsv(l) { const o = []; let c = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { o.push(c); c = ''; } else c += ch; } o.push(c); return o; }
