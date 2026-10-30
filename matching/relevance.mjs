// Feed relevance check (docs/keyword-search.md E13): scores the feed the user
// actually sees, then re-runs it with ONE active filter relaxed at a time so a
// weak feed can say which filter is hiding the good jobs, plus a patch to undo it.
import { generateRecommendations } from './recommend.mjs';

export const STRONG = 65;

// activeFilters key -> how to relax it. `override` feeds generateRecommendations;
// `patch` is what the UI saves (prefs = preferences endpoint, visa = profile.needs_sponsorship, posted = days).
export const RELAXATIONS = {
  maxExperienceRequired: { label: 'Drop the max-years cap',        override: { preferences: { maxExperienceRequired: null } }, patch: { prefs: { max_experience_required: null } } },
  minSalary:             { label: 'Drop the minimum salary',       override: { preferences: { salaryIsHardConstraint: false } }, patch: { prefs: { salary_is_hard_constraint: false } } },
  remoteOnly:            { label: 'Allow hybrid and onsite',       override: { preferences: { remoteOnly: false } }, patch: { prefs: { remote_only: false, preferred_workplace_types: [] } } },
  employmentTypes:       { label: 'Any job type',                  override: { preferences: { preferredEmploymentTypes: [] } }, patch: { prefs: { preferred_employment_types: [] } } },
  excludeClearanceJobs:  { label: 'Show jobs that need clearance', override: { preferences: { excludeClearanceJobs: false } }, patch: { prefs: { exclude_clearance_jobs: false } } },
  excludedRoleFamilies:  { label: 'Unhide role categories',        override: { preferences: { excludedRoleFamilies: [] } }, patch: { prefs: { excluded_role_families: [] } } },
  needsSponsorship:      { label: 'Include jobs without sponsorship', override: { profile: { needsSponsorship: false } }, patch: { visa: false } },
  postedWithinDays:      { label: 'Look back 30 days',             override: { postedWithinDays: 30 }, patch: { posted: 30 } },
};

export function summarize(jobs) {
  const scores = jobs.map(j => j.matchScore).sort((a, b) => b - a);
  const strong = scores.filter(s => s >= STRONG).length;
  return { best: scores[0] ?? 0, median: scores[scores.length >> 1] ?? 0, strong };
}

export function verdict({ best, strong }, count) {
  if (!count) return 'EMPTY';
  if (strong >= 5) return 'GOOD';
  return strong ? 'THIN' : (best < 50 ? 'WEAK' : 'THIN');
}

// ponytail: scores the top 100 only (recommend's page cap); strong counts above 100 read as 100.
const run = (userId, base, extra = {}) => generateRecommendations(userId, { ...base, limit: 100, ...extra });

export async function assessFeedRelevance(userId, base = {}) {
  const feed = await run(userId, base);
  if (feed.zeroResultReason === 'NO_PROFILE') return { zeroResultReason: 'NO_PROFILE', verdict: 'EMPTY', top: [], counterfactuals: [] };
  const stats = summarize(feed.jobs);
  const out = {
    verdict: verdict(stats, feed.jobs.length), ...stats, total: feed.total,
    top: feed.jobs.slice(0, 6), zeroResultReason: feed.zeroResultReason ?? null,
    activeFilters: feed.activeFilters, appliedFilters: feed.appliedFilters, counterfactuals: [],
  };
  if (out.verdict === 'GOOD') return out;
  const keys = feed.activeFilters.filter(k => RELAXATIONS[k]);
  const runs = await Promise.all(keys.map(k => {
    const { override } = RELAXATIONS[k];
    const { preferences, profile, ...rest } = override;
    return run(userId, base, { preferencesOverride: preferences, profileOverride: profile && { profile }, ...rest });
  }));
  out.counterfactuals = keys.map((k, i) => ({ filter: k, label: RELAXATIONS[k].label, patch: RELAXATIONS[k].patch, total: runs[i].total, ...summarize(runs[i].jobs), top: runs[i].jobs.slice(0, 3).map(({ jobId, title, company, matchScore }) => ({ jobId, title, company, matchScore })) }))
    .filter(c => c.strong > out.strong || (out.strong === 0 && c.total > out.total))
    .sort((a, b) => b.strong - a.strong || b.best - a.best);
  return out;
}
