/**
 * scripts/test-ranking-regressions.mjs
 *
 * Spec Step 26: regression tests for the false-positive patterns found
 * during ranking tuning (see docs/ranking-experiments.md for the diagnostic
 * evidence behind each one). Pure, DB-free — exercises the real
 * matching/final-score.mjs pipeline against synthetic job/profile fixtures.
 */
import { computeFinalScore } from '../matching/final-score.mjs';

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

const NOW = new Date().toISOString();
const DAYS_AGO = n => new Date(Date.now() - n * 86400000).toISOString();

function baseJob(overrides = {}) {
  return {
    jobId: '1', title: 'Software Engineer', company: 'Acme',
    roleFamily: 'SOFTWARE_ENGINEERING', canonicalRole: 'SOFTWARE_ENGINEERING', seniority: 'MID',
    experience: { min: 2, max: 5, requirementType: 'REQUIRED' },
    education: { level: 'BACHELORS', requirement: 'PREFERRED', equivalentExperienceAccepted: true },
    workplace: 'REMOTE',
    locations: [{ city: null, stateCode: null, countryCode: 'US', isRemoteRestriction: false, region: null }],
    sponsorship: 'UNKNOWN', clearance: { type: 'NONE', requirement: 'NONE' },
    salary: { minRaw: 100000, maxRaw: 140000, period: 'YEAR', minAnnual: 100000, maxAnnual: 140000, currency: 'USD' },
    skills: { required: ['python', 'sql'], preferred: ['aws'], mentioned: [] },
    postedAt: NOW, discovered: NOW,
    ...overrides,
  };
}

const baseProfile = { currentTitle: 'Software Engineer', totalExperienceYears: 4, highestEducationLevel: 'BACHELORS', currentCity: null, currentState: null, currentCountry: 'US' };
const basePreferences = { preferredStates: [], preferredCities: [], preferredWorkplaceTypes: ['REMOTE'], minSalary: null };
const targetPrimary = [{ canonicalRole: 'SOFTWARE_ENGINEERING', roleFamily: 'SOFTWARE_ENGINEERING', priority: 1 }];
const baseSkills = ['python', 'sql', 'aws'];

function score(job, { profile = baseProfile, preferences = basePreferences, targetRoles = targetPrimary, skills = baseSkills } = {}) {
  return computeFinalScore(job, profile, preferences, targetRoles, skills, { postedAt: job.postedAt, discovered: job.discovered });
}

// 1. High skill overlap on a completely unrelated role must not rank strong.
{
  const job = baseJob({ roleFamily: 'SALES', canonicalRole: 'SALES' }); // SALES has no FAMILY_ADJACENCY entry vs SOFTWARE_ENGINEERING -> UNRELATED
  const r = score(job);
  check('high-skill-overlap-wrong-role does not rank strong', r.matchScore < 65, JSON.stringify(r.components));
}

// 2. Correct role with partial skills should generally outrank an unrelated role with full skill overlap.
{
  const correctRolePartialSkills = score(baseJob({ skills: { required: ['python', 'go'], preferred: ['kubernetes'], mentioned: [] } }));
  const unrelatedRoleFullSkills = score(baseJob({ roleFamily: 'SALES', canonicalRole: 'SALES' }));
  check('correct-role-partial-skills outranks unrelated-high-skill-overlap',
    correctRolePartialSkills.matchScore > unrelatedRoleFullSkills.matchScore,
    JSON.stringify({ correctRolePartialSkills: correctRolePartialSkills.matchScore, unrelatedRoleFullSkills: unrelatedRoleFullSkills.matchScore }));
}

// 3. Entry-level user vs. a Staff-level job should be strongly penalized on experience.
{
  const entryProfile = { ...baseProfile, totalExperienceYears: 1 };
  const staffJob = baseJob({ seniority: 'STAFF', experience: { min: null, max: null, requirementType: 'REQUIRED' } });
  const r = score(staffJob, { profile: entryProfile });
  check('entry-vs-staff strong experience penalty', r.components.experience <= 40, JSON.stringify(r.components));
}

