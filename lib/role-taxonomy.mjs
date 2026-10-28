/**
 * lib/role-taxonomy.mjs
 *
 * Fine-grained canonical-role taxonomy, nested under the EXISTING role_family
 * enum (unchanged — role_family stays the broad bucket, per spec Step 2:
 * "Keep role_family as the broader bucket"). canonical_role becomes finer
 * WITHIN a job's existing role_family; it never crosses family boundaries.
 *
 * Scope decision: full canonical-role depth is only built for the three
 * families with real corpus volume and benchmark coverage — SOFTWARE_ENGINEERING
 * (20,156 READY jobs), DATA_SCIENCE (2,944), DEVOPS_SRE (6,207) — verified via
 * live corpus audit before writing this file (spec Step 1/10). Every other
 * family (SALES, PRODUCT, FINANCE, ...) keeps canonical_role === role_family,
 * matching today's behavior — "do not make it excessively granular... curate
 * only meaningful role distinctions" (spec Step 2/10). Same fallback applies
 * within the three deep families whenever a title doesn't match any pattern:
 * canonical_role falls back to the family name itself, never forced finer
 * without evidence (spec Step 5).
 */

// canonicalRole -> { family, specializations: [...] }. `specializations` is
// the closed set of values lib/role-classifier.mjs may assign for that role;
// anything else stays UNKNOWN/null (spec Step 3: "do not force specialization
// when uncertain").
export const CANONICAL_ROLES = {
  // ── SOFTWARE_ENGINEERING ──────────────────────────────────────────────
  // `generic: true` marks a within-family catch-all (matched by "Software
  // Engineer", "Engineer II", or any bare "engineer" title with no more
  // specific evidence — lib/role-classifier.mjs's Tier-3 fallback). Two
  // jobs both landing on a generic role are NOT a genuine specialization
  // match — matching/role-score.mjs treats a generic canonicalRole the same
  // as the family-level fallback (never EXACT_CANONICAL), which is exactly
  // what caught this: two "Staff Engineer"-type titles with wildly
  // different actual specializations both classify as SOFTWARE_ENGINEER,
  // and without this flag they scored a false EXACT_CANONICAL 95-100
  // (found via the dev-benchmark "Entry Software Engineer" profile
  // regressing to P@5=0 — see docs/ranking-experiments.md).
  SOFTWARE_ENGINEER: { family: 'SOFTWARE_ENGINEERING', specializations: [], generic: true },
  BACKEND_ENGINEER: { family: 'SOFTWARE_ENGINEERING', specializations: ['JAVA', 'PYTHON', 'NODE', 'DOTNET', 'GO', 'RUBY'] },
  FRONTEND_ENGINEER: { family: 'SOFTWARE_ENGINEERING', specializations: ['REACT', 'ANGULAR', 'VUE'] },
  FULL_STACK_ENGINEER: { family: 'SOFTWARE_ENGINEERING', specializations: ['REACT', 'NODE', 'PYTHON', 'JAVA'] },
  MOBILE_ENGINEER: { family: 'SOFTWARE_ENGINEERING', specializations: ['IOS', 'ANDROID', 'REACT_NATIVE'] },
  EMBEDDED_ENGINEER: { family: 'SOFTWARE_ENGINEERING', specializations: [] },
  GAME_ENGINEER: { family: 'SOFTWARE_ENGINEERING', specializations: [] },
  SOFTWARE_ARCHITECT: { family: 'SOFTWARE_ENGINEERING', specializations: [] },
  QA_ENGINEER: { family: 'SOFTWARE_ENGINEERING', specializations: [] },
  QA_AUTOMATION_ENGINEER: { family: 'SOFTWARE_ENGINEERING', specializations: [] },
  SDET: { family: 'SOFTWARE_ENGINEERING', specializations: [] },

  // ── DATA_SCIENCE (houses data engineering, analytics, and ML per spec's
  // grouping — role_family itself is not being split, only canonical_role) ──
  DATA_ENGINEER: { family: 'DATA_SCIENCE', specializations: ['AWS', 'AZURE', 'GCP', 'SPARK', 'STREAMING', 'WAREHOUSE', 'DATABRICKS'] },
  ETL_ENGINEER: { family: 'DATA_SCIENCE', specializations: [] },
  ANALYTICS_ENGINEER: { family: 'DATA_SCIENCE', specializations: [] },
  DATA_PLATFORM_ENGINEER: { family: 'DATA_SCIENCE', specializations: ['AWS', 'AZURE', 'GCP'] },
  DATA_SCIENTIST: { family: 'DATA_SCIENCE', specializations: [] },
  DATA_ANALYST: { family: 'DATA_SCIENCE', specializations: [] },
  ML_ENGINEER: { family: 'DATA_SCIENCE', specializations: ['LLM', 'NLP', 'COMPUTER_VISION', 'RECOMMENDATION_SYSTEMS', 'MLOPS'] },
  AI_ENGINEER: { family: 'DATA_SCIENCE', specializations: ['LLM', 'NLP', 'COMPUTER_VISION'] },
  MLOPS_ENGINEER: { family: 'DATA_SCIENCE', specializations: [] },
  ML_PLATFORM_ENGINEER: { family: 'DATA_SCIENCE', specializations: [] },
  // role-consistency repair phase: was declared under DATA_SCIENCE, but
  // the live corpus audit found 166 "Research Scientist"/"Applied
  // Scientist" jobs classified role_family=RESEARCH (a distinct, already-
  // used role_family value — see matching/role-score.mjs's own
  // FAMILY_ADJACENCY, which already treats RESEARCH as its own family
  // adjacent to DATA_SCIENCE) and ZERO under DATA_SCIENCE — this was a
  // taxonomy data error, not a classifier bug: fixing it here, rather
  // than leaving classifyRole()'s confidence-based family correction
  // (spec Steps 5-7) to actively force the WRONG family onto every future
  // "Research Scientist" title.
  RESEARCH_SCIENTIST: { family: 'RESEARCH', specializations: [] },

  // ── DEVOPS_SRE (houses security per corpus evidence — "security engineer"
  // is a top DEVOPS_SRE title, not its own role_family) ────────────────────
  DEVOPS_ENGINEER: { family: 'DEVOPS_SRE', specializations: [] },
  SITE_RELIABILITY_ENGINEER: { family: 'DEVOPS_SRE', specializations: [] },
  PLATFORM_ENGINEER: { family: 'DEVOPS_SRE', specializations: [] },
  CLOUD_ENGINEER: { family: 'DEVOPS_SRE', specializations: ['AWS', 'AZURE', 'GCP'] },
  INFRASTRUCTURE_ENGINEER: { family: 'DEVOPS_SRE', specializations: [] },
  NETWORK_ENGINEER: { family: 'DEVOPS_SRE', specializations: [] },
  SECURITY_ENGINEER: { family: 'DEVOPS_SRE', specializations: [] },
  CLOUD_SECURITY_ENGINEER: { family: 'DEVOPS_SRE', specializations: ['AWS', 'AZURE', 'GCP'] },
  APPLICATION_SECURITY_ENGINEER: { family: 'DEVOPS_SRE', specializations: [] },
  RELEASE_ENGINEER: { family: 'DEVOPS_SRE', specializations: [] },
};

