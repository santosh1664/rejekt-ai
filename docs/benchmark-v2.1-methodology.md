# Benchmark v2.1 methodology

Fixes benchmark-v2's one known design flaw without touching v2 itself
(`fixtures/benchmark-v2/`, `evaluation/benchmark-v2-baseline.json`,
`docs/benchmark-v2-methodology.md` are all preserved unchanged).
`fixtures/benchmark-v2.1/` + `scripts/build-benchmark-v2.1.mjs` /
`scripts/evaluate-recommendations-v2.1.mjs`.

## The v2 issue

v2's quality buckets (A/B/C/D/E/F/G/I) were sampled purely on role/seniority/
skill criteria and then, separately, given the profile's two deliberate hard
constraints (`salaryIsHardConstraint`, `preferredEmploymentTypes=['FULL_TIME']`)
for bucket H's sake. Nothing stopped a quality-bucket job from *also*
violating those same constraints (an internship, a contract role, a job
below the salary floor) — v2's own methodology doc flagged this
post-hoc as a ~0.29 "quality-sample eligibility exclusion rate" on dev,
verified as benchmark contamination, not an engine defect (bucket H's
dedicated hard-ineligible jobs were still rejected 11/11 dev, 7/7 holdout).
The exclusion rate mixed two different things into one number: ranking
quality and eligibility-engine behavior.

## The v2.1 fix

Every quality-bucket (A/B/C/D/E/F/G/I) candidate is now passed through the
real `matching/eligibility.mjs::evaluateEligibility()` — the exact function
the production recommendation pipeline calls — at build time, before it's
allowed into the fixture. Ineligible candidates are dropped and the bucket's
query is re-run with a widened `LIMIT` (excluding already-seen ids) until
either the bucket's target count is reached or the bucket's own query is
exhausted; a profile-level top-up (more target-canonical-role jobs, same
filter) makes up any remaining shortfall against the 30-job floor. No
eligibility rule was duplicated in SQL — the actual shared helper is
imported and called directly (spec Step 3).

Bucket H is untouched: still sampled to be deliberately hard-ineligible
(salary below floor, or non-full-time employment type), and explicitly
**not** eligibility-filtered — filtering it would remove every job by
construction.

Every label file entry now carries a `set: 'quality' | 'eligibility'` field
(replacing v2's implicit `label === 'HARD_INELIGIBLE'` convention, though
that label string is also kept for bucket H entries) so the two tracks
never need to be inferred from the label.

## Sampling, labeling rubric — unchanged from v2

`roleFitTier`/`seniorityGapTier`/`skillOverlapTier` and `decideLabel()`
are copied verbatim from `scripts/build-benchmark-v2.mjs` (spec Step 7:
preserve the rubric unless a bug is found; none was). Labels remain
EXCELLENT/GOOD/BORDERLINE/BAD, computed only from structured job metadata
(`canonical_role`, `role_family`, `seniority_level`, `job_skills`) —
never from `matching/role-score.mjs` or `matching/final-score.mjs` output
(spec Step 8). Same 9 profiles, same targets, same skills — reused
directly from `fixtures/benchmark-v2/profiles.json`.

## Profile hard-constraint audit (spec Step 6)

All 9 profiles carry exactly two intentional hard constraints, added in v2
specifically to make bucket H's hard-reject validation real:

| Profile | minSalary (hard) | preferredEmploymentTypes | sponsorship | citizenship/clearance |
|---|---|---|---|---|
| Entry SWE | $70,000 | FULL_TIME | needsSponsorship=false | none set |
| Mid SWE | $120,000 | FULL_TIME | needsSponsorship=false | none set |
| Backend Java | $140,000 | FULL_TIME | needsSponsorship=false | none set |
| Data Engineer | $110,000 | FULL_TIME | needsSponsorship=false | none set |
| Senior Data Engineer | $160,000 | FULL_TIME | needsSponsorship=false | none set |
| ML Engineer | $150,000 | FULL_TIME | needsSponsorship=false | none set |
| QA Automation | $90,000 | FULL_TIME | needsSponsorship=false | none set |
| DevOps/SRE | $130,000 | FULL_TIME | needsSponsorship=false | none set |
| Data Analyst | $75,000 | FULL_TIME | needsSponsorship=false | none set |

