/**
 * matching/eligibility.mjs
 *
 * Hard-eligibility evaluation: does a job disqualify a user for a reason
 * the user has explicitly told us matters? Consumes the structured job
 * contract from matching/job-contract.mjs plus the user's profile and
 * preferences rows — never reaches into unrelated DB columns directly.
 *
 * Ground rule (spec Phase 8): UNKNOWN != FAIL. A hard reject only fires
 * when BOTH sides are known and they conflict. Missing data becomes an
 * "unknowns" entry instead — never a silent guess in either direction.
 *
 * @typedef {Object} UserProfile - user_profiles row, camelCase
 * @property {number|null} totalExperienceYears
 * @property {'NONE'|'HIGH_SCHOOL'|'ASSOCIATE'|'BACHELORS'|'MASTERS'|'DOCTORATE'|null} highestEducationLevel
 * @property {string|null} currentCountry - ISO country code
 * @property {string|null} workAuthorization - e.g. 'US_CITIZEN', 'GREEN_CARD', 'H1B', 'OPT', 'OTHER_VISA'; null = unknown
 * @property {boolean|null} needsSponsorship
 * @property {boolean|null} clearanceEligible - can the user hold/obtain the clearance level jobs may require (not yet a stored column; pass null until the profile model grows one)
 *
 * @typedef {Object} UserPreferences - user_profile_preferences row, camelCase
 * @property {boolean} remoteOnly
 * @property {string[]} preferredEmploymentTypes - HARD allow-list when non-empty (spec Phase 3's "employment type restrictions")
 * @property {boolean} excludeClearanceJobs
 * @property {string[]} excludedCompanies
 * @property {string[]} excludedRoleFamilies
 * @property {string[]} allowedCountries - HARD allow-list when non-empty
 * @property {number|null} maxExperienceRequired - reject jobs asking for more than this
 * @property {number|null} minSalary
 * @property {boolean} salaryIsHardConstraint
 */

const EDUCATION_RANK = { NONE: 0, HIGH_SCHOOL: 1, ASSOCIATE: 2, BACHELORS: 3, MASTERS: 4, DOCTORATE: 5 };

function unknown(list, dimension, reason) {
  list.push({ dimension, reason });
}

/**
 * @param {UserProfile} userProfile
 * @param {UserPreferences} userPreferences
 * @param {import('./job-contract.mjs').JobContract} job
 * @param {{ strictEducation?: boolean }} [options] - strictEducation: hard-reject a
 *   required-education shortfall instead of warning (off by default — see spec Phase 14).
 */
