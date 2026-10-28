/**
 * scripts/recategorize.mjs
 *
 * Backfill all jobs with the updated classifyCategory logic.
 * Safe to re-run — only updates rows where the category would change.
 *
 * Usage:
 *   npm run recategorize
 *   node --env-file=.env.local scripts/recategorize.mjs [--dry-run] [--verbose]
 */

import { query, closePool } from '../lib/db.mjs';
import { classifyCategory }  from '../lib/fingerprint.mjs';

const dryRun  = process.argv.includes('--dry-run');
const verbose = process.argv.includes('--verbose');
const BATCH   = 5_000;

async function main() {
  console.error(`\n📂  Recategorization pass${dryRun ? '  [DRY RUN]' : ''}`);

  const { rows: [{ n }] } = await query('SELECT COUNT(*) AS n FROM jobs');
  const total = parseInt(n);
  console.error(`   Jobs in DB: ${total.toLocaleString()}`);

  const { rows: before } = await query(
    `SELECT category, COUNT(*) AS n FROM jobs GROUP BY category ORDER BY n DESC`
  );

  let offset = 0, changed = 0, unchanged = 0;

  while (offset < total) {
    const { rows } = await query(
      `SELECT id, title, category FROM jobs ORDER BY id LIMIT $1 OFFSET $2`,
      [BATCH, offset]
    );
    if (rows.length === 0) break;

    const updates = new Map();
    const unchangedIds = [];
    for (const row of rows) {
      const newCat = classifyCategory(row.title);
      if (newCat !== row.category) {
        if (!updates.has(newCat)) updates.set(newCat, []);
        updates.get(newCat).push(row.id);
        changed++;
        if (verbose) console.error(`    ${row.id}  "${row.title}"  ${row.category} → ${newCat}`);
      } else {
        unchangedIds.push(row.id);
        unchanged++;
      }
    }

    if (!dryRun) {
      // This script is the keyword classifier's authority over the whole
      // table — every row it touches (changed or not) should be tagged
      // category_source='keyword', otherwise a row previously reclassified
      // by ml-recategorize.mjs keeps saying category_source='ml' even after
      // its category value has just been overwritten by classifyCategory().
      for (const [cat, ids] of updates) {
        await query(`UPDATE jobs SET category = $1, category_source = 'keyword' WHERE id = ANY($2)`, [cat, ids]);
      }
      if (unchangedIds.length > 0) {
        await query(`UPDATE jobs SET category_source = 'keyword' WHERE id = ANY($1) AND category_source != 'keyword'`, [unchangedIds]);
      }
    }

    offset += rows.length;
    const pct = Math.round(offset / total * 100);
    process.stderr.write(`\r   Progress: ${offset.toLocaleString()} / ${total.toLocaleString()}  (${pct}%)  changed=${changed.toLocaleString()}`);
  }

  console.error('\n');

  const { rows: after } = await query(
    `SELECT category, COUNT(*) AS n FROM jobs GROUP BY category ORDER BY n DESC`
  );

  console.error('BEFORE → AFTER');
  const beforeMap = new Map(before.map((r) => [r.category, parseInt(r.n)]));
  const afterMap  = new Map(after.map((r)  => [r.category, parseInt(r.n)]));
  const allCats   = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  for (const cat of [...allCats].sort()) {
    const b = beforeMap.get(cat) ?? 0;
    const a = afterMap.get(cat)  ?? 0;
    const diff = a - b;
    console.error(`  ${(cat ?? 'other').padEnd(16)}: ${String(b).padStart(7)} → ${String(a).padStart(7)}  (${diff >= 0 ? '+' : ''}${diff})`);
  }

  console.error(`\nSummary`);
  console.error(`  Total        : ${total.toLocaleString()}`);
  console.error(`  Recategorized: ${changed.toLocaleString()}`);
  console.error(`  Unchanged    : ${unchanged.toLocaleString()}`);
  if (dryRun) console.error('\n[DRY RUN — no rows written]');
  console.error('');
}

main()
  .catch((err) => { console.error('\n💥 Fatal:', err.message); process.exit(1); })
  .finally(() => closePool());
