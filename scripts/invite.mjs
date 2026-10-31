/**
 * Invite someone (sign-up is invite-only): they can then create an account at /signup with this email.
 *   node --env-file=.env.local scripts/invite.mjs person@example.com
 *   node --env-file=.env.local scripts/invite.mjs you@example.com --admin --user-id <existing uuid>
 * --user-id attaches the new account to an existing user's profile, resumes and applications.
 * --admin   lets the account open the scan log and start/stop scans.
 */
import { parseArgs } from 'node:util';
import { query, closePool } from '../lib/db.mjs';
import { normEmail } from '../lib/auth.mjs';

const { values: f, positionals: [email] } = parseArgs({ allowPositionals: true,
  options: { admin: { type: 'boolean', default: false }, 'user-id': { type: 'string' } } });
if (!email || !email.includes('@')) { console.error('usage: scripts/invite.mjs <email> [--admin] [--user-id <uuid>]'); process.exit(1); }

await query(`
  INSERT INTO invites (email, user_id, is_admin) VALUES ($1, $2, $3)
  ON CONFLICT (email) DO UPDATE SET user_id = EXCLUDED.user_id, is_admin = EXCLUDED.is_admin, used_at = NULL`,
  [normEmail(email), f['user-id'] || null, f.admin]);
console.log(`Invited ${normEmail(email)}${f.admin ? ' (admin)' : ''}${f['user-id'] ? ` → user ${f['user-id']}` : ''}. Sign up at /signup.`);
await closePool();
