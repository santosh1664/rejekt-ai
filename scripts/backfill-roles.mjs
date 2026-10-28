/**
 * scripts/backfill-roles.mjs
 *
 * Backfills jobs.canonical_role / jobs.role_specialization using
 * lib/role-classifier.mjs (role-v2), and writes an audit trail to
 * job_classifications (field_name='canonical_role'/'role_specialization').
 *
 * Idempotent + resumable without any extra state file: job_classifications
 * has a unique (job_id, field_name, classifier_version) index, so a job
 * already classified at the CURRENT classifier version is skipped on the
 * next run (cheap, indexed NOT EXISTS check) — a restart after an
 * interruption just re-scans from the top and skips already-done rows
 * until it reaches the real frontier. Pass --since-id <id> to skip the
 * rescan directly (the script prints the last processed id in its
 * progress output for exactly this). Pass --force to reclassify
 * everything regardless of what's already recorded (still safe/idempotent
 * — ON CONFLICT DO UPDATE, never a duplicate audit row).
 *
 * Usage:
 *   node --env-file=.env.local scripts/backfill-roles.mjs
 *   node --env-file=.env.local scripts/backfill-roles.mjs --force
 *   node --env-file=.env.local scripts/backfill-roles.mjs --since-id 50000
 *   node --env-file=.env.local scripts/backfill-roles.mjs --limit 1000   # dry-run-ish cap for testing
 */
import { query, closePool } from '../lib/db.mjs';
import { classifyRole, CLASSIFIER_VERSION } from '../lib/role-classifier.mjs';

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const SINCE_ID = (() => { const i = args.indexOf('--since-id'); return i !== -1 ? Number(args[i + 1]) : 0; })();
const ROW_LIMIT = (() => { const i = args.indexOf('--limit'); return i !== -1 ? Number(args[i + 1]) : Infinity; })();
const BATCH = 500;

async function fetchBatch(lastId) {
  const skipClause = FORCE ? '' : `AND NOT EXISTS (
    SELECT 1 FROM job_classifications jc
     WHERE jc.job_id = j.id AND jc.field_name = 'canonical_role' AND jc.classifier_version = $3
  )`;
  const { rows } = await query(
    `SELECT j.id, j.title, j.role_family
       FROM jobs j
      WHERE j.status = 'READY' AND j.id > $1
        ${skipClause}
      ORDER BY j.id LIMIT $2`,
    FORCE ? [lastId, BATCH] : [lastId, BATCH, CLASSIFIER_VERSION]
  );
  return rows;
}

async function writeBatch(rows, classifications) {
  await query(
    `UPDATE jobs AS j SET canonical_role = u.canonical_role, role_specialization = u.role_specialization
       FROM UNNEST($1::bigint[], $2::text[], $3::text[]) AS u(id, canonical_role, role_specialization)
      WHERE j.id = u.id`,
    [rows.map(r => r.id), classifications.map(c => c.canonicalRole), classifications.map(c => c.roleSpecialization)]
  );

  const auditRows = [];
  rows.forEach((row, i) => {
    const c = classifications[i];
    auditRows.push({ jobId: row.id, field: 'canonical_role', value: c.canonicalRole, confidence: c.confidence, evidence: c.evidence });
    if (c.roleSpecialization) auditRows.push({ jobId: row.id, field: 'role_specialization', value: c.roleSpecialization, confidence: c.confidence, evidence: c.evidence });
  });
  if (auditRows.length === 0) return;
  await query(
    `INSERT INTO job_classifications (job_id, field_name, predicted_value, confidence, classifier_version, evidence)
     SELECT * FROM UNNEST($1::bigint[], $2::text[], $3::text[], $4::real[], $5::text[], $6::text[])
     ON CONFLICT (job_id, field_name, classifier_version) DO UPDATE SET
       predicted_value = EXCLUDED.predicted_value, confidence = EXCLUDED.confidence, evidence = EXCLUDED.evidence, created_at = NOW()`,
    [
      auditRows.map(r => r.jobId),
      auditRows.map(r => r.field),
      auditRows.map(r => r.value),
      auditRows.map(r => r.confidence),
      auditRows.map(() => CLASSIFIER_VERSION),
      auditRows.map(r => r.evidence),
    ]
  );
}

async function main() {
  let lastId = SINCE_ID;
  let processed = 0;
  const canonicalRoleCounts = {};
  const confidenceSum = { total: 0, count: 0 };

  while (processed < ROW_LIMIT) {
    const rows = await fetchBatch(lastId);
    if (rows.length === 0) break;

    const classifications = rows.map(row => classifyRole({ title: row.title, roleFamily: row.role_family }));
    await writeBatch(rows, classifications);

    for (const c of classifications) {
      canonicalRoleCounts[c.canonicalRole] = (canonicalRoleCounts[c.canonicalRole] || 0) + 1;
      confidenceSum.total += c.confidence;
      confidenceSum.count += 1;
    }

    lastId = rows[rows.length - 1].id;
    processed += rows.length;
    console.error(`Processed ${processed.toLocaleString()} jobs (last id ${lastId}, resume with --since-id ${lastId})`);
  }

  console.error(`\nBackfill complete: ${processed.toLocaleString()} jobs classified (classifier ${CLASSIFIER_VERSION}).`);
  console.error(`Average confidence: ${confidenceSum.count ? (confidenceSum.total / confidenceSum.count).toFixed(3) : 'n/a'}`);
  console.error('\nTop canonical_role assignments this run:');
  console.error(Object.entries(canonicalRoleCounts).sort((a, b) => b[1] - a[1]).slice(0, 40)
    .map(([role, n]) => `  ${role}: ${n.toLocaleString()}`).join('\n'));
}

main().catch(error => { console.error('Backfill failed:', error.message); process.exitCode = 1; }).finally(() => closePool());
