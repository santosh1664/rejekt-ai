/**
 * scripts/test-role-classifier.mjs
 *
 * Spec Step 27: extensive classifier tests, including named ambiguity and
 * collision cases. Pure, DB-free.
 */
import { classifyRole } from '../lib/role-classifier.mjs';

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

function classify(title, roleFamily = 'SOFTWARE_ENGINEERING') {
  return classifyRole({ title, roleFamily });
}

// ── Backend ──────────────────────────────────────────────────────────────
check('Backend Engineer -> BACKEND_ENGINEER', classify('Backend Engineer').canonicalRole === 'BACKEND_ENGINEER');
check('Java Backend Developer -> BACKEND_ENGINEER/JAVA', (() => { const r = classify('Java Backend Developer'); return r.canonicalRole === 'BACKEND_ENGINEER' && r.roleSpecialization === 'JAVA'; })());
check('Server-Side Engineer -> BACKEND_ENGINEER', classify('Server-Side Engineer').canonicalRole === 'BACKEND_ENGINEER');

// ── Frontend ─────────────────────────────────────────────────────────────
check('Frontend Engineer -> FRONTEND_ENGINEER', classify('Frontend Engineer').canonicalRole === 'FRONTEND_ENGINEER');
check('React Developer -> FRONTEND_ENGINEER/REACT', (() => { const r = classify('React Frontend Developer'); return r.canonicalRole === 'FRONTEND_ENGINEER' && r.roleSpecialization === 'REACT'; })());
check('UI Engineer -> FRONTEND_ENGINEER', classify('UI Engineer').canonicalRole === 'FRONTEND_ENGINEER');

// ── Full Stack ───────────────────────────────────────────────────────────
check('Full Stack Engineer -> FULL_STACK_ENGINEER', classify('Full Stack Engineer').canonicalRole === 'FULL_STACK_ENGINEER');

// ── QA ───────────────────────────────────────────────────────────────────
check('QA Automation Engineer -> QA_AUTOMATION_ENGINEER', classify('QA Automation Engineer').canonicalRole === 'QA_AUTOMATION_ENGINEER');
check('SDET -> SDET', classify('SDET').canonicalRole === 'SDET');
check('Test Automation Engineer -> QA_AUTOMATION_ENGINEER', classify('Test Automation Engineer').canonicalRole === 'QA_AUTOMATION_ENGINEER');

// ── DevOps/SRE ───────────────────────────────────────────────────────────
check('DevOps Engineer -> DEVOPS_ENGINEER', classify('DevOps Engineer', 'DEVOPS_SRE').canonicalRole === 'DEVOPS_ENGINEER');
check('Site Reliability Engineer -> SITE_RELIABILITY_ENGINEER', classify('Site Reliability Engineer', 'DEVOPS_SRE').canonicalRole === 'SITE_RELIABILITY_ENGINEER');
check('Platform Reliability Engineer -> SITE_RELIABILITY_ENGINEER', classify('Platform Reliability Engineer', 'DEVOPS_SRE').canonicalRole === 'SITE_RELIABILITY_ENGINEER');

// ── Data ─────────────────────────────────────────────────────────────────
check('Data Engineer -> DATA_ENGINEER', classify('Data Engineer', 'DATA_SCIENCE').canonicalRole === 'DATA_ENGINEER');
check('ETL Engineer -> ETL_ENGINEER', classify('ETL Engineer', 'DATA_SCIENCE').canonicalRole === 'ETL_ENGINEER');
check('Analytics Engineer -> ANALYTICS_ENGINEER', classify('Analytics Engineer', 'DATA_SCIENCE').canonicalRole === 'ANALYTICS_ENGINEER');
check('Data Platform Engineer -> DATA_PLATFORM_ENGINEER', classify('Data Platform Engineer', 'DATA_SCIENCE').canonicalRole === 'DATA_PLATFORM_ENGINEER');

