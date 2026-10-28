/**
 * db/migrate.mjs
 * Runs schema.sql against the configured DATABASE_URL.
 * Usage: node db/migrate.mjs
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getPool } from '../lib/db.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8');

const pool = getPool();
try {
  // Schema changes such as widening a populated column can exceed the normal
  // application statement timeout, while remaining bounded at the migration layer.
  await pool.query('SET statement_timeout = 120000');
  await pool.query(sql);
  console.log('✅  Schema applied successfully');
} catch (err) {
  console.error('Migration failed:', err.message);
  process.exit(1);
} finally {
  await pool.end();
}
