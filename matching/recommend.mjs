/**
 * matching/recommend.mjs
 *
 * Phase 18/19: bounded candidate generation + eligibility + scoring for
 * GET /users/:userId/recommendations. Funnel (spec's own example shape):
 *   active/READY jobs
 *   -> exclude SKIP/HIDE/APPLY interactions
 *   -> SQL-level hard filters (sponsorship, employment type, excluded
 *      companies/role families, clearance, max experience, salary floor,
 *      role-family narrowing) — cheap, coarse, no per-row JS needed
 *   -> bounded candidate set (ORDER BY discovered DESC LIMIT candidatePoolSize)
 *   -> build job contracts, run full evaluateEligibility (catches anything
 *      SQL couldn't express cleanly — citizenship, country/multi-location,
 *      the fine-grained salary-hard-constraint edge cases)
 *   -> score eligible candidates, sort, paginate
 */
import { cached } from '../lib/stale-cache.mjs';
import { query } from '../lib/db.mjs';
import { normalizeTitle } from '../lib/normalize.mjs';
import { buildJobContracts } from './job-contract.mjs';
import { evaluateEligibility } from './eligibility.mjs';
import { computeFinalScore } from './final-score.mjs';
import { evaluateProfileCompleteness } from './profile-completeness.mjs';
import { FAMILY_ADJACENCY } from './role-score.mjs';
import {
  buildKeywordSql, classifyKeywordMatch, rebaseScore, describeKeywordMatch,
  keywordSearchWarnings, summarizeKeywordSearch,
} from './keyword-search.mjs';

const CANDIDATE_POOL_SIZE = 1500; // was 600/2000: with the date index and the country rule in SQL, 1500 costs ~1s cold

export async function loadUserContext(userId) {
  const { rows: profileRows } = await query(
    `SELECT p.id, p.current_title, p.total_experience_years, p.highest_education_level,
            p.current_city, p.current_state, p.current_country, p.work_authorization, p.needs_sponsorship,
            pref.preferred_workplace_types, pref.preferred_employment_types, pref.preferred_states, pref.preferred_cities,
            pref.remote_only, pref.min_salary, pref.salary_is_hard_constraint, pref.max_experience_required,
            pref.exclude_clearance_jobs, pref.excluded_companies, pref.excluded_role_families, pref.allowed_countries
       FROM user_profiles p LEFT JOIN user_profile_preferences pref ON pref.user_profile_id = p.id
      WHERE p.user_id = $1`, [userId]
  );
  if (!profileRows.length) return null;
  const row = profileRows[0];

  const [{ rows: targetRoleRows }, { rows: skillRows }] = await Promise.all([
    query(`SELECT canonical_role, role_family, priority FROM user_target_roles WHERE user_profile_id = $1 ORDER BY priority`, [row.id]),
    query(`SELECT s.normalized_name FROM user_skills us JOIN skills s ON s.id = us.skill_id WHERE us.user_profile_id = $1`, [row.id]),
  ]);
  // RANK-001 fix: scoreRole()/relevantRoleFamilies() read camelCase
  // (canonicalRole/roleFamily) — passing the raw pg snake_case rows through
  // silently made role.canonicalRole/roleFamily undefined on every call,
  // which made role-score fall through to its UNRELATED branch (10) for
  // every job regardless of actual fit. Found via rank-diagnostics.mjs: the
  // role component averaged 10.0 across every label, including EXCELLENT.
  const targetRoles = targetRoleRows.map(r => ({ canonicalRole: r.canonical_role, roleFamily: r.role_family, priority: r.priority }));

  return {
    profile: {
      currentTitle: row.current_title,
      totalExperienceYears: row.total_experience_years, highestEducationLevel: row.highest_education_level,
      currentCity: row.current_city, currentState: row.current_state, currentCountry: row.current_country,
      workAuthorization: row.work_authorization, needsSponsorship: row.needs_sponsorship,
      clearanceEligible: null, // not yet a stored field — see docs/profile-recommendation-model.md's known limitations
    },
    preferences: {
      remoteOnly: row.remote_only ?? false, preferredEmploymentTypes: row.preferred_employment_types ?? [],
      preferredWorkplaceTypes: row.preferred_workplace_types ?? [], excludeClearanceJobs: row.exclude_clearance_jobs ?? false,
      excludedCompanies: row.excluded_companies ?? [], excludedRoleFamilies: row.excluded_role_families ?? [],
      allowedCountries: row.allowed_countries ?? [], maxExperienceRequired: row.max_experience_required,
      minSalary: row.min_salary, salaryIsHardConstraint: row.salary_is_hard_constraint ?? false,
      preferredStates: row.preferred_states ?? [], preferredCities: row.preferred_cities ?? [],
    },
    targetRoles,
    userSkillNames: skillRows.map(r => r.normalized_name),
    completeness: evaluateProfileCompleteness(
      { currentTitle: row.current_title, totalExperienceYears: row.total_experience_years, highestEducationLevel: row.highest_education_level },
      targetRoles, skillRows, { currentCountry: row.current_country }
    ),
  };
}

