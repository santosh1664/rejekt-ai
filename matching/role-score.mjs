/**
 * matching/role-score.mjs
 *
 * Scores how well a job's role matches a user's target roles.
 *
 * RANK-010+ (this phase — fine-grained canonical role taxonomy): jobs'
 * `canonical_role` used to always be a copy of `role_family` (verified live:
 * 89,759/105,719 READY jobs exactly equal, 0 disagreements, before this
 * phase's backfill). scripts/backfill-roles.mjs + lib/role-classifier.mjs
 * now populate a real, finer canonical_role (and role_specialization) from
 * each job's title, using lib/role-taxonomy.mjs's controlled taxonomy —
 * see docs/role-taxonomy.md. This module now trusts that finer signal as
 * the PRIMARY discriminator (spec Step 17's ordering: canonical role → role
 * adjacency → specialization → title similarity), with the title-Jaccard
 * heuristic from the previous phase demoted to a fallback/tie-breaker used
 * only when canonical-role-level evidence itself is uninformative (both
 * sides still at family-level granularity — old user_target_roles rows
 * created before this taxonomy existed, or a job the classifier could only
 * place at low confidence).
 */
import { roleAdjacency, isGenericCanonicalRole } from '../lib/role-taxonomy.mjs';

// Adjacency between role FAMILIES themselves (used when canonical-role-level
// evidence isn't available on both sides, or the families differ outright).
// Unchanged from the prior phase — not exhaustive, unlisted pairs default to
// UNRELATED.
export const FAMILY_ADJACENCY = {
  SOFTWARE_ENGINEERING: { DEVOPS_SRE: 0.55, DATA_SCIENCE: 0.35, PRODUCT: 0.25 },
  DEVOPS_SRE: { SOFTWARE_ENGINEERING: 0.55, DATA_SCIENCE: 0.30 },
  DATA_SCIENCE: { SOFTWARE_ENGINEERING: 0.35, DEVOPS_SRE: 0.30, RESEARCH: 0.35 },
  PRODUCT: { SOFTWARE_ENGINEERING: 0.25, DESIGN: 0.35, MARKETING: 0.20 },
  DESIGN: { PRODUCT: 0.35 },
  MARKETING: { SALES: 0.30, PRODUCT: 0.20 },
  SALES: { MARKETING: 0.30 },
  FINANCE: { CONSULTING: 0.25 },
  CONSULTING: { FINANCE: 0.25, OPERATIONS: 0.20 },
  RESEARCH: { DATA_SCIENCE: 0.35 },
};

// role_family is always populated on both job and target rows in practice
// (verified: 0 NULL role_family across the whole corpus) — this is a thin
// wrapper kept only so a future caller that omits family isn't penalized.
function familyOf(family) {
  return family || null;
}

// Title-Jaccard tie-breaker (spec Step 17 — now secondary, not primary).
// Kept from the prior phase for the residual case where canonical_role
// itself is uninformative on one or both sides.
const TITLE_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'senior', 'sr', 'junior', 'jr', 'staff', 'principal', 'lead',
  'manager', 'director', 'engineer', 'engineering', 'specialist', 'associate', 'i', 'ii', 'iii', 'iv',
]);
function titleTokens(title) {
  return new Set(String(title || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !TITLE_STOPWORDS.has(w)));
}
/** Jaccard-style overlap in [0,1], or null when either title has no signal-bearing tokens left. */
function titleSimilarity(jobTitle, userTitle) {
  const a = titleTokens(jobTitle), b = titleTokens(userTitle);
  if (a.size === 0 || b.size === 0) return null;
  const intersection = [...a].filter(w => b.has(w)).length;
  const union = new Set([...a, ...b]).size;
  return intersection / union;
}

// spec Step 18: specialization is a bonus/tie-breaker within an already-
// correct canonical role match, never a separate weighted factor and never
// a penalty for an unknown/mismatched specialization. Since
// user_target_roles has no stored specialization column (out of scope to
// add a new column for this phase), the user's specialization preference is
// inferred from their existing skill list — already-available profile data,
// no schema change needed.
function specializationMatches(jobSpecialization, userSkillNames) {
  if (!jobSpecialization || !userSkillNames?.length) return false;
  const skills = userSkillNames.map(s => String(s).toLowerCase());
  return skills.includes(jobSpecialization.toLowerCase());
}

/**
 * @param {{ canonicalRole: string|null, roleFamily: string|null, roleSpecialization: string|null, title: string|null }} job
 * @param {Array<{ canonicalRole: string, roleFamily: string|null, priority: number }>} targetRoles - user_target_roles rows, priority 1 = highest
 * @param {string|null} [userTitle] - user_profiles.current_title, used only as a same-family tie-breaker
 * @param {string[]} [userSkillNames] - normalized user skills, used only for the specialization bonus (spec Step 18)
 */