// 4. A fresh unrelated-role job should not outrank an older exact-role match.
{
  const freshUnrelated = score(baseJob({ roleFamily: 'SALES', canonicalRole: 'SALES', postedAt: NOW, discovered: NOW }));
  const olderExact = score(baseJob({ postedAt: DAYS_AGO(60), discovered: DAYS_AGO(60) }));
  check('fresh-unrelated does not outrank older-exact-role',
    olderExact.matchScore > freshUnrelated.matchScore,
    JSON.stringify({ freshUnrelated: freshUnrelated.matchScore, olderExact: olderExact.matchScore }));
}

// 5. A nearby unrelated-role job should not outrank a remote exact-role match.
{
  const nearbyUnrelated = score(baseJob({
    roleFamily: 'SALES', canonicalRole: 'SALES', workplace: 'ONSITE',
    locations: [{ city: 'Austin', stateCode: 'TX', countryCode: 'US', isRemoteRestriction: false, region: null }],
  }), { profile: { ...baseProfile, currentCity: 'Austin', currentState: 'TX' } });
  const remoteExact = score(baseJob());
  check('nearby-unrelated does not outrank remote-exact-role',
    remoteExact.matchScore > nearbyUnrelated.matchScore,
    JSON.stringify({ nearbyUnrelated: nearbyUnrelated.matchScore, remoteExact: remoteExact.matchScore }));
}

// 6. Missing salary should get a neutral score, not an extreme penalty or bonus.
{
  const noSalaryJob = baseJob({ salary: { minRaw: null, maxRaw: null, period: null, minAnnual: null, maxAnnual: null, currency: null } });
  const r = score(noSalaryJob);
  check('missing salary is neutral, not extreme', r.components.salary >= 50 && r.components.salary <= 80, JSON.stringify(r.components));
}

// 7. A secondary target role should rank below the primary target role, other factors equal.
{
  const targetBoth = [
    { canonicalRole: 'SOFTWARE_ENGINEERING', roleFamily: 'SOFTWARE_ENGINEERING', priority: 1 },
    { canonicalRole: 'DATA_SCIENCE', roleFamily: 'DATA_SCIENCE', priority: 2 },
  ];
  const primaryMatch = score(baseJob(), { targetRoles: targetBoth });
  const secondaryMatch = score(baseJob({ roleFamily: 'DATA_SCIENCE', canonicalRole: 'DATA_SCIENCE' }), { targetRoles: targetBoth });
  check('secondary target role ranks below primary target role, other factors equal',
    primaryMatch.matchScore > secondaryMatch.matchScore,
    JSON.stringify({ primaryMatch: primaryMatch.matchScore, secondaryMatch: secondaryMatch.matchScore }));
}

// 8. An unrelated role with a high salary should not rank strong (spec Step 22 #3).
{
  const job = baseJob({ roleFamily: 'SALES', canonicalRole: 'SALES', salary: { minRaw: 300000, maxRaw: 400000, period: 'YEAR', minAnnual: 300000, maxAnnual: 400000, currency: 'USD' } });
  const r = score(job);
  check('unrelated-role-high-salary does not rank strong', r.matchScore < 65, JSON.stringify(r.components));
}

// 9. Same-family generic should score meaningfully below a genuine exact canonical-role match (spec Step 22 #7).
{
  const sameFamilyGeneric = score(baseJob()); // canonicalRole===roleFamily -> not "genuinely finer", SAME_FAMILY_GENERIC
  const exactCanonical = score(
    baseJob({ canonicalRole: 'BACKEND_ENGINEER' }),
    { targetRoles: [{ canonicalRole: 'BACKEND_ENGINEER', roleFamily: 'SOFTWARE_ENGINEERING', priority: 1 }] }
  );
  check('same-family-generic scores below exact-canonical, other factors equal',
    exactCanonical.matchScore > sameFamilyGeneric.matchScore,
    JSON.stringify({ sameFamilyGeneric: sameFamilyGeneric.matchScore, exactCanonical: exactCanonical.matchScore }));
}

