/**
 * matching/profile-completeness.mjs
 *
 * Recommendations should still run on a partial profile (spec Phase 6) —
 * this only flags what's missing so the caller can surface uncertainty,
 * never blocks generation outright.
 */

/**
 * @param {{ currentTitle: string|null }} userProfile
 * @param {Array} targetRoles - user_target_roles rows
 * @param {Array} skills - user_skills rows
 * @param {{ currentCountry: string|null }} location - from userProfile, split out for clarity
 */
export function evaluateProfileCompleteness(userProfile, targetRoles, skills, location) {
  const missing = [];
  const warnings = [];

  const hasRoleSignal = (targetRoles && targetRoles.length > 0) || !!userProfile.currentTitle;
  if (!hasRoleSignal) missing.push('At least one target role, or a current title, is needed to score role match.');

  const hasSkillSignal = (skills && skills.length > 0);
  if (!hasSkillSignal) missing.push('At least one skill is needed to score required/preferred skill match.');

  if (!location.currentCountry) warnings.push('No country on file — location and country-restricted eligibility checks will be less accurate.');
  if (userProfile.totalExperienceYears == null) warnings.push('Years of experience not set — experience compatibility will be neutral rather than precise.');
  if (userProfile.highestEducationLevel == null) warnings.push('Education level not set — education compatibility will be neutral rather than precise.');

  return {
    completeEnoughForRecommendations: missing.length === 0,
    missing,
    warnings,
  };
}
