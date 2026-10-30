/**
 * node --env-file=.env.local db/migrate-workauth.mjs
 * Work authorization moves from one set of answers to one row per country. Profiles that answered the old
 * single-country questions get that country as their first row. Safe to run again: rows already there win.
 */
import { query } from '../lib/db.mjs';

const { rows } = await query(`SELECT id, sections FROM resume_profiles WHERE COALESCE(jsonb_array_length(sections->'workAuth'), 0) = 0`);
let n = 0;
for (const { id, sections } of rows) {
  const ad = sections.applicationDefaults || {};
  if (ad.authorizedToWork === undefined && ad.needsSponsorship === undefined) continue;
  const row = { country: ad.workCountry || 'United States', authorized: ad.authorizedToWork ?? null, needsSponsorship: ad.needsSponsorship ?? null,
    status: [ad.workPermit, ad.workPermitStatus].filter(v => v && v !== 'Not applicable').join(', ') };
  await query(`UPDATE resume_profiles SET sections = jsonb_set(sections, '{workAuth}', $2::jsonb) WHERE id = $1`, [id, JSON.stringify([row])]);
  n++;
}
console.log(`✓ workAuth: ${n} of ${rows.length} profiles got a country row from their old answers`);
process.exit(0);
