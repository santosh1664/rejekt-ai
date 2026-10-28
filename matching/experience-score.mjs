/**
 * matching/experience-score.mjs
 *
 * Graded (never binary) experience-compatibility scoring — this affects
 * ranking, not eligibility (see matching/eligibility.mjs for the one case
 * where experience CAN hard-reject: a user-configured max_experience_required
 * ceiling, which is a distinct concept from "job wants more than I have").
 */

// RANK-007 (spec Step 8 — seniority compatibility): ~42% of READY jobs have
// no min_exp_years (verified against the corpus), which fell back to a flat
// neutral 90 regardless of actual seniority gap — rank-diagnostics.mjs on
// RANK-006 showed exactly this: an "Entry Software Engineer" profile scored
// experience=90 against a "Staff Engineer" job with role=35 (unrelated,
// senior title), because that job had no min_exp_years. jobs.seniority_level
// is populated for the vast majority of jobs and gives a coarser but real
// fallback signal. Management levels are a different track from IC years —
// this only softens confidence there, never inflates it, per the spec's
// "not simply higher" caution.
const SENIORITY_ORDINAL = { INTERN: 0, ENTRY: 1, JUNIOR: 1, MID: 2, SENIOR: 3, LEAD: 3, STAFF: 4, PRINCIPAL: 5, MANAGER: 4, DIRECTOR: 5, EXECUTIVE: 6 };
const MANAGEMENT_LEVELS = new Set(['MANAGER', 'DIRECTOR', 'EXECUTIVE']);

function userSeniorityOrdinal(years) {
  if (years < 1) return 0.5;
  if (years < 3) return 1;
  if (years < 5) return 2;
  if (years < 8) return 3;
  if (years < 12) return 4;
  if (years < 18) return 5;
  return 6;
}

function scoreBySeniorityLevel(userYears, jobSeniority) {
  const jobOrdinal = SENIORITY_ORDINAL[jobSeniority];
  if (jobOrdinal == null || userYears == null) {
    return { score: 90, userYears, jobMinYears: null, gap: null, reason: 'This role states no minimum experience requirement.' };
  }
  const gap = jobOrdinal - userSeniorityOrdinal(userYears);
  let score = gap <= 0 ? 90 : gap <= 1 ? 65 : gap <= 2 ? 40 : 15;
  let reason = `Estimated from this role's ${jobSeniority} level vs. your ${userYears}y experience (no explicit years requirement posted).`;
  if (MANAGEMENT_LEVELS.has(jobSeniority)) {
    // We have no management-track signal on the user's profile (no reports,
    // no people-management history) — years alone can't confirm a real fit,
    // so cap confidence rather than let ordinal years alone score it high.
    score = Math.min(score, 55);
    reason += ' Management-track role — years alone can\'t confirm fit.';
  }
  return { score, userYears, jobMinYears: null, gap: null, reason };
}

/**
 * @param {number|null} userYears
 * @param {{min: number|null, max: number|null}} jobExperience
 * @param {string|null} [jobSeniority] - jobs.seniority_level, used only when jobExperience.min is absent
 */
export function scoreExperience(userYears, jobExperience, jobSeniority = null) {
  const jobMinYears = jobExperience?.min ?? null;
  const jobMaxYears = jobExperience?.max ?? null;

  if (jobMinYears == null) {
    return scoreBySeniorityLevel(userYears, jobSeniority);
  }
  if (userYears == null) {
    return { score: 60, userYears, jobMinYears, gap: null, reason: "This role requires experience, but your profile doesn't list years of experience." };
  }

  const gap = jobMinYears - userYears;
  if (gap <= 0) {
    // Meets or exceeds. Light, non-aggressive overqualification handling —
    // only kicks in well past the job's stated max, and never drops below 80.
    if (jobMaxYears != null && userYears > jobMaxYears + 5) {
      return { score: 80, userYears, jobMinYears, gap, reason: `Your ${userYears}y is well above this role's ${jobMinYears}-${jobMaxYears}y range — may be overqualified.` };
    }
    return { score: 100, userYears, jobMinYears, gap, reason: `Your ${userYears}y meets the ${jobMinYears}y minimum.` };
  }
  if (gap <= 1) {
    return { score: 82, userYears, jobMinYears, gap, reason: `You're ${gap}y below the ${jobMinYears}y minimum — a small gap.` };
  }
  if (gap <= 2) {
    return { score: 62, userYears, jobMinYears, gap, reason: `You're ${gap}y below the ${jobMinYears}y minimum — a moderate gap.` };
  }
  // 3+ years below — progressively lower, floor at 10.
  const score = Math.max(10, 45 - (gap - 3) * 10);
  return { score, userYears, jobMinYears, gap, reason: `You're ${gap}y below the ${jobMinYears}y minimum — a significant gap.` };
}
