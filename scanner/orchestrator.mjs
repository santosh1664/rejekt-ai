/**
 * scanner/orchestrator.mjs
 *
 * Loads all active companies from PostgreSQL and dispatches them
 * in parallel using per-ATS concurrency pools.
 *
 * Architecture:
 *   - One pool per ATS (respects their individual rate limits)
 *   - Companies scheduled round-robin into their ATS pool
 *   - All pools run concurrently (Greenhouse + Ashby + Lever all run at same time)
 *   - Progress reported every N completions
 */

import { query, startScanRun, finishScanRun, batchTouchCompanies } from '../lib/db.mjs';
import { createPool }                          from '../lib/pool.mjs';
import { ATS_CONCURRENCY }                     from '../lib/pool.mjs';
import { processCompany }                      from './worker.mjs';
import { markClosedJobs }                      from '../freshness/checker.mjs';
import { matchNewJobs }                        from '../matching/matcher.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Run a full scan across all active companies.
 *
 * @param {object} opts
 * @param {string}  [opts.ats]      — filter to one ATS only
 * @param {string}  [opts.company]  — filter to one company name (substring)
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.verbose]
 * @param {boolean} [opts.skipFreshness] — skip the freshness pass
 */
export async function runScan(opts = {}) {
  const started = Date.now();

  // Self-heal: a run that crashed hard (RDS unreachable, OOM, kill -9,
  // machine sleep) never reaches the try/finally below, so it never gets a
  // finished_at and sits at status='running' forever. Normal runs take
  // 2-40 min (the orchestrator's own per-company timeouts cap it); anything
  // still 'running' after 90 min is unambiguously dead. Auto-fail those here
  // instead of leaving permanent zombie rows for someone to notice and
  // clean up by hand.
  if (!opts.dryRun) {
    const { rowCount } = await query(`
      UPDATE scan_runs SET status = 'failed', finished_at = started_at
       WHERE status = 'running' AND started_at < NOW() - INTERVAL '90 minutes'
    `).catch(() => ({ rowCount: 0 })); // best-effort — don't let this block a real scan
    if (rowCount > 0) console.error(`   Cleaned up ${rowCount} stale 'running' scan_runs row(s) from a previous crash\n`);
  }

  // Load companies
  let sql    = `SELECT id, name, ats, slug, meta FROM companies WHERE active = TRUE`;
  const params = [];
  if (opts.ats) {
    params.push(opts.ats.toLowerCase());
    sql += ` AND ats = $${params.length}`;
  }
  if (process.env.SKIP_ATS) {
    // e.g. SKIP_ATS=workable while the host has our IP banned (429 with a long Retry-After)
    params.push(process.env.SKIP_ATS.toLowerCase().split(','));
    sql += ` AND NOT (ats = ANY($${params.length}))`;
  }
  if (opts.company) {
    params.push(`%${opts.company.toLowerCase()}%`);
    sql += ` AND lower(name) LIKE $${params.length}`;
  }
  if (opts.minAgeHours > 0) {
    // skip companies scanned recently, so an interrupted or repeated run resumes instead of starting over
    params.push(opts.minAgeHours);
    sql += ` AND (last_scan IS NULL OR last_scan < NOW() - ($${params.length} * INTERVAL '1 hour'))`;
  }
  sql += ` ORDER BY priority ASC, last_scan ASC NULLS FIRST`;

  let { rows: companies } = await query(sql, params);

  // Sharding: --shard 1/3 means "take every company whose (index % 3) === 0"
  if (opts.shard) {
    const [part, total] = opts.shard.split('/').map(Number);
    companies = companies.filter((_, i) => i % total === part - 1);
    console.error(`   Shard ${part}/${total}: ${companies.length} companies`);
  }

  if (companies.length === 0) {
    console.error('No active companies found. Run --harvest first.');
    return;
  }

  console.error(`\n🔍  Scanning ${companies.length} companies across ${[...new Set(companies.map(c => c.ats))].join(', ')}`);
  console.error(`    Mode: ${opts.dryRun ? 'DRY RUN' : 'LIVE'} · ${opts.quick ? 'quick (new jobs only)' : 'full'}  |  ${new Date().toISOString()}\n`);

  // Start audit run
  const runId = opts.dryRun ? null : await startScanRun();

  // Totals — declared outside the try so the catch block can still report
  // (and persist) whatever partial progress was made before a crash.
  const totals = {
    companiesScanned:  0,
    companiesErrored:  0,
    jobsFetched:       0,
    jobsNew:           0,
    jobsReactivated:   0,
    jobsClosed:        0,
    jobsUnchanged:     0,
  };
  // Collect company IDs for batched touchCompany at end (2 queries instead of N)
  const companySuccessIds = [];
  const companyErrorIds   = [];

  try {
    // Build one pool per ATS
    const pools = {};
    for (const ats of Object.keys(ATS_CONCURRENCY)) {
      pools[ats] = createPool(ATS_CONCURRENCY[ats]);
    }
    const defaultPool = createPool(10);

    // Max time to allow a single company to process before giving up on it.
    // Worst-case HTTP: 3 attempts × 15s + 2 delays × 2s = 49s. Add generous
    // buffer for DB round-trips (many jobs) and slow ATS responses → 90s.
    const COMPANY_TIMEOUT_MS = +process.env.COMPANY_TIMEOUT_MS || 90_000;

    // Stop starting new companies once the run's time budget is spent, so the run ends on its own
    // (saves progress, closes old jobs, matches) before run-scan.sh's 3h kill (135 min leaves time for closing old jobs and matching). Companies left over
    // are scanned first next run (ORDER BY last_scan). Every run used to be killed, so it never finished.
    const deadline = started + (+process.env.SCAN_BUDGET_MIN || 135) * 60_000;
    let leftForNext = 0;

    // Dispatch all companies into their ATS pool concurrently
    const tasks = companies.map((company) => {
      const pool = pools[company.ats] || defaultPool;
      return pool(async () => {
        if (Date.now() > deadline) { leftForNext++; return null; }
        // Wrap processCompany in a per-company timeout so a single hung worker
        // (e.g. dead RDS connection or stalled HTTP response) can't block the
        // entire scan indefinitely.
        const result = await Promise.race([
          processCompany(company, opts),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error(`company timeout after ${COMPANY_TIMEOUT_MS / 1000}s`)),
              COMPANY_TIMEOUT_MS
            )
          ),
        ]).catch((err) => {
          if (opts.verbose) {
            console.error(`  ✗ ${company.name} (${company.ats}): ${err.message}`);
          }
          return { fetched: 0, newJobs: 0, reactivated: 0, error: err.message };
        });
        totals.companiesScanned++;
        totals.jobsFetched     += result.fetched;
        totals.jobsNew         += result.newJobs;
        totals.jobsReactivated += result.reactivated;
        totals.jobsUnchanged   += result.unchanged ?? 0;
        if (result.error && /429|statement timeout|company timeout|timeout exceeded|Connection terminated|ECONNRESET|too many clients/i.test(result.error)) {
          // rate-limited by the host or our own DB/pool under load: not the company's fault,
          // so don't count it toward deactivation (and leave last_scan alone so a resume retries it)
          totals.companiesErrored++;
        } else if (result.error) {
          totals.companiesErrored++;
          if (!opts.dryRun) companyErrorIds.push(result.companyId);
        } else {
          if (!opts.dryRun) companySuccessIds.push(result.companyId);
        }

        // Progress log every 50 companies; also save which companies are done so a killed run can resume
        if (totals.companiesScanned % 50 === 0) {
          if (!opts.dryRun) await batchTouchCompanies(companySuccessIds.splice(0), companyErrorIds.splice(0)).catch(() => {});
          console.error(
            `  [${totals.companiesScanned}/${companies.length}]  ` +
            `new=${totals.jobsNew}  errors=${totals.companiesErrored}`
          );
        }

        return result;
      });
    });

    await Promise.all(tasks);
    if (leftForNext) console.error(`\n⏱   Time budget reached: ${leftForNext} companies left for the next run`);

    // Batch-update all company last_scan timestamps in 2 queries (instead of N)
    if (!opts.dryRun) {
      await batchTouchCompanies(companySuccessIds, companyErrorIds).catch(err =>
        console.error(`  ⚠️  batchTouchCompanies failed (non-fatal): ${err.message}`)
      );
    }

    // Freshness pass — mark jobs not seen in N consecutive runs as closed.
    // This is best-effort maintenance, not part of the scan's core contract:
    // the `jobs` table's index footprint currently makes this bulk UPDATE
    // very slow under RDS I/O pressure (observed up to ~25 min for one pass,
    // see freshness/checker.mjs). A slow-but-working freshness pass used to
    // sink the ENTIRE run's status to 'failed' even though the actual scan
    // (fetching + upserting jobs, the time-sensitive part) had already
    // completed successfully — isolate it so it can't do that.
    // Quick runs don't see every job, so only full runs may count jobs as missing.
    if (!opts.dryRun && !opts.skipFreshness && !opts.quick) {
      console.error('\n🔄  Running freshness check...');
      try {
        const { closed } = await markClosedJobs({ since: new Date(started) });   // only companies this run reached
        totals.jobsClosed = closed;
      } catch (err) {
        console.error(`  ⚠️  Freshness check failed (non-fatal): ${err.message}`);
      }
    }

    // Matching pass
    if (!opts.dryRun && totals.jobsNew > 0) {
      console.error('👥  Running matcher pass...');
      // cover the whole run: runs last up to ~2.5h, a fixed 120 min missed the early new jobs
      const since = Math.ceil((Date.now() - started) / 60_000) + 5;
      const { matched } = await matchNewJobs({ since, verbose: opts.verbose }).catch(() => ({ matched: 0 }));
      if (matched > 0) console.error(`   -> ${matched.toLocaleString()} user alerts created`);
    }

    // Finish audit run
    if (runId) await finishScanRun(runId, totals, 'completed');
    if (!opts.dryRun && !opts.quick && !opts.ats && !opts.company) {
      fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'logs', 'last-full-scan'), new Date().toISOString());
    }

    // Summary
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    console.error(`\n${'─'.repeat(56)}`);
    console.error(`✅  Scan complete  (${elapsed}s)${opts.dryRun ? '  [DRY RUN]' : ''}`);
    console.error(`${'─'.repeat(56)}`);
    console.error(`   Companies scanned  : ${totals.companiesScanned}`);
    console.error(`   Companies errored  : ${totals.companiesErrored}`);
    console.error(`   Jobs fetched       : ${totals.jobsFetched.toLocaleString()}`);
    console.error(`   Unchanged (skipped): ${(totals.jobsUnchanged ?? 0).toLocaleString()}`);
    console.error(`   New / changed      : ${totals.jobsNew.toLocaleString()}`);
    console.error(`   Reactivated        : ${totals.jobsReactivated}`);
    console.error(`   Closed/inactive    : ${totals.jobsClosed}`);
    console.error(`${'─'.repeat(56)}\n`);

  } catch (err) {
    // Whatever broke (RDS unreachable, an unhandled rejection, ...) — record
    // it as 'failed' with whatever partial totals we have instead of leaving
    // the row stuck at 'running' forever. Re-throw so the caller's own
    // fatal-error handling (logging, process exit code) still runs.
    console.error(`\n💥  Scan run failed: ${err.message}`);
    if (runId) await finishScanRun(runId, totals, 'failed').catch(() => {});
    throw err;
  }
}