export function scoreRole(job, targetRoles, userTitle = null, userSkillNames = []) {
  if (!targetRoles || targetRoles.length === 0) {
    return { score: 50, reason: 'No target roles set — neutral score.', matchedRole: null, matchType: 'NONE' };
  }

  const jobFamily = familyOf(job.roleFamily);
  let best = { score: 0, reason: 'No relationship to any target role.', matchedRole: null, matchType: 'NONE' };
  let bestWeighted = -1;

  for (const target of targetRoles) {
    const weight = 1 / (target.priority || 1); // priority 1 counts fully, priority 2 half, etc.
    const targetFamily = familyOf(target.roleFamily);
    let candidate;

    // A canonical role is only trustworthy as FINER than the family when
    // it's neither a copy of the family string (old rows, or a job the
    // classifier could only place at low confidence — canonicalRole===
    // roleFamily) NOR a within-family generic/catch-all value like
    // SOFTWARE_ENGINEER (lib/role-classifier.mjs's own fallback for a bare
    // "Software Engineer"/"Engineer II" title — matching two of THOSE is
    // not a genuine specialization match either). Guards the same collapse
    // RANK-002 fixed, now checked on both sides and against both forms of
    // "not actually finer."
    const jobFine = job.canonicalRole && job.canonicalRole !== jobFamily && !isGenericCanonicalRole(job.canonicalRole);
    const targetFine = target.canonicalRole && target.canonicalRole !== targetFamily && !isGenericCanonicalRole(target.canonicalRole);

    // RANK-021 (benchmark-v2.1 calibration, spec Steps 16-17 finding "D"):
    // an exact canonical-role match must win regardless of role_family
    // agreement. role_family and canonical_role are populated by separate
    // classification passes and can legitimately disagree on a borderline
    // title (e.g. an "ML Engineer" posting tagged role_family=
    // SOFTWARE_ENGINEERING while canonical_role correctly resolves to
    // ML_ENGINEER) — checked live: 6 such cases across dev+holdout, all
    // GOOD/EXCELLENT-labeled, none BAD/BORDERLINE, so this can only ever
    // help a genuine match, never rescue a bad one. Previously the
    // family-equality gate below ran first, so any family disagreement
    // fell straight to DIFFERENT_FAMILY_RELATED even with an exact
    // canonical-role match — capping two EXCELLENT ML Engineer jobs at
    // score 42 instead of ~95. This check is intentionally identical to
    // the EXACT_CANONICAL branch below, just evaluated before the family
    // gate instead of after it.
    if (jobFine && targetFine && job.canonicalRole === target.canonicalRole) {
      let score = 95;
      let reason = `Exact canonical role match: ${target.canonicalRole}.`;
      if (specializationMatches(job.roleSpecialization, userSkillNames)) {
        score = 100;
        reason += ` Specialization also matches (${job.roleSpecialization}).`;
      }
      candidate = { score, reason, matchedRole: target.canonicalRole, matchType: 'EXACT_CANONICAL' };
    } else if (jobFamily && targetFamily && jobFamily === targetFamily) {
      if (jobFine && targetFine && roleAdjacency(job.canonicalRole, target.canonicalRole) != null) {
        // RELATED_CANONICAL — explicit adjacency between two distinct,
        // genuinely-finer canonical roles in the same family (spec Step 16).
        const weight2 = roleAdjacency(job.canonicalRole, target.canonicalRole);
        candidate = {
          score: Math.round(weight2 * 100),
          reason: `Related canonical role: ${job.canonicalRole} is adjacent to target ${target.canonicalRole}.`,
          matchedRole: target.canonicalRole, matchType: 'RELATED_CANONICAL',
        };
      } else {
        // SAME_FAMILY_GENERIC — same family, but no finer canonical-role
        // signal discriminates (one or both sides are family-level, or the
        // pair has no defined adjacency). Title similarity is the
        // secondary/tie-breaker signal here ONLY (spec Step 17) — it never
        // overrides a canonical-role match found above.
        let score = 50;
        let reason = `Same role family (${jobFamily}) as target ${target.canonicalRole || targetFamily} — no finer canonical-role signal available.`;
        if (userTitle) {
          const sim = titleSimilarity(job.title, userTitle);
          if (sim != null) {
            if (sim >= 0.34) { score = 65; reason += ` Title overlaps with your current title ("${userTitle}").`; }
            else if (sim === 0) { score = 35; reason += ` Title shares no specialization words with your current title ("${userTitle}").`; }
          }
        }
        candidate = { score, reason, matchedRole: target.canonicalRole || targetFamily, matchType: 'SAME_FAMILY_GENERIC' };
      }
    } else if (jobFamily && targetFamily && FAMILY_ADJACENCY[targetFamily]?.[jobFamily] != null) {
      const score = Math.round(FAMILY_ADJACENCY[targetFamily][jobFamily] * 100);
      candidate = { score, reason: `Related field to target ${target.canonicalRole || targetFamily} (${targetFamily} ↔ ${jobFamily}).`, matchedRole: target.canonicalRole || targetFamily, matchType: 'DIFFERENT_FAMILY_RELATED' };
    } else {
      candidate = { score: 10, reason: `Unrelated to target ${target.canonicalRole || targetFamily}.`, matchedRole: null, matchType: 'UNRELATED' };
    }

    // Priority weighting picks which target "wins" when scores are close.
    const weighted = candidate.score * weight;
    if (weighted > bestWeighted) {
      bestWeighted = weighted;
      // Mild reported-score discount for a match found only on a
      // lower-priority target, so two otherwise-identical jobs — one an
      // exact match on the user's #1 target, one on their #2 — don't tie
      // (spec Step 14 + its named regression scenario).
      const priorityDiscount = target.priority <= 1 ? 1 : target.priority === 2 ? 0.9 : 0.8;
      best = { ...candidate, score: Math.round(candidate.score * priorityDiscount) };
    }
  }

  return best;
}
