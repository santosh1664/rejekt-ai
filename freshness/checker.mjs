/**
 * freshness/checker.mjs
 *
 * Job freshness tracking — run AFTER a full scan completes.
 *
 * Strategy:
 *   1. Any active job whose last_seen is older than "this scan window" hasn't
 *      been seen in the current run → increment missed_scans.
 *   2. Jobs whose missed_scans >= MISSED_SCANS_THRESHOLD are marked inactive.
 *
 * We detect "this scan window" as: last_seen < NOW() - interval '2 hours'
 * (scan windows are every 6 hours; 2h gives buffer for slow ATS providers).
 *
 * MISSED_SCANS_THRESHOLD env default: 2
 *   → a job must be absent in 2 consecutive scans before being closed.
 *   → with 6h scans: job closed after ~12 hours of absence.
 *
 * PERFORMANCE NOTE:
 *   The jobs table has no fillfactor set (default 100), which prevents HOT
 *   updates — every UPDATE forces index maintenance on ALL indexes, including
 *   a large GIN full-text index on `description` that freshness never touches.
 *   To avoid one massive table-spanning UPDATE that holds locks for minutes,
 *   we chunk the work by id range (BATCH_SIZE rows at a time). Each small
 *   batch:
 *     • acquires and releases row locks quickly → less contention
 *     • produces less WAL I/O per round-trip
 *     • allows autovacuum to interleave between batches
 *   Run `DROP INDEX CONCURRENTLY idx_jobs_description_fts` on the DB to
 *   eliminate the GIN index cost permanently once confirmed unused.
 */

import { getPool } from '../lib/db.mjs';

const THRESHOLD   = parseInt(process.env.MISSED_SCANS_THRESHOLD ?? '2', 10);
// Raised 5000->15000 (2026-09-21): observed a run where 20 total rows changed
// across the whole `jobs` table still cost 535s combined for step 1 + step 2 —
// almost entirely per-batch round-trip overhead during a slow-RDS window, not
// row-count-proportional work (most batches match ~0 rows in their id range
// but still cost a full round-trip). Fewer, larger batches cuts that
// multiplier directly. Keeps the original point of batching (bounded work per
// statement, no single all-table UPDATE) while reducing round-trip count ~3x.
const BATCH_SIZE  = parseInt(process.env.FRESHNESS_BATCH_SIZE   ?? '15000', 10);

// Each batch gets this timeout. 30s was too little while a scan or the Workable feed load keeps RDS busy:
// one slow batch failed the whole pass and no jobs were closed.
const BATCH_TIMEOUT_MS = +process.env.FRESHNESS_BATCH_TIMEOUT_MS || 120_000;

// Pause between batches to let autovacuum and other queries breathe.
const INTER_BATCH_PAUSE_MS = 200;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Run UPDATE in id-range batches.
 * Returns total rowCount affected.
 */
async function batchedUpdate(client, sql, params, opts = {}) {
  const { verbose } = opts;

  // Find the id bounds of qualifying rows first so we can page by id.
  // This avoids OFFSET-based pagination which gets slower as offset grows.
  const boundsResult = await client.query(`
    SELECT MIN(id) AS min_id, MAX(id) AS max_id
      FROM jobs
     WHERE active = TRUE
  `);
  const { min_id, max_id } = boundsResult.rows[0];
  if (!min_id) return 0;    // no active jobs at all

  let totalAffected = 0;
  let batchNum      = 0;
  let lo            = Number(min_id);
  const hi          = Number(max_id);

  while (lo <= hi) {
    const batchHi = lo + BATCH_SIZE - 1;
    batchNum++;

    // Inject id-range filter at the end of each UPDATE's WHERE clause.
    // The caller's sql must end with its own WHERE predicate; we append AND.
    const batchSql = sql.replace('__ID_RANGE__', `AND id BETWEEN ${lo} AND ${batchHi}`);
    const result   = await client.query(batchSql, params);
    totalAffected += result.rowCount ?? 0;

    if (verbose) {
      process.stderr.write(`    batch ${batchNum}: ids ${lo}–${batchHi}  rows=${result.rowCount}\n`);
    }

    lo = batchHi + 1;

    if (lo <= hi) await sleep(INTER_BATCH_PAUSE_MS);
  }

  return totalAffected;
}

/**
 * Mark jobs not seen in the current scan as having missed a scan.
 * Close jobs that have exceeded the missed-scan threshold.
 *
 * @param {object} [opts]
 * @param {number} [opts.threshold]      — override env MISSED_SCANS_THRESHOLD
 * @param {number} [opts.windowMinutes]  — how far back "current scan window" is (default 120)
 * @param {boolean} [opts.verbose]
 * @returns {Promise<{ incremented: number, closed: number }>}
 */
