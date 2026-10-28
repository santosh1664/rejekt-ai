/**
 * Imports harvester/data/workday-companies.csv into companies (ats='workday').
 * Every site (primary + other_sites) becomes slug '{tenant}/{site}'.
 * Usage: node --env-file=.env.local harvester/import-workday-csv.mjs [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CSV = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'workday-companies.csv');
const dry = process.argv.includes('--dry-run');

// CSV line split that honours "quoted, fields"
const split = l => [...l.matchAll(/("([^"]*)"|[^,]*)(,|$)/g)].slice(0, 8).map(m => m[2] ?? m[1]);

const boards = [];
for (const line of fs.readFileSync(CSV, 'utf8').trim().split('\n').slice(1)) {
  const [company, tenant, shard, primary, , , others] = split(line.replace(/\r$/, ''));
  const sites = [primary, ...others.split(',').map(s => s.trim())].filter(s => s && !s.includes('.'));
  for (const site of new Set(sites)) boards.push({ name: company, tenant, shard, site });
}
console.error(`${boards.length} boards from CSV`);
if (dry) process.exit(0);

const { query, closePool } = await import('../lib/db.mjs');
let inserted = 0, existing = 0;
for (const b of boards) {
  const { rows } = await query(
    `INSERT INTO companies (name, ats, slug, meta, discovered)
          VALUES ($1, 'workday', $2, $3, NOW())
     ON CONFLICT (ats, slug) DO UPDATE
        SET meta = CASE WHEN companies.meta = '{}'::jsonb OR companies.meta IS NULL
                        THEN EXCLUDED.meta ELSE companies.meta END
     RETURNING (xmax = 0) AS inserted`,
    [b.name, `${b.tenant}/${b.site}`, JSON.stringify({ tenant: b.tenant, shard: b.shard, site: b.site })]
  );
  rows[0]?.inserted ? inserted++ : existing++;
}
console.error(`inserted ${inserted}, already known ${existing}`);
await closePool?.();