export function familyOfCanonicalRole(canonicalRole) {
  return CANONICAL_ROLES[canonicalRole]?.family ?? null;
}

/** True for a within-family generic/catch-all role (e.g. SOFTWARE_ENGINEER) — never a genuine specialization match. */
export function isGenericCanonicalRole(canonicalRole) {
  return CANONICAL_ROLES[canonicalRole]?.generic === true;
}

// Adjacency BETWEEN canonical roles, always within the same family (cross-
// family adjacency is unchanged — still matching/role-score.mjs's existing
// FAMILY_ADJACENCY on role_family). Weights follow the spec's own worked
// examples (Step 16) directly where it named the pair; extended consistently
// for the rest of each family's roles. very_close=0.92, close=0.78,
// related=0.55, weak=0.32 — tuned against dev-set evidence alongside the
// role-score integration (see docs/role-taxonomy.md and
// docs/ranking-experiments.md RANK-010+ for before/after).
const VERY_CLOSE = 0.92, CLOSE = 0.78, RELATED = 0.55, WEAK = 0.32;

export const ROLE_ADJACENCY = {
  // SOFTWARE_ENGINEERING
  BACKEND_ENGINEER: { SOFTWARE_ENGINEER: CLOSE, FULL_STACK_ENGINEER: CLOSE, SOFTWARE_ARCHITECT: RELATED, FRONTEND_ENGINEER: WEAK, QA_AUTOMATION_ENGINEER: WEAK, SDET: WEAK },
  FRONTEND_ENGINEER: { SOFTWARE_ENGINEER: CLOSE, FULL_STACK_ENGINEER: CLOSE, MOBILE_ENGINEER: RELATED, BACKEND_ENGINEER: WEAK },
  FULL_STACK_ENGINEER: { SOFTWARE_ENGINEER: CLOSE, BACKEND_ENGINEER: CLOSE, FRONTEND_ENGINEER: CLOSE },
  MOBILE_ENGINEER: { SOFTWARE_ENGINEER: RELATED, FRONTEND_ENGINEER: RELATED, FULL_STACK_ENGINEER: WEAK },
  EMBEDDED_ENGINEER: { SOFTWARE_ENGINEER: RELATED, BACKEND_ENGINEER: WEAK },
  GAME_ENGINEER: { SOFTWARE_ENGINEER: RELATED, BACKEND_ENGINEER: WEAK, FRONTEND_ENGINEER: WEAK },
  SOFTWARE_ARCHITECT: { SOFTWARE_ENGINEER: CLOSE, BACKEND_ENGINEER: RELATED, FULL_STACK_ENGINEER: RELATED },
  SDET: { QA_AUTOMATION_ENGINEER: VERY_CLOSE, QA_ENGINEER: CLOSE, SOFTWARE_ENGINEER: RELATED, BACKEND_ENGINEER: WEAK },
  QA_AUTOMATION_ENGINEER: { SDET: VERY_CLOSE, QA_ENGINEER: CLOSE, SOFTWARE_ENGINEER: RELATED },
  QA_ENGINEER: { QA_AUTOMATION_ENGINEER: CLOSE, SDET: CLOSE, SOFTWARE_ENGINEER: RELATED },

  // DATA_SCIENCE (data engineering / analytics / ML)
  DATA_ENGINEER: { ETL_ENGINEER: VERY_CLOSE, DATA_PLATFORM_ENGINEER: CLOSE, ANALYTICS_ENGINEER: CLOSE, DATA_SCIENTIST: RELATED, ML_ENGINEER: WEAK, DATA_ANALYST: WEAK },
  ETL_ENGINEER: { DATA_ENGINEER: VERY_CLOSE, DATA_PLATFORM_ENGINEER: CLOSE, ANALYTICS_ENGINEER: RELATED },
  DATA_PLATFORM_ENGINEER: { DATA_ENGINEER: CLOSE, ETL_ENGINEER: CLOSE, ANALYTICS_ENGINEER: RELATED },
  ANALYTICS_ENGINEER: { DATA_ENGINEER: CLOSE, DATA_ANALYST: RELATED, DATA_SCIENTIST: RELATED },
  DATA_SCIENTIST: { ML_ENGINEER: RELATED, ANALYTICS_ENGINEER: RELATED, DATA_ANALYST: RELATED, DATA_ENGINEER: RELATED, RESEARCH_SCIENTIST: RELATED },
  DATA_ANALYST: { ANALYTICS_ENGINEER: RELATED, DATA_SCIENTIST: RELATED, DATA_ENGINEER: WEAK },
  ML_ENGINEER: { AI_ENGINEER: VERY_CLOSE, ML_PLATFORM_ENGINEER: CLOSE, MLOPS_ENGINEER: RELATED, DATA_SCIENTIST: RELATED, DATA_ENGINEER: WEAK },
  AI_ENGINEER: { ML_ENGINEER: VERY_CLOSE, ML_PLATFORM_ENGINEER: RELATED, MLOPS_ENGINEER: RELATED, DATA_SCIENTIST: RELATED },
  MLOPS_ENGINEER: { ML_ENGINEER: RELATED, ML_PLATFORM_ENGINEER: CLOSE, AI_ENGINEER: RELATED, DATA_ENGINEER: RELATED },
  ML_PLATFORM_ENGINEER: { ML_ENGINEER: CLOSE, MLOPS_ENGINEER: CLOSE, DATA_PLATFORM_ENGINEER: RELATED },
  RESEARCH_SCIENTIST: { DATA_SCIENTIST: RELATED, ML_ENGINEER: WEAK },

  // DEVOPS_SRE (including security)
  SITE_RELIABILITY_ENGINEER: { DEVOPS_ENGINEER: VERY_CLOSE, PLATFORM_ENGINEER: CLOSE, CLOUD_ENGINEER: CLOSE, INFRASTRUCTURE_ENGINEER: CLOSE },
  DEVOPS_ENGINEER: { SITE_RELIABILITY_ENGINEER: VERY_CLOSE, PLATFORM_ENGINEER: CLOSE, RELEASE_ENGINEER: RELATED },
  PLATFORM_ENGINEER: { SITE_RELIABILITY_ENGINEER: CLOSE, DEVOPS_ENGINEER: CLOSE, INFRASTRUCTURE_ENGINEER: CLOSE },
  CLOUD_ENGINEER: { SITE_RELIABILITY_ENGINEER: CLOSE, INFRASTRUCTURE_ENGINEER: CLOSE, DEVOPS_ENGINEER: RELATED },
  INFRASTRUCTURE_ENGINEER: { PLATFORM_ENGINEER: CLOSE, CLOUD_ENGINEER: CLOSE, NETWORK_ENGINEER: RELATED, SITE_RELIABILITY_ENGINEER: CLOSE },
  NETWORK_ENGINEER: { INFRASTRUCTURE_ENGINEER: RELATED, CLOUD_ENGINEER: WEAK },
  RELEASE_ENGINEER: { DEVOPS_ENGINEER: RELATED, PLATFORM_ENGINEER: WEAK },
  SECURITY_ENGINEER: { APPLICATION_SECURITY_ENGINEER: CLOSE, CLOUD_SECURITY_ENGINEER: CLOSE, DEVOPS_ENGINEER: WEAK },
  APPLICATION_SECURITY_ENGINEER: { SECURITY_ENGINEER: CLOSE, CLOUD_SECURITY_ENGINEER: RELATED },
  CLOUD_SECURITY_ENGINEER: { SECURITY_ENGINEER: CLOSE, APPLICATION_SECURITY_ENGINEER: RELATED, CLOUD_ENGINEER: WEAK },
};

