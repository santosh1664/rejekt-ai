/**
 * node --env-file=.env.local db/migrate-address.mjs
 * Full address on the account profile (it only had city / state / country), filled from the default resume profile.
 */
import { query } from '../lib/db.mjs';

await query(`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS address_line1 TEXT`);
await query(`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS postal_code TEXT`);
const r = await query(`
  UPDATE user_profiles up
     SET address_line1 = COALESCE(up.address_line1, NULLIF(rp.sections->'personal'->>'address', '')),
         postal_code   = COALESCE(up.postal_code,   NULLIF(rp.sections->'personal'->>'zip', ''))
    FROM resume_profiles rp
   WHERE rp.user_id = up.user_id AND rp.is_default`);
console.log(`✓ user_profiles.address_line1, postal_code (${r.rowCount} profiles checked)`);
process.exit(0);
