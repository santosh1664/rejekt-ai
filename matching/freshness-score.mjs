/**
 * matching/freshness-score.mjs
 *
 * Recency scoring — a single curve function, not scattered conditions.
 */

/** @param {Date|string|null} postedAt @param {Date|string|null} discovered */
export function scoreFreshness(postedAt, discovered) {
  const value = postedAt || discovered;
  if (!value) return { score: 30, ageDays: null, reason: 'No posted/discovered date available.' };

  const ageDays = Math.max(0, (Date.now() - new Date(value).getTime()) / 86_400_000);
  let score;
  if (ageDays <= 1) score = 100;
  else if (ageDays <= 3) score = 90;
  else if (ageDays <= 7) score = 80;
  else if (ageDays <= 14) score = 60;
  else if (ageDays <= 30) score = 40;
  else score = 20;

  return { score, ageDays: Math.round(ageDays), reason: `Posted ${Math.round(ageDays)} day(s) ago.` };
}