export async function markClosedJobs(opts = {}) {
  const pool      = getPool();
  const threshold = opts.threshold ?? THRESHOLD;
  const window    = opts.windowMinutes ?? 120;   // 2h buffer inside a 6h cycle

  if (opts.verbose) {
    console.error(`  [freshness] threshold=${threshold} scans  window=${window}min  batchSize=${BATCH_SIZE}`);
  }

  const client = await pool.connect();
  // A raw client from pool.connect() emits its own 'error' event if the
  // underlying connection drops (e.g. RDS network blip mid-query). Without a
  // listener here, that's an unhandled EventEmitter error — which crashes the
  // ENTIRE node process, bypassing every try/catch including the orchestrator's
  // soft-fail wrapper around this function. Observed 2026-09-21: an ETIMEDOUT
  // here killed a scan mid-repair. The pending query's own promise already
  // rejects on the same failure and is handled by the try/catch below; this
  // listener just stops the redundant 'error' event from being fatal.
  let connectionError = null;
  client.on('error', (err) => {
    connectionError = err;
    console.error('  [freshness] client connection error:', err.message);
  });
  try {
    await client.query(`SET statement_timeout = ${BATCH_TIMEOUT_MS}`);

    // ── Step 1 — Increment missed_scans for stale jobs (batched by id) ──────
    const t1 = Date.now();
    const incremented = await batchedUpdate(
      client,
      `UPDATE jobs
          SET missed_scans = missed_scans + 1
        WHERE active = TRUE
          ${opts.since
            // a run's own start: not seen since it began, and only companies it scanned cleanly
            // …except companies whose board was cut off at a page cap (Workday 200, Oracle 1,000 jobs): unseen ≠ gone
            ? `AND last_seen < $1 AND company_id IN (SELECT id FROM companies WHERE last_scan >= $1 AND scan_errors = 0)
               AND NOT (company_id = ANY($2::int[]))`
            : `AND last_seen < NOW() - ($1 * interval '1 minute')`}
          __ID_RANGE__`,
      opts.since ? [opts.since, opts.skipCompanies || []] : [window],
      opts,
    );
    const ms1 = Date.now() - t1;

    // ── Step 2 — Close jobs exceeding the threshold (batched by id) ─────────
    const t2 = Date.now();
    const closed = await batchedUpdate(
      client,
      `UPDATE jobs
          SET active    = FALSE,
              closed_at = NOW()
        WHERE active        = TRUE
          AND missed_scans >= $1
          __ID_RANGE__`,
      [threshold],
      opts,
    );
    const ms2 = Date.now() - t2;

    if (opts.verbose || closed > 0) {
      console.error(
        `  [freshness] incremented=${incremented} (${ms1}ms)  ` +
        `closed=${closed} (${ms2}ms)  ` +
        `(threshold=${threshold} consecutive missed scans)`
      );
    }

    return { incremented, closed };
  } finally {
    // Restore pool default before returning connection — but skip this (and
    // pass the error into release) if the connection already died, so the
    // pool discards it instead of recycling a dead connection to whoever
    // acquires next.
    if (!connectionError) {
      await client.query('SET statement_timeout = 30000').catch(() => {});
    }
    client.release(connectionError);
  }
}

/**
 * Reactivate jobs that reappeared (missed_scans reset on upsert in db.mjs,
 * and active flipped back to TRUE).  This function just returns a count of
 * how many jobs were reactivated in the last scan window for reporting.
 *
 * @returns {Promise<number>}
 */
export async function countReactivated() {
  const pool = getPool();
  const { rows } = await pool.query(`
    SELECT COUNT(*)::int AS n
      FROM jobs
     WHERE active        = TRUE
       AND missed_scans  = 0
       AND closed_at IS NOT NULL
       AND last_seen >= NOW() - INTERVAL '3 hours'
  `);
  return rows[0]?.n ?? 0;
}

/**
 * Return a quick summary of job health for --stats output.
 *
 * @returns {Promise<object>}
 */
export async function freshnessStats() {
  const pool = getPool();
  const { rows } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE active = TRUE)                              AS active,
      COUNT(*) FILTER (WHERE active = FALSE)                             AS closed,
      COUNT(*) FILTER (WHERE active = TRUE  AND missed_scans > 0)       AS stale,
      COUNT(*) FILTER (WHERE active = FALSE AND closed_at > NOW() - INTERVAL '24 hours') AS closed_24h,
      MAX(last_seen)                                                     AS last_seen_any
    FROM jobs
  `);
  return rows[0];
}
