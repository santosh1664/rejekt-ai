/**
 * scripts/backfill-role-consistency.mjs
 *
 * Role-consistency repair phase, spec Steps 10-12. Re-runs the (now-fixed)
 * classifyCategory() -> classifyRole() pipeline from each job's title —
 * never a hardcoded SQL rewrite ("IF canonical_role='ML_ENGINEER' THEN
 * role_family=...") per spec Step 11 — and persists only what actually
 * changed, with a full audit trail in job_classifications (old value
 * embedded in the evidence string, classifier_version bumped, nothing
 * deleted — spec Step 12).
 *
 * Idempotent + resumable the same way scripts/backfill-roles.mjs is:
 * job_classifications' unique (job_id, field_name, classifier_version)
 * index means a job already stamped with the CURRENT canonical-role
 * classifier version (role-v2.2) is skipped on the next run unless
 * --force. A restart after interruption just re-scans from the top and
 * skips already-done rows until it reaches the real frontier; --since-id
 * skips the rescan directly.
 *
 * Usage:
 *   node --env-file=.env.local scripts/backfill-role-consistency.mjs --dry-run
 *   node --env-file=.env.local scripts/backfill-role-consistency.mjs
 *   node --env-file=.env.local scripts/backfill-role-consistency.mjs --force
 *   node --env-file=.env.local scripts/backfill-role-consistency.mjs --since-id 50000
 *   node --env-file=.env.local scripts/backfill-role-consistency.mjs --limit 1000
 */
import { query, closePool } from '../lib/db.mjs';
import { classifyCategory, CATEGORY_CLASSIFIER_VERSION } from '../lib/fingerprint.mjs';
import { CATEGORY_TO_ROLE_FAMILY } from '../lib/normalize.mjs';
import { classifyRole, CLASSIFIER_VERSION as ROLE_CLASSIFIER_VERSION } from '../lib/role-classifier.mjs';
import { validateRoleClassification } from '../lib/role-taxonomy.mjs';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');
const SINCE_ID = (() => { const i = args.indexOf('--since-id'); return i !== -1 ? Number(args[i + 1]) : 0; })();
const ROW_LIMIT = (() => { const i = args.indexOf('--limit'); return i !== -1 ? Number(args[i + 1]) : Infinity; })();
const BATCH = 500;
const MAX_RETRIES = 3;

async function fetchBatch(lastId) {
  const skipClause = FORCE ? '' : `AND NOT EXISTS (
    SELECT 1 FROM job_classifications jc
     WHERE jc.job_id = j.id AND jc.field_name = 'canonical_role' AND jc.classifier_version = $3
  )`;
  const sql = `SELECT j.id, j.title, j.role_family AS old_family, j.canonical_role AS old_canonical, j.role_specialization AS old_spec
                 FROM jobs j
                WHERE j.status='READY' AND j.id > $1
                  ${skipClause}
                ORDER BY j.id LIMIT $2`;
  const params = FORCE ? [lastId, BATCH] : [lastId, BATCH, ROLE_CLASSIFIER_VERSION];
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return (await query(sql, params)).rows;
    } catch (err) {
      if (attempt === MAX_RETRIES - 1) throw err;
      console.error(`  retry ${attempt + 1}/${MAX_RETRIES} after: ${err.message}`);
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}

function reclassify(job) {
  const category = classifyCategory(job.title);
  const rawFamily = CATEGORY_TO_ROLE_FAMILY[category] || 'OTHER';
  const classified = classifyRole({ title: job.title, roleFamily: rawFamily });

  let { roleFamily, canonicalRole, roleSpecialization } = classified;
  const validation = validateRoleClassification({ roleFamily, canonicalRole, roleSpecialization });
  if (!validation.valid) {
    // Defense in depth (spec Step 6) — should not fire given classifyRole's
    // own reconcileFamily, mirrors lib/normalize.mjs's same fallback.
    canonicalRole = roleFamily === 'OTHER' ? null : roleFamily;
    roleSpecialization = null;
  }

  const changed = roleFamily !== job.old_family || canonicalRole !== job.old_canonical || roleSpecialization !== job.old_spec;
  return { roleFamily, canonicalRole, roleSpecialization, category, confidence: classified.confidence, evidence: classified.evidence, changed, invalidBefore: !validation.valid };
}