// ── ML ───────────────────────────────────────────────────────────────────
check('Machine Learning Engineer -> ML_ENGINEER', classify('Machine Learning Engineer', 'DATA_SCIENCE').canonicalRole === 'ML_ENGINEER');
check('AI Engineer -> AI_ENGINEER', classify('AI Engineer', 'DATA_SCIENCE').canonicalRole === 'AI_ENGINEER');
check('MLOps Engineer -> MLOPS_ENGINEER', classify('MLOps Engineer', 'DATA_SCIENCE').canonicalRole === 'MLOPS_ENGINEER');
check('NLP Engineer -> ML_ENGINEER/NLP', (() => { const r = classify('NLP Engineer', 'DATA_SCIENCE'); return r.canonicalRole === 'ML_ENGINEER' && r.roleSpecialization === 'NLP'; })());
check('Software Engineer, Machine Learning -> ML_ENGINEER (spec example, strong non-contiguous evidence)',
  classify('Software Engineer, Machine Learning').canonicalRole === 'ML_ENGINEER');

// ── Ambiguity — falls back to the broad/generic canonical role, never guesses finer ──
check('Software Engineer -> SOFTWARE_ENGINEER (generic, no finer evidence)', classify('Software Engineer').canonicalRole === 'SOFTWARE_ENGINEER');
check('Engineer II -> SOFTWARE_ENGINEER (generic)', classify('Engineer II').canonicalRole === 'SOFTWARE_ENGINEER');
check('Developer -> SOFTWARE_ENGINEER (generic)', classify('Developer').canonicalRole === 'SOFTWARE_ENGINEER');
check('Technical Engineer -> SOFTWARE_ENGINEER (generic)', classify('Technical Engineer').canonicalRole === 'SOFTWARE_ENGINEER');
{
  const r = classify('Software Engineer');
  check('generic titles get medium confidence, not high', r.confidence <= 0.6, JSON.stringify(r));
}
{
  const r = classify('Gibberish Title With No Signal At All', 'SOFTWARE_ENGINEERING');
  check('title with zero pattern match falls back to role_family at low confidence',
    r.canonicalRole === 'SOFTWARE_ENGINEERING' && r.confidence <= 0.3, JSON.stringify(r));
}

// ── Collision cases (spec Step 7) — must NOT be misclassified by naive substring matching ──
check('Platform Product Manager does NOT become PLATFORM_ENGINEER',
  classify('Platform Product Manager', 'PRODUCT').canonicalRole !== 'PLATFORM_ENGINEER');
check('Data Quality Analyst does NOT become QA_ENGINEER',
  classify('Data Quality Analyst', 'DATA_SCIENCE').canonicalRole !== 'QA_ENGINEER');
{
  const r = classify('Security Software Engineer', 'DEVOPS_SRE');
  check('Security Software Engineer -> SECURITY_ENGINEER or SOFTWARE_ENGINEER (either is spec-acceptable)',
    r.canonicalRole === 'SECURITY_ENGINEER' || r.canonicalRole === 'SOFTWARE_ENGINEER', JSON.stringify(r));
}
// Real corpus collisions found during the audit (lib/fingerprint.mjs's
// classifyCategory sweeps these hardware/manufacturing titles into
// role_family=SOFTWARE_ENGINEERING via its broad "quality engineer"/"test
// engineer" pattern) — the classifier must not compound that error by also
// forcing them into QA_ENGINEER.
for (const title of ['Supplier Quality Engineer', 'Electrical Test Engineer', 'Flight Test Engineer', 'Hardware Test Engineer', 'Manufacturing Test Engineer']) {
  check(`"${title}" does not become a QA canonical role (hardware/manufacturing collision guard)`,
    !['QA_ENGINEER', 'QA_AUTOMATION_ENGINEER', 'SDET'].includes(classify(title).canonicalRole));
}

// ── Classifier version ──────────────────────────────────────────────────
check('classifierVersion is reported', classify('Backend Engineer').classifierVersion === 'role-v2.1');

console.log(`\n${failures === 0 ? 'All checks passed' : failures + ' check(s) FAILED'}`);
if (failures > 0) process.exit(1);
