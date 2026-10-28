/**
 * matching/final-score.mjs
 *
 * Combines every component scorer into one explainable match score.
 *
 * Weights: 30% role, 25% required skills, 10% preferred skills,
 * 10% experience, 10% location, 10% freshness, 5% salary.
 *
 * Unavailable-component handling: every component scorer already returns
 * a neutral (not zero) score when its input data is missing — e.g.
 * scoreSalary returns 65 when salary is unposted, scoreExperience returns
 * 60 when the user has no experience on file. Because neutral is baked in
 * at the component level, this module does a plain weighted sum with no
 * separate redistribution step — an unknown component pulls the final
 * score modestly toward neutral rather than distorting it toward 0, which
 * is the behavior spec Step 16 asks for ("do not treat salary as 0").
 */
import { scoreRole } from './role-score.mjs';
import { scoreSkills } from './skill-score.mjs';
import { scoreExperience } from './experience-score.mjs';
import { scoreLocation } from './location-score.mjs';
import { scoreSalary } from './salary-score.mjs';
import { scoreEducation } from './education-score.mjs';
import { scoreFreshness } from './freshness-score.mjs';

// RANK-008 (spec Steps 10/11) tried shifting weight from freshness/location/
// salary into role (30->38%, 10/10/5 -> 7/7/3%) since those averaged 67-80
// even for BAD-labeled jobs. Measured a small regression (NDCG@10
// 0.803->0.798) with no other metric improving — reverted. See
// docs/ranking-experiments.md.
const WEIGHTS = { role: 0.30, requiredSkills: 0.25, preferredSkills: 0.10, experience: 0.10, location: 0.10, freshness: 0.10, salary: 0.05 };

/**
 * @param {import('./job-contract.mjs').JobContract} job
 * @param {object} userProfile - user_profiles row (camelCase): totalExperienceYears, highestEducationLevel, currentCity, currentState, currentCountry
 * @param {object} userPreferences - user_profile_preferences row (camelCase): preferredStates, preferredCities, preferredWorkplaceTypes, minSalary
 * @param {Array<{canonicalRole, roleFamily, priority}>} targetRoles
 * @param {string[]} userSkillNames - normalized skill names
 * @param {{postedAt: string|null, discovered: string|null}} dates
 */
