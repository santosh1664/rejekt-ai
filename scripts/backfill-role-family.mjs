/**
 * scripts/backfill-role-family.mjs
 *
 * Backfills jobs.category / jobs.role_family using the hardened
 * classifyCategory() (role-family-v2 — see lib/fingerprint.mjs), and
 * — critically — re-runs the role-v2.1 canonical-role classifier
 * (lib/role-classifier.mjs) for any job whose role_family actually
 * changes, so canonical_role/role_specialization never go stale relative
 * to a corrected family (spec's explicit pipeline requirement: old
 * role_family -> new role_family -> canonical_role -> role_specialization,
 * never left inconsistent). This is a single combined pass, not two
 * separate scripts run back to back — that's what guarantees the
 * consistency by construction rather than by convention.
 *
 * Idempotent + resumable the same way scripts/backfill-roles.mjs is: keyed
 * on job_classifications' unique (job_id, field_name, classifier_version)
 * index. A job already stamped with the current CATEGORY_CLASSIFIER_VERSION
 * is skipped on the next run unless --force.
 *
 * Usage:
 *   node --env-file=.env.local scripts/backfill-role-family.mjs
 *   node --env-file=.env.local scripts/backfill-role-family.mjs --force
 *   node --env-file=.env.local scripts/backfill-role-family.mjs --since-id 50000
 *   node --env-file=.env.local scripts/backfill-role-family.mjs --limit 1000
 */
import { query, closePool } from '../lib/db.mjs';
import { classifyCategory, classifyRoleFamilyWithConfidence, CATEGORY_CLASSIFIER_VERSION } from '../lib/fingerprint.mjs';
import { classifyRole, CLASSIFIER_VERSION as ROLE_CLASSIFIER_VERSION } from '../lib/role-classifier.mjs';

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const SINCE_ID = (() => { const i = args.indexOf('--since-id'); return i !== -1 ? Number(args[i + 1]) : 0; })();
const ROW_LIMIT = (() => { const i = args.indexOf('--limit'); return i !== -1 ? Number(args[i + 1]) : Infinity; })();
const BATCH = 500;

async function fetchBatch(lastId) {
  const skipClause = FORCE ? '' : `AND NOT EXISTS (
    SELECT 1 FROM job_classifications jc
     WHERE jc.job_id = j.id AND jc.field_name = 'role_family' AND jc.classifier_version = $3
  )`;
  const { rows } = await query(
    `SELECT j.id, j.title, j.role_family AS old_role_family
       FROM jobs j
      WHERE j.status = 'READY' AND j.id > $1
        ${skipClause}
      ORDER BY j.id LIMIT $2`,
    FORCE ? [lastId, BATCH] : [lastId, BATCH, CATEGORY_CLASSIFIER_VERSION]
  );
  return rows;
}

