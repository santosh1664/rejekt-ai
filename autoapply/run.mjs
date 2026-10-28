/**
 * Auto-apply worker (docs/auto-apply.md).
 *
 *   npm run autoapply                     every user with auto-apply on
 *   npm run autoapply -- --user <uuid>    one user
 *   npm run autoapply -- --dry-run        plan only: what would be queued, nothing written
 *
 * Schedule it like the scanner (cron, launchd, a hosted job) a few times a
 * day. It needs Chrome (or CHROME_PATH) to fill forms; AUTO_APPLY_HEADFUL=1
 * shows the browser while it works.
 */
import { query, closePool } from '../lib/db.mjs';
import { runForUser } from './engine.mjs';
import { closeBrowser } from '../lib/resume-render.mjs';

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const val = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

const dryRun = flag('--dry-run');
const only = val('--user');

try {
  const users = only ? [only] : (await query(`SELECT user_id FROM auto_apply_settings WHERE enabled`)).rows.map(r => r.user_id);
  if (!users.length) console.log('No users have auto-apply turned on.');
  for (const userId of users) {
    console.log(`\n▶ ${userId}${dryRun ? ' (dry run)' : ''}`);
    const s = await runForUser(userId, { dryRun, log: m => console.log(`  ${m}`) });
    if (s.skipped) { console.log(`  ${s.skipped}`); continue; }
    for (const l of s.plan?.lanes || []) {
      console.log(`  lane "${l.name}" (${l.resumeProfile || 'no profile'}): considered ${l.considered}, ≥ threshold ${l.aboveThreshold}, picked ${l.picked.length}`);
      for (const [reason, n] of Object.entries(l.skipped)) console.log(`    skipped ${n}: ${reason}`);
      if (dryRun) for (const p of l.picked) console.log(`    → ${p.matchScore}  ${p.title} — ${p.company}`);
      if (l.error) console.log(`    ${l.error}`);
    }
    if (!dryRun) console.log(`  prepared ${s.prepared}; outcomes ${JSON.stringify(s.outcomes)}${s.errors.length ? `; errors ${JSON.stringify(s.errors.slice(0, 5))}` : ''}`);
  }
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await closeBrowser();
  await closePool();
}