// 10. An exact canonical-role match with unknown salary should still score strong (spec Step 22 #8).
{
  const r = score(
    baseJob({ canonicalRole: 'BACKEND_ENGINEER', salary: { minRaw: null, maxRaw: null, period: null, minAnnual: null, maxAnnual: null, currency: null } }),
    { targetRoles: [{ canonicalRole: 'BACKEND_ENGINEER', roleFamily: 'SOFTWARE_ENGINEERING', priority: 1 }] }
  );
  check('exact-canonical-role with unknown salary still scores strong', r.matchScore >= 65, JSON.stringify(r.components));
}

// 11. An exact-role match posted slightly older should still outrank an unrelated fresh posting (spec Step 22 #9).
{
  const exactSlightlyOlder = score(
    baseJob({ canonicalRole: 'BACKEND_ENGINEER', postedAt: DAYS_AGO(10), discovered: DAYS_AGO(10) }),
    { targetRoles: [{ canonicalRole: 'BACKEND_ENGINEER', roleFamily: 'SOFTWARE_ENGINEERING', priority: 1 }] }
  );
  const unrelatedFresh = score(baseJob({ roleFamily: 'SALES', canonicalRole: 'SALES', postedAt: NOW, discovered: NOW }));
  check('exact-role-slightly-older outranks unrelated-fresh',
    exactSlightlyOlder.matchScore > unrelatedFresh.matchScore,
    JSON.stringify({ exactSlightlyOlder: exactSlightlyOlder.matchScore, unrelatedFresh: unrelatedFresh.matchScore }));
}

// ── Benchmark-v2 ranking-calibration phase (spec Step 22) — 10 scenarios ──
const backendTarget = [{ canonicalRole: 'BACKEND_ENGINEER', roleFamily: 'SOFTWARE_ENGINEERING', priority: 1 }];
const backendProfile = { ...baseProfile, currentTitle: 'Backend Engineer', totalExperienceYears: 6 };
const backendSkills = ['java', 'spring boot', 'kafka'];

// 12. Exact backend role + matching Java stack (spec Step 12).
{
  const r = score(
    baseJob({ canonicalRole: 'BACKEND_ENGINEER', skills: { required: ['java', 'spring boot'], preferred: ['kafka'], mentioned: [] } }),
    { profile: backendProfile, targetRoles: backendTarget, skills: backendSkills }
  );
  check('exact backend role + matching Java stack scores strong', r.matchScore >= 80, JSON.stringify(r.components));
}

// 13. Exact backend role + completely wrong stack (Python/Django/AWS for a Java/Spring/Kafka profile) should NOT rank as strongly.
{
  const matching = score(
    baseJob({ canonicalRole: 'BACKEND_ENGINEER', skills: { required: ['java', 'spring boot'], preferred: ['kafka'], mentioned: [] } }),
    { profile: backendProfile, targetRoles: backendTarget, skills: backendSkills }
  );
  const wrongStack = score(
    baseJob({ canonicalRole: 'BACKEND_ENGINEER', skills: { required: ['python', 'django', 'aws'], preferred: [], mentioned: [] } }),
    { profile: backendProfile, targetRoles: backendTarget, skills: backendSkills }
  );
  check('exact backend role + completely wrong stack scores below matching-stack, same role (spec Step 12)',
    wrongStack.matchScore < matching.matchScore, JSON.stringify({ matching: matching.matchScore, wrongStack: wrongStack.matchScore }));
}

// 14. Exact role + no skill data at all (NO_REQUIREMENT_DATA) must stay neutral, never treated as a true zero match (spec Step 5).
{
  const r = score(
    baseJob({ canonicalRole: 'BACKEND_ENGINEER', skills: { required: [], preferred: [], mentioned: [] } }),
    { profile: backendProfile, targetRoles: backendTarget, skills: backendSkills }
  );
  check('exact role + no required-skill data stays neutral (not penalized as a true zero match)', r.components.requiredSkills === 70 && r.matchScore >= 75, JSON.stringify(r.components));
}