function relevantRoleFamilies(targetRoles) {
  const families = new Set();
  for (const t of targetRoles) {
    const family = t.roleFamily;
    if (!family) continue;
    families.add(family);
    for (const related of Object.keys(FAMILY_ADJACENCY[family] || {})) families.add(related);
  }
  return [...families];
}

/**
 * Builds the WHERE clause for the candidate pool. Also returns which filters
 * were applied (machine-readable `activeFilters` + human-readable `appliedFilters`)
 * so an empty result can say WHY it's empty instead of just returning [].
 */
function buildCandidateFilters(userId, ctx, options) {
  const conditions = [`j.status = 'READY'`, `j.active = TRUE`];
  const params = [];
  const activeFilters = [];
  const appliedFilters = [];
  const note = (key, text) => { activeFilters.push(key); appliedFilters.push(text); };
  const ks = options.keywordSearch;

  conditions.push(`NOT EXISTS (
    SELECT 1 FROM user_job_interactions i
     WHERE i.user_id = $${params.push(userId)} AND i.job_id = j.id AND i.interaction_type IN ('SKIP','HIDE','APPLY')
  )`);

  if (ctx.profile.needsSponsorship === true) {
    conditions.push(`j.sponsorship_status != 'NO_SPONSORSHIP'`);
    note('needsSponsorship', 'Visa: hides jobs that say they don\'t sponsor');
  }
  if (ctx.preferences.preferredEmploymentTypes.length) {
    params.push(ctx.preferences.preferredEmploymentTypes);
    conditions.push(`j.employment_type = ANY($${params.length}::text[])`);
    note('employmentTypes', `Employment type: ${ctx.preferences.preferredEmploymentTypes.join(', ')}`);
  }
  if (ctx.preferences.excludedCompanies.length) {
    params.push(ctx.preferences.excludedCompanies);
    conditions.push(`NOT (j.company = ANY($${params.length}::text[]))`);
    note('excludedCompanies', `Hidden companies: ${ctx.preferences.excludedCompanies.join(', ')}`);
  }
  if (ctx.preferences.excludedRoleFamilies.length) {
    params.push(ctx.preferences.excludedRoleFamilies);
    conditions.push(`NOT (j.role_family = ANY($${params.length}::text[]))`);
    note('excludedRoleFamilies', `Hidden role categories: ${ctx.preferences.excludedRoleFamilies.join(', ')}`);
  }
  if (ctx.preferences.allowedCountries?.length) {
    // same rule as evaluateEligibility's country check, in SQL: the pool is only the newest few hundred rows, so a
    // check that ran afterwards threw most of them away (a Europe-only profile kept ~90 jobs out of 270k)
    params.push(ctx.preferences.allowedCountries);
    const rel = `l.job_id = j.id AND l.country_code IS NOT NULL AND l.is_remote_restriction = (j.workplace_type = 'REMOTE')`;
    conditions.push(`(NOT EXISTS (SELECT 1 FROM job_locations l WHERE ${rel}) OR EXISTS (SELECT 1 FROM job_locations l WHERE ${rel} AND l.country_code = ANY($${params.length}::text[])))`);
    note('allowedCountries', `Countries: ${ctx.preferences.allowedCountries.join(', ')}`);
  }
  if (ctx.preferences.excludeClearanceJobs) {
    conditions.push(`j.clearance_type = 'NONE'`);
    note('excludeClearanceJobs', 'Hides jobs requiring a security clearance');
  }
  if (ctx.preferences.maxExperienceRequired != null) {
    params.push(ctx.preferences.maxExperienceRequired);
    conditions.push(`(j.min_exp_years IS NULL OR j.min_exp_years <= $${params.length})`);
    note('maxExperienceRequired', `Max years of experience: ${ctx.preferences.maxExperienceRequired}`);
  }
  if (ctx.preferences.salaryIsHardConstraint && ctx.preferences.minSalary != null) {
    params.push(ctx.preferences.minSalary);
    conditions.push(`(j.salary_max_annual IS NULL AND j.salary_min_annual IS NULL OR COALESCE(j.salary_max_annual, j.salary_min_annual) >= $${params.length})`);
    note('minSalary', `Minimum salary (hard): ${ctx.preferences.minSalary}`);
  }
  if (ctx.preferences.remoteOnly) {
    conditions.push(`j.workplace_type = 'REMOTE'`);
    note('remoteOnly', 'Workplace: remote only');
  }
  if (options.postedWithinDays) {
    params.push(Number(options.postedWithinDays));
    // the posting date when the board gives one, else when we found it (what the card shows). "posted OR found
    // recently" let a job posted 12 days ago through a 24-hour filter just because a new company brought it in today
    conditions.push(`COALESCE(j.posted_at, j.discovered) >= NOW() - ($${params.length} * interval '1 day')`); // same test as one expression so idx_jobs_ready_family_date serves it
    note('postedWithinDays', `Date posted: last ${Number(options.postedWithinDays)} days`);
  }
  // A title/title_description INCLUDE search looks across every job, not
  // just the role families near the profile — that's what lets a Java
  // profile search "react" and actually find React jobs. Exclude-only or
  // description-scope searches keep the normal profile narrowing.
  // Only a Titles search widens: description matches stay among the profile's role families (as Tsenta's "all"),
  // or "software engineer" in a description pulls in Head of Customer Deployments.
  const keywordWidensPool = ks?.include?.length > 0 && ks.scope === 'title';
  const families = keywordWidensPool ? [] : relevantRoleFamilies(ctx.targetRoles);
  if (families.length) {
    params.push(families);
    conditions.push(`(j.role_family = ANY($${params.length}::text[]) OR j.role_family IS NULL)`);
    note('roleFamilies', `Role category (from target roles): ${families.join(', ')}`);
  }
  const keyword = buildKeywordSql(ks, params);
  conditions.push(...keyword.conditions);
  if (ks?.include?.length) activeFilters.push('search');
  if (ks?.exclude?.length) activeFilters.push('excludeSearch');
  if (ks?.active) appliedFilters.push(summarizeKeywordSearch(ks));

  return { conditions, params, activeFilters, appliedFilters, semanticRoles: keyword.semanticRoles };
}

