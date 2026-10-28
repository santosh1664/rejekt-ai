/**
 * matching/skill-score.mjs
 *
 * Scores required/preferred/mentioned skill overlap between a user's
 * normalized skill set and a job's (from matching/job-contract.mjs).
 * Comparison happens on normalized skill names (lib/skills.mjs) so aliases
 * ("Postgres" vs "PostgreSQL") match correctly on both sides.
 */

/**
 * @param {string[]} userSkillNames - already-normalized skill names (see lib/skills.mjs's normalizeSkillName)
 * @param {{ required: string[], preferred: string[], mentioned: string[] }} jobSkills - canonical names from the job contract
 */
export function scoreSkills(userSkillNames, jobSkills) {
  const userSet = new Set(userSkillNames.map(s => s.toLowerCase()));
  const required = jobSkills.required || [];
  const preferred = jobSkills.preferred || [];
  const mentioned = jobSkills.mentioned || [];

  const matchedRequired = required.filter(s => userSet.has(s.toLowerCase()));
  const missingRequired = required.filter(s => !userSet.has(s.toLowerCase()));
  const matchedPreferred = preferred.filter(s => userSet.has(s.toLowerCase()));
  const missingPreferred = preferred.filter(s => !userSet.has(s.toLowerCase()));
  const matchedMentioned = mentioned.filter(s => userSet.has(s.toLowerCase()));

  // Zero required skills on the job is common (many postings list only
  // "mentioned" tech) and must not auto-score zero — neutral instead.
  // RANK-017 (spec Step 7) tested an absolute missing-count penalty on top
  // of the ratio (so 4/8 matched scores worse than 1/2 matched despite the
  // same 50% ratio) — regressed dev NDCG@10 0.901->0.887, reverted. It
  // likely over-penalized GOOD-labeled senior/technical roles that
  // naturally list more required skills. See docs/ranking-experiments.md.
  const requiredScore = required.length === 0 ? 70 : Math.round((matchedRequired.length / required.length) * 100);
  const preferredScore = preferred.length === 0 ? 70 : Math.round((matchedPreferred.length / preferred.length) * 100);

  return {
    requiredScore,
    preferredScore,
    matchedRequired,
    missingRequired,
    matchedPreferred,
    missingPreferred,
    matchedMentioned,
  };
}
