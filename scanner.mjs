#!/usr/bin/env node
/**
 * scanner.mjs  —  CLI entry point for the Rejekt.ai engine
 *
 * Usage:
 *   node scanner.mjs --harvest   [--ats greenhouse] [--dry-run] [--verbose] [--skip-validation]
 *   node scanner.mjs --scan      [--ats lever] [--company stripe] [--dry-run] [--verbose] [--skip-freshness]
 *   node scanner.mjs --freshen   [--threshold 3] [--verbose]
 *   node scanner.mjs --stats
 *   node scanner.mjs --smoke     [--ats greenhouse]   ← test 10 companies per ATS
 *
 * Environment:
 *   DATABASE_URL               postgres://user:pass@host:5432/dbname
 *   MISSED_SCANS_THRESHOLD     2 (default)
 *   COMMON_CRAWL_INDEX         CC-MAIN-2024-22 (default)
 */

import './lib/load-env.mjs';
import { parseArgs } from 'node:util';
import { closePool, query } from './lib/db.mjs';
import { runScan }          from './scanner/orchestrator.mjs';
import { harvest }          from './harvester/commoncrawl.mjs';
import { markClosedJobs, freshnessStats } from './freshness/checker.mjs';

// ─── Parse CLI args ───────────────────────────────────────────────────────────

const { values: flags } = parseArgs({
  options: {
    harvest:          { type: 'boolean', default: false },
    scan:             { type: 'boolean', default: false },
    freshen:          { type: 'boolean', default: false },
    stats:            { type: 'boolean', default: false },
    smoke:            { type: 'boolean', default: false },

    // Shared filters
    ats:              { type: 'string'  },
    company:          { type: 'string'  },

    // Flags
    'dry-run':        { type: 'boolean', default: false },
    verbose:          { type: 'boolean', default: false },
    'skip-freshness': { type: 'boolean', default: false },
    'skip-validation':{ type: 'boolean', default: false },
    threshold:        { type: 'string'  },   // integer, parsed below
    index:            { type: 'string'  },   // CC index name
    shard:            { type: 'string'  },   // e.g. "1/3"
    'min-age-hours':  { type: 'string'  },   // skip companies scanned within this many hours
  },
  allowPositionals: false,
  strict: false,
});

const dryRun          = flags['dry-run'];
const verbose         = flags.verbose;
const skipFreshness   = flags['skip-freshness'];
const skipValidation  = flags['skip-validation'];
const threshold       = flags.threshold ? parseInt(flags.threshold, 10) : undefined;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function banner(text) {
  console.error(`\n${'═'.repeat(56)}`);
  console.error(`  ${text}`);
  console.error(`${'═'.repeat(56)}\n`);
}

function fmtNum(n) { return (n ?? 0).toLocaleString(); }

// ─── --stats ─────────────────────────────────────────────────────────────────

