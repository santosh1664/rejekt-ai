/**
 * db/add-description.mjs
 *
 * One-time migration:
 *   1. Adds  description TEXT  column to jobs table
 *   2. Backfills it from the raw JSONB (same field priority as extractDescription())
 *   3. Creates a GIN full-text search index on the description column
 *
 * Usage:
 *   node --env-file=.env.local db/add-description.mjs
 */
import { query, closePool } from '../lib/db.mjs';

async function run() {
  console.log('1/3  Adding description column…');
  await query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS description TEXT`);

  console.log('2/3  Backfilling description from raw JSONB (may take a minute)…');
  const { rowCount } = await query(`
    UPDATE jobs
    SET description = COALESCE(
      NULLIF(raw->>'description',       ''),
      NULLIF(raw->>'descriptionHtml',   ''),
      NULLIF(raw->>'content',           ''),
      NULLIF(raw->>'full_description',  ''),
      NULLIF(raw->>'body',              ''),
      ''
    )
    WHERE description IS NULL
  `);
  console.log(`   → ${rowCount} rows updated`);

  console.log('3/3  Creating GIN FTS index on description…');
  await query(`
    CREATE INDEX IF NOT EXISTS idx_jobs_description_fts
      ON jobs USING GIN (to_tsvector('english', coalesce(description, '')))
  `);

  console.log('Done ✓  Description search is now fully indexed.');
  await closePool();
}

run().catch((e) => { console.error(e); process.exit(1); });
