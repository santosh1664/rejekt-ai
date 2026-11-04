// One-off: Workday job URLs were stored without the site segment (…/job/… instead of …/{site}/job/…).
// node --env-file=.env.local scripts/fix-workday-urls.mjs   (idempotent)
import { query } from '../lib/db.mjs';
const { rows: cos } = await query(`SELECT id, meta->>'site' AS site FROM companies WHERE ats='workday' AND meta->>'site' IS NOT NULL`);
let fixed = 0;
for (const c of cos) {
  const r = await query(
    `UPDATE jobs SET url = regexp_replace(url, '^(https://[^/]+)(/job/)', '\\1/' || $2 || '\\2')
      WHERE company_id = $1 AND ats='workday' AND url ~ '^https://[^/]+/job/'`, [c.id, c.site]);
  fixed += r.rowCount;
}
console.log('fixed', fixed);
process.exit(0);
