import { query, closePool } from '../lib/db.mjs';
import { normalizeJob } from '../lib/normalize.mjs';

const BATCH = 250;

async function main() {
  let lastId = 0;
  let processed = 0;
  while (true) {
    const { rows } = await query(
      `SELECT id, title, company, location, remote, ats, category, raw
         FROM jobs WHERE id > $1 ORDER BY id LIMIT $2`, [lastId, BATCH]
    );
    if (rows.length === 0) break;

    const normalized = rows.map(row => normalizeJob({
      title: row.title,
      company: row.company,
      location: row.location,
      remote: row.remote,
      raw: row.raw || {},
    }, row.category || 'other'));

    await query(
      `UPDATE jobs AS j SET
         display_title = u.display_title,
         normalized_title = u.normalized_title,
         canonical_role = u.canonical_role,
         role_family = u.role_family,
         description_clean = u.description_clean,
         workplace_type = CASE WHEN j.workplace_type IS NULL OR j.workplace_type = 'UNKNOWN' THEN u.workplace_type ELSE j.workplace_type END,
         min_exp_years = COALESCE(j.min_exp_years, u.min_exp_years),
         max_exp_years = COALESCE(j.max_exp_years, u.max_exp_years),
         salary_min_annual = COALESCE(j.salary_min_annual, u.salary_min_annual),
         salary_max_annual = COALESCE(j.salary_max_annual, u.salary_max_annual),
         salary_currency = COALESCE(j.salary_currency, u.salary_currency),
         sponsorship_status = CASE WHEN j.sponsorship_status IS NULL OR j.sponsorship_status = 'NOT_MENTIONED' THEN u.sponsorship_status ELSE j.sponsorship_status END,
         employment_type = CASE WHEN j.employment_type IS NULL OR j.employment_type = 'UNKNOWN' THEN u.employment_type ELSE j.employment_type END
        FROM UNNEST(
          $1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
          $7::text[], $8::smallint[], $9::smallint[], $10::integer[], $11::integer[],
          $12::text[], $13::text[], $14::text[]
        ) AS u(id, display_title, normalized_title, canonical_role, role_family, description_clean,
               workplace_type, min_exp_years, max_exp_years, salary_min_annual, salary_max_annual,
               salary_currency, sponsorship_status, employment_type)
       WHERE j.id = u.id`, [
        rows.map(row => row.id),
        normalized.map(item => item.displayTitle),
        normalized.map(item => item.normalizedTitle),
        normalized.map(item => item.canonicalRole),
        normalized.map(item => item.roleFamily),
        normalized.map(item => item.descriptionClean),
        normalized.map(item => item.workplaceType),
        normalized.map(item => item.fields.minExpYears == null ? null : Math.round(item.fields.minExpYears)),
        normalized.map(item => item.fields.maxExpYears == null ? null : Math.round(item.fields.maxExpYears)),
        normalized.map(item => item.fields.salaryMinAnnual),
        normalized.map(item => item.fields.salaryMaxAnnual),
        normalized.map(item => item.fields.salaryCurrency),
        normalized.map(item => item.fields.sponsorshipStatus),
        normalized.map(item => item.fields.employmentType),
      ]
    );

    lastId = rows[rows.length - 1].id;
    processed += rows.length;
    if (processed % 2500 === 0) console.error(`Backfilled ${processed.toLocaleString()} jobs`);
  }
  console.error(`Canonical backfill complete: ${processed.toLocaleString()} jobs`);
}

main().catch(error => { console.error('Backfill failed:', error.message); process.exitCode = 1; }).finally(() => closePool());
