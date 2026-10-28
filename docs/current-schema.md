# Current Database Schema Baseline

Captured: 2026-09-26

## Current model

The application currently uses PostgreSQL tables for:

- `companies`: ATS boards discovered and scheduled for scanning.
- `jobs`: one URL-keyed job record containing source fields, raw ATS JSON, classification, freshness state, and enrichment fields.
- `scan_runs`: scanner audit records.
- `user_preferences`: per-user matching preferences.
- `user_job_alerts`: persisted job matches and user alert state.

## `jobs` identity and lifecycle

- `id BIGSERIAL PRIMARY KEY`
- `url TEXT UNIQUE NOT NULL`
- `company_id` references `companies(id)` with `ON DELETE SET NULL`
- `active` is a soft-lifecycle flag; jobs are not deleted when they disappear.
- `missed_scans`, `last_seen`, and `closed_at` support freshness tracking.
- `fingerprint` is a 16-character hash of company plus normalized title.
- `title_fp` is a 16-character hash of normalized title for cross-listing analysis.

## Source and searchable fields

- `title`, `company`, `location`, `remote`, `ats`, `posted_at`
- `raw JSONB` preserves the full provider payload.
- `description TEXT` stores an extracted description.
- `description_hash` detects description-only content changes.
- Full-text and trigram indexes exist for title/company/description search.

## Classification and enrichment fields

- `category`, `category_source`
- `career_level`
- `min_exp_years`, `max_exp_years`
- `degree_required`
- `sponsorship_status`
- `employment_type`
- `workplace_type`
- `salary_min_annual`, `salary_max_annual`, `salary_currency`
- `skill_tags`
- `extraction_confidence`, `extraction_version`

These fields are currently additive to the legacy `jobs` table. They are not yet split into raw postings, canonical jobs, locations, skills, or classification audit tables.

## Current baseline counts

- Total jobs: 102,585
- Active jobs: 89,779
- Inactive jobs: 12,806
- Missing titles: 1
- Missing companies: 0
- Missing locations: 9
- Missing descriptions: 180
- Distinct URLs: 102,585
- Duplicate company/title rows: 18,012

## Current limitations

- The raw payload and canonical searchable record share one table.
- Source identity and canonical identity are not modeled separately.
- A company/title fingerprint is not sufficient to identify separate requisitions.
- Skills are not relational and do not encode required versus preferred importance.
- Classification history and evidence are not persisted in an audit table.
- `active` is used instead of a richer processing/status lifecycle.
