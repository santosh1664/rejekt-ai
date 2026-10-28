#!/usr/bin/env node
/**
 * scripts/fix-jobs-indexes.mjs
 *
 * Step 1  — List all indexes on the `jobs` table with size + scan count.
 * Step 2  — Drop indexes that have never been used (idx_scan = 0) and are
 *            not the primary key, using DROP INDEX CONCURRENTLY (no table lock).
 *
 * Usage:
 *   node --env-file=.env.local scripts/fix-jobs-indexes.mjs           # inspect only
 *   node --env-file=.env.local scripts/fix-jobs-indexes.mjs --drop    # inspect + drop unused
 *
 * Run this from your Mac terminal where you have direct RDS access.
 * The DROP happens CONCURRENTLY so it doesn't block reads/writes.
 */

import pg from 'pg';
const { Pool } = pg;

const DROP = process.argv.includes('--drop');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

console.log('\n🔍 Indexes on the `jobs` table:\n');

const { rows } = await pool.query(`
  SELECT
    i.indexname,
    pg_size_pretty(pg_relation_size(i.indexname::regclass)) AS size,
    pg_relation_size(i.indexname::regclass)                  AS size_bytes,
    s.idx_scan,
    CASE WHEN i.indexname LIKE '%pkey%' THEN true ELSE false END AS is_pkey,
    i.indexdef
  FROM pg_indexes i
  JOIN pg_stat_user_indexes s ON s.indexrelname = i.indexname
  WHERE i.tablename = 'jobs'
  ORDER BY pg_relation_size(i.indexname::regclass) DESC
`);

for (const r of rows) {
  const tag = r.is_pkey ? ' [PRIMARY KEY — never drop]'
    : r.idx_scan === '0' || r.idx_scan === 0 ? ' ⚠️  NEVER USED — candidate for drop'
    : ` (used ${r.idx_scan}×)`;
  console.log(`  ${r.indexname}`);
  console.log(`    size: ${r.size}   scans: ${r.idx_scan}${tag}`);
  console.log(`    ${r.indexdef}\n`);
}

const totalSize = rows.reduce((sum, r) => sum + Number(r.size_bytes), 0);
const unused    = rows.filter(r => !r.is_pkey && (r.idx_scan === '0' || r.idx_scan === 0));

console.log(`Total index size: ${(totalSize / 1024 / 1024).toFixed(0)} MB`);
console.log(`Unused indexes:   ${unused.length}`);

if (!DROP) {
  if (unused.length > 0) {
    console.log('\nRun with --drop to remove unused indexes (CONCURRENTLY — safe, no table lock):');
    console.log('  node --env-file=.env.local scripts/fix-jobs-indexes.mjs --drop\n');
  }
  await pool.end();
  process.exit(0);
}

// ── Drop unused indexes ────────────────────────────────────────────────────────
if (unused.length === 0) {
  console.log('\n✅ No unused indexes to drop.\n');
  await pool.end();
  process.exit(0);
}

console.log('\n⚠️  Dropping unused indexes CONCURRENTLY (reads/writes continue during drop)...\n');

// DROP INDEX CONCURRENTLY cannot run inside a transaction — use raw client.
const client = await pool.connect();
try {
  // Temporarily disable statement_timeout for CONCURRENTLY drops (they can take minutes).
  await client.query('SET statement_timeout = 0');

  for (const r of unused) {
    console.log(`  Dropping ${r.indexname} (${r.size})...`);
    const t = Date.now();
    await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "${r.indexname}"`);
    console.log(`  ✅ Dropped in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  }
} finally {
  client.release();
}

await pool.end();
console.log('\n✅ Done. Re-run without --drop to verify.\n');