async function fetchCandidates(filters) {
  const { conditions, params } = filters;

  // DISTINCT ON (fingerprint) — found via live-data review: a company
  // sometimes posts the identical listing multiple times (same fingerprint/
  // content, different ATS req URLs), which without this would let one
  // popular posting occupy several slots in a user's top-10. This is a
  // pre-existing gap in the scanner's per-company change-detection
  // fingerprint (never meant to dedupe concurrent live duplicates), fixed
  // here rather than in the scanner since it only matters for what gets
  // shown, not what gets stored.
  const sql = `
    SELECT id FROM (
      SELECT DISTINCT ON (fingerprint) id, discovered FROM (
        SELECT j.id, j.fingerprint, j.discovered
          FROM jobs j WHERE ${conditions.join(' AND ')}
         ORDER BY j.discovered DESC LIMIT ${CANDIDATE_POOL_SIZE * 3}
      ) newest
       ORDER BY fingerprint, discovered DESC
    ) deduped ORDER BY discovered DESC LIMIT ${CANDIDATE_POOL_SIZE}`;
  // ponytail: dedupe runs over the newest 3x pool, not every match — sorting ~1M rows by fingerprint timed out at 30s; raise the multiplier if dupes ever starve the pool
  return candidateIds(JSON.stringify([sql, params]), sql, params);
}

// The candidate query is the heaviest one in the app. Reuse it for 5 min, and when the DB is too busy
// to answer (vacuum, scan writes) serve the last result for up to 24h instead of an error page.
const candidateIds = cached(async (_k, sql, params) => (await query(sql, params)).rows.map(r => r.id), { ttl: 300_000, maxAge: 24 * 3600_000, max: 100, name: 'candidates' });

