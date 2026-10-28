/**
 * lib/scan-status.mjs — live scan state for the /scan-log page.
 * Which scanner processes are running, per-platform progress, and when the
 * scheduled (launchd) scan fires next. Read-only.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from './db.mjs';

const run = promisify(execFile);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LABEL = 'com.job-discovery-saas.scan';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

const etimeToSecs = (e) => {            // [[dd-]hh:]mm:ss
  const [d, rest] = e.includes('-') ? e.split('-') : [0, e];
  const p = rest.split(':').map(Number);
  while (p.length < 3) p.unshift(0);
  return (+d) * 86400 + p[0] * 3600 + p[1] * 60 + p[2];
};

export async function scannerProcesses() {
  const { stdout } = await run('ps', ['-eo', 'pid=,ppid=,etime=,command=']);
  const rows = stdout.split('\n').map(l => l.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean)
    .map(([, pid, ppid, etime, cmd]) => ({ pid: +pid, ppid: +ppid, secs: etimeToSecs(etime), cmd }));
  const byPid = new Map(rows.map(r => [r.pid, r]));
  return rows.filter(r => /scanner\.mjs\s+--scan/.test(r.cmd) && !/\bps\b|grep/.test(r.cmd)).map(r => {
    const parent = byPid.get(r.ppid)?.cmd || '';
    return {
      pid: r.pid, elapsedSecs: r.secs,
      ats: (r.cmd.match(/--ats\s+(\S+)/) || [])[1] || 'all',
      source: /run-bulk-scan/.test(parent) ? 'bulk' : /run-scan\.sh/.test(parent) ? 'scheduled' : 'manual',
    };
  });
}

function lastLogLine(file, re) {
  try {
    const lines = fs.readFileSync(path.join(ROOT, 'logs', file), 'utf8').trimEnd().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) { const m = lines[i].match(re); if (m) return m; }
  } catch { /* log missing */ }
  return null;
}

async function schedule(running) {
  let intervalSecs = null, loaded = false;
  try { intervalSecs = +fs.readFileSync(PLIST, 'utf8').match(/StartInterval<\/key>\s*<integer>(\d+)/)[1]; } catch { /* no plist */ }
  try { loaded = (await run('launchctl', ['list'])).stdout.includes(LABEL); } catch { /* ignore */ }
  const m = lastLogLine('scan.log', /^=== (\S+) — scan starting/);
  const lastStart = m ? new Date(m[1]) : null;
  const nextAt = intervalSecs && lastStart ? new Date(lastStart.getTime() + intervalSecs * 1000) : null;
  return {
    loaded, intervalSecs, lastStart, nextAt,
    runningNow: running.some(p => p.source === 'scheduled'),
    overdue: !!(nextAt && nextAt < new Date() && loaded && !running.some(p => p.source === 'scheduled')),
  };
}

export async function getScanStatus() {
  const procs = await scannerProcesses();
  const sched = await schedule(procs);

  const { rows: ats } = await query(`
    SELECT ats,
           COUNT(*)                                                     AS companies,
           COUNT(*) FILTER (WHERE NOT active)                           AS dead,
           COUNT(*) FILTER (WHERE active AND last_scan IS NULL)         AS waiting,
           COUNT(*) FILTER (WHERE last_scan IS NOT NULL)                AS scanned,
           COUNT(*) FILTER (WHERE active AND scan_errors > 0)           AS erroring,
           COUNT(*) FILTER (WHERE last_scan > NOW() - INTERVAL '15 minutes') AS scanned_15m,
           MAX(last_scan)                                               AS last_scan
      FROM companies GROUP BY ats`);
  const { rows: jobs } = await query(`SELECT ats, COUNT(*) AS active_jobs FROM jobs WHERE active GROUP BY ats`);
  const { rows: fresh } = await query(`SELECT ats, COUNT(*) AS new_1h FROM jobs WHERE discovered > NOW() - INTERVAL '1 hour' GROUP BY ats`);
  const jobsBy = Object.fromEntries(jobs.map(r => [r.ats, +r.active_jobs]));
  const freshBy = Object.fromEntries(fresh.map(r => [r.ats, +r.new_1h]));
  const fullScan = procs.some(p => p.ats === 'all');

  const platforms = ats.map(r => {
    const running = fullScan || procs.some(p => p.ats === r.ats);
    const waiting = +r.waiting, rate = +r.scanned_15m / 15;          // companies per minute
    return {
      ats: r.ats, companies: +r.companies, dead: +r.dead, waiting, scanned: +r.scanned, erroring: +r.erroring,
      activeJobs: jobsBy[r.ats] || 0, new1h: freshBy[r.ats] || 0, lastScan: r.last_scan,
      ratePerMin: +rate.toFixed(1),
      etaMins: running && waiting && rate > 0 ? Math.ceil(waiting / rate) : null,
      state: running ? 'running' : waiting > 0 ? 'waiting' : 'idle',
    };
  }).sort((a, b) => (b.state === 'running') - (a.state === 'running') || b.waiting - a.waiting || b.activeJobs - a.activeJobs);

  const bulk = lastLogLine('bulk-scan.log', /^=== (.*?)(?: ===)?$/);
  return {
    now: new Date(), processes: procs, schedule: sched, platforms,
    bulk: { running: procs.some(p => p.source === 'bulk'), lastEvent: bulk ? bulk[1].trim() : null },
  };
}

/** Close scan_runs rows left 'running' by killed scans. Only acts when no scanner process exists. */
export async function reapStaleRuns() {
  if ((await scannerProcesses()).length) return 0;
  const { rowCount } = await query(`UPDATE scan_runs SET status = 'failed', finished_at = started_at WHERE status = 'running'`);
  return rowCount;
}
