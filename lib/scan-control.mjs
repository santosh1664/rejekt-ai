/**
 * lib/scan-control.mjs — start/stop scans from the /scan-log page.
 *   start 'bulk'      → scripts/run-bulk-scan.sh (every queued platform, one at a time)
 *   start <ats>       → scripts/run-bulk-scan.sh <ats>
 *   start 'scheduled' → kick the launchd job now
 *   stop  <ats>      → kill only that platform's own process (a bulk run moves on to its next platform)
 *   stop  'all'      → kill every scanner and its wrapper script, so nothing relaunches
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
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
    if (procs.some(p => p.ats === 'all')) return { ok: false, message: 'All platforms are already being scanned' };
    await run('launchctl', ['kickstart', `gui/${os.userInfo().uid}/${LABEL}`]);
    return { ok: true, message: 'Scanning all platforms' };
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
  if (target === 'all') return stopAll(procs);
  // A platform stop touches only that platform's own process. A platform that is merely one part of
  // an all-platform run (the scheduled scan) can't be stopped alone, so say so instead of killing the run.
  const hit = procs.filter(p => p.ats === target);
  if (!hit.length) {
    return { ok: false, message: procs.some(p => p.ats === 'all')
      ? `${target} is part of the all-platform scan and can't be stopped on its own. Use "Stop all", or let it finish.`
      : `${target} is not running` };
  }
  // The bulk wrapper would relaunch this platform's next pass; the flag makes it move on to the next platform.
  if (hit.some(p => p.source === 'bulk')) fs.writeFileSync(path.join(ROOT, 'logs', `.skip-${target}`), '');
  for (const p of hit) { try { process.kill(p.pid, 'SIGTERM'); } catch { /* already gone */ } }
  await sleep(1500);
  await reapStaleRuns().catch(() => {});
  return { ok: true, message: `Stopped ${target}${hit.some(p => p.source === 'bulk') ? ' (the bulk run continues with the next platform)' : ''}` };
}

async function stopAll(procs) {
  if (!procs.length) return { ok: false, message: 'Nothing is running' };
  // wrapper scripts first, or they relaunch the next pass / next platform
  if (procs.some(p => p.source === 'bulk')) await run('pkill', ['-f', 'run-bulk-scan.sh']).catch(() => {});
  if (procs.some(p => p.source === 'scheduled')) await run('pkill', ['-f', 'run-scan.sh']).catch(() => {});
  for (const p of procs) { try { process.kill(p.pid, 'SIGTERM'); } catch { /* already gone */ } }
  await sleep(1500);
  await reapStaleRuns().catch(() => {});
  const note = procs.some(p => p.source === 'bulk') ? ' (bulk run stopped)' : procs.some(p => p.source === 'scheduled') ? ' (scheduled job fires again at its next interval)' : '';
  return { ok: true, message: `Stopped ${procs.length} scan${procs.length > 1 ? 's' : ''}${note}` };
}
