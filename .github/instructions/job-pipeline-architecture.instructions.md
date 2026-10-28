---
name: "Job Pipeline Architecture"
description: "Use when changing the job ingestion pipeline, PostgreSQL schema, normalization, classification, enrichment, deduplication, search, matching, ranking, or job API. Apply this instruction incrementally to evolve the existing job-discovery SaaS into a structured recommendation platform."
applyTo: ["db/**", "lib/**", "scanner/**", "freshness/**", "matching/**", "api/**", "ml/**", "providers/**", "scripts/**", "docs/**"]
---

# Job Pipeline Architecture

## Core rule

Never treat the raw ATS description as the user-facing searchable record. Preserve raw source data, transform it into a clean structured job record, and expose only validated searchable records through the API.

Target flow:

```text
ATS sources
  -> raw capture
  -> normalization
  -> deduplication
  -> classification and enrichment
  -> canonical jobs
  -> search index and embeddings
  -> hard eligibility filters
  -> matching
  -> ranking
  -> explainable personalized feed
```

## Existing-system constraints

- Preserve the current `jobs` table and existing records. Migrate incrementally; do not replace or drop the table.
- Preserve `jobs.raw` as the original ATS payload. Never overwrite raw source data with cleaned or inferred values.
- Keep existing provider adapters and scanner behavior working while new fields are introduced.
- Use PostgreSQL migrations through the repository migration workflow. Every schema change must be repeatable with `IF NOT EXISTS` or an explicit migration guard.
- Do not invent salary, sponsorship, experience, education, location, or skill values. Unknown data must remain `NULL`, `UNKNOWN`, or an equivalent explicit state.
- Keep classification and extraction provenance, confidence, and version so results can be reprocessed later.
- Keep public API queries restricted to active, ready records unless an endpoint explicitly requests historical or failed records.

## Required implementation workflow

Complete phases in order. After finishing one phase, run its focused validation, record the result, and immediately continue to the next phase unless a real blocker requires user input. Do not stop at a plan when the next implementation step is clear.

For every phase:

1. Inspect the current schema and call sites before editing.
2. Write or update the migration and code for the smallest coherent slice.
3. Backfill existing records where the new field can be derived safely.
4. Add focused tests or executable checks for the new behavior.
5. Run the check before moving on.
6. Update the relevant documentation and note any remaining data-quality limitations.

## Phase 1: Establish raw and canonical boundaries

- Treat the current `jobs.raw` JSONB as the raw payload during migration.
- Add a dedicated raw-posting layer only when it can be introduced without breaking current `jobs` references. It should preserve source, external job ID, source URL, raw title, raw location, raw description, raw salary, payload JSON, content hash, first seen, last seen, scrape time, and status.
- Define `jobs` as the canonical searchable representation.
- Add or reconcile canonical fields such as `display_title`, `canonical_title`, `role_family`, `role_specialization`, `status`, `description_clean`, `updated_at`, and `canonical_key`.
- Make `description` and all fields currently written by code part of the main schema or a documented migration chain. A fresh database must be reproducible.

## Phase 2: Make ingestion and upserts correct

- Normalize provider output before persistence.
- Keep source identifiers, apply URLs, ATS type, and external requisition IDs.
- On an existing URL, refresh mutable source fields and enrichment inputs when the source content changes.
- Do not use only `title + company` as the final deduplication rule. Use source URL, ATS requisition ID, company, normalized title, location, and description similarity as available.
- Preserve legitimate separate requisitions for the same company and title.
- Keep soft expiration. Do not delete jobs that disappear from an ATS.
- Ensure fingerprint and content-hash semantics distinguish title changes from description-only changes.

## Phase 3: Add controlled taxonomy and title normalization

- Keep display title exactly as collected for the user.
- Derive a canonical title separately, for example `Data Engineer` from `Senior Data Engineer II - Cloud Data Platform`.
- Replace free-form category drift with a controlled taxonomy. Initial role families should remain manageable:

```text
SOFTWARE_ENGINEERING
DATA_ENGINEERING
DATA_SCIENCE
MACHINE_LEARNING
DEVOPS_SRE
QA_TEST_AUTOMATION
CYBERSECURITY
CLOUD_INFRASTRUCTURE
PRODUCT
DESIGN
ANALYTICS
FINANCE
MARKETING
SALES
OPERATIONS
OTHER
```

- Preserve `category_source`, classifier version, confidence, and processing timestamp.
- Keep the current keyword classifier as a deterministic fallback while ML classification is unavailable.
- Use ML classification as enrichment, not as the only source of truth.

## Phase 4: Normalize locations and work arrangements

- Replace string-only location matching with structured location data: country code, state code, city, metro area, latitude, and longitude where available.
- Support multiple locations through a `job_locations` table rather than comma-packed text.
- Keep `workplace_type` separate from location and normalize it to `REMOTE`, `HYBRID`, `ONSITE`, `FLEXIBLE`, or `UNKNOWN`.
- Preserve the existing `remote` field during migration for compatibility.
- Do not infer a precise city or radius when the source does not support it.

## Phase 5: Extract structured eligibility fields

Add and populate fields for:

- `employment_type`: `FULL_TIME`, `PART_TIME`, `CONTRACT`, `INTERNSHIP`, `TEMPORARY`, `COOP`, or `UNKNOWN`.
- `career_level`: `INTERN`, `ENTRY`, `JUNIOR`, `MID`, `SENIOR`, `STAFF`, `PRINCIPAL`, `LEAD`, `MANAGER`, `DIRECTOR`, `EXECUTIVE`, or `UNKNOWN`.
- `experience_min` and `experience_max` as nullable numeric values.
- `education_level` and degree requirement details.
- `sponsorship_status`: `SPONSORS`, `NO_SPONSORSHIP`, `MAY_SPONSOR`, or `UNKNOWN`.
- `clearance_required` as an explicit nullable or tri-state value.
- salary minimum, maximum, currency, and period.

Use title, description sections, and explicit requirement language together. Missing sponsorship language means `UNKNOWN`, not `NO_SPONSORSHIP`. Never treat a missing experience requirement as zero years.

## Phase 6: Make skills first-class data

- Create canonical `skills`, `skill_aliases`, and `job_skills` tables.
- Store canonical skill, alias normalization, required versus preferred importance, extraction source, and confidence.
- Normalize aliases such as `Postgres` and `PostgreSQL`, `K8s` and `Kubernetes`, and `JS` and `JavaScript`.
- Do not treat every technology mentioned in a description as required.
- Keep a simple `skill_tags` compatibility field only if existing API consumers need it; use relational skill data for matching.

## Phase 7: Introduce processing states and asynchronous enrichment

Use explicit job processing states such as:

```text
RAW
NORMALIZING
ENRICHING
READY
FAILED
EXPIRED
ARCHIVED
```

- The scanner should save raw data quickly and enqueue or run enrichment separately.
- The public API should normally return only `READY` and active jobs.
- Record failures and retry metadata in a processing log.
- Enrichment must be rerunnable by version so improved extractors can reprocess the existing corpus.
- Keep a quality dashboard or queries for field completeness and extraction failure rates.

## Phase 8: Improve search storage

- Keep PostgreSQL full-text search over clean title, company, summary, requirements, and clean description.
- Do not send an LLM request for ordinary filters or every search request.
- Add structured indexes based on actual filters: status and posted date, role family, location, workplace type, employment type, experience, salary, sponsorship, and active state.
- Add vector storage only after the structured search and hard filters work. Embed role, skills, summary, and requirements rather than blindly embedding the entire raw description.

## Phase 9: Build structured user profiles

Add profile data for:

- desired roles and role families
- canonical skills and proficiency evidence
- years of experience
- education
- preferred and excluded locations
- remote preference
- salary expectations
- employment types
- work authorization and sponsorship needs
- industry preferences
- excluded companies and roles

Separate hard constraints from soft preferences. Hard constraints filter; soft preferences affect ranking.

## Phase 10: Implement staged matching and ranking

Use this retrieval order:

```text
active and ready jobs
  -> hard eligibility filters
  -> role relevance
  -> location compatibility
  -> experience compatibility
  -> required and preferred skill match
  -> semantic similarity
  -> freshness
  -> user behavior
  -> final ranking
```

- Never allow vector similarity to override an obvious hard incompatibility.
- Required skills must matter more than preferred skills.
- Keep the initial score interpretable. A reasonable starting formula is:

```text
0.30 role match
+ 0.25 required skill match
+ 0.15 semantic similarity
+ 0.10 experience match
+ 0.08 location match
+ 0.07 freshness
+ 0.05 salary match
```

- Do not use one score for every sort mode. Search relevance, personalized match, newest, salary, and lowest experience are different orderings.
- Persist the score components or explanation data so the API can explain why a job matched.
- Show matched skills, missing preferred skills, experience comparison, location compatibility, salary compatibility, and sponsorship confidence.

## Phase 11: Evolve the API and UI contract

- Keep `/jobs` backward compatible while adding structured filters and explicit sort modes.
- Add separate search and recommendation behavior. Search should prioritize the query; recommendations should prioritize the user profile.
- Return canonical fields, structured locations, normalized workplace type, salary, eligibility fields, skills, freshness, and match explanation where available.
- Keep raw payload access restricted to detail or operator workflows, not ordinary list responses.
- Do not make the frontend wait for enrichment or AI processing.

## Phase 12: Reprocess and measure the existing corpus

For the existing job corpus:

1. Preserve current rows and raw payloads.
2. Add canonical fields and migrations.
3. Backfill safe deterministic fields.
4. Run versioned enrichment in batches.
5. Rebuild search indexes after enrichment.
6. Re-run deduplication as a report before deleting or merging anything.
7. Measure completeness, confidence, duplicate candidates, classifier accuracy, search latency, and match quality.
8. Only promote records to `READY` when required validation passes.

## Data and migration safety

- Never run destructive schema changes or merge/delete jobs automatically without an explicit review step.
- Prefer additive migrations and compatibility views during transitions.
- Use direct PostgreSQL migrations for schema changes and test them against a branch or staging database before production.
- Keep indexes aligned with query predicates and avoid duplicate indexes.
- Validate that every column referenced by application writes exists in the reproducible schema path.
- Preserve existing user alerts and job IDs when enriching or updating jobs.
- Do not mix unrelated refactors into pipeline migrations.

## Definition of done for each phase

A phase is complete only when:

- The schema and application code agree on column names and types.
- Existing records remain readable.
- New records follow the new path.
- A focused executable check passes.
- Reprocessing is safe to repeat.
- API behavior is documented.
- The next phase can begin without leaving a known migration inconsistency.