// 15. SAME_FAMILY_GENERIC + weak skills (no title overlap either) should be meaningfully dampened.
{
  const weak = score(
    baseJob({ canonicalRole: 'SOFTWARE_ENGINEERING', title: 'Staff Engineer, Unrelated Systems', skills: { required: ['cobol', 'mainframe', 'jcl'], preferred: [], mentioned: [] } }),
  );
  check('SAME_FAMILY_GENERIC + weak title + weak skills is dampened', weak.roleMatchType === 'SAME_FAMILY_GENERIC' && weak.matchScore < 55, JSON.stringify(weak.components));
}

// 16. SAME_FAMILY_GENERIC + strong skills should NOT be additionally
// dampened by RANK-020 — compared directly against test 15's weak case
// rather than an absolute threshold, since the pre-existing role<40 score
// cap (RANK-004, unchanged) already caps this specific role=35 band at 58
// regardless of RANK-020's conditional dampening.
{
  const weak = score(baseJob({ canonicalRole: 'SOFTWARE_ENGINEERING', title: 'Staff Engineer, Unrelated Systems', skills: { required: ['cobol', 'mainframe', 'jcl'], preferred: [], mentioned: [] } }));
  const strong = score(baseJob({ canonicalRole: 'SOFTWARE_ENGINEERING', title: 'Staff Engineer, Unrelated Systems', skills: { required: ['python', 'sql'], preferred: ['aws'], mentioned: [] } }));
  check('SAME_FAMILY_GENERIC + strong skills is NOT additionally dampened (scores above the weak-skills case)',
    strong.roleMatchType === 'SAME_FAMILY_GENERIC' && strong.matchScore > weak.matchScore,
    JSON.stringify({ weak: weak.matchScore, strong: strong.matchScore }));
}

// 17. Unrelated role + strong generic skill overlap must still not rank strong (RANK-016's existing dampening).
{
  const r = score(baseJob({ roleFamily: 'SALES', canonicalRole: 'SALES', skills: { required: ['python', 'sql'], preferred: ['aws'], mentioned: [] } }));
  check('unrelated + strong generic skills still does not rank strong', r.matchScore < 55, JSON.stringify(r.components));
}

// 18. A skill-rich posting with several missing skills scores proportionally
// (via the plain ratio — RANK-017's absolute missing-count penalty was
// tested and reverted last phase for over-penalizing skill-rich postings;
// this guards against that regression returning), not catastrophically:
// matched 4/8 (50%) must not score far below its plain ratio.
{
  const r = score(baseJob({ skills: { required: ['python', 'sql', 'aws', 'kubernetes', 'terraform', 'go', 'rust', 'scala'], preferred: [], mentioned: [] } })); // matches python, sql, aws = 3/8
  check('skill-rich posting with several missing skills is not catastrophically penalized beyond its plain ratio', r.components.requiredSkills === 38, JSON.stringify(r.components));
}

// 19. A sparse posting with just one missing skill scores a reasonably high ratio, not overly punished for the single gap.
{
  const r = score(baseJob({ skills: { required: ['python', 'kubernetes'], preferred: [], mentioned: [] } })); // matches python = 1/2
  check('sparse posting with one missing skill scores a reasonable ratio', r.components.requiredSkills === 50, JSON.stringify(r.components));
}

// 20. A QA role with real automation skills scores strong (must not be collaterally damaged by the EXACT_CANONICAL skill-floor change).
{
  const qaTarget = [{ canonicalRole: 'QA_AUTOMATION_ENGINEER', roleFamily: 'SOFTWARE_ENGINEERING', priority: 1 }];
  const qaProfile = { ...baseProfile, currentTitle: 'QA Automation Engineer' };
  const r = score(
    baseJob({ canonicalRole: 'QA_AUTOMATION_ENGINEER', skills: { required: ['selenium', 'playwright'], preferred: ['ci/cd'], mentioned: [] } }),
    { profile: qaProfile, targetRoles: qaTarget, skills: ['selenium', 'playwright', 'python', 'java', 'ci/cd'] }
  );
  check('QA role with matching automation skills scores strong', r.matchScore >= 80, JSON.stringify(r.components));
}