async function writeBatch(rows, results) {
  const changedIdx = rows.map((_, i) => i).filter(i => results[i].changed);
  if (changedIdx.length === 0) return;

  await retryable(() => query(
    `UPDATE jobs AS j SET role_family = u.role_family, canonical_role = u.canonical_role, role_specialization = u.role_specialization
       FROM UNNEST($1::bigint[], $2::text[], $3::text[], $4::text[]) AS u(id, role_family, canonical_role, role_specialization)
      WHERE j.id = u.id`,
    [
      changedIdx.map(i => rows[i].id),
      changedIdx.map(i => results[i].roleFamily),
      changedIdx.map(i => results[i].canonicalRole),
      changedIdx.map(i => results[i].roleSpecialization),
    ]
  ));

  // Audit trail (spec Step 12): one job_classifications row per changed
  // field, old value embedded in the evidence string, nothing deleted —
  // the PREVIOUS classifier-version row (if any) stays in the table
  // untouched, giving a full queryable history by classifier_version.
  const auditRows = [];
  for (const i of changedIdx) {
    const r = rows[i], res = results[i];
    const reason = `role-consistency repair: category=${res.category}`;
    if (res.roleFamily !== r.old_family) {
      auditRows.push({ jobId: r.id, field: 'role_family', value: res.roleFamily, confidence: res.confidence, version: CATEGORY_CLASSIFIER_VERSION,
        evidence: `${reason}; previous role_family=${r.old_family ?? 'NULL'} -> ${res.roleFamily}; ${res.evidence}` });
    }
    if (res.canonicalRole !== r.old_canonical) {
      auditRows.push({ jobId: r.id, field: 'canonical_role', value: res.canonicalRole, confidence: res.confidence, version: ROLE_CLASSIFIER_VERSION,
        evidence: `${reason}; previous canonical_role=${r.old_canonical ?? 'NULL'} -> ${res.canonicalRole}; ${res.evidence}` });
    }
    if (res.roleSpecialization !== r.old_spec) {
      auditRows.push({ jobId: r.id, field: 'role_specialization', value: res.roleSpecialization, confidence: res.confidence, version: ROLE_CLASSIFIER_VERSION,
        evidence: `${reason}; previous role_specialization=${r.old_spec ?? 'NULL'} -> ${res.roleSpecialization ?? 'NULL'}; ${res.evidence}` });
    }
  }
  if (auditRows.length) {
    await retryable(() => query(
      `INSERT INTO job_classifications (job_id, field_name, predicted_value, confidence, classifier_version, evidence)
       SELECT * FROM UNNEST($1::bigint[], $2::text[], $3::text[], $4::real[], $5::text[], $6::text[])
       ON CONFLICT (job_id, field_name, classifier_version) DO UPDATE SET
         predicted_value = EXCLUDED.predicted_value, confidence = EXCLUDED.confidence, evidence = EXCLUDED.evidence, created_at = NOW()`,
      [auditRows.map(r => r.jobId), auditRows.map(r => r.field), auditRows.map(r => r.value),
       auditRows.map(r => r.confidence), auditRows.map(r => r.version), auditRows.map(r => r.evidence)]
    ));
  }
}

async function retryable(fn) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === MAX_RETRIES - 1) throw err;
      console.error(`  retry ${attempt + 1}/${MAX_RETRIES} after: ${err.message}`);
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}

async function main() {
  console.log(`${DRY_RUN ? 'DRY RUN — no writes' : 'LIVE — writing changes'} | force=${FORCE} | classifier versions: family=${CATEGORY_CLASSIFIER_VERSION} canonical=${ROLE_CLASSIFIER_VERSION}`);
  let lastId = SINCE_ID;
  let scanned = 0, repaired = 0, unchanged = 0, pendingRetry = 0, failures = 0;
  const transitionCounts = {};

  while (scanned < ROW_LIMIT) {
    let rows;
    try {
      rows = await fetchBatch(lastId);
    } catch (err) {
      console.error(`Batch fetch failed after retries at id>${lastId}: ${err.message}`);
      failures++;
      break;
    }
    if (rows.length === 0) break;

    const results = rows.map(reclassify);
    const changedCount = results.filter(r => r.changed).length;

    let writeOk = true;
    if (!DRY_RUN && changedCount > 0) {
      try {
        await writeBatch(rows, results);
      } catch (err) {
        console.error(`  write failed for batch ending id ${rows[rows.length - 1].id} (repairs NOT persisted — will be retried on a future run with --since-id below this batch's start): ${err.message}`);
        failures++;
        writeOk = false;
      }
    }

    // Only counted as "repaired" if actually persisted (or in dry-run,
    // where nothing is ever persisted and "repaired" means "would be") —
    // a failed write must not be reported as a completed repair. A
    // changed-but-unwritten row is "pendingRetry", not "unchanged" — it
    // still needs repair, just didn't get it this run.
    if (writeOk) {
      repaired += changedCount;
      unchanged += rows.length - changedCount;
      for (let i = 0; i < rows.length; i++) {
        if (results[i].changed) {
          const key = `${rows[i].old_family ?? 'NULL'}/${rows[i].old_canonical ?? 'NULL'} -> ${results[i].roleFamily}/${results[i].canonicalRole ?? 'NULL'}`;
          transitionCounts[key] = (transitionCounts[key] || 0) + 1;
        }
      }
    } else {
      pendingRetry += changedCount;
      unchanged += rows.length - changedCount;
    }
    lastId = rows[rows.length - 1].id;
    scanned += rows.length;
    console.error(`Scanned ${scanned.toLocaleString()} (last id ${lastId}, repaired=${repaired}, unchanged=${unchanged}, resume with --since-id ${lastId})`);
  }

  console.log(`\n${DRY_RUN ? 'DRY RUN' : 'Backfill'} complete: scanned=${scanned.toLocaleString()} repaired=${repaired.toLocaleString()} unchanged=${unchanged.toLocaleString()} pendingRetry=${pendingRetry.toLocaleString()} failures=${failures}`);
  if (pendingRetry > 0) console.log(`${pendingRetry} job(s) identified as needing repair but not written due to a transient failure — re-run this script (same --since-id range) to retry them.`);
  console.log('\nTop transitions:');
  for (const [k, n] of Object.entries(transitionCounts).sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`  ${k}: ${n.toLocaleString()}`);
}

main().catch(e => { console.error('Fatal:', e.message, e.stack); process.exitCode = 1; }).finally(() => closePool());
