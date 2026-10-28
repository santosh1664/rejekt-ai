#!/usr/bin/env node
/**
 * scripts/create-desc-search-index.mjs
 *
 * Creates a GIN full-text index on (title + description) so the
 * "Title + Description" search mode is fast.
 *
 * Run once from your Mac terminal:
 *   node --env-file=.env.local scripts/create-desc-search-index.mjs
 *
 * DROP INDEX CONCURRENTLY takes no table lock — safe in production.
 * This index will be ~500MB–1.5GB depending on description sizes.
 */

import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();

try {
  // Disable statement_timeout — CONCURRENTLY can take many minutes
  await client.query('SET statement_timeout = 0');

  console.log('Creating idx_jobs_title_desc_fts (CONCURRENTLY — table stays live)...');
  const t = Date.now();

  await client.query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_title_desc_fts
      ON jobs
      USING gin(to_tsvector('english', coalesce(title,'') || ' ' || coalesce(description,'')))
  `);

  console.log(`✅ Done in ${((Date.now()-t)/1000).toFixed(1)}s`);
  console.log('The "Title + Description" search mode is now index-backed and fast.');
} finally {
  client.release();
  await pool.end();
}
