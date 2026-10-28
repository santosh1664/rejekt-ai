import { evaluateEligibility } from '../matching/eligibility.mjs';
import { scoreExperience } from '../matching/experience-score.mjs';
import { scoreEducation } from '../matching/education-score.mjs';

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

function baseJob(overrides = {}) {
  return {
    jobId: '1', title: 'Backend Engineer', company: 'Acme Corp', roleFamily: 'SOFTWARE_ENGINEERING', canonicalRole: null, seniority: 'MID',
    experience: { min: 3, max: 5, requirementType: 'REQUIRED' },
    education: { level: 'BACHELORS', requirement: 'REQUIRED', equivalentExperienceAccepted: false },
    workplace: 'REMOTE', locations: [], sponsorship: 'UNKNOWN', citizenshipRequirement: null, itarRelated: false,
    clearance: { type: 'NONE', requirement: 'NONE' }, employmentType: 'FULL_TIME',
    salary: { minRaw: null, maxRaw: null, period: null, minAnnual: null, maxAnnual: null, currency: null },
    skills: { required: [], preferred: [], mentioned: [] },
    ...overrides,
  };
}
function baseProfile(overrides = {}) {
  return { totalExperienceYears: null, highestEducationLevel: null, currentCountry: null, workAuthorization: null, needsSponsorship: null, clearanceEligible: null, ...overrides };
}
function basePrefs(overrides = {}) {
  return { remoteOnly: false, preferredEmploymentTypes: [], excludeClearanceJobs: false, excludedCompanies: [], excludedRoleFamilies: [], allowedCountries: [], maxExperienceRequired: null, minSalary: null, salaryIsHardConstraint: false, ...overrides };
}

// ── Hard-reject only when user explicitly requires something ───────────────
check('no sponsorship + user requires it -> hard reject',
  !evaluateEligibility(baseProfile({ needsSponsorship: true }), basePrefs(), baseJob({ sponsorship: 'NO_SPONSORSHIP' })).eligible);
check('no sponsorship + user does not need it -> eligible',
  evaluateEligibility(baseProfile({ needsSponsorship: false }), basePrefs(), baseJob({ sponsorship: 'NO_SPONSORSHIP' })).eligible);
check('citizenship required (US), user is green card -> hard reject',
  !evaluateEligibility(baseProfile({ workAuthorization: 'GREEN_CARD' }), basePrefs(), baseJob({ citizenshipRequirement: 'US' })).eligible);
check('citizenship required (US), user is US citizen -> eligible',
  evaluateEligibility(baseProfile({ workAuthorization: 'US_CITIZEN' }), basePrefs(), baseJob({ citizenshipRequirement: 'US' })).eligible);
check('exclude_clearance_jobs + job requires clearance -> hard reject',
  !evaluateEligibility(baseProfile(), basePrefs({ excludeClearanceJobs: true }), baseJob({ clearance: { type: 'SECRET', requirement: 'REQUIRED_NOW' } })).eligible);
check('clearance required, user cannot obtain -> hard reject',
  !evaluateEligibility(baseProfile({ clearanceEligible: false }), basePrefs(), baseJob({ clearance: { type: 'SECRET', requirement: 'REQUIRED_NOW' } })).eligible);
check('employment type allow-list excludes CONTRACT -> hard reject',
  !evaluateEligibility(baseProfile(), basePrefs({ preferredEmploymentTypes: ['FULL_TIME'] }), baseJob({ employmentType: 'CONTRACT' })).eligible);
check('excluded company -> hard reject',
  !evaluateEligibility(baseProfile(), basePrefs({ excludedCompanies: ['Acme Corp'] }), baseJob()).eligible);
check('excluded role family -> hard reject',
  !evaluateEligibility(baseProfile(), basePrefs({ excludedRoleFamilies: ['SOFTWARE_ENGINEERING'] }), baseJob()).eligible);
check('onsite job outside allowed countries -> hard reject',
  !evaluateEligibility(baseProfile(), basePrefs({ allowedCountries: ['US'] }), baseJob({ workplace: 'ONSITE', locations: [{ city: 'Berlin', stateCode: null, countryCode: 'DE', isRemoteRestriction: false, region: null }] })).eligible);
check('remote job with no country restriction is eligible even with allowedCountries set',
  evaluateEligibility(baseProfile(), basePrefs({ allowedCountries: ['US'] }), baseJob({ workplace: 'REMOTE', locations: [] })).eligible);
