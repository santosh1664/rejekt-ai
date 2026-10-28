/**
 * scripts/backfill-seniority.mjs
 *
 * Classifies seniority_level for existing jobs using lib/seniority.mjs.
 * Resumable and idempotent: by default skips jobs that already have a
 * classified (non-UNKNOWN) seniority_level, so re-running after an
 * interruption just picks up where it left off. Pass --force to
 * reclassify everything regardless of current value (e.g. after a rule
 * change in lib/seniority.mjs).
 *
 * Usage:
 *   node --env-file=.env.local scripts/backfill-seniority.mjs
 *   node --env-file=.env.local scripts/backfill-seniority.mjs --force
 *   SENIORITY_START_ID=12345 node --env-file=.env.local scripts/backfill-seniority.mjs   (manual resume point)
 */
import { query, closePool, upsertJobClassifications } from '../lib/db.mjs';
import { classifySeniority } from '../lib/seniority.mjs';

const FORCE = process.argv.includes('--force');
// Kept small on purpose: this runs alongside the live scanner (every ~45min),
// which competes for the same RDS I/O. Smaller batches finish well inside
// the pool's 30s statement_timeout even under scan contention; a short pause
// between batches gives the scanner room to breathe rather than racing it.
const BATCH = 150;
const INTER_BATCH_PAUSE_MS = 150;
const MAX_BATCH_RETRIES = 8;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// SELECT and UPDATE below are both idempotent for a given lastId (the SELECT
// re-reads the same not-yet-classified window; the UPDATE just re-applies the
// same deterministic classification), so on a transient timeout — e.g. an
// autovacuum saturating I/O on jobs/raw_job_postings — we retry the same
// batch with backoff instead of crashing the whole run.
async function withRetry(fn, label) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= MAX_BATCH_RETRIES) throw err;
      const backoffMs = Math.min(30000, 1000 * 2 ** attempt);
      console.error(`  ⚠ ${label} failed (attempt ${attempt}/${MAX_BATCH_RETRIES}): ${err.message} — retrying in ${backoffMs}ms`);
      await sleep(backoffMs);
    }
  }
}

async function main() {
  let lastId = Number(process.env.SENIORITY_START_ID || 0);
  let processed = 0;
  let classified = 0; // ended up non-UNKNOWN
  const counts = {};
  const started = Date.now();

  while (true) {
    const { rows } = await withRetry(() => query(
      FORCE
        ? `SELECT id, title, description_clean, min_exp_years FROM jobs WHERE id > $1 ORDER BY id LIMIT $2`
        : `SELECT id, title, description_clean, min_exp_years FROM jobs
            WHERE id > $1 AND (seniority_level IS NULL OR seniority_level = 'UNKNOWN')
            ORDER BY id LIMIT $2`,
      [lastId, BATCH]
    ), 'select batch');
    if (!rows.length) break;

    const results = rows.map(row => ({
      row,
      result: classifySeniority({ title: row.title }, row.description_clean || '', row.min_exp_years),
    }));

    // Only touch rows whose classification actually changes something —
    // avoids a no-op write (and its index/WAL cost) for jobs that stay UNKNOWN.
    const toUpdate = results.filter(({ result }) => result.level !== 'UNKNOWN');
    if (toUpdate.length) {
      const ids    = toUpdate.map(({ row }) => row.id);
      const levels = toUpdate.map(({ result }) => result.level);
      await withRetry(() => query(
        `UPDATE jobs AS j SET seniority_level = u.level
           FROM UNNEST($1::bigint[], $2::text[]) AS u(id, level)
          WHERE j.id = u.id`,
        [ids, levels]
      ), 'update batch');
      await withRetry(() => upsertJobClassifications(toUpdate.map(({ row, result }) => ({
        jobId: row.id,
        fieldName: 'seniority_level',
        value: result.level,
        confidence: result.confidence,
        version: result.classifierVersion,
        evidence: result.evidence,
      }))), 'classifications batch');
    }

    await sleep(INTER_BATCH_PAUSE_MS);

    for (const { result } of results) {
      counts[result.level] = (counts[result.level] || 0) + 1;
      if (result.level !== 'UNKNOWN') classified++;
    }

    processed += rows.length;
    lastId = rows[rows.length - 1].id;
    if (processed % 5000 === 0 || rows.length < BATCH) {
      console.error(`  [${processed.toLocaleString()} processed]  classified=${classified.toLocaleString()}  last_id=${lastId}`);
    }
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.error(`\nSeniority backfill complete in ${elapsed}s.`);
  console.error(`  Processed:  ${processed.toLocaleString()} jobs`);
  console.error(`  Classified: ${classified.toLocaleString()} (non-UNKNOWN)`);
  console.error(`  Breakdown:`);
  for (const [level, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.error(`    ${level.padEnd(10)} ${n.toLocaleString()}`);
  }
}

main()
  .catch(error => { console.error('Seniority backfill failed:', error.message); process.exitCode = 1; })
  .finally(() => closePool());
