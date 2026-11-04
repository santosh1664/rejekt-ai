/**
 * node --env-file=.env.local db/migrate-gmail.mjs
 * Adds Gmail OAuth token table and ats_password column.
 */
import { query } from '../lib/db.mjs';

await query(`
  CREATE TABLE IF NOT EXISTS user_gmail_tokens (
    user_id       UUID PRIMARY KEY,
    access_token  TEXT NOT NULL,
    refresh_token TEXT,
    expiry        TIMESTAMPTZ,
    gmail_email   TEXT,
    connected_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
  )
`);
console.log('✓ user_gmail_tokens');

await query(`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS ats_password TEXT`);
console.log('✓ user_profiles.ats_password');


await query(`
  CREATE TABLE IF NOT EXISTS oauth_state (
    state      TEXT PRIMARY KEY,
    user_id    UUID NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
  )
`);
await query(`CREATE INDEX IF NOT EXISTS idx_oauth_state_expires ON oauth_state (expires_at)`);
console.log('✓ oauth_state');

process.exit(0);