check('remote job restricted to US, user allows US -> eligible',
  evaluateEligibility(baseProfile(), basePrefs({ allowedCountries: ['US'] }), baseJob({ workplace: 'REMOTE', locations: [{ city: null, stateCode: null, countryCode: 'US', isRemoteRestriction: true, region: null }] })).eligible);
check('max experience threshold exceeded -> hard reject',
  !evaluateEligibility(baseProfile(), basePrefs({ maxExperienceRequired: 2 }), baseJob({ experience: { min: 8, max: 10, requirementType: 'REQUIRED' } })).eligible);
check('experience below max threshold -> eligible (experience does not hard-reject by default)',
  evaluateEligibility(baseProfile(), basePrefs(), baseJob({ experience: { min: 8, max: 10, requirementType: 'REQUIRED' } })).eligible);
check('hard salary floor not met -> hard reject',
  !evaluateEligibility(baseProfile(), basePrefs({ minSalary: 150000, salaryIsHardConstraint: true }), baseJob({ salary: { minRaw: null, maxRaw: null, period: 'YEAR', minAnnual: 100000, maxAnnual: 120000, currency: 'USD' } })).eligible);
check('salary below floor but NOT a hard constraint -> eligible',
  evaluateEligibility(baseProfile(), basePrefs({ minSalary: 150000, salaryIsHardConstraint: false }), baseJob({ salary: { minRaw: null, maxRaw: null, period: 'YEAR', minAnnual: 100000, maxAnnual: 120000, currency: 'USD' } })).eligible);

// ── UNKNOWN never hard-rejects — becomes an unknown/warning instead ────────
{
  const result = evaluateEligibility(baseProfile({ needsSponsorship: null }), basePrefs(), baseJob({ sponsorship: 'NO_SPONSORSHIP' }));
  check('UNKNOWN profile need + no-sponsorship job -> not a hard reject', result.eligible && result.unknowns.some(u => u.dimension === 'sponsorship'));
}
{
  const result = evaluateEligibility(baseProfile({ workAuthorization: null }), basePrefs(), baseJob({ citizenshipRequirement: 'US' }));
  check('citizenship required but work authorization unknown -> not a hard reject', result.eligible && result.unknowns.some(u => u.dimension === 'citizenship'));
}
{
  const result = evaluateEligibility(baseProfile({ clearanceEligible: null }), basePrefs(), baseJob({ clearance: { type: 'SECRET', requirement: 'REQUIRED_NOW' } }));
  check('clearance required but profile unknown -> not a hard reject', result.eligible && result.unknowns.some(u => u.dimension === 'clearance'));
}

// ── Education: warning by default, never a silent hard reject ─────────────
{
  const result = evaluateEligibility(baseProfile({ highestEducationLevel: 'HIGH_SCHOOL' }), basePrefs(), baseJob());
  check('education shortfall is a warning by default, not a hard reject', result.eligible && result.warnings.some(w => w.dimension === 'education'));
}
{
  const result = evaluateEligibility(baseProfile({ highestEducationLevel: 'HIGH_SCHOOL' }), basePrefs(), baseJob(), { strictEducation: true });
  check('education shortfall escalates to hard reject only when explicitly requested', !result.eligible && result.hardRejectReasons.some(r => r.dimension === 'education'));
}

// ── Compatibility scorers (soft, non-gating) ────────────────────────────────
check('experience: meets minimum -> score 100', scoreExperience(5, { min: 3, max: 5 }).score === 100);
check('experience: 1y below -> small penalty band', scoreExperience(2, { min: 3, max: 5 }).score < 100 && scoreExperience(2, { min: 3, max: 5 }).score >= 75);
check('experience: several years below -> strong penalty', scoreExperience(1, { min: 8, max: 10 }).score < 30);
check('experience: unknown user years -> neutral, not zero', scoreExperience(null, { min: 3, max: 5 }).score > 0 && scoreExperience(null, { min: 3, max: 5 }).score < 100);
check('education: exact match', scoreEducation('BACHELORS', { level: 'BACHELORS', requirement: 'REQUIRED', equivalentExperienceAccepted: false }).status === 'meets');
check('education: below required but equivalent experience accepted', scoreEducation('HIGH_SCHOOL', { level: 'BACHELORS', requirement: 'REQUIRED', equivalentExperienceAccepted: true }).status === 'equivalent_experience_possible');
check('education: preferred mismatch not heavily penalized', scoreEducation('BACHELORS', { level: 'MASTERS', requirement: 'PREFERRED', equivalentExperienceAccepted: false }).score >= 70);

console.log(`\n${failures === 0 ? 'All checks passed' : failures + ' check(s) FAILED'}`);
if (failures > 0) process.exit(1);
