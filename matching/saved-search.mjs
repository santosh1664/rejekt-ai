/**
 * matching/saved-search.mjs
 *
 * Persistence for a user's saved feed keyword search (user_keyword_searches,
 * db/schema.sql). Validation of WHAT gets saved lives in api/server.mjs's
 * PUT /users/:userId/search handler, which previews the search against the
 * real feed first and refuses one that returns no jobs.
 */
import { query } from '../lib/db.mjs';
import { normalizeKeywordSearch } from './keyword-search.mjs';

/** @returns normalized keyword search with source:'saved', or null when the user has none. */
export async function getSavedKeywordSearch(userId) {
  const { rows } = await query(
    `SELECT include_terms, exclude_terms, scope, updated_at FROM user_keyword_searches WHERE user_id = $1`, [userId]
  );
  if (!rows.length) return null;
  const ks = normalizeKeywordSearch({ include: rows[0].include_terms, exclude: rows[0].exclude_terms, scope: rows[0].scope });
  return ks.active ? { ...ks, source: 'saved', updatedAt: rows[0].updated_at } : null;
}

export async function saveKeywordSearch(userId, ks) {
  await query(
    `INSERT INTO user_keyword_searches (user_id, include_terms, exclude_terms, scope)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET include_terms = EXCLUDED.include_terms,
       exclude_terms = EXCLUDED.exclude_terms, scope = EXCLUDED.scope, updated_at = NOW()`,
    [userId, ks.include, ks.exclude, ks.scope]
  );
  return getSavedKeywordSearch(userId);
}

export async function clearKeywordSearch(userId) {
  const { rowCount } = await query(`DELETE FROM user_keyword_searches WHERE user_id = $1`, [userId]);
  return rowCount > 0;
}