export function computeFinalScore(job, userProfile, userPreferences, targetRoles, userSkillNames, dates) {
  const role = scoreRole(job, targetRoles, userProfile.currentTitle, userSkillNames);
  const skills = scoreSkills(userSkillNames, job.skills);
  const experience = scoreExperience(userProfile.totalExperienceYears, job.experience, job.seniority);
  const location = scoreLocation(
    { currentCity: userProfile.currentCity, currentState: userProfile.currentState, currentCountry: userProfile.currentCountry },
    { preferredStates: userPreferences.preferredStates, preferredCities: userPreferences.preferredCities, preferredWorkplaceTypes: userPreferences.preferredWorkplaceTypes },
    job
  );
  const salary = scoreSalary(userPreferences.minSalary, job.salary);
  const education = scoreEducation(userProfile.highestEducationLevel, job.education);
  const freshness = scoreFreshness(dates.postedAt, dates.discovered);

  const components = {
    role: role.score,
    requiredSkills: skills.requiredScore,
    preferredSkills: skills.preferredScore,
    experience: experience.score,
    location: location.score,
    freshness: freshness.score,
    salary: salary.score,
  };

  // RANK-012 experiment A (spec Step 5/6): rank-diagnostics-fit.mjs showed
  // top-10 ROLE_MISMATCH jobs (roleMatchType=UNRELATED, role score pinned
  // at 10) averaging requiredSkills=59.4, preferredSkills=68.7 — even
  // "Cookie Crew"/"Cookie Delivery Driver" (zero extracted skills, so they
  // get skill-score.mjs's neutral-70 fallback) score as high as a genuine
  // partial-overlap job. A simple professionalFit average (role+skills+
  // experience)/4 barely separated ROLE_MISMATCH (50.8) from GOOD/EXCELLENT
  // (59.8) despite a 58-point role gap. Dampening skills/experience when
  // role is confirmed low (not just ambiguous) directly targets this.
  // RANK-016: dampen ALL non-role components together when roleMatchType
  // is UNRELATED (spec Step 6's own literal example concept), tested as
  // one combined hypothesis against A (skills+experience only) and B
  // (preference only) individually.
  const ROLE_DAMPEN = { UNRELATED: 0.3, DIFFERENT_FAMILY_RELATED: 0.6 };
  const dampen = ROLE_DAMPEN[role.matchType] ?? 1;

  // RANK-019 (spec Steps 4-6, benchmark-v2 ranking-calibration phase):
  // EXACT_CANONICAL + zero required-skill overlap. rank-diagnostics-fit's
  // benchmark-v2 diagnosis found 12 such top-10 cases — 9 BORDERLINE, 3
  // GOOD, **0 BAD** — weak-skill overlap inside a confirmed exact-role
  // match is NOT strongly predictive of a bad label, so this is
  // deliberately mild, not a strong penalty. Gated on requiredSkillCount
  // (spec Step 5: NO_REQUIREMENT_DATA, where skill-score.mjs's neutral-70
  // fallback already applies, must never be confused with a genuine
  // TRUE_ZERO_MATCH) so a job where the extractor only found one
  // questionable required skill isn't punished the same as one with many
  // (spec Step 5's explicit example) — N=3 tested against 2 and 4, see
  // docs/ranking-experiments.md.
  const requiredSkillCount = skills.matchedRequired.length + skills.missingRequired.length;
  const isTrueZeroRequiredMatch = requiredSkillCount >= 3 && skills.matchedRequired.length === 0;
  const exactRoleSkillDampen = (role.matchType === 'EXACT_CANONICAL' && isTrueZeroRequiredMatch) ? 0.85 : 1;

  // RANK-020 (spec Steps 7-9): SAME_FAMILY_GENERIC conditional dampening.
  // rank-diagnostics-fit's benchmark-v2 diagnosis of entry_swe (7/7 top-10
  // false positives in this tier) found the SAME role/experience band
  // (role=35, experience=90) producing BOTH a GOOD label ("Backend
  // Services Programmer Intern", requiredSkills=70) and a BAD one
  // ("Agentic AI Engineer", requiredSkills=0) — required-skill overlap is
  // what actually separates them within this tier, even though it wasn't
  // predictive within EXACT_CANONICAL above. role.score itself already
  // encodes title-similarity confidence for this tier (35/50/65 — see
  // role-score.mjs), reused here rather than adding a new signal: weak
  // title evidence (role<=35) AND weak required-skill overlap together
  // get a real dampen; either signal alone does not (a single false
  // positive shouldn't be enough to punish a real title/skill match).
  const sameFamilyWeakSignal = role.matchType === 'SAME_FAMILY_GENERIC' && role.score <= 35 && components.requiredSkills <= 30;
  const sameFamilyDampen = sameFamilyWeakSignal ? 0.85 : 1;

  // RANK-022 (benchmark-v2.1 calibration, spec Steps 16-19): conditional
  // additional dampening for DIFFERENT_FAMILY_RELATED when required-skill
  // coverage is ALSO weak. Diagnosed top-10 cases (Step 17 category "C" —
  // an adjacency-map edge too generous in one direction) were consistently
  // low-required-skill (0-33) cross-family jobs riding a family-level
  // adjacency score (e.g. a QA/Security/generic-SWE posting via the
  // SOFTWARE_ENGINEERING<->DATA_SCIENCE or DEVOPS_SRE<->DATA_SCIENCE edge)
  // despite having almost nothing in common with the target's actual
  // skill set. A strong-skill DIFFERENT_FAMILY_RELATED case (e.g. a Quant
  // Researcher role a Data Engineer profile has real Python/SQL overlap
  // with) is deliberately untouched — spec's explicit "do not punish
  // genuinely adjacent strong-skill matches". Gated on requiredSkills
  // alone (not also title similarity) since every diagnosed false
  // positive was already separable on this one signal — see
  // docs/ranking-experiments.md for the evidence.
  const crossFamilyWeakSkill = role.matchType === 'DIFFERENT_FAMILY_RELATED' && components.requiredSkills <= 35;
  const crossFamilyDampen = crossFamilyWeakSkill ? 0.8 : 1;

  const dampenedComponents = {
    role: components.role,
    requiredSkills: components.requiredSkills * dampen * exactRoleSkillDampen * sameFamilyDampen * crossFamilyDampen,
    preferredSkills: components.preferredSkills * dampen * exactRoleSkillDampen * sameFamilyDampen * crossFamilyDampen,
    experience: components.experience * dampen * sameFamilyDampen * crossFamilyDampen,
    location: components.location * dampen * sameFamilyDampen * crossFamilyDampen,
    freshness: components.freshness * dampen * sameFamilyDampen * crossFamilyDampen,
    salary: components.salary * dampen * sameFamilyDampen * crossFamilyDampen,
  };

  const rawScore = Math.round(
    dampenedComponents.role * WEIGHTS.role +
    dampenedComponents.requiredSkills * WEIGHTS.requiredSkills +
    dampenedComponents.preferredSkills * WEIGHTS.preferredSkills +
    dampenedComponents.experience * WEIGHTS.experience +
    dampenedComponents.location * WEIGHTS.location +
    dampenedComponents.freshness * WEIGHTS.freshness +
    dampenedComponents.salary * WEIGHTS.salary
  );
  // RANK-004 (spec Step 5, option A — score cap): the additive formula lets
  // a poor role fit (30% weight) get diluted by high skill/experience/
  // location/freshness/salary (the other 70%) into a deceptively decent
  // total. rank-diagnostics.mjs showed jobs at role=35 (same-family, no
  // title overlap — the common case for a role_family this broad) still
  // reaching 55-70 overall before this cap. RANK-006 tried tightening the
  // role<40 cap further (58->45) and made things worse: it collapsed
  // GOOD/BORDERLINE/BAD jobs in that band to the same score (45), destroying
  // the fine-grained ranking a tighter-but-not-flooring cap should preserve
  // — reverted. Thresholds calibrated against the dev benchmark split — see
  // docs/ranking-experiments.md for the before/after evidence, not chosen
  // a priori.
  // spec Step 19: re-evaluated after the fine-grained taxonomy landed.
  // Option C (no cap) tested and reverted — NDCG@10 0.827->0.815 on dev, no
  // other metric improved. Option A (this cap, unchanged from the prior
  // phase) still generalizes best; its 40/60 score boundaries turn out to
  // still roughly track the new scale's UNRELATED/DIFFERENT_FAMILY_RELATED
  // vs. SAME_FAMILY_GENERIC vs. RELATED_CANONICAL+ tiers well enough that a
  // fresh recalibration (option B) wasn't pursued further — see
  // docs/ranking-experiments.md.
  // RANK-015 experiment D: two-stage banded ranking — professional-relevance
  // band strictly dominates; preference/overall fit only orders WITHIN a
  // band via a fractional offset (rawScore/100 scaled into the band's
  // width), so no amount of skill/experience/location/salary/freshness can
  // ever lift a job out of its professional-relevance band.
  const roleCap = components.role < 40 ? 58 : components.role < 60 ? 75 : 100;
  // RANK-018 (spec Step 8): a severe seniority gap survives even a
  // correctly-matched role (rank-diagnostics-fit.mjs: 15/25 EXPERIENCE_MISMATCH
  // top-10 cases are SAME_FAMILY_GENERIC/RELATED_CANONICAL, e.g. an Entry
  // profile against "Staff Software Engineer, App Platform" — role=50,
  // experience=10). A modifier on the final-score ceiling (mirroring the
  // existing role cap's own shape) rather than reweighting the 10%
  // experience component further avoids double-counting it.
  const experienceCap = components.experience <= 20 ? 55 : components.experience <= 40 ? 75 : 100;
  const matchScore = Math.min(rawScore, roleCap, experienceCap);

  const whyMatched = [];
  if (role.matchType === 'EXACT_CANONICAL') whyMatched.push(`Target role matches ${role.matchedRole}.`);
  else if (role.matchType === 'RELATED_CANONICAL') whyMatched.push(`Closely related role to your target (${role.matchedRole}).`);
  else if (role.matchType === 'SAME_FAMILY_GENERIC') whyMatched.push(`Same field as your target role (${role.matchedRole}).`);
  if (skills.matchedRequired.length) whyMatched.push(`Matched required skills: ${skills.matchedRequired.join(', ')}.`);
  if (skills.matchedPreferred.length) whyMatched.push(`Matched preferred skills: ${skills.matchedPreferred.join(', ')}.`);
  if (experience.score >= 90) whyMatched.push('Experience requirement fits.');
  if (location.score >= 90) whyMatched.push(location.reason);
  if (freshness.ageDays != null && freshness.ageDays <= 3) whyMatched.push('Recently posted.');

  const warnings = [];
  if (job.sponsorship === 'UNKNOWN') warnings.push('Sponsorship status is unknown.');
  if (job.clearance.type !== 'NONE' && job.clearance.requirement === 'PREFERRED') warnings.push(`${job.clearance.type} clearance is preferred for this role.`);
  if (userProfile.totalExperienceYears == null && job.experience.min != null) warnings.push('Your years of experience are not on file.');
  if (education.status === 'unknown') warnings.push(education.reason);
  if (!salary.known) warnings.push('Salary not posted for this role.');

  return {
    jobId: job.jobId,
    matchScore,
    rawScore, // pre-cap weighted total — exposed for diagnostics (spec Step 2's "raw weighted total" vs "final capped score")
    components,
    roleMatchType: role.matchType, // exposed for diagnostics (scripts/rank-diagnostics.mjs) — not just the raw score
    whyMatched,
    missingRequiredSkills: skills.missingRequired,
    missingPreferredSkills: skills.missingPreferred,
    warnings,
  };
}
