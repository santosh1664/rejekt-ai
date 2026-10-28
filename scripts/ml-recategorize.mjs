/**
 * scripts/ml-recategorize.mjs
 *
 * Like scripts/recategorize.mjs, but uses the ML classifier (via
 * lib/ml-classify.mjs -> ml/classifier-server.py) instead of the keyword
 * regex classifier. Requires the ML server to be running (npm run ml:server)
 * — if it isn't reachable, smartClassify() silently falls back to the
 * keyword classifier and category_source stays 'keyword' for that row.
 *
 * Scope:
 *   default   — every job with category = 'other'
 *   --all     — every job with category_source = 'keyword', regardless of
 *               category (re-runs the ML model over already-keyword-tagged
 *               rows too, in case it disagrees). NOTE: the classifier
 *               server (as specified) returns only a bare category, no
 *               confidence score, so this does not implement genuine
 *               low-confidence filtering — it's a blanket re-pass.
 *
 * The trained model was fit only on category != 'other' rows, so it has no
 * 'other' class at all — every prediction it returns is a real category
 * (never 'other'). That means running this against every 'other' row will
 * force all of them into one of the 16 trained categories, right or wrong;
 * there's no confidence-based "I don't know, leave it as other" option
 * without extending the server to expose predict_proba.
 *
 * Usage:
 *   npm run ml:classify
 *   node --env-file=.env.local scripts/ml-recategorize.mjs [--all] [--dry-run] [--verbose]
 */

import { query, closePool } from '../lib/db.mjs';
import { smartClassify }    from '../lib/ml-classify.mjs';

const all     = process.argv.includes('--all');
const dryRun  = process.argv.includes('--dry-run');
const verbose = process.argv.includes('--verbose');
const BATCH   = 500;

const DESC_SQL = `COALESCE(
  raw->>'description', raw->>'descriptionHtml', raw->>'content',
  raw->>'full_description', raw->>'body', ''
)`;

async function main() {
  console.error(`\n🤖  ML recategorization pass${all ? '  [--all]' : ''}${dryRun ? '  [DRY RUN]' : ''}`);

  const scopeWhere = all
    ? `category_source = 'keyword'`
    : `category = 'other'`;

  const { rows: [{ n }] } = await query(`SELECT COUNT(*) AS n FROM jobs WHERE ${scopeWhere}`);
  const total = parseInt(n);
  console.error(`   Jobs in scope: ${total.toLocaleString()}`);

  if (total === 0) {
    console.error('   Nothing to do.\n');
    return;
  }

  const { rows: before } = await query(
    `SELECT category, COUNT(*) AS n FROM jobs GROUP BY category ORDER BY n DESC`
  );

  // Keyset (cursor) pagination on id, NOT OFFSET: the scope's WHERE clause
  // (category='other', or category_source='keyword' under --all) shrinks as
  // we process rows out of it, so OFFSET against a shrinking result set
  // silently skips rows — it was previously skipping ~half the scope.
  // "id > lastId" stays correct regardless of whether earlier rows are still
  // in scope, and also works in --dry-run where the scope never shrinks.
  let lastId = 0, processed = 0, mlClassified = 0, fellBack = 0, unchanged = 0;

  while (true) {
    const { rows } = await query(
      `SELECT id, title, category, ${DESC_SQL} AS desc_text
         FROM jobs WHERE ${scopeWhere} AND id > $2
        ORDER BY id LIMIT $1`,
      [BATCH, lastId]
    );
    if (rows.length === 0) break;

    const updates = []; // { id, category }
    for (const row of rows) {
      const { category, source } = await smartClassify(row.title, row.desc_text || '');

      if (source !== 'ml') {
        fellBack++;
        continue; // ML server unavailable — leave row untouched (keyword result already stored)
      }
      if (category === row.category) {
        unchanged++;
        // ML agreed with the existing label — still worth recording that it
        // was ML-verified, so category_source flips even with no category change.
        updates.push({ id: row.id, category });
        continue;
      }
      updates.push({ id: row.id, category });
      mlClassified++;
      if (verbose) console.error(`    ${row.id}  "${row.title}"  ${row.category} → ${category} [ml]`);
    }

    if (!dryRun && updates.length > 0) {
      const ids  = updates.map(u => u.id);
      const cats = updates.map(u => u.category);
      await query(
        `UPDATE jobs AS j SET category = u.category, category_source = 'ml'
           FROM UNNEST($1::bigint[], $2::text[]) AS u(id, category)
          WHERE j.id = u.id`,
        [ids, cats]
      );
    }

    lastId     = rows[rows.length - 1].id;
    processed += rows.length;
    const pct = Math.min(100, Math.round(processed / total * 100));
    process.stderr.write(`\r   Progress: ${processed.toLocaleString()} / ${total.toLocaleString()}  (${pct}%)  ml=${mlClassified.toLocaleString()}  fallback=${fellBack.toLocaleString()}`);
  }

  console.error('\n');

  if (fellBack > 0) {
    console.error(`⚠️  ${fellBack.toLocaleString()} rows fell back to the keyword classifier — is the ML server running (npm run ml:server)?\n`);
  }

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
  console.error(`  Scope           : ${total.toLocaleString()}`);
  console.error(`  ML-reclassified : ${mlClassified.toLocaleString()}`);
  console.error(`  Unchanged       : ${unchanged.toLocaleString()}`);
  console.error(`  Fell back       : ${fellBack.toLocaleString()}`);
  if (dryRun) console.error('\n[DRY RUN — no rows written]');
  console.error('');
}

main()
  .catch((err) => { console.error('\n💥 Fatal:', err.message); process.exit(1); })
  .finally(() => closePool());
