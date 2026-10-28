/**
 * matching/education-score.mjs
 *
 * Soft education compatibility — hard rejection for education is a
 * deliberate, opt-in product decision (see matching/eligibility.mjs's
 * strictEducation option), never the default. PREFERRED mismatches are
 * barely penalized; REQUIRED mismatches lower the score but never zero it
 * outright when equivalent experience is accepted.
 */
const EDUCATION_RANK = { NONE: 0, HIGH_SCHOOL: 1, ASSOCIATE: 2, BACHELORS: 3, MASTERS: 4, DOCTORATE: 5 };

/**
 * @param {string|null} userLevel - one of EDUCATION_RANK's keys, or null if unknown
 * @param {{level: string, requirement: string, equivalentExperienceAccepted: boolean}} jobEducation
 */
export function scoreEducation(userLevel, jobEducation) {
  const { level, requirement, equivalentExperienceAccepted } = jobEducation;
  if (level === 'UNKNOWN' || level === 'NONE') {
    return { status: 'meets', score: 90, reason: 'This role has no stated education requirement.' };
  }
  if (userLevel == null) {
    return { status: 'unknown', score: 60, reason: `This role lists ${level} (${requirement.toLowerCase()}), but your education level is unknown.` };
  }

  const userRank = EDUCATION_RANK[userLevel];
  const jobRank = EDUCATION_RANK[level];
  if (userRank > jobRank) {
    return { status: 'exceeds', score: 95, reason: `Your ${userLevel} exceeds this role's ${level} requirement.` };
  }
  if (userRank === jobRank) {
    return { status: 'meets', score: 95, reason: `Your ${userLevel} meets this role's requirement.` };
  }
  if (requirement === 'PREFERRED') {
    return { status: 'below_required', score: 80, reason: `${level} is preferred, not required — your ${userLevel} is likely still fine.` };
  }
  if (equivalentExperienceAccepted) {
    return { status: 'equivalent_experience_possible', score: 65, reason: `This role accepts equivalent experience in place of the stated ${level} requirement.` };
  }
  return { status: 'below_required', score: 35, reason: `This role requires ${level}; your profile lists ${userLevel}.` };
}
