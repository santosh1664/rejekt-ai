/**
 * Import your Tsenta application history (docs/resume-model.md).
 *   npm run import:tsenta -- --user <your user id>
 * Your user id is shown on the Applied screen. The app's "Import" button does the same.
 */
import { importTsentaHistory } from '../lib/import-tsenta.mjs';
import { closePool } from '../lib/db.mjs';
const i = process.argv.indexOf('--user'); const userId = i > 0 ? process.argv[i + 1] : null;
if (!userId) { console.error('Usage: npm run import:tsenta -- --user <uuid>'); process.exit(1); }
try {
  const r = await importTsentaHistory(userId);
  if (r.error) { console.error(r.error); process.exitCode = 1; }
  else console.log(`Imported ${r.applications} applications (${r.inserted} new, ${r.updated} updated); ${r.withDescription} with the posting, ${r.withResume} with the resume Tsenta sent.`);
} finally { await closePool(); }
