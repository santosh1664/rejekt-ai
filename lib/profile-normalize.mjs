/**
 * lib/profile-normalize.mjs
 *
 * Reusable normalization for user-profile inputs — deliberately reuses the
 * SAME taxonomies jobs already use (lib/skills.mjs, lib/fingerprint.mjs's
 * classifyCategory, lib/normalize.mjs's CATEGORY_TO_ROLE_FAMILY,
 * lib/location.mjs's state/country matchers, lib/education.mjs's levels)
 * rather than maintaining a second, user-only taxonomy (spec Phase 4's
 * explicit instruction).
 */
import { classifyCategory } from './fingerprint.mjs';
import { CATEGORY_TO_ROLE_FAMILY } from './normalize.mjs';
import { normalizeSkillName } from './skills.mjs';
import { matchState, matchCountry } from './location.mjs';
import { EDUCATION_LEVELS } from './education.mjs';
import { classifyRole } from './role-classifier.mjs';

/**
 * Maps free-text like a resume title or a target-role search term to
 * {roleFamily, canonicalRole}. Uses lib/role-classifier.mjs (role-v2) so a
 * user typing a specific title ("Backend Engineer") gets the same
 * fine-grained canonical role a matching job would (spec Step 14) —
 * classifyRole() already falls back to the broad role_family when the text
 * carries no finer signal, which is exactly "if a user only has broad
 * family preference, keep role_family preference valid" (no separate
 * broad/fine code path needed). Existing user_target_roles rows created
 * before this classifier existed keep canonical_role === role_family and
 * are left as-is — role-score.mjs's SAME_FAMILY tier already handles that
 * granularity correctly, so no migration/backfill of past user input is
 * needed ("do not require users to re-enter data").
 */
export function normalizeRoleInput(titleText = '') {
  const category = classifyCategory(String(titleText));
  const roleFamily = CATEGORY_TO_ROLE_FAMILY[category] || 'OTHER';
  const classified = classifyRole({ title: titleText, roleFamily });
  return { roleFamily, canonicalRole: classified.canonicalRole };
}

export { normalizeSkillName };

/** Normalizes free-text city/state/country into a structured location. Unresolvable parts are kept as given (city) rather than dropped. */
export function normalizeUserLocation({ city, state, country } = {}) {
  const stateCode = state ? (matchState(state) || String(state).toUpperCase()) : null;
  const countryCode = country ? (matchCountry(country) || String(country).toUpperCase()) : (stateCode ? 'US' : null);
  return { city: city || null, stateCode, countryCode };
}

const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'TEMPORARY', 'INTERNSHIP', 'COOP', 'UNKNOWN'];
const WORKPLACE_TYPES = ['REMOTE', 'HYBRID', 'ONSITE', 'FLEXIBLE', 'UNKNOWN'];

export function isValidEducationLevel(value) { return EDUCATION_LEVELS.includes(value); }
export function isValidEmploymentType(value) { return EMPLOYMENT_TYPES.includes(value); }
export function isValidWorkplaceType(value) { return WORKPLACE_TYPES.includes(value); }
export { EMPLOYMENT_TYPES, WORKPLACE_TYPES };
