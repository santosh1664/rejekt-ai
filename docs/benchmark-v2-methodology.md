# Benchmark v2 methodology

Replaces the legacy `fixtures/benchmark-profiles.json` fixture (kept as a
regression fixture, not deleted — see "Legacy benchmark" below) with a
larger, independently-sampled benchmark specifically built so P@10,
bad-match rate, candidate recall, and top-10 membership changes are all
mathematically capable of moving. `fixtures/benchmark-v2/` and
`scripts/build-benchmark-v2.mjs`/`scripts/evaluate-recommendations-v2.mjs`.

## Legacy benchmark limitations (why v2 exists)

`fixtures/benchmark-profiles.json` + `fixtures/benchmark-labels/*.json` +
`fixtures/benchmark-split.json` labeled exactly 15 jobs per profile (10
dev / 5 holdout). Since `evaluate-recommendations.mjs`'s `precisionAt(labels,
10)` and `badMatchRate` both slice to the first 10 ranked labels, and the
dev closed-set *is* exactly 10 jobs, that slice always returns the entire
labeled set regardless of ranking order — **P@10 and bad-match rate were
mathematically invariant to reranking on dev**, and P@5/P@10 were *both*
invariant on holdout (5 labeled jobs, any slice ≥5 returns the full set).
This was discovered during the post-classification ranking calibration
phase and fully explains "P@10 stubbornly flat at 0.211" across every prior
phase of this project. Separately, the QA Automation Engineer fixture had
zero GOOD/EXCELLENT labels at all, making its P@5/P@10 mathematically 0
regardless of ranking quality. **The legacy fixture is preserved as-is** —
still useful as a small regression check (`scripts/evaluate-recommendations.mjs`
still works against it unchanged) — but is no longer the basis for ranking
quality claims going forward.

## New benchmark size

9 profiles (same core set as legacy — see below), ~30-35 labeled jobs each
(target: 30 minimum, stratified sampling naturally lands slightly above
that on most profiles), ~70/30 dev/holdout split. Every profile has dev
≥20 and holdout ≥8 (most reach the ≥10 holdout target; see LABEL
DISTRIBUTION in the final report for exact per-profile counts) — both well
above K=5/K=10, so P@5/P@10/bad-match/NDCG/Recall@10/MRR can all move.

## Core profiles (unchanged from legacy — spec Step 3)

Entry Software Engineer, Mid Software Engineer, Backend Java Engineer,
Data Engineer, Senior Data Engineer, ML Engineer, QA Automation Engineer,
DevOps/SRE Engineer, Data Analyst. Same user-profile definitions (title,
experience, skills, preferences) as the legacy fixture — only the labeled
*job* set is new. v2 adds two real, testable hard-eligibility preferences
to every profile (spec Step 9): `salaryIsHardConstraint: true` and
`preferredEmploymentTypes: ['FULL_TIME']` — deliberate additions to enable
genuine hard-reject validation, not a ranking change.

## Sampling method (spec Step 4) — independent of current ranking

For each profile, `scripts/build-benchmark-v2.mjs` runs 9 separate,
stratified SQL queries — never touching `matching/role-score.mjs` or
`matching/final-score.mjs`, so sampling cannot be biased toward jobs the
current model already ranks highly:

| Bucket | Selection criterion |
|---|---|
| A. obvious target-role | `canonical_role` = the profile's target canonical role (title-pattern search for QA Automation — see below) |
| B. adjacent-role | same family, `lib/role-taxonomy.mjs`'s `roleAdjacency() >= 0.55` to the target |
| C. same-family wrong specialization | same family, a real canonical role, but no meaningful adjacency to the target |
| D. unrelated + overlapping skills | different family, but `job_skills` overlaps the profile's own skill list |
| E. seniority mismatch | same family, `seniority_level` far from the profile's expected band (entry profiles → STAFF/PRINCIPAL/DIRECTOR/EXECUTIVE postings; senior profiles → ENTRY/JUNIOR postings) |
| F. location/salary attractive, role-wrong | different family, `workplace_type=REMOTE` and `salary_max_annual > 150000` |
| G. low-signal/ambiguous | `role_family='OTHER'` or `canonical_role IS NULL`, loosely engineer-titled |
| H. hard-ineligible | `salary_max_annual` below the profile's stated minimum, or non-FULL_TIME employment type — for eligibility validation only, never quality-labeled |
| I. random eligible | broad random sample, weighted toward the target family |

A deterministic per-profile `setseed()` (hashed from the profile id) makes
every build run reproducible. A top-up step pads any profile that lands
under 30 total (narrow buckets like F/B can legitimately return fewer than
requested in a single corpus slice) with additional target-canonical-role
jobs rather than leaving it under the floor.

## QA Automation fix (spec Step 6)

Bucket A used an explicit title-pattern search (`QA Automation Engineer`,
`SDET`, `Software Test Engineer`, `Test Automation Engineer`, `Automation
QA Engineer`, `API Test Engineer`, `Selenium Engineer`, `Playwright
Automation Engineer`) instead of a `canonical_role` equality check, since
real QA roles benefit from direct title evidence. Bucket C used the
spec-named confusing negatives directly (`Manufacturing Quality Engineer`,
`Electrical Test Engineer`, `Systems Test Engineer`, `Industrial Automation
Engineer`, `Validation Engineer`, `Hardware Test Engineer`). Result: GOOD=7,
EXCELLENT=1 in the full labeled set (was 0/0 in the legacy fixture) — the
profile can now measure real precision.

## Labeling rubric (spec Step 7) — written before labeling, applied deterministically

Labels are computed from **structured job metadata only**
(`canonical_role`, `role_family`, `seniority_level`, `job_skills`) — never
from `matching/role-score.mjs`'s or `matching/final-score.mjs`'s computed
scores. Three tiers, each independently derived:

**roleFitTier** — `EXACT` (canonical role matches the target exactly, and
isn't a raw `role_family` copy — i.e. some real title evidence exists) →
`ADJACENT` (same family, `roleAdjacency >= 0.75`) → `RELATED` (same family,
weaker/no adjacency) → `CROSS_FAMILY` (different family, but
`FAMILY_ADJACENCY`-related) → `UNRELATED`.

**seniorityGapTier** — ordinal gap between the job's `seniority_level` and
the profile's years-of-experience-derived band (same ordinal scale as
`matching/experience-score.mjs`'s fallback, reimplemented locally so this
script never imports the scoring module itself) — `MATCH` (≤1 band) →
`MODERATE` (2 bands) → `SEVERE` (3+ bands).

**skillOverlapTier** — required-skill overlap between the job and the
profile's declared skill list — `STRONG` (≥50% or no required skills
listed) → `PARTIAL` (>0%) → `WEAK` (0%).

**Decision tree** (`decideLabel()` in `scripts/build-benchmark-v2.mjs`):
1. `UNRELATED` role → **BAD** ("wrong profession").
2. `CROSS_FAMILY` + `WEAK` skill → **BAD**.
3. `SEVERE` seniority gap and role isn't `EXACT` → **BAD**.
4. `WEAK` skill and role is `RELATED`/`CROSS_FAMILY` → **BAD**.
5. `EXACT` + `MATCH` seniority + `STRONG` skill → **EXCELLENT**.
6. (`EXACT` or `ADJACENT`) + (`MATCH` or `MODERATE` seniority) + (`STRONG`
   or `PARTIAL` skill) → **GOOD**.
7. `EXACT` role but `SEVERE` seniority gap → **BORDERLINE** (role is right,
   seniority badly off).
8. Everything else → **BORDERLINE**.

Every label is stored with its contributing `reasons` (spec Step 8), e.g.
`["Role fit: EXACT", "Seniority: MATCH", "Skill overlap: WEAK"]`.

## Candidate recall (spec Step 12)

`scripts/evaluate-recommendations-v2.mjs` checks, for every GOOD/EXCELLENT
labeled job, whether it's still `status='READY' AND active=TRUE` (i.e.
retrievable at all) — reported per profile as `candidateRecall.relevant`
vs. `candidateRecall.stillActive` in the dump, separating a genuine
retrieval failure from a ranking failure.

## Metrics (spec Step 13)

Precision@5, Precision@10, Recall@10, NDCG@5, NDCG@10, MRR, bad-match@5,
bad-match@10, eligibility violation rate, hard-ineligible validation rate
(bucket H jobs correctly hard-rejected). GOOD+EXCELLENT = relevant for
precision/recall/MRR, matching the legacy convention.

## Dev/holdout discipline (spec Step 11)

`fixtures/benchmark-v2/split.json` is generated once, deterministically
(sorted job-id list, every 3rd id → holdout), and frozen at that point —
this document records that no ranking tuning occurred against holdout
during this phase (none occurred against dev either — this phase makes no
ranking changes at all, per its own explicit scope).

## Known limitation found during baseline measurement

The current model's dev-set eligibility violation rate on benchmark-v2 is
non-zero (~0.29) — traced directly to buckets A-G/I not being filtered for
the two new hard-constraint preferences (salary floor, full-time-only)
added for bucket H's sake. Several quality-labeled jobs (chosen for
role/seniority/skill fit only) are internships, contracts, or below the
stated salary floor, and the eligibility engine correctly hard-rejects
them — verified: bucket H's dedicated hard-ineligible jobs are rejected
11/11 (dev) and 7/7 (holdout). This is a benchmark-construction property,
not a ranking-model defect; a v2.1 iteration could pre-filter buckets
A-G/I by employment-type/salary eligibility to isolate quality-labeling
from hard-constraint validation entirely.
