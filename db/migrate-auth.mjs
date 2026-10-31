/**
 * node --env-file=.env.local db/migrate-auth.mjs
 * Accounts and sessions: users, sessions, invites (sign-up is invite-only), password_resets.
 * users.id is the same UUID every user_* table already keys on, so an invite can carry an existing id
 * and the account picks up that user's profile, resumes and applications.
 */
import { query, closePool } from '../lib/db.mjs';

await query(`
  CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT NOT NULL UNIQUE,              -- stored lowercase
    password_hash TEXT NOT NULL,                     -- scrypt$N$salt$hash
    is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMPTZ
  )`);
console.log('✓ users');

await query(`
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,                     -- sha256 of the cookie value; the raw token is never stored
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
await query(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`);
console.log('✓ sessions');

await query(`
  CREATE TABLE IF NOT EXISTS invites (
    email      TEXT PRIMARY KEY,                     -- lowercase
    user_id    UUID,                                 -- optional: attach the account to an existing user id
    is_admin   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    used_at    TIMESTAMPTZ
  )`);
console.log('✓ invites');

await query(`
  CREATE TABLE IF NOT EXISTS password_resets (
    token_hash TEXT PRIMARY KEY,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ
  )`);
console.log('✓ password_resets');

await closePool();
