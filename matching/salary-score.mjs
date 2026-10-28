/**
 * matching/salary-score.mjs
 *
 * Soft salary compatibility. A hard salary floor (salary_is_hard_constraint)
 * is enforced in matching/eligibility.mjs, not here — this only scores
 * jobs that already passed eligibility. Unknown salary is never a low
 * score; it's neutral, per spec Step 8's UNKNOWN policy.
 */

/**
 * @param {number|null} userMinSalary - annualized
 * @param {{minAnnual: number|null, maxAnnual: number|null}} jobSalary
 */
export function scoreSalary(userMinSalary, jobSalary) {
  const jobMax = jobSalary?.maxAnnual ?? jobSalary?.minAnnual ?? null;
  const jobMin = jobSalary?.minAnnual ?? null;

  if (jobMax == null && jobMin == null) {
    return { score: 65, known: false, reason: 'Salary not posted for this role.' };
  }
  if (userMinSalary == null) {
    return { score: 65, known: true, reason: 'Salary is posted, but you have no salary preference set to compare it against.' };
  }

  const best = jobMax ?? jobMin;
  if (best >= userMinSalary) {
    return { score: 100, known: true, reason: `Posted salary (up to $${best.toLocaleString()}) meets your minimum ($${userMinSalary.toLocaleString()}).` };
  }
  const shortfallRatio = (userMinSalary - best) / userMinSalary;
  const score = Math.max(15, Math.round(100 - shortfallRatio * 150));
  return { score, known: true, reason: `Posted salary (up to $${best.toLocaleString()}) is below your minimum ($${userMinSalary.toLocaleString()}).` };
}
