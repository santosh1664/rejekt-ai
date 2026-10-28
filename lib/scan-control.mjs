/**
 * lib/scan-control.mjs — start/stop scans from the /scan-log page.
 *   start 'bulk'      → scripts/run-bulk-scan.sh (every queued platform, one at a time)
 *   start <ats>       → scripts/run-bulk-scan.sh <ats>
 *   start 'scheduled' → kick the launchd job now
 *   stop  'all'|<ats> → kill matching scanner processes; a bulk run is stopped as a whole
 *                       (otherwise its wrapper script would just launch the next pass)
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_ATS } from './ats-detect.mjs';
import { scannerProcesses, reapStaleRuns } from './scan-status.mjs';

const run = promisify(execFile);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LABEL = 'com.job-discovery-saas.scan';
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function startScan(target) {
  const procs = await scannerProcesses();
  if (target === 'scheduled') {
    if (procs.some(p => p.source === 'scheduled')) return { ok: false, message: 'Scheduled scan is already running' };
    await run('launchctl', ['kickstart', `gui/${os.userInfo().uid}/${LABEL}`]);
    return { ok: true, message: 'Scheduled scan started' };
  }
  if (target !== 'bulk' && !SUPPORTED_ATS.includes(target)) return { ok: false, message: `Unknown platform: ${target}` };
  if (procs.some(p => p.source === 'bulk')) return { ok: false, message: 'A bulk run is already running. Stop it first.' };
  if (target !== 'bulk' && procs.some(p => p.ats === target || p.ats === 'all')) return { ok: false, message: `${target} is already being scanned` };
  const child = spawn('/bin/bash', [path.join(ROOT, 'scripts', 'run-bulk-scan.sh'), ...(target === 'bulk' ? [] : [target])],
    { cwd: ROOT, detached: true, stdio: 'ignore' });
  child.unref();
  return { ok: true, message: target === 'bulk' ? 'Bulk run started (all queued platforms)' : `Started ${target}` };
}

export async function stopScans(target) {
  const procs = await scannerProcesses();
  const hit = procs.filter(p => target === 'all' || p.ats === target || (p.ats === 'all' && target !== 'all'));
  if (!hit.length) return { ok: false, message: target === 'all' ? 'Nothing is running' : `${target} is not running` };
  // wrapper scripts first, or they relaunch the next pass / next platform
  if (target === 'all' || hit.some(p => p.source === 'bulk')) await run('pkill', ['-f', 'run-bulk-scan.sh']).catch(() => {});
  if (target === 'all' || hit.some(p => p.source === 'scheduled')) await run('pkill', ['-f', 'run-scan.sh']).catch(() => {});
  for (const p of hit) { try { process.kill(p.pid, 'SIGTERM'); } catch { /* already gone */ } }
  await sleep(1500);
  await reapStaleRuns().catch(() => {});
  const note = hit.some(p => p.source === 'bulk') ? ' (bulk run stopped)' : hit.some(p => p.source === 'scheduled') ? ' (scheduled job fires again at its next interval)' : '';
  return { ok: true, message: `Stopped ${hit.length} scan${hit.length > 1 ? 's' : ''}${note}` };
}