/** @param {Array<{id, title, old_role_family}>} rows @param {Array<{category, family}>} results @returns {number} count of jobs whose role_family actually changed */
async function writeBatch(rows, results) {
  await query(
    `UPDATE jobs AS j SET category = u.category, category_source = 'keyword', role_family = u.role_family
       FROM UNNEST($1::bigint[], $2::text[], $3::text[]) AS u(id, category, role_family)
      WHERE j.id = u.id`,
    [rows.map(r => r.id), results.map(r => r.category), results.map(r => r.family.roleFamily)]
  );

  const familyAudit = rows.map((r, i) => ({ jobId: r.id, value: results[i].family.roleFamily, confidence: results[i].family.confidence, evidence: results[i].family.evidence }));
  await query(
    `INSERT INTO job_classifications (job_id, field_name, predicted_value, confidence, classifier_version, evidence)
     SELECT * FROM UNNEST($1::bigint[], $2::text[], $3::text[], $4::real[], $5::text[], $6::text[])
     ON CONFLICT (job_id, field_name, classifier_version) DO UPDATE SET
       predicted_value = EXCLUDED.predicted_value, confidence = EXCLUDED.confidence, evidence = EXCLUDED.evidence, created_at = NOW()`,
    [familyAudit.map(r => r.jobId), familyAudit.map(() => 'role_family'), familyAudit.map(r => r.value),
     familyAudit.map(r => r.confidence), familyAudit.map(() => CATEGORY_CLASSIFIER_VERSION), familyAudit.map(r => r.evidence)]
  );

  // Re-run the canonical-role classifier for any job whose family actually
  // changed (or unconditionally under --force) — this is what keeps
  // canonical_role/role_specialization consistent with the corrected family.
  const changedIdx = rows.map((r, i) => i).filter(i => FORCE || results[i].family.roleFamily !== rows[i].old_role_family);
  if (changedIdx.length > 0) {
    const canon = changedIdx.map(i => classifyRole({ title: rows[i].title, roleFamily: results[i].family.roleFamily }));
    await query(
      `UPDATE jobs AS j SET canonical_role = u.canonical_role, role_specialization = u.role_specialization
         FROM UNNEST($1::bigint[], $2::text[], $3::text[]) AS u(id, canonical_role, role_specialization)
        WHERE j.id = u.id`,
      [changedIdx.map(i => rows[i].id), canon.map(c => c.canonicalRole), canon.map(c => c.roleSpecialization)]
    );

    const canonAudit = [];
    changedIdx.forEach((rowIdx, k) => {
      const c = canon[k];
      canonAudit.push({ jobId: rows[rowIdx].id, field: 'canonical_role', value: c.canonicalRole, confidence: c.confidence, evidence: c.evidence });
      if (c.roleSpecialization) canonAudit.push({ jobId: rows[rowIdx].id, field: 'role_specialization', value: c.roleSpecialization, confidence: c.confidence, evidence: c.evidence });
    });
    await query(
      `INSERT INTO job_classifications (job_id, field_name, predicted_value, confidence, classifier_version, evidence)
       SELECT * FROM UNNEST($1::bigint[], $2::text[], $3::text[], $4::real[], $5::text[], $6::text[])
       ON CONFLICT (job_id, field_name, classifier_version) DO UPDATE SET
         predicted_value = EXCLUDED.predicted_value, confidence = EXCLUDED.confidence, evidence = EXCLUDED.evidence, created_at = NOW()`,
      [canonAudit.map(r => r.jobId), canonAudit.map(r => r.field), canonAudit.map(r => r.value),
       canonAudit.map(r => r.confidence), canonAudit.map(() => ROLE_CLASSIFIER_VERSION), canonAudit.map(r => r.evidence)]
    );
  }

  return changedIdx.length;
}

async function main() {
  let lastId = SINCE_ID;
  let processed = 0, changed = 0;
  const familyDeltas = {};

  while (processed < ROW_LIMIT) {
    const rows = await fetchBatch(lastId);
    if (rows.length === 0) break;

    const results = rows.map(row => ({ category: classifyCategory(row.title), family: classifyRoleFamilyWithConfidence(row.title) }));
    changed += await writeBatch(rows, results);

    rows.forEach((r, i) => {
      if (r.old_role_family !== results[i].family.roleFamily) {
        const key = `${r.old_role_family} -> ${results[i].family.roleFamily}`;
        familyDeltas[key] = (familyDeltas[key] || 0) + 1;
      }
    });

    lastId = rows[rows.length - 1].id;
    processed += rows.length;
    const actualFamilyChanges = Object.values(familyDeltas).reduce((a, b) => a + b, 0);
    console.error(`Processed ${processed.toLocaleString()} jobs (last id ${lastId}, family actually changed=${actualFamilyChanges}, canonical-role reprocessed=${changed}, resume with --since-id ${lastId})`);
  }

  const actualFamilyChanges = Object.values(familyDeltas).reduce((a, b) => a + b, 0);
  console.error(`\nBackfill complete: ${processed.toLocaleString()} jobs processed, ${actualFamilyChanges.toLocaleString()} had role_family actually change, ${changed.toLocaleString()} had canonical_role/role_specialization reprocessed${FORCE ? ' (--force: all jobs reprocessed regardless of family change)' : ''} (classifier ${CATEGORY_CLASSIFIER_VERSION}).`);
  console.error('\nTop role_family transitions:');
  console.error(Object.entries(familyDeltas).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, n]) => `  ${k}: ${n.toLocaleString()}`).join('\n'));
}

main().catch(error => { console.error('Backfill failed:', error.message); process.exitCode = 1; }).finally(() => closePool());