No `allowedCountries`, `excludeClearanceJobs`, `maxExperienceRequired`,
`excludedCompanies`, or `excludedRoleFamilies` are set on any profile — all
9 profiles are US-citizen, no-sponsorship-needed by design (consistent with
the legacy fixture they're derived from), so citizenship/sponsorship/
clearance hard-rejects are exercised only incidentally by whatever real job
postings happen to carry those requirements, never by a deliberately-added
constraint. This is intentional: v2/v2.1's engineered hard-reject coverage
targets salary floor + employment type specifically, the two dimensions
bucket H was built to exercise. No arbitrary constraint was added just to
inflate bucket H's difficulty.

## Result — every profile cleared the floor without a profile-level top-up

| Profile | Quality total | Quality eligible | Bucket H | H rejected |
|---|---|---|---|---|
| all 9 profiles | 34 | 34 (100%) | 2 | 2 (100%) |

34/profile is comfortably above the 30 target (spec Step 9) — each
bucket's own widening retry found enough eligible replacements without
needing the profile-level top-up. Holdout quality-job counts land at 10-12
per profile (spec Step 10's ≥10 target, met on all 9).

## Metrics — same machinery as v2, eligibility reporting corrected

Precision@5/10, Recall@10, NDCG@5/10, MRR, bad-match@5/10, max-precision@K
(spec Step 11), normalized-precision@K (spec Step 12), and candidate recall
(spec Step 13) are unchanged from `evaluate-recommendations-v2.mjs`.

Eligibility reporting (spec Step 5) replaces v2's single misleading
"eligibility violation rate" with four explicit numbers:
- **qualitySetEligibilityPassRate** — fraction of the quality set the
  engine still calls eligible at evaluation time. Expected 1.0 (the set
  was pre-filtered eligible at build time using the same function).
- **falseRejectRate** — quality-set jobs the engine wrongly calls
  ineligible. A non-zero value here would mean the build-time filter and
  eval-time check disagree (e.g. profile-seeding drift) — a real
  diagnostic signal, not expected noise.
- **hard-ineligible rejection accuracy** — bucket H jobs correctly
  rejected. The actual engine-correctness check.
- **falseAcceptRate** — bucket H jobs the engine wrongly calls eligible.

## Dev/holdout split — unchanged methodology from v2

Deterministic, full sorted job-id list per profile, every 3rd id →
holdout (~70/30). Not stratified by label — for a profile with very few
EXCELLENT/GOOD jobs, this can unevenly split the handful of relevant jobs
between dev and holdout by chance (see Entry SWE below), a known,
accepted trade-off carried over from v2 (methodology doc's own words:
"approximately stratified... while reliably hitting the size floor").

## Candidate-recall fix (found via spec Step 13's own diagnostic)

The first build of this fixture never filtered `active = TRUE` in any
bucket's sampling SQL — only `status = 'READY'`. Since this is a live,
continuously-scraped job board, some sampled "quality" jobs had already
gone inactive by the time of evaluation (confirmed: several had
`last_seen` days before the benchmark build itself, i.e. already stale at
sampling time) — real production candidate generation
(`matching/recommend.mjs`'s `fetchCandidates`) correctly excludes them,
which is exactly what it should do for a real user, but it meant ~30% of
labeled relevant jobs were never retrievable by construction. This is a
**benchmark-sampling gap, not a candidate-generation defect** — fixed by
adding `AND active = TRUE` to every bucket query in
`scripts/build-benchmark-v2.1.mjs` and rebuilding. All numbers in this
document and the final report are from the rebuilt fixture; candidate
recall is now 100% (71/71 dev, 30/30 holdout relevant jobs confirmed
retrievable) — up from ~70% on the first build.

## Known limitation

Entry Software Engineer's relevant-job count is small relative to other
profiles (7 dev / 2 holdout) — its P@5/P@10 move in bigger increments per
job than profiles with 8-11 relevant jobs. Not a ranking regression, just
a smaller labeled pool for this one profile; spec Step 23 explicitly says
not to optimize around it alone.