/** @returns adjacency weight in [0,1], or null if the pair isn't in the map (never assume 0 — caller decides the fallback). */
export function roleAdjacency(a, b) {
  if (a === b) return 1;
  return ROLE_ADJACENCY[a]?.[b] ?? ROLE_ADJACENCY[b]?.[a] ?? null;
}

// Families this taxonomy actually deepens with real CANONICAL_ROLES entries
// (SOFTWARE_ENGINEERING, DATA_SCIENCE, DEVOPS_SRE). Every other family
// intentionally keeps canonical_role === role_family — that is the designed
// "not deepened" state, never a fallback artifact needing a flag.
const DEEP_FAMILIES = new Set(Object.values(CANONICAL_ROLES).map(r => r.family));

/**
 * Role-consistency audit/repair phase: the single authoritative check for
 * whether a (roleFamily, canonicalRole, roleSpecialization) combination is
 * internally valid against this taxonomy. Pure, no DB access — safe to call
 * at ingestion time before persistence (spec Step 5) as well as from the
 * read-only corpus audit (spec Step 2's `classifyRow` below, which reuses
 * this instead of duplicating the mapping).
 *
 * Invariant enforced: a KNOWN canonical role (a `CANONICAL_ROLES` key) must
 * belong to its one declared family, and its specialization (if any) must
 * be in that role's declared set. `canonicalRole === roleFamily` (the
 * "not deepened"/fallback state) and `canonicalRole === null` are always
 * valid — spec Step 6/13's explicit policy: UNKNOWN/generic is allowed,
 * only an invalid KNOWN combination is not.
 *
 * @param {{ roleFamily: string|null, canonicalRole: string|null, roleSpecialization: string|null }} input
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateRoleClassification({ roleFamily, canonicalRole, roleSpecialization }) {
  const errors = [];

  if (!roleFamily) errors.push('roleFamily is missing');

  if (canonicalRole) {
    const entry = CANONICAL_ROLES[canonicalRole];
    if (entry) {
      if (roleFamily && entry.family !== roleFamily) {
        errors.push(`canonicalRole ${canonicalRole} belongs to family ${entry.family}, not ${roleFamily}`);
      }
      if (roleSpecialization && !(entry.specializations || []).includes(roleSpecialization)) {
        errors.push(`roleSpecialization ${roleSpecialization} is not valid for canonicalRole ${canonicalRole} (allowed: ${(entry.specializations || []).join(', ') || 'none'})`);
      }
    } else if (canonicalRole !== roleFamily) {
      // Not a recognized taxonomy entry, and not the legacy "copy of
      // family" fallback either — not reachable via the current
      // classifier, flagged defensively (e.g. hand-edited/legacy data).
      errors.push(`canonicalRole ${canonicalRole} is not a recognized taxonomy entry and does not match roleFamily ${roleFamily}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Audit-report bucket (spec Step 2) for one stored row. Built directly on
 * validateRoleClassification() — never a second copy of the mapping.
 * @param {{ role_family: string|null, canonical_role: string|null, role_specialization: string|null }} row
 * @returns {'CONSISTENT'|'CANONICAL_ROLE_FAMILY_MISMATCH'|'SPECIALIZATION_CANONICAL_MISMATCH'|'UNKNOWN_CANONICAL'|'UNKNOWN_FAMILY'|'LEGACY_FAMILY_FALLBACK'|'OTHER'}
 */
export function classifyRow({ role_family, canonical_role, role_specialization }) {
  if (!role_family) return 'UNKNOWN_FAMILY';
  if (!canonical_role) return 'UNKNOWN_CANONICAL';

  const entry = CANONICAL_ROLES[canonical_role];
  if (entry) {
    if (entry.family !== role_family) return 'CANONICAL_ROLE_FAMILY_MISMATCH';
    if (role_specialization && !(entry.specializations || []).includes(role_specialization)) return 'SPECIALIZATION_CANONICAL_MISMATCH';
    return 'CONSISTENT';
  }
  if (canonical_role === role_family) {
    return DEEP_FAMILIES.has(role_family) ? 'LEGACY_FAMILY_FALLBACK' : 'CONSISTENT';
  }
  return 'OTHER';
}