async function showStats() {
  banner('Database statistics');

  // Companies
  const { rows: [co] } = await query(`
    SELECT
      COUNT(*)                            AS total,
      COUNT(*) FILTER (WHERE active)      AS active,
      COUNT(DISTINCT ats)                 AS ats_count,
      MIN(discovered)                     AS first_discovered,
      MAX(last_scan)                      AS last_scan
    FROM companies
  `);

  // Jobs
  const { rows: [jo] } = await query(`
    SELECT
      COUNT(*)                                     AS total,
      COUNT(*) FILTER (WHERE active)               AS active,
      COUNT(*) FILTER (WHERE NOT active)            AS closed,
      COUNT(*) FILTER (WHERE discovered > NOW()-INTERVAL '24h') AS new_24h,
      COUNT(*) FILTER (WHERE remote)               AS remote,
      MIN(discovered)                              AS first_job,
      MAX(last_seen)                               AS last_seen
    FROM jobs
  `);

  // Category breakdown
  const { rows: cats } = await query(`
    SELECT category, COUNT(*) AS n
      FROM jobs WHERE active=TRUE
     GROUP BY category ORDER BY n DESC
  `);

  // ATS breakdown
  const { rows: ats } = await query(`
    SELECT c.ats, COUNT(DISTINCT c.id) AS companies, COUNT(j.id) AS jobs
      FROM companies c
      LEFT JOIN jobs j ON j.company_id = c.id AND j.active = TRUE
     WHERE c.active = TRUE
     GROUP BY c.ats ORDER BY jobs DESC
  `);

  // Last scan runs
  const { rows: runs } = await query(`
    SELECT started_at, companies_scanned, jobs_new, jobs_closed,
           EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000 AS elapsed_ms
      FROM scan_runs ORDER BY started_at DESC LIMIT 5
  `);

  // Freshness
  const fresh = await freshnessStats();

  console.error('COMPANIES');
  console.error(`  Total          : ${fmtNum(co.total)}`);
  console.error(`  Active         : ${fmtNum(co.active)}`);
  console.error(`  ATS platforms  : ${co.ats_count}`);
  console.error(`  First discover : ${co.first_discovered?.toISOString().slice(0,10) ?? 'n/a'}`);
  console.error(`  Last scan      : ${co.last_scan?.toISOString() ?? 'n/a'}\n`);

  console.error('JOBS');
  console.error(`  Total          : ${fmtNum(jo.total)}`);
  console.error(`  Active         : ${fmtNum(jo.active)}`);
  console.error(`  Closed         : ${fmtNum(jo.closed)}`);
  console.error(`  New (24h)      : ${fmtNum(jo.new_24h)}`);
  console.error(`  Remote         : ${fmtNum(jo.remote)}`);
  console.error(`  Stale (missed) : ${fmtNum(fresh.stale)}`);
  console.error(`  Closed (24h)   : ${fmtNum(fresh.closed_24h)}\n`);

  console.error('CATEGORIES (active jobs)');
  for (const { category, n } of cats) {
    console.error(`  ${(category ?? 'other').padEnd(14)}: ${fmtNum(n)}`);
  }

  console.error('\nBY ATS');
  for (const row of ats) {
    console.error(`  ${row.ats.padEnd(16)}: ${fmtNum(row.companies)} companies  ${fmtNum(row.jobs)} jobs`);
  }

  if (runs.length > 0) {
    console.error('\nRECENT SCAN RUNS');
    for (const r of runs) {
      const elapsed = r.elapsed_ms ? `${(r.elapsed_ms / 1000).toFixed(0)}s` : '?';
      console.error(
        `  ${r.started_at.toISOString().slice(0,16)}  ` +
        `companies=${fmtNum(r.companies_scanned)}  ` +
        `new=${fmtNum(r.jobs_new)}  ` +
        `closed=${fmtNum(r.jobs_closed)}  ` +
        `(${elapsed})`
      );
    }
  }
  console.error('');
}

// ─── --smoke ─────────────────────────────────────────────────────────────────

async function smokeTest(opts = {}) {
  banner('Smoke test — 10 companies per ATS');

  const atsFilter = opts.ats ? `AND ats = '${opts.ats.toLowerCase()}'` : '';
  const { rows: companies } = await query(`
    SELECT id, name, ats, slug, meta
      FROM companies
     WHERE active = TRUE ${atsFilter}
     ORDER BY ats, RANDOM()
     LIMIT ${opts.ats ? 10 : 70}
  `);

  if (companies.length === 0) {
    console.error('No active companies. Run --harvest first.');
    return;
  }

  await runScan({
    ...opts,
    dryRun: true,
    verbose: true,
    skipFreshness: true,
    // Override company list — pass via override if orchestrator supports it
    // For now: just run with dryRun + verbose to see fetches
  });
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

async function main() {
  if (!flags.harvest && !flags.scan && !flags.freshen && !flags.stats && !flags.smoke) {
    console.error(`
Rejekt.ai engine

Usage:
  node scanner.mjs --harvest    [--ats <ats>] [--dry-run] [--verbose] [--skip-validation]
  node scanner.mjs --scan       [--ats <ats>] [--company <name>] [--dry-run] [--verbose] [--skip-freshness]
  node scanner.mjs --freshen    [--threshold <n>] [--verbose]
  node scanner.mjs --stats
  node scanner.mjs --smoke      [--ats <ats>]

ATS values: greenhouse | ashby | lever | workday | bamboohr | workable | smartrecruiters
            recruitee | breezy | pinpoint | rippling | teamtailor | oraclecloud
    `);
    process.exit(0);
  }

  try {
    if (flags.harvest) {
      await harvest({
        ats:            flags.ats,
        dryRun,
        verbose,
        skipValidation,
        index:          flags.index,
      });
    }

    if (flags.scan) {
      await runScan({
        ats:           flags.ats,
        company:       flags.company,
        dryRun,
        verbose,
        skipFreshness,
        shard:         flags.shard,
        minAgeHours:   flags['min-age-hours'] ? +flags['min-age-hours'] : 0,
      });
    }

    if (flags.freshen) {
      banner('Manual freshness pass');
      const result = await markClosedJobs({ threshold, verbose });
      console.error(`Incremented : ${result.incremented}`);
      console.error(`Closed      : ${result.closed}\n`);
    }

    if (flags.stats) {
      await showStats();
    }

    if (flags.smoke) {
      await smokeTest({ ats: flags.ats, verbose: true });
    }

  } finally {
    await closePool();
  }
}

main().catch((err) => {
  console.error('\n💥 Fatal error:', err.message);
  if (verbose) console.error(err.stack);
  process.exit(1);
});