export function evaluateEligibility(userProfile, userPreferences, job, options = {}) {
  const hardRejectReasons = [];
  const warnings = [];
  const unknowns = [];

  // ── Sponsorship ─────────────────────────────────────────────────────────
  if (userProfile.needsSponsorship === true) {
    if (job.sponsorship === 'NO_SPONSORSHIP') {
      hardRejectReasons.push({ dimension: 'sponsorship', reason: 'You require visa sponsorship; this employer has stated they do not sponsor.' });
    } else if (job.sponsorship === 'UNKNOWN') {
      unknown(unknowns, 'sponsorship', 'Job sponsorship status is unknown.');
    } else if (job.sponsorship === 'MAY_SPONSOR') {
      warnings.push({ dimension: 'sponsorship', reason: 'Sponsorship is only described as possible (case-by-case), not guaranteed.' });
    }
  } else if (userProfile.needsSponsorship == null && job.sponsorship === 'NO_SPONSORSHIP') {
    unknown(unknowns, 'sponsorship', 'This job does not sponsor visas; whether that matters to you is unknown.');
  }

  // ── Citizenship ──────────────────────────────────────────────────────────
  // Only an explicit 'US_CITIZEN' work_authorization satisfies a US
  // citizenship requirement — a green card or H-1B holder does not, even
  // though both are "authorized to work" (spec Phase 5's point: citizenship,
  // work authorization, sponsorship, and clearance are separate concepts).
  if (job.citizenshipRequirement) {
    if (userProfile.workAuthorization == null) {
      unknown(unknowns, 'citizenship', `This role requires ${job.citizenshipRequirement} citizenship; your work authorization isn't on file.`);
    } else if (job.citizenshipRequirement === 'US' && userProfile.workAuthorization !== 'US_CITIZEN') {
      hardRejectReasons.push({ dimension: 'citizenship', reason: `This role requires ${job.citizenshipRequirement} citizenship, which doesn't match your profile.` });
    }
  }

  // ── Security clearance ───────────────────────────────────────────────────
  if (job.clearance.type !== 'NONE') {
    if (userPreferences.excludeClearanceJobs) {
      hardRejectReasons.push({ dimension: 'clearance', reason: "You've chosen to exclude roles that require a security clearance." });
    } else if (job.clearance.requirement === 'PREFERRED') {
      warnings.push({ dimension: 'clearance', reason: `${job.clearance.type} clearance is preferred but not required.` });
    } else if (job.clearance.requirement === 'REQUIRED_NOW' || job.clearance.requirement === 'ELIGIBLE_TO_OBTAIN') {
      if (userProfile.clearanceEligible == null) {
        unknown(unknowns, 'clearance', `This role requires ${job.clearance.type} clearance (${job.clearance.requirement}); your clearance eligibility isn't on file.`);
      } else if (userProfile.clearanceEligible === false) {
        hardRejectReasons.push({ dimension: 'clearance', reason: `This role requires ${job.clearance.type} clearance, which you've indicated you cannot obtain.` });
      }
    }
  }

  // ── Employment type — allow-list when the user set one ──────────────────
  if (userPreferences.preferredEmploymentTypes?.length) {
    if (job.employmentType === 'UNKNOWN') {
      unknown(unknowns, 'employmentType', "This posting's employment type isn't stated.");
    } else if (!userPreferences.preferredEmploymentTypes.includes(job.employmentType)) {
      hardRejectReasons.push({ dimension: 'employmentType', reason: `You only want ${userPreferences.preferredEmploymentTypes.join('/')} roles; this is ${job.employmentType}.` });
    }
  }

  // ── Excluded companies / role families ──────────────────────────────────
  if (job.company && userPreferences.excludedCompanies?.some(c => c.toLowerCase() === job.company.toLowerCase())) {
    hardRejectReasons.push({ dimension: 'company', reason: `You've excluded ${job.company}.` });
  }
  if (job.roleFamily && userPreferences.excludedRoleFamilies?.includes(job.roleFamily)) {
    hardRejectReasons.push({ dimension: 'roleFamily', reason: `You've excluded ${job.roleFamily} roles.` });
  }

  // ── Country ───────────────────────────────────────────────────────────────
  // Applies to both onsite jobs (their own office country) and remote jobs
  // restricted to specific countries — a remote job with NO stated
  // restriction is allowed regardless of allowedCountries (spec Phase 7's
  // example: "Remote job restricted to US → eligible if user is US-based").
  if (userPreferences.allowedCountries?.length) {
    const officeCountries = (job.locations || []).filter(l => !l.isRemoteRestriction && l.countryCode).map(l => l.countryCode);
    const remoteRestrictionCountries = (job.locations || []).filter(l => l.isRemoteRestriction && l.countryCode).map(l => l.countryCode);
    const relevantCountries = job.workplace === 'REMOTE' ? remoteRestrictionCountries : officeCountries;
    if (relevantCountries.length > 0) {
      const allowed = relevantCountries.some(c => userPreferences.allowedCountries.includes(c));
      if (!allowed) {
        hardRejectReasons.push({ dimension: 'location', reason: `This role is restricted to ${relevantCountries.join('/')}, outside your allowed countries (${userPreferences.allowedCountries.join('/')}).` });
      }
    } else if (job.workplace !== 'REMOTE') {
      unknown(unknowns, 'location', "This job's country isn't on file.");
    }
    // A remote job with no stated country restriction is allowed by design.
  }

  // ── Max experience the user is willing to consider (hard cap) ──────────
  if (userPreferences.maxExperienceRequired != null) {
    if (job.experience.min == null) {
      unknown(unknowns, 'experience', "This job's minimum experience requirement isn't stated.");
    } else if (job.experience.min > userPreferences.maxExperienceRequired) {
      hardRejectReasons.push({ dimension: 'experience', reason: `This role wants ${job.experience.min}y+, above your configured maximum of ${userPreferences.maxExperienceRequired}y.` });
    }
  }

  // ── Salary — hard only when the user opted into a hard floor ───────────
  if (userPreferences.salaryIsHardConstraint && userPreferences.minSalary != null) {
    const jobMax = job.salary.maxAnnual ?? job.salary.minAnnual;
    if (jobMax == null) {
      unknown(unknowns, 'salary', 'Salary is not posted for this role.');
    } else if (jobMax < userPreferences.minSalary) {
      hardRejectReasons.push({ dimension: 'salary', reason: `This role's posted salary (up to $${jobMax.toLocaleString()}) is below your minimum of $${userPreferences.minSalary.toLocaleString()}.` });
    }
  }

  // ── Education (default: warning, never a silent hard reject) ───────────
  if (job.education.requirement === 'REQUIRED' && job.education.level !== 'UNKNOWN' && job.education.level !== 'NONE') {
    if (userProfile.highestEducationLevel == null) {
      unknown(unknowns, 'education', `This role requires ${job.education.level}; your education level isn't on file.`);
    } else if (EDUCATION_RANK[userProfile.highestEducationLevel] < EDUCATION_RANK[job.education.level] && !job.education.equivalentExperienceAccepted) {
      const entry = { dimension: 'education', reason: `This role requires ${job.education.level}; your profile lists ${userProfile.highestEducationLevel}.` };
      if (options.strictEducation) hardRejectReasons.push(entry);
      else warnings.push(entry);
    }
  }

  return {
    eligible: hardRejectReasons.length === 0,
    hardRejectReasons,
    warnings,
    unknowns,
  };
}