/**
 * @param {string} userId
 * @param {{ limit?: number, cursor?: string, postedWithinDays?: number, strictEducation?: boolean,
 *           profileOverride?: { profile?: object, userSkillNames?: string[] },
 *           keywordSearch?: { include: string[], exclude: string[], scope: string, active: boolean, source?: 'request'|'saved' } }} options
 *   keywordSearch comes from normalizeKeywordSearch() (matching/keyword-search.mjs).
 */
export async function generateRecommendations(userId, options = {}) {
  const limit = Math.min(Number(options.limit) || 20, 100);
  const cursorOffset = options.cursor ? Number(options.cursor) || 0 : 0;

  const ctx = await loadUserContext(userId);
  if (!ctx) {
    return { jobs: [], total: 0, nextCursor: null, zeroResultReason: 'NO_PROFILE', profileWarnings: ['No profile found — create one via PUT /users/:userId/profile.'] };
  }

  // Auto-apply lanes score jobs against the lane's resume profile instead of
  // the default one (docs/auto-apply.md): its title, experience and skills.
  if (options.profileOverride) {
    const o = options.profileOverride;
    for (const [k, v] of Object.entries(o.profile || {})) if (v !== null && v !== undefined && v !== '') ctx.profile[k] = v;
    if (o.userSkillNames?.length) ctx.userSkillNames = o.userSkillNames;
  }
  // What-if runs (matching/relevance.mjs) relax one preference without saving it.
  if (options.preferencesOverride) Object.assign(ctx.preferences, options.preferencesOverride);
  const ks = options.keywordSearch?.active ? options.keywordSearch : null;
  const filters = buildCandidateFilters(userId, ctx, { ...options, keywordSearch: ks });
  const candidateIds = await fetchCandidates(filters);
  const contracts = await buildJobContracts(candidateIds);

  const scored = [];
  let ineligible = 0;
  for (const job of contracts) {
    const eligibility = evaluateEligibility(ctx.profile, ctx.preferences, job, { strictEducation: !!options.strictEducation });
    if (!eligibility.eligible) { ineligible++; continue; }
    const scoreResult = computeFinalScore(job, ctx.profile, ctx.preferences, ctx.targetRoles, ctx.userSkillNames, { postedAt: job.postedAt, discovered: job.discovered });
    const keywordMatch = ks ? classifyKeywordMatch(job, ks, filters.semanticRoles) : null;
    const finalScore = keywordMatch?.type ? rebaseScore(scoreResult, keywordMatch) : scoreResult.matchScore;
    scored.push({
      job, eligibility, scoreResult, keywordMatch, finalScore,
    });
  }

  scored.sort((a, b) => b.finalScore - a.finalScore || a.job.jobId.localeCompare(b.job.jobId));
  const grouped = groupOpenings(scored);
  const page = grouped.slice(cursorOffset, cursorOffset + limit);

  const result = {
    jobs: page.map(({ job, eligibility, scoreResult, keywordMatch, finalScore, siblings }) => ({
      jobId: job.jobId, title: job.title, company: job.company,
      url: job.url, locationText: job.locationText, locations: job.locations,
      workplace: job.workplace, employmentType: job.employmentType, seniority: job.seniority,
      roleFamily: job.roleFamily, canonicalRole: job.canonicalRole,
      salary: job.salary, experience: job.experience, sponsorship: job.sponsorship,
      skills: job.skills, postedAt: job.postedAt, discovered: job.discovered,
      matchScore: finalScore,
      siblings,
      ...(keywordMatch?.type ? {
        baseMatchScore: scoreResult.matchScore,
        scoreRebased: true,
        keywordMatch,
      } : {}),
      components: scoreResult.components,
      whyMatched: keywordMatch?.type ? [describeKeywordMatch(keywordMatch), ...scoreResult.whyMatched] : scoreResult.whyMatched,
      missingRequiredSkills: scoreResult.missingRequiredSkills,
      missingPreferredSkills: scoreResult.missingPreferredSkills,
      warnings: [...scoreResult.warnings, ...eligibility.warnings.map(w => w.reason), ...eligibility.unknowns.map(u => u.reason)],
    })),
    total: grouped.length,
    nextCursor: cursorOffset + limit < grouped.length ? String(cursorOffset + limit) : null,
    candidatePoolSize: candidateIds.length,
    keywordSearch: ks ? { include: ks.include, exclude: ks.exclude, scope: ks.scope, source: options.keywordSearch.source ?? 'request' } : null,
    activeFilters: filters.activeFilters,
    appliedFilters: filters.appliedFilters,
    searchWarnings: ks ? keywordSearchWarnings(ks) : [],
    profileWarnings: ctx.completeness.warnings,
    profileComplete: ctx.completeness.completeEnoughForRecommendations,
  };
  if (scored.length === 0) {
    result.zeroResultReason = await diagnoseZeroResults(ks, filters, candidateIds.length, ineligible);
  }
  return result;
}

