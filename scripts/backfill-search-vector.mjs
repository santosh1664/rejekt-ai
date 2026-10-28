/**
 * scripts/backfill-search-vector.mjs
 *
 * One-time backfill of jobs.search_vector for rows that predate the
 * trg_jobs_search_vector trigger (db/schema.sql). Batched so a single
 * statement never risks the app's/migration's statement_timeout — every
 * new/updated row going forward is already handled by the trigger, this
 * only needs to run once (or --since-id resumed) for existing data.
 *
 * The GIN index (idx_jobs_search_vector) is created here too, AFTER the
 * backfill completes — building it once over populated data is far
 * cheaper than maintaining it incrementally during the backfill.
 *
 * Usage:
 *   node --env-file=.env.local scripts/backfill-search-vector.mjs
 *   node --env-file=.env.local scripts/backfill-search-vector.mjs --since-id 50000
 */
import { query, closePool } from '../lib/db.mjs';

const args = process.argv.slice(2);
const SINCE_ID = (() => { const i = args.indexOf('--since-id'); return i !== -1 ? Number(args[i + 1]) : 0; })();
const BATCH = 2000;

async function main() {
  let lastId = SINCE_ID;
  let processed = 0;

  while (true) {
    const { rows } = await query(
      `UPDATE jobs SET search_vector =
          setweight(to_tsvector('english', coalesce(display_title, title, '')), 'A') ||
          setweight(to_tsvector('english', coalesce(company, '')), 'B') ||
          setweight(to_tsvector('english', coalesce(canonical_role, '') || ' ' || coalesce(role_family, '')), 'B') ||
          setweight(to_tsvector('english', coalesce(description_clean, '')), 'C')
        WHERE id IN (
          SELECT id FROM jobs WHERE id > $1 AND search_vector IS NULL ORDER BY id LIMIT $2
        )
        RETURNING id`,
      [lastId, BATCH]
    );
    if (rows.length === 0) break;
    lastId = Math.max(...rows.map(r => r.id));
    processed += rows.length;
    console.error(`Backfilled ${processed.toLocaleString()} jobs (last id ${lastId}, resume with --since-id ${lastId})`);
  }

  console.error(`\nBackfill complete: ${processed.toLocaleString()} jobs. Building GIN index idx_jobs_search_vector...`);
  await query('CREATE INDEX IF NOT EXISTS idx_jobs_search_vector ON jobs USING GIN (search_vector)');
  console.error('Index built.');
}

main().catch(error => { console.error('Backfill failed:', error.message); process.exitCode = 1; }).finally(() => closePool());
