/**
 * scripts/audit-role-consistency.mjs
 *
 * Read-only corpus audit (spec Step 2) — classifies every READY/active job
 * into one of: CONSISTENT, CANONICAL_ROLE_FAMILY_MISMATCH,
 * SPECIALIZATION_CANONICAL_MISMATCH, UNKNOWN_CANONICAL, UNKNOWN_FAMILY,
 * LEGACY_FAMILY_FALLBACK, OTHER. Uses lib/role-taxonomy.mjs's
 * validateRoleClassification() — no mapping duplicated here.
 *
 * Usage:
 *   node --env-file=.env.local scripts/audit-role-consistency.mjs
 *   node --env-file=.env.last scripts/audit-role-consistency.mjs --window 24h   # last 24h only (spec Step 9)
 */
import { query, closePool } from '../lib/db.mjs';
import { validateRoleClassification, classifyRow } from '../lib/role-taxonomy.mjs';

const args = process.argv.slice(2);
const WINDOW = (() => { const i = args.indexOf('--window'); return i !== -1 ? args[i + 1] : null; })();
const sinceClause = WINDOW
  ? { '6h': "AND discovered >= NOW() - INTERVAL '6 hours'", '24h': "AND discovered >= NOW() - INTERVAL '24 hours'", '7d': "AND discovered >= NOW() - INTERVAL '7 days'" }[WINDOW]
  : '';
if (WINDOW && !sinceClause) { console.error('--window must be 6h, 24h, or 7d'); process.exit(1); }

async function main() {
  const { rows } = await query(
    `SELECT role_family, canonical_role, role_specialization, COUNT(*) n
       FROM jobs WHERE status='READY' AND active=TRUE ${sinceClause}
      GROUP BY role_family, canonical_role, role_specialization`
  );

  const counts = { CONSISTENT: 0, CANONICAL_ROLE_FAMILY_MISMATCH: 0, SPECIALIZATION_CANONICAL_MISMATCH: 0, UNKNOWN_CANONICAL: 0, UNKNOWN_FAMILY: 0, LEGACY_FAMILY_FALLBACK: 0, OTHER: 0 };
  let total = 0;
  const byCanonical = {}, byFamily = {}, mismatchCombos = {};

  for (const r of rows) {
    const n = Number(r.n);
    total += n;
    const cls = classifyRow(r);
    counts[cls] += n;
    if (r.canonical_role) byCanonical[r.canonical_role] = (byCanonical[r.canonical_role] || 0) + n;
    if (r.role_family) byFamily[r.role_family] = (byFamily[r.role_family] || 0) + n;
    if (cls === 'CANONICAL_ROLE_FAMILY_MISMATCH') {
      const key = `${r.canonical_role} + ${r.role_family}`;
      mismatchCombos[key] = (mismatchCombos[key] || 0) + n;
    }
  }

  console.log(`\n=== Role consistency audit${WINDOW ? ` (window=${WINDOW})` : ''} ===`);
  console.log('Total READY/active jobs:', total.toLocaleString());
  for (const [k, v] of Object.entries(counts)) {
    console.log(`  ${k.padEnd(34)} ${v.toLocaleString()} (${total ? (100 * v / total).toFixed(2) : '0.00'}%)`);
  }

  console.log('\n=== Top mismatch combinations (canonical_role + role_family) ===');
  for (const [k, v] of Object.entries(mismatchCombos).sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`  ${k.padEnd(50)} ${v.toLocaleString()}`);
  }

  console.log('\n=== Counts by canonical_role (top 20) ===');
  for (const [k, v] of Object.entries(byCanonical).sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`  ${(k || '(null)').padEnd(30)} ${v.toLocaleString()}`);
  }

  console.log('\n=== Counts by role_family ===');
  for (const [k, v] of Object.entries(byFamily).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${(k || '(null)').padEnd(30)} ${v.toLocaleString()}`);
  }

  await closePool();
}

main().catch(e => { console.error(e.message, e.stack); process.exit(1); });