/**
 * Openings grouping (docs/job-sourcing.md): the same company posting the same
 * title more than once — one req per city, or the same req behind two ATS
 * URLs — shows as ONE card with `siblings` instead of filling the top of the
 * feed with copies. Tsenta does the same with canonicalRoleKey
 * ("company|title") + siblings. The fingerprint DISTINCT ON in
 * fetchCandidates only catches byte-identical content; this catches the rest.
 * Input must already be sorted best-first: the best-scoring copy is kept.
 */
export function groupOpenings(sorted) {
  const groups = new Map();
  const out = [];
  for (const item of sorted) {
    const key = `${String(item.job.company || '').trim().toLowerCase()}|${normalizeTitle(item.job.title)}`;
    const lead = groups.get(key);
    if (lead) {
      lead.siblings.push({ jobId: item.job.jobId, url: item.job.url, locationText: item.job.locationText, matchScore: item.finalScore });
    } else {
      const entry = { ...item, siblings: [] };
      groups.set(key, entry);
      out.push(entry);
    }
  }
  return out;
}

/**
 * Why is the feed empty? Distinguishes "your keyword matches nothing at all"
 * (change the keyword) from "it matches, but your other filters remove
 * everything" (loosen a filter — activeFilters says which ones applied).
 */
async function diagnoseZeroResults(ks, filters, candidateCount, ineligibleCount) {
  if (ks?.include?.length) {
    const params = [];
    const { conditions } = buildKeywordSql({ ...ks, exclude: [] }, params);
    const { rows } = await query(
      `SELECT 1 FROM jobs j WHERE j.status = 'READY' AND j.active = TRUE AND ${conditions.join(' AND ')} LIMIT 1`, params
    );
    if (!rows.length) return 'NO_MATCHING_JOBS';
  }
  if (candidateCount > 0 && ineligibleCount === candidateCount) return 'NOT_ELIGIBLE';
  return filters.activeFilters.length ? 'FILTERS_NARROW' : 'NO_MATCHING_JOBS';
}

/**
 * Full match explanation for one job (job detail panel): the same
 * eligibility + scoring the feed uses, plus the job's description, so the
 * detail view never disagrees with the score shown on the card. An active
 * keyword search is not applied here — the detail view shows the profile
 * match itself.
 */
export async function explainJobMatch(userId, jobId) {
  const [{ rows: jobRows }, contracts] = await Promise.all([
    query(`SELECT id, description_clean, display_title, status, active FROM jobs WHERE id = $1`, [jobId]),
    buildJobContracts([jobId]),
  ]);
  if (!jobRows.length || !contracts.length) return null;
  const job = contracts[0];
  const base = {
    job: { ...job, description: jobRows[0].description_clean, active: jobRows[0].active },
  };
  const ctx = await loadUserContext(userId);
  if (!ctx) return { ...base, match: null, profileWarnings: ['No profile found — create one via PUT /users/:userId/profile.'] };
  const eligibility = evaluateEligibility(ctx.profile, ctx.preferences, job, {});
  const score = computeFinalScore(job, ctx.profile, ctx.preferences, ctx.targetRoles, ctx.userSkillNames, { postedAt: job.postedAt, discovered: job.discovered });
  const { rows: appRows } = await query(
    `SELECT id, status, applied_at, updated_at FROM applications WHERE user_id = $1 AND job_id = $2 ORDER BY updated_at DESC LIMIT 1`, [userId, jobId]
  );
  return {
    ...base,
    match: {
      matchScore: score.matchScore, components: score.components, roleMatchType: score.roleMatchType,
      whyMatched: score.whyMatched, missingRequiredSkills: score.missingRequiredSkills,
      missingPreferredSkills: score.missingPreferredSkills,
      eligible: eligibility.eligible,
      blockers: eligibility.hardRejectReasons.map(b => b.reason ?? b),
      warnings: [...score.warnings, ...eligibility.warnings.map(w => w.reason), ...eligibility.unknowns.map(u => u.reason)],
    },
    application: appRows[0] ?? null,
  };
}
