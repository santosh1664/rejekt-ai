/**
 * matching/job-contract.mjs
 *
 * The one structured object the recommendation/eligibility layer consumes.
 * Nothing downstream should query jobs/job_locations/job_skills ad hoc —
 * build a JobContract here once and pass it around (spec Step 17: "Do not
 * make matching code reach directly into many unrelated DB columns").
 *
 * @typedef {Object} JobContract
 * @property {string} jobId
 * @property {string} title
 * @property {string} company
 * @property {string|null} roleFamily
 * @property {string|null} canonicalRole
 * @property {string|null} roleSpecialization
 * @property {string} seniority
 * @property {{min: number|null, max: number|null, requirementType: string}} experience
 * @property {{level: string, requirement: string, equivalentExperienceAccepted: boolean}} education
 * @property {string} workplace
 * @property {Array<{city: string|null, stateCode: string|null, countryCode: string|null, isRemoteRestriction: boolean, region: string|null}>} locations
 * @property {string} sponsorship
 * @property {string|null} citizenshipRequirement
 * @property {boolean} itarRelated
 * @property {{type: string, requirement: string}} clearance
 * @property {string} employmentType
 * @property {{minRaw: number|null, maxRaw: number|null, period: string|null, minAnnual: number|null, maxAnnual: number|null, currency: string|null}} salary
 * @property {{required: string[], preferred: string[], mentioned: string[]}} skills
 * @property {string|null} postedAt
 * @property {string} discovered
 * @property {string} url
 * @property {string|null} locationText - raw location string as scraped, for display
 */

import { query } from '../lib/db.mjs';

/** Builds JobContract objects for the given job ids in one batched round trip (no N+1). */
export async function buildJobContracts(jobIds) {
  if (jobIds.length === 0) return [];

  const { rows: jobs } = await query(
    `SELECT id, title, company, role_family, canonical_role, role_specialization, seniority_level,
            min_exp_years, max_exp_years, experience_requirement_type,
            education_level, education_requirement, education_equivalent_experience,
            workplace_type, sponsorship_status, citizenship_requirement, itar_related,
            clearance_type, clearance_requirement, employment_type,
            salary_min_raw, salary_max_raw, salary_period, salary_min_annual, salary_max_annual, salary_currency,
            posted_at, discovered, url, location, remote
       FROM jobs WHERE id = ANY($1::bigint[])`,
    [jobIds]
  );

  const { rows: locationRows } = await query(
    `SELECT job_id, city, state_code, country_code, is_remote_restriction, region
       FROM job_locations WHERE job_id = ANY($1::bigint[])`,
    [jobIds]
  );
  const locationsByJob = new Map();
  for (const row of locationRows) {
    if (!locationsByJob.has(row.job_id)) locationsByJob.set(row.job_id, []);
    locationsByJob.get(row.job_id).push({
      city: row.city, stateCode: row.state_code, countryCode: row.country_code,
      isRemoteRestriction: row.is_remote_restriction, region: row.region,
    });
  }

  const { rows: skillRows } = await query(
    `SELECT js.job_id, s.canonical_name, js.importance
       FROM job_skills js JOIN skills s ON s.id = js.skill_id
      WHERE js.job_id = ANY($1::bigint[])`,
    [jobIds]
  );
  const skillsByJob = new Map();
  for (const row of skillRows) {
    if (!skillsByJob.has(row.job_id)) skillsByJob.set(row.job_id, { required: [], preferred: [], mentioned: [] });
    const bucket = row.importance === 'REQUIRED' ? 'required' : row.importance === 'PREFERRED' ? 'preferred' : 'mentioned';
    skillsByJob.get(row.job_id)[bucket].push(row.canonical_name);
  }

  return jobs.map(job => ({
    jobId: String(job.id),
    title: job.title,
    company: job.company,
    roleFamily: job.role_family,
    canonicalRole: job.canonical_role,
    roleSpecialization: job.role_specialization,
    seniority: job.seniority_level,
    experience: { min: job.min_exp_years, max: job.max_exp_years, requirementType: job.experience_requirement_type },
    education: { level: job.education_level, requirement: job.education_requirement, equivalentExperienceAccepted: job.education_equivalent_experience },
    workplace: job.workplace_type,
    locations: locationsByJob.get(job.id) || [],
    sponsorship: job.sponsorship_status,
    citizenshipRequirement: job.citizenship_requirement,
    itarRelated: job.itar_related,
    clearance: { type: job.clearance_type, requirement: job.clearance_requirement },
    employmentType: job.employment_type,
    salary: {
      minRaw: job.salary_min_raw, maxRaw: job.salary_max_raw, period: job.salary_period,
      minAnnual: job.salary_min_annual, maxAnnual: job.salary_max_annual, currency: job.salary_currency,
    },
    skills: skillsByJob.get(job.id) || { required: [], preferred: [], mentioned: [] },
    postedAt: job.posted_at,
    discovered: job.discovered,
    url: job.url,
    locationText: job.location,
  }));
}
