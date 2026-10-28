#!/usr/bin/env node
/**
 * watchdog.mjs  —  Scan-run health monitor
 *
 * Periodically checks scan_runs for stuck "running" entries and marks
 * them as "timed_out". Also logs a live status summary to stdout.
 *
 * Usage:
 *   node --env-file=.env.local watchdog.mjs [--interval 60] [--timeout 120] [--verbose]
 *
 *   --interval N   check every N seconds        (default: 60)
 *   --timeout N    consider a run stuck after N minutes with zero progress (default: 120)
 *   --verbose      print full run table each tick
 */

import { parseArgs } from 'node:util';
import { query, closePool } from './lib/db.mjs';

const { values: flags } = parseArgs({
  options: {
    interval: { type: 'string',  default: '60'  },
    timeout:  { type: 'string',  default: '120' },
    verbose:  { type: 'boolean', default: false  },
  },
  strict: false,
});

const INTERVAL_MS  = parseInt(flags.interval, 10) * 1_000;
const TIMEOUT_MINS = parseInt(flags.timeout,  10);
const VERBOSE      = flags.verbose;

// ── Formatting helpers ───────────────────────────────────────────────────────

function fmt(n)  { return String(n ?? 0).padStart(6); }
function ago(ts) {
  if (!ts) return '—';
  const s = Math.round((Date.now() - new Date(ts)) / 1000);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ${s%60}s ago`;
  return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m ago`;
}
function duration(start, end) {
  const ms = (end ? new Date(end) : new Date()) - new Date(start);
  const s  = Math.round(ms / 1000);
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.floor(s/60)}m ${s%60}s`;
  return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;
}

// ── Core check ───────────────────────────────────────────────────────────────

async function check() {
  const now = new Date().toLocaleTimeString();

  // 1. Fetch recent runs
  const { rows: runs } = await query(`
    SELECT id, started_at, finished_at, status,
           companies_scanned, companies_errored,
           jobs_fetched, jobs_new, jobs_closed, jobs_reactivated
      FROM scan_runs
     ORDER BY started_at DESC
     LIMIT 20
  `);

  // 2. Mark hard-stuck runs (0 companies, over timeout)
  const { rows: timedOut } = await query(`
    UPDATE scan_runs
       SET status      = 'timed_out',
           finished_at = NOW()
     WHERE status      = 'running'
       AND companies_scanned = 0
       AND started_at  < NOW() - ($1 * interval '1 minute')
     RETURNING id, started_at
  `, [TIMEOUT_MINS]);

  // 3. Mark zombie runs (some progress but running 3x longer than timeout)
  const { rows: zombies } = await query(`
    UPDATE scan_runs
       SET status      = 'timed_out',
           finished_at = NOW()
     WHERE status      = 'running'
       AND companies_scanned > 0
       AND started_at  < NOW() - ($1 * interval '1 minute')
     RETURNING id, started_at, companies_scanned
  `, [TIMEOUT_MINS * 3]);

  // ── Print summary ──────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(72)}`);
  console.log(`  🐕  Watchdog tick  ${now}   (timeout: ${TIMEOUT_MINS}m)`);
  console.log(`${'─'.repeat(72)}`);

  if (timedOut.length > 0) {
    console.log(`  ⚠️  Marked ${timedOut.length} stuck run(s) as timed_out:`);
    for (const r of timedOut) {
      console.log(`     run #${r.id}  started ${ago(r.started_at)}  (0 companies — hard stuck)`);
    }
  }
  if (zombies.length > 0) {
    console.log(`  ⚠️  Marked ${zombies.length} zombie run(s) as timed_out:`);
    for (const r of zombies) {
      console.log(`     run #${r.id}  started ${ago(r.started_at)}  (${r.companies_scanned} co — zombie shard)`);
    }
  }
  if (timedOut.length === 0 && zombies.length === 0) {
    console.log(`  ✔  No stuck runs found.`);
  }

  // ── Active runs ────────────────────────────────────────────────────────────
  const liveRunning = runs.filter(r => r.status === 'running');
  if (liveRunning.length > 0) {
    console.log(`\n  Active scan runs (${liveRunning.length}):`);
    for (const r of liveRunning) {
      const mins  = (Date.now() - new Date(r.started_at)) / 60_000;
      const badge = (mins > TIMEOUT_MINS && Number(r.companies_scanned) === 0)
        ? '🔴 STUCK'
        : mins > TIMEOUT_MINS
          ? '🟡 SLOW '
          : '🔵 OK   ';
      console.log(
        `    ${badge}  run #${r.id}  duration ${duration(r.started_at)}` +
        `  companies: ${r.companies_scanned}  fetched: ${r.jobs_fetched}  new: ${r.jobs_new}`
      );
    }
  } else {
    console.log(`  No active scan runs.`);
  }

  // ── Verbose: full table ────────────────────────────────────────────────────
  if (VERBOSE) {
    console.log(`\n  Recent runs (last 20):`);
    for (const r of runs) {
      const mins = (Date.now() - new Date(r.started_at)) / 60_000;
      let badge;
      if (r.status === 'completed')  badge = '✅';
      else if (r.status === 'failed' || r.status === 'timed_out') badge = '❌';
      else if (mins > TIMEOUT_MINS && Number(r.companies_scanned) === 0) badge = '🔴';
      else if (mins > TIMEOUT_MINS)  badge = '🟡';
      else                           badge = '🔵';
      console.log(
        `  ${badge} #${String(r.id).padEnd(5)} ${r.status.padEnd(12)} ` +
        `${duration(r.started_at, r.finished_at).padEnd(10)} ` +
        `co:${r.companies_scanned} fetch:${r.jobs_fetched} new:${r.jobs_new} err:${r.companies_errored} ` +
        `| started ${ago(r.started_at)}`
      );
    }
  }

  // ── Summary line ──────────────────────────────────────────────────────────
  const completed = runs.filter(r => r.status === 'completed').length;
  const failed    = runs.filter(r => r.status === 'failed' || r.status === 'timed_out').length;
  console.log(`\n  Last 20 runs: ${liveRunning.length} running  ·  ${completed} completed  ·  ${failed} failed/timed_out`);
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function main() {
  console.log(`🐕  Watchdog started`);
  console.log(`   interval : every ${INTERVAL_MS / 1000}s`);
  console.log(`   stuck    : running > ${TIMEOUT_MINS}m with 0 companies → timed_out`);
  console.log(`   zombie   : running > ${TIMEOUT_MINS * 3}m regardless   → timed_out`);

  try { await check(); } catch (e) { console.error('[watchdog] check error:', e.message); }

  const timer = setInterval(async () => {
    try { await check(); } catch (e) { console.error('[watchdog] check error:', e.message); }
  }, INTERVAL_MS);

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      console.log(`\n[watchdog] ${sig} — shutting down`);
      clearInterval(timer);
      await closePool();
      process.exit(0);
    });
  }
}

main().catch(e => { console.error(e); process.exit(1); });