// 21. Entry-level user vs. a generic Senior Software Engineer posting with
// a genuinely severe years gap (0.5y vs. an 8y-minimum posting — the
// experienceCap's own <=20 band, RANK-018, unchanged this phase) scores
// meaningfully low despite title/skill overlap.
{
  const entryProfile = { ...baseProfile, totalExperienceYears: 0.5 };
  const r = score(baseJob({ title: 'Senior Software Engineer', seniority: 'SENIOR', experience: { min: 8, max: 12, requirementType: 'REQUIRED' } }), { profile: entryProfile });
  check('entry user vs generic senior SWE (severe years gap) scores meaningfully low', r.matchScore < 60, JSON.stringify(r.components));
}

// 22. RANK-021 (benchmark-v2.1 calibration): a job whose canonical_role
// matches the target's canonical role EXACTLY must score as EXACT_CANONICAL
// even when role_family disagrees between job and target — role_family and
// canonical_role are populated by separate classification passes and can
// legitimately disagree on a borderline title (diagnosed live: an
// "ML Engineer" posting tagged role_family=SOFTWARE_ENGINEERING against an
// ML Engineer target whose OWN role_family is DATA_SCIENCE). Before
// RANK-021 this fell to DIFFERENT_FAMILY_RELATED (score ~42); it must now
// score as a genuine exact match.
{
  const mlTarget = [{ canonicalRole: 'ML_ENGINEER', roleFamily: 'DATA_SCIENCE', priority: 1 }];
  const mlProfile = { ...baseProfile, currentTitle: 'Machine Learning Engineer' };
  const r = score(
    baseJob({ roleFamily: 'SOFTWARE_ENGINEERING', canonicalRole: 'ML_ENGINEER', title: 'Senior ML Engineer', skills: { required: ['python', 'pytorch'], preferred: ['aws'], mentioned: [] } }),
    { profile: mlProfile, targetRoles: mlTarget, skills: ['python', 'pytorch', 'machine learning', 'aws'] }
  );
  check('exact canonical-role match wins despite role_family disagreement (RANK-021)',
    r.roleMatchType === 'EXACT_CANONICAL' && r.matchScore >= 80,
    JSON.stringify({ roleMatchType: r.roleMatchType, matchScore: r.matchScore, components: r.components }));
}

// 23. RANK-022: DIFFERENT_FAMILY_RELATED with weak required-skill coverage
// gets additional dampening; the same cross-family relationship with
// strong required-skill coverage must NOT be additionally punished (spec's
// explicit "do not punish genuinely adjacent strong-skill matches").
// Compared directly against each other, mirroring test 16's pattern.
{
  const deTarget = [{ canonicalRole: 'DATA_ENGINEER', roleFamily: 'DATA_SCIENCE', priority: 1 }];
  const deProfile = { ...baseProfile, currentTitle: 'Data Engineer' };
  const deSkills = ['python', 'sql', 'apache spark', 'airflow', 'aws', 'snowflake'];
  const weak = score(
    baseJob({ roleFamily: 'SOFTWARE_ENGINEERING', canonicalRole: 'QA_ENGINEER', title: 'Software Quality Engineer (Selenium)', skills: { required: ['java', 'selenium'], preferred: [], mentioned: [] } }),
    { profile: deProfile, targetRoles: deTarget, skills: deSkills }
  );
  const strong = score(
    baseJob({ roleFamily: 'RESEARCH', canonicalRole: 'RESEARCH', title: 'Quantitative Researcher', skills: { required: ['python', 'sql'], preferred: [], mentioned: [] } }),
    { profile: deProfile, targetRoles: deTarget, skills: deSkills }
  );
  check('DIFFERENT_FAMILY_RELATED + weak required skills is dampened below the strong-skill case (RANK-022)',
    weak.roleMatchType === 'DIFFERENT_FAMILY_RELATED' && strong.roleMatchType === 'DIFFERENT_FAMILY_RELATED' && weak.matchScore < strong.matchScore,
    JSON.stringify({ weak: weak.matchScore, strong: strong.matchScore }));
}

console.log(`\n${failures === 0 ? 'All checks passed' : failures + ' check(s) FAILED'}`);
if (failures > 0) process.exit(1);
