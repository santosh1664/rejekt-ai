import { computeFinalScore } from '../matching/final-score.mjs';
import { scoreFreshness } from '../matching/freshness-score.mjs';

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

// ── Freshness curve ─────────────────────────────────────────────────────────
check('0-1 day -> 100', scoreFreshness(new Date().toISOString(), null).score === 100);
check('30+ days -> 20', scoreFreshness(new Date(Date.now() - 45 * 86400000).toISOString(), null).score === 20);
check('no date -> low but not crashing', scoreFreshness(null, null).score > 0);

// ── Final score: weight normalization + deterministic ordering ─────────────
function job(overrides = {}) {
  return {
    jobId: '1', title: 'Backend Engineer', company: 'Acme', roleFamily: 'SOFTWARE_ENGINEERING', canonicalRole: null,
    experience: { min: 3, max: 5, requirementType: 'REQUIRED' },
    education: { level: 'UNKNOWN', requirement: 'UNKNOWN', equivalentExperienceAccepted: false },
    workplace: 'REMOTE', locations: [], sponsorship: 'UNKNOWN', citizenshipRequirement: null, itarRelated: false,
    clearance: { type: 'NONE', requirement: 'NONE' }, employmentType: 'FULL_TIME',
    salary: { minRaw: null, maxRaw: null, period: null, minAnnual: null, maxAnnual: null, currency: null },
    skills: { required: ['python', 'aws'], preferred: [], mentioned: [] },
    postedAt: new Date().toISOString(), discovered: new Date().toISOString(),
    ...overrides,
  };
}
const profile = { totalExperienceYears: 4, highestEducationLevel: 'BACHELORS', currentCity: null, currentState: null, currentCountry: null };
const prefs = { preferredStates: [], preferredCities: [], preferredWorkplaceTypes: [], minSalary: null };
const targetRoles = [{ canonicalRole: 'SOFTWARE_ENGINEERING', roleFamily: 'SOFTWARE_ENGINEERING', priority: 1 }];

{
  const result = computeFinalScore(job(), profile, prefs, targetRoles, ['python', 'aws'], { postedAt: job().postedAt, discovered: job().discovered });
  check('matchScore is a number in [0,100]', typeof result.matchScore === 'number' && result.matchScore >= 0 && result.matchScore <= 100);
  check('components object has all 7 weighted dimensions', Object.keys(result.components).sort().join(',') === 'experience,freshness,location,preferredSkills,requiredSkills,role,salary'.split(',').sort().join(','));
  check('whyMatched is populated for a strong match', result.whyMatched.length > 0);
  check('unknown salary does not drag score toward 0 — component stays neutral', result.components.salary >= 50);
}
{
  // Deterministic ordering: same input twice -> same score.
  const a = computeFinalScore(job(), profile, prefs, targetRoles, ['python', 'aws'], { postedAt: job().postedAt, discovered: job().discovered });
  const b = computeFinalScore(job(), profile, prefs, targetRoles, ['python', 'aws'], { postedAt: job().postedAt, discovered: job().discovered });
  check('deterministic: identical input produces identical score', a.matchScore === b.matchScore);
}
{
  const strong = computeFinalScore(job({ skills: { required: ['python', 'aws'], preferred: [], mentioned: [] } }), profile, prefs, targetRoles, ['python', 'aws'], { postedAt: job().postedAt, discovered: job().discovered });
  const weak = computeFinalScore(job({ skills: { required: ['python', 'aws', 'kubernetes', 'terraform'], preferred: [], mentioned: [] } }), profile, prefs, targetRoles, ['python'], { postedAt: job().postedAt, discovered: job().discovered });
  check('more missing required skills -> lower score', weak.matchScore < strong.matchScore);
  check('missingRequiredSkills reflects the actual gap', weak.missingRequiredSkills.length === 3);
}

console.log(`\n${failures === 0 ? 'All checks passed' : failures + ' check(s) FAILED'}`);
if (failures > 0) process.exit(1);
