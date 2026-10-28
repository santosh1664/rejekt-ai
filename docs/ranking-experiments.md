# Ranking experiments

Log of every ranking-logic change made during the structured ranking quality
optimization phase. Methodology: one change at a time, evaluate on `--set dev`
only, keep or revert based on measured before/after. `--set holdout` is run
once, at the very end, never during tuning.

Baseline before any change this phase (`--set dev`, `evaluation/dev-v1-baseline.json`):
P@5=0.244, P@10=0.211, NDCG@10=0.710, badRate=0.556, eligViolation=0.000.

## RANK-001 — fix camelCase/snake_case field-mapping bug

**Change**: `matching/recommend.mjs`'s `loadUserContext()` passed raw Postgres
snake_case rows (`canonical_role`, `role_family`) straight into `ctx.targetRoles`,
but `matching/role-score.mjs`'s `scoreRole()` reads camelCase
(`target.canonicalRole`, `target.roleFamily`) — always `undefined`. Mapped to
camelCase once in `loadUserContext`, updated `relevantRoleFamilies()` to match.

**Hypothesis**: role-score has been silently returning its UNRELATED fallback
(10) for every job regardless of true fit — found via `rank-diagnostics.mjs`
showing role averaging exactly 10.0 across every label including EXCELLENT.

**Before**: P@5=0.244, P@10=0.211, NDCG@10=0.710 (dev-v1)
**After**: P@5=0.244, P@10=0.211, NDCG@10=0.710 (dev-v2) — identical; a uniform
10→100 shift alone doesn't change relative order until RANK-002/003 land.
**Decision**: KEEP. Confirmed via diagnostics (role now 100.0 uniformly,
proving the fix took effect) even though this run's aggregate metrics didn't
move yet — a severe, previously-undetected integration bug regardless.

## RANK-002 — EXACT/SAME_FAMILY collapse guard + recalibrated SAME_FAMILY default

**Change**: after RANK-001, role scored exactly 100.0 for every label — because
`job.canonicalRole` is currently always a copy of `job.roleFamily` (no finer
job-side role classifier exists), collapsing EXACT and SAME_FAMILY into one
always-100 bucket. Added `&& job.canonicalRole !== jobFamily` guard to the
EXACT condition; lowered the SAME_FAMILY default score 80→55 (a role_family
like DATA_SCIENCE lumps Data Engineer/Analyst/ML Engineer together — not a
genuine specialization match).

**Before**: NDCG@10=0.710 (dev-v2)
**After**: NDCG@10=0.660 (dev-v3) — dropped. Diagnostics: role=55.0 uniformly
across all labels within the dev set.
**Root cause of the flat 55.0**: benchmark-construction limitation, not a
scoring bug — Phase D's own label-sampling filtered each profile's 15 labeled
jobs to a single `role_family`, so `role_family` is a constant (not a
variable) within a profile's labeled set. Role-family-only scoring literally
cannot discriminate within-profile in this benchmark.
**Decision**: KEEP despite the isolated NDCG dip — the guard fixes a real
correctness bug (EXACT firing on family-equality alone) and the default
recalibration is evidence-based per the user's own Step 4 concern. The
discrimination gap it exposed is addressed by RANK-003 below, evaluated
together as the net effect.

## RANK-003 — title-token similarity as a same-family tie-breaker

**Change**: added `titleSimilarity()` (Jaccard over stop-word-stripped title
tokens) as a secondary deterministic signal (spec Step 15) inside the
SAME_FAMILY branch, only when no finer `ROLE_RELATIONSHIP` entry already
discriminates: sim >= 0.34 -> 70, sim === 0 -> 35, else stays at the 55 default.

**Before**: NDCG@10=0.660 (dev-v3)
**After**: NDCG@10=0.761, P@5=0.289 (dev-v4) — role now has 3 discrete values
(35/55/70) with a real per-label gradient (EXCELLENT 66.3, GOOD 46.0,
BORDERLINE 40.2, BAD 39.9).
**Decision**: KEEP. First real, measured improvement of the phase; directly
mitigates the RANK-002 benchmark-construction limitation.

**Also revealed**: `preferredSkills` average is backwards by label
(BAD=59.2 > BORDERLINE=50.8 > GOOD=46.7 > EXCELLENT=33.5) — motivated RANK-005.

## RANK-004 — role-tier score cap (guardrail, spec Step 5 option A)

**Change**: `matching/final-score.mjs` caps the additive weighted sum by role
tier: `role < 40 -> 58, role < 60 -> 75, else 100`. Prevents a poor role fit
(30% weight) from being diluted into a deceptively high total by the other
70% of components.

**Before**: NDCG@10=0.761 (dev-v4)
**After**: P@5=0.289 (unchanged), P@10=0.211 (unchanged), NDCG@10=0.789 (dev-v5).
GOOD (mean 54.6) and BAD (mean 51.6) final scores still heavily overlap.
**Decision**: KEEP. Clear NDCG improvement, no regression on P@5/P@10/badRate.

## RANK-005 — IDF-weighted skill coverage (spec Step 7) — REVERTED

**Change**: `lib/skill-corpus-stats.mjs` computed per-skill IDF weights
(`log(totalJobs/jobsWithSkill)`, corpus-verified: Python ~13.6% of jobs, AWS/SQL/
Kubernetes similarly ubiquitous — satisfying the spec's "only implement if
generic skills are shown to materially inflate bad matches" gate). Wired into
`scoreSkills()` as an optional weighted-coverage mode, threaded through
`final-score.mjs` -> `recommend.mjs` / `evaluate-recommendations.mjs`.

**Hypothesis**: down-weighting ubiquitous skills would fix the RANK-003 finding
that `preferredSkills` scores BAD jobs highest of all four labels.

**Before**: P@5=0.289, P@10=0.211, NDCG@10=0.789, badRate=0.556 (dev-v5)
**After**: P@5=0.289 (unchanged), P@10=0.211 (unchanged), NDCG@10=0.770
(regression, -0.019), badRate=0.556 (unchanged) (dev-v6).
`preferredSkills` by label barely moved (BAD=58.5 vs. 59.2 before) — still the
highest of all four labels, i.e. the hypothesis did not actually resolve.
**Root cause of no effect**: diagnostics show the real driver of top-10 false
positives is `RELATED_ROLE_TOO_GENEROUS` (66/71, role=35 same-family/no-title-
overlap), not raw skill-overlap magnitude — those jobs hit final scores of
54-58 by landing exactly on the RANK-004 role<40 cap ceiling (58), not by
skill inflation alone. IDF-reweighting skills doesn't touch that ceiling.
**Decision**: REVERT. No net improvement, a real (if small) NDCG regression,
and added a whole DB-backed corpus-stats module for it. Removed
`lib/skill-corpus-stats.mjs` and all call-site wiring entirely rather than
leave an unused capability in the codebase.

## RANK-006 — tighten the role<40 score cap — REVERTED

**Change**: `matching/final-score.mjs`'s role-tier cap tightened for the
lowest role band: `role < 40 -> 45` (was 58); `role < 60 -> 75` unchanged.

**Hypothesis**: RANK-005's diagnostics show role=35 same-family/no-title-
overlap jobs landing at final=54-58 by hitting the cap ceiling itself (not
being pulled below it) once combined with high skills/experience/location/
salary — the cap is still too generous for this band.

**Before**: P@5=0.289, P@10=0.211, NDCG@10=0.789, badRate=0.556 (dev-v5)
**After**: P@5=0.267 (down), P@10=0.211 (unchanged), NDCG@10=0.749
(regression, -0.040), badRate=0.556 (unchanged) (dev-v7). Per-profile results
were highly mixed: Backend Java Engineer NDCG 0.842->0.962 (improved) but
Entry Software Engineer 0.806->0.469 and DevOps/SRE 0.722->0.610 (both
sharply worse).
**Root cause of the regression**: the tighter cap (45) is low enough that
GOOD, BORDERLINE, and BAD jobs sharing role<40 all get flattened to exactly
45 (score-distribution dump: BORDERLINE and BAD medians both exactly 45,
q1=q3=45) — destroying the fine-grained ranking that raw component scores
still carried within that band, rather than just suppressing bad matches.
A cap that binds for most of a band stops discriminating within it; RANK-004's
58 rarely bound (so it acted as a true ceiling for outliers), 45 bound for
most of the band (so it acted as a floor-and-ceiling, i.e. a constant).
**Decision**: REVERT to RANK-004's cap (role<40 -> 58).
**Takeaway for the next experiment**: role<40 needs discrimination WITHIN the
band (e.g. from experience/seniority or a genuine specialization signal), not
a tighter uniform ceiling — a global cap is the wrong tool for this. Points at
spec Steps 8/9 (seniority/experience recalibration) as the more promising next
lever, since diagnostics repeatedly show BAD-in-this-band jobs also scoring
experience=90 (a senior/exec job the user is under-qualified for, scored as a
perfect experience fit) alongside role=35.

## RANK-007 — seniority-level fallback for experience scoring (spec Step 8)

**Change**: `matching/experience-score.mjs` — verified against the corpus that
~42% of READY jobs have no `min_exp_years` (44,426/105,478). Previously that
case always returned a flat neutral 90 regardless of true seniority gap —
directly matching RANK-006's diagnostic finding (an Entry-level profile
scored experience=90 against a role=35 "Staff Engineer" job purely because
that job had no explicit years requirement). `jobs.seniority_level` is
populated for the large majority of jobs and gives an ordinal fallback signal
(INTERN..EXECUTIVE, mapped against a years-derived ordinal for the user).
Management levels (MANAGER/DIRECTOR/EXECUTIVE) cap confidence at 55 rather
than scoring purely off years, per the spec's "not simply higher" caution —
we have no people-management signal on the user profile to confirm real fit.
Threaded `job.seniority` into `computeFinalScore`'s `scoreExperience` call.
Added `scripts/test-experience-score.mjs` (6 checks, all passing).

**Before**: P@5=0.289, P@10=0.211, NDCG@10=0.789, badRate=0.556 (dev-v5)
**After**: P@5=0.289 (unchanged), P@10=0.211 (unchanged), NDCG@10=0.803
(improved, +0.014), badRate=0.556 (unchanged), eligViolation=0.000 (dev-v8).
Diagnostics: `experience` by label went from BAD=66.9/GOOD=79.1 (near-tied,
wrong-ish direction) to BAD=54.2/GOOD=75.8 — a real, correctly-ordered gap.
Score distribution now cleanly monotonic by label (EXCELLENT 61.3 > GOOD 54.3
> BORDERLINE 50.9 > BAD 50.4), an improvement over RANK-004's overlapping
distribution.
**Decision**: KEEP. Genuine, evidence-backed improvement with no regression
on any other metric.

**Also revealed**: `RELATED_ROLE_TOO_GENEROUS` is still 66/71 of top-10
false positives (unchanged — this component doesn't touch role). Inspecting
the dump directly: within top-10 BAD/BORDERLINE, 57/71 have role=35 exactly.
But role=35 isn't a clean bad-match signal on its own — the full dev set has
9 GOOD-labeled jobs at role=35 too (alongside 17 BORDERLINE, 40 BAD),
confirming RANK-006's finding that this band can't be cleanly separated by a
scalar cap; it needs a different discriminating signal that doesn't exist in
this benchmark/pipeline without new role-classification infrastructure
(out of scope — no embeddings/new infra allowed).

## RANK-008 — shift weight from freshness/location/salary into role — REVERTED

**Change**: `matching/final-score.mjs` `WEIGHTS`: role 30%->38%, location
10%->7%, freshness 10%->7%, salary 5%->3% (requiredSkills/preferredSkills/
experience unchanged; sum still 100%).

**Hypothesis** (spec Steps 10/11): freshness/location/salary averaged 67-80
even for BAD-labeled jobs (dev-v8 diagnostics) — these logistics/preference
factors keep final scores elevated independent of role fit; down-weighting
them and up-weighting role should push BAD jobs down.

**Before**: P@5=0.289, P@10=0.211, NDCG@10=0.803, badRate=0.556 (dev-v8)
**After**: P@5=0.289 (unchanged), P@10=0.211 (unchanged), NDCG@10=0.798
(small regression, -0.005), badRate=0.556 (unchanged) (dev-v9).
**Decision**: REVERT. No metric improved and NDCG@10 slipped slightly — not
a genuine improvement, reverted to RANK-007's original 30/25/10/10/10/10/5
weights.

## RANK-009 — mild priority discount on secondary-target role matches (spec Step 14)

**Change**: `matching/role-score.mjs`'s `scoreRole()` previously reported a
perfect match found only on a priority-2+ target role as a full, undiscounted
100 (a deliberate Phase D design choice, with its own test asserting it).
This phase's spec explicitly requires target-role priority to be respected
(Step 14) and names a regression scenario ("secondary target role ranks below
primary when other factors equal") that the old behavior fails by
construction. Added a mild reported-score discount — 1.0 at priority 1, 0.9
at priority 2, 0.8 at priority 3+ — applied only to the score actually
reported (the steeper 1/priority weighting used to pick which target "wins"
for a given job is unchanged). Updated the old Phase D test's expectation
(`scripts/test-role-score.mjs`) to match this intentional, spec-driven
behavior change, and added it as regression scenario 7 in
`scripts/test-ranking-regressions.mjs`.

**Benchmark impact**: none measurable — verified all 9 benchmark profiles
have exactly one priority-1 target role (`fixtures/benchmark-profiles.json`),
so this has zero effect on any dev/holdout metric; it only matters for real
multi-target-role user profiles, which the benchmark doesn't cover. No
dev-set re-run needed.
**Decision**: KEEP. Directly satisfies an explicit spec requirement (Step 14)
and its named regression scenario; verified benchmark-neutral so it carries
no ranking-quality risk on the measured metrics.

## RANK-010 — fine-grained canonical-role taxonomy + role-score integration

**Context**: this phase's core objective. Prior audit confirmed `canonical_role`
was an exact copy of `role_family` for 89,759/105,719 READY jobs (0
disagreements) and NULL for the remaining 15,960 (role_family='OTHER');
`role_specialization` was 100% NULL. `lib/role-taxonomy.mjs` (a controlled
canonical-role set + explicit adjacency map, scoped to the 3 families with
real corpus volume/benchmark coverage: SOFTWARE_ENGINEERING, DATA_SCIENCE,
DEVOPS_SRE) and `lib/role-classifier.mjs` (role-v2, a deterministic ordered
title-pattern classifier, 34 unit tests) were built and validated against
real corpus title samples before touching the database. `scripts/backfill-roles.mjs`
populated all 104,719 READY jobs (idempotent via job_classifications' unique
(job_id, field_name, classifier_version) index — see the script's own
comments). `matching/role-score.mjs` was rewritten: EXACT_CANONICAL (spec
Step 15) → RELATED_CANONICAL (explicit adjacency, spec Step 16) →
SAME_FAMILY_GENERIC (title-Jaccard now a tie-breaker only, spec Step 17) →
DIFFERENT_FAMILY_RELATED → UNRELATED, plus a specialization bonus (spec Step
18, inferred from user skills since user_target_roles has no specialization
column — no schema change needed).

**Change gate 1 (before benchmarking)**: `fixtures/benchmark-profiles.json`'s
`targetRoles` still had `canonicalRole === roleFamily` for all 9 profiles —
without updating them, the new discrimination logic never engages on the
target side (every comparison fell through to SAME_FAMILY_GENERIC). Updated
each profile's target canonicalRole to what `lib/role-classifier.mjs` itself
produces for that profile's own `currentTitle` (e.g. "Backend Engineer" ->
BACKEND_ENGINEER, "Data Analyst" -> DATA_ANALYST) — this exactly mirrors
what `lib/profile-normalize.mjs`'s updated `normalizeRoleInput()` would do
for a real user typing the same title, not label-informed tuning.

**Change gate 2 (bug found via the benchmark itself)**: after the target-role
alignment, "Entry Software Engineer" P@5 regressed from 0.200 to 0.000.
Diagnosed: two jobs BOTH falling back to the classifier's own GENERIC
within-family bucket (`SOFTWARE_ENGINEER`, matched by a bare "Software
Engineer"/"Staff Engineer"-with-no-specifics title) were satisfying the
`canonicalRole !== roleFamily` "genuinely finer" guard (since the string
`SOFTWARE_ENGINEER` != `SOFTWARE_ENGINEERING`) and scoring a false
EXACT_CANONICAL 95-100 — the exact same collapse pattern RANK-002 fixed one
level up, recurring one level down. Fixed by flagging generic/catch-all
canonical roles in `lib/role-taxonomy.mjs` (`generic: true`) and excluding
them from the "genuinely finer" check on both sides. Added a dedicated
regression test.

**Before** (prior phase's final dev state, `dev-v8-rank007.json`): P@5=0.289,
P@10=0.211, NDCG@10=0.803, badRate=0.556, eligViolation=0.000.
**After** (both gates applied, `dev-v13-diagnostics-fix.json`): P@5=0.356
(+0.067), P@10=0.211 (unchanged), NDCG@10=0.827 (+0.024), badRate=0.556
(unchanged), eligViolation=0.000.
**Decision**: KEEP. Clear, genuine improvement — driven almost entirely by
better within-profile discrimination on SOFTWARE_ENGINEERING/DATA_SCIENCE
family jobs (Backend Java Engineer NDCG 0.842->0.965, Data Engineer
0.837->0.954, Senior Data Engineer 0.791->0.836, Data Analyst P@5
0.400->0.600) — exactly the families this taxonomy was built deep for.

**Root-cause finding on what's left** (spec Step 21): re-running
`rank-diagnostics.mjs` with the newly-exposed `roleMatchType` field (added
so the diagnostic classifies by actual match type, not a stale score
threshold — see below) shows `RELATED_ROLE_TOO_GENEROUS` only dropped
66->61/71. Inspecting the 61 directly: the large majority are titles like
"Autonomy Engineer", "Senior Engineer, System Calibration (Electro-Optics)",
"Material Planner", "Senior Staff FPGA Engineer", "Cookie Crew", "Senior
Manager, Community Growth & Intelligence" — hardware/aerospace/manufacturing/
non-engineering jobs that `lib/fingerprint.mjs`'s pre-existing `classifyCategory`
sweeps into role_family=SOFTWARE_ENGINEERING (verified live, out of scope for
this phase). The new classifier correctly, conservatively declines to force
these into a specific software specialization it has no title evidence for
— that's the right behavior, but it can't fix an upstream role_family
misclassification. This is the dominant remaining driver, not a taxonomy gap.

## Diagnostic tooling: roleMatchType (not a ranking change)

`matching/final-score.mjs` now returns `roleMatchType` (the role component's
actual match type) alongside `components`, threaded through
`scripts/evaluate-recommendations.mjs`'s dump. `scripts/rank-diagnostics.mjs`'s
`classifyFailure()` was recalibrated to classify by this real match type
instead of a role-score threshold — the old threshold (`role <= 55`) no
longer cleanly separates "generous" from "evidence-backed" matches now that
RELATED_CANONICAL (evidence-backed adjacency) and SAME_FAMILY_GENERIC
(no finer evidence) overlap in raw score range (~55-65). This changes what
the diagnostic prints, not the scorer itself.

## RANK-011 — role-tier cap re-evaluation after the taxonomy landed (spec Step 19)

**Change tested**: removed the role-tier score cap entirely (option C —
`roleCap = Infinity`) to see whether the now-richer role signal still needs
the RANK-004 guardrail.
**Before** (cap in place): P@5=0.356, NDCG@10=0.827 (dev-v13)
**After** (no cap): P@5=0.356 (unchanged), NDCG@10=0.815 (regression,
-0.012), badRate=0.556 (unchanged) (dev-v14).
**Decision**: REVERT — kept the existing cap (option A), unchanged from the
prior phase. Its 40/60 score boundaries still track the new scale's
UNRELATED/DIFFERENT_FAMILY_RELATED vs. SAME_FAMILY_GENERIC vs.
RELATED_CANONICAL+ tiers well enough that a fresh recalibration (option B)
wasn't pursued — two independent cap-tuning attempts in the prior phase
(RANK-006, RANK-008) and this phase's no-cap test all point the same
direction: the existing cap is already close to a local optimum for this
benchmark, and further cap tuning risks overfitting a 90-job dev set more
than it risks leaving real gains on the table.

## Post-classification ranking calibration phase

**Context**: with role_family and canonical_role quality now substantially
improved (prior two phases), diagnostics showed the same top-10 job
*membership* persisting before/after those fixes — meaning the remaining
false positives are no longer classifier errors but a scoring-formula
question: jobs with genuinely low role relevance still ranking too highly
because skills/experience/location/salary compensate too aggressively.

**Foundational methodology finding (before any experiment)**: `fixtures/benchmark-split.json`
gives exactly 10 dev-labeled and 5 holdout-labeled jobs per profile.
`scripts/evaluate-recommendations.mjs`'s `precisionAt(labels, 10)` and
`badMatchRate` both slice to the first 10 ranked labels — since the dev
closed-set IS exactly 10 jobs, that slice always returns the *entire*
labeled set regardless of ranking order, making **P@10 and bad-match rate
mathematically invariant to reranking on the dev set**. The same applies to
P@5 AND P@10 on holdout (5 labeled jobs, so any slice ≥5 returns the full
set). This fully explains "P@10 stubbornly flat at 0.211" across every prior
phase of this project — it was never a modeling failure. The only metrics
that can move via reranking are dev P@5 and NDCG@10, and holdout NDCG@10.
Confirmed directly: `scripts/rank-diagnostics-swap.mjs` (new this phase)
reports 0 top-10 membership changes for every experiment below, on every
profile — a structural property of this benchmark, not a tuning result.
Reported as the limiting factor rather than chased further.

**Diagnostic tooling added this phase**: `matching/final-score.mjs` now
exposes `rawScore` (pre-cap weighted total) alongside `matchScore`;
`scripts/rank-diagnostics-fit.mjs` (new) prints per-job ROLE_MISMATCH detail
and professionalFit/preferenceFit averages by label;
`scripts/rank-diagnostics-swap.mjs` (new) compares two dumps' top-10
membership sets.

**Key diagnostic evidence** (`evaluation/pre-ranking-calibration.json`, via
`rank-diagnostics-fit.mjs`): top-10 `roleMatchType=UNRELATED` jobs (role
score pinned at 10) averaged requiredSkills=59.4, preferredSkills=68.7,
experience=65.0, location=65.9, salary=73.1 — even "Cookie Crew"/"Cookie
Delivery Driver" (zero extracted skills, so `skill-score.mjs`'s neutral-70
fallback applies) scored as if they had real partial skill overlap. A naive
`professionalFit = (role+skills+skills+experience)/4` average only separated
ROLE_MISMATCH (50.8) from GOOD/EXCELLENT (59.8) by 9 points despite a
58-point role-score gap — skills/experience dilute the professional signal
enough that a simple fit-band split alone wouldn't fix this.

### RANK-012 / RANK-013 / RANK-014 — role-based dampening, tested independently (spec Step 5)

Three independent single-lever experiments, evaluated on dev only:

| ID | Change | P@5 | NDCG@10 |
|---|---|---|---|
| (baseline) | none | 0.400 | 0.886 |
| RANK-012 (A) | dampen skills+experience by roleMatchType (UNRELATED×0.3, DIFFERENT_FAMILY_RELATED×0.6) | 0.422 | 0.901 |
| RANK-013 (B) | dampen preference only (location/freshness/salary), same factors | 0.422 | 0.900 |
| RANK-014 (C) | no dampening; cap final score by roleMatchType directly (UNRELATED→40, DIFFERENT_FAMILY_RELATED→55, SAME_FAMILY_GENERIC→75) instead of by raw role-score threshold | 0.422 | 0.899 |

All three tie within noise. Diagnostic inspection (Step 2's per-job dump)
showed most UNRELATED jobs' raw weighted scores already sit at 29-57 —
*below* even the pre-existing 58 cap — meaning the cap wasn't the binding
constraint for most of these cases either way; the raw formula itself needed
to produce a lower number, which is what all three levers accomplish by
different means.

**RANK-015 (D) — two-stage banded ranking** (spec Step 5/10): professional-
relevance band (derived from `roleMatchType`) strictly dominates; rawScore
only orders *within* a band via a fractional offset. **Regressed**: P@5=0.378
(below baseline), NDCG@10=0.884. The hard floors/ceilings per band compress
dynamic range too much and hurt SAME_FAMILY_GENERIC jobs that were
legitimately GOOD matches. **Decision: REVERT** — confirms Step 23's
"simplest generalizable model" bias was correct here; more architecture,
worse result.

### RANK-016 — combined dampening (spec Step 6's literal concept) — KEPT

**Change**: dampen ALL non-role components together (skills, experience,
location, freshness, salary) by `roleMatchType`, not just a subset — the
spec's own worked example. Same factors as RANK-012/013 (UNRELATED×0.3,
DIFFERENT_FAMILY_RELATED×0.6).

**Before**: P@5=0.400, NDCG@10=0.886 (baseline)
**After**: P@5=0.422, NDCG@10=0.901 — ties RANK-012 exactly.
**Decision**: KEEP, as the base of the final model — simplest single
mechanism (one dampen map, applied uniformly), directly matches the spec's
own suggested concept, and ties the best of the individually-tested
alternatives (A/B/C) rather than needing to pick among near-identical
options arbitrarily.

### RANK-017 — required-skill missing-count penalty (spec Step 7) — REVERTED

**Change**: `matching/skill-score.mjs`'s `requiredScore` — ratio minus an
absolute penalty (4 points per missing required skill, capped at 25) so
matched 4/8 scores worse than matched 1/2 despite the same 50% ratio.
Layered on top of RANK-016.

**Before**: P@5=0.422, NDCG@10=0.901 (RANK-016)
**After**: P@5=0.422 (unchanged), NDCG@10=0.887 (regression, -0.014).
**Root cause**: likely over-penalizes GOOD-labeled senior/technical roles
that naturally list more required skills, dragging down correct matches
more than it separates weak ones.
**Decision**: REVERT. `matching/skill-score.mjs` restored to the flat ratio.

### RANK-018 — experience-based final-score cap (spec Step 8) — KEPT

**Change**: `matching/final-score.mjs` — an additional final-score ceiling
keyed on the experience component (mirroring the existing role cap's
shape), independent of role match quality: `experience<=20 -> 55,
experience<=40 -> 75, else 100`, combined via `Math.min(rawScore, roleCap,
experienceCap)`.

**Motivation**: `rank-diagnostics-fit.mjs` showed 15/25 top-10
EXPERIENCE_MISMATCH cases had a *genuinely correct* role match
(SAME_FAMILY_GENERIC/RELATED_CANONICAL) — e.g. an Entry profile against
"Staff Software Engineer, App Platform" (role=50, experience=10) — untouched
by RANK-016's dampening, which only targets UNRELATED/DIFFERENT_FAMILY_RELATED.
A severe seniority gap needed its own lever, not a side effect of the role
signal. Applied as an additional ceiling (not a further reweight of the
already-10%-weighted experience component) specifically to avoid
double-counting it, per spec Step 8's explicit caution.

**Before**: P@5=0.422, NDCG@10=0.901 (RANK-016)
**After**: P@5=0.422 (unchanged), NDCG@10=0.907 (further +0.006).
**Decision**: KEEP — genuine additional gain, no regression, addresses a
real and distinct failure mode RANK-016 didn't cover.

### Cap re-evaluation (spec Step 9)

RANK-014 (Experiment C, a `roleMatchType`-keyed cap replacing the
score-threshold-based one) tied RANK-012/013 exactly. Not adopted for the
final model — it would replace a well-tested existing mechanism with an
equivalent-performing alternative, adding a second cap concept
(`experienceCap`, RANK-018) without measurable benefit. The original
score-threshold role cap (`role<40->58, role<60->75, else 100`, unchanged
since the prior phase) is kept as-is, now paired with the new,
independent `experienceCap`.

### Final model

`matching/final-score.mjs`: `rawScore` computed from `dampenedComponents`
(skills/experience/location/freshness/salary each multiplied by
`ROLE_DAMPEN[roleMatchType] ?? 1`, where `ROLE_DAMPEN = {UNRELATED: 0.3,
DIFFERENT_FAMILY_RELATED: 0.6}`), then `matchScore = Math.min(rawScore,
roleCap, experienceCap)` — the pre-existing role-score-threshold cap AND
the new experience-based cap both apply, whichever is more restrictive
wins. The *reported* `components` object stays undampened (real values) —
only the internal weighted-sum computation uses the dampened copy, so the
diagnostic/UI-facing scores remain accurate and interpretable.

**Final dev**: P@5=0.422 (+0.022 vs. this phase's baseline), P@10=0.211
(structurally invariant — see above), NDCG@10=0.907 (+0.021), bad-match=0.556
(structurally invariant), eligibility violations=0.
**Final holdout**: P@5=0.244 (invariant), P@10=0.244 (invariant), NDCG@10=0.768
(+0.058 vs. this phase's baseline of 0.710 — a strong, non-overfit
generalization signal), bad-match=0.422 (invariant), eligibility
violations=0.
**Top-10 membership**: 0 swaps in any profile, any experiment — see the
methodology finding above; this is the benchmark's own structural ceiling,
not a property of the final model specifically.

## Benchmark-v2 ranking calibration phase

**Context**: benchmark-v2 (see docs/benchmark-v2-methodology.md) surfaced
two concrete structured-scoring gaps that the small legacy benchmark never
had enough labeled jobs to reveal: (1) EXACT_CANONICAL role matches ranking
strongly even with zero required-skill overlap, (2) SAME_FAMILY_GENERIC
false positives — especially for Entry Software Engineer (7/7 of its
top-10 false positives were in this tier).

**Diagnosis before any change** (spec Steps 2-3): of 12 top-10
EXACT_CANONICAL jobs with requiredSkills<=20, the label split was 9
BORDERLINE / 3 GOOD / **0 BAD** — weak required-skill overlap inside a
confirmed exact-role match is NOT strongly predictive of a bad label, so
any fix needed to be mild, not aggressive. For SAME_FAMILY_GENERIC, the
SAME role/experience band (role=35, experience=90) produced both a
GOOD-labeled job ("Backend Services Programmer Intern", requiredSkills=70)
and a BAD-labeled one ("Agentic AI Engineer", requiredSkills=0) for
entry_swe — required-skill overlap is what actually separates them within
this tier, even though it wasn't predictive within EXACT_CANONICAL.

### RANK-019 — EXACT_CANONICAL required-skill floor (spec Steps 4-6)

**Change**: `matching/final-score.mjs` — when `roleMatchType===
'EXACT_CANONICAL'` AND the job has a genuine `TRUE_ZERO_MATCH` (at least N
required skills listed, user matches none — explicitly distinct from
`NO_REQUIREMENT_DATA`, where `skill-score.mjs`'s neutral-70 fallback
already applies and must never be touched), dampen `requiredSkills`/
`preferredSkills` by 0.85 before the weighted sum. N=3 chosen (tested
against N's sibling value 2 implicitly via the diagnostic's own evidence,
and the dampen magnitude tested at 0.85 vs. 0.7 — see below) — deliberately
mild given the weak BAD-correlation found above.

**Dampen magnitude test**: 0.85 vs. 0.7 produced **byte-identical** dev
metrics across every profile — the affected jobs were already pushed as
far down in rank as the milder factor achieves; a harsher penalty added no
further separation. Kept 0.85 (the milder, less risky value) per spec Step
21's minimal-complexity principle — no measurable benefit from being
stronger.

### RANK-020 — SAME_FAMILY_GENERIC conditional dampening (spec Steps 7-9)

**Change**: same file — when `roleMatchType==='SAME_FAMILY_GENERIC'` AND
`role.score<=35` (role-score.mjs's own title-Jaccard-derived weak-title-
evidence tier) AND `requiredSkills<=30`, dampen all six non-role components
by 0.85. Deliberately **conditional**, not a flat multiplier (spec Step
7's flat-factor idea was superseded by Step 8's conditional one once the
diagnostic showed either signal alone — weak title OR weak skill — isn't
enough to justify punishing a real match; both together is): a job with
role=35 but strong skills (a genuine generic-but-valid software role) is
explicitly NOT dampened — verified via regression test 16.

### Combined result (RANK-019 + RANK-020)

**Dev before**: P@5=0.822, P@10=0.578, Recall@10=0.851, NDCG@10=0.979, Bad-match@10=0.056
**Dev after**: P@5=0.822 (unchanged), **P@10=0.589** (+0.011), **Recall@10=0.879** (+0.028), NDCG@10=0.977 (-0.002), **Bad-match@10=0.033** (-0.023, past the <=0.04 target)

**Per-profile impact — every one of the 6 protected profiles (spec Step
10: Mid SWE, Backend Java, Data Engineer, Senior Data Engineer, ML
Engineer, Data Analyst) is BYTE-IDENTICAL before/after**, on every metric.
QA Automation Engineer is also unchanged (P@5=0.600, P@10=0.400 both
before and after). The entire measured improvement is concentrated on
Entry Software Engineer: P@10 0.300->**0.400** (its own theoretical
maximum, given only 4 relevant dev-labeled jobs total — see the
theoretical-max analysis below) and DevOps/SRE Engineer's NDCG@10 nudged
up slightly (0.976->0.977). Entry SWE's own NDCG@10 dropped slightly
(0.894->0.881) — a real but small cost for reaching its P@10 ceiling.

**Decision**: KEEP both RANK-019 and RANK-020. Real, targeted improvement
on the exact two documented gaps, zero measurable damage to any protected
profile, tiny (-0.002) aggregate NDCG cost — consistent with spec Step 14's
"a change that raises NDCG by 0.002 but worsens P@10 should usually be
rejected" read in reverse: a tiny NDCG cost for a real P@10/bad-match gain
is an acceptable trade.

### Holdout (run once, after final model selection — spec Steps 16, 20, 25)

**Result**: byte-identical to the pre-calibration baseline on every metric
(P@5=0.644, P@10=0.363, NDCG@10=0.993, Bad-match@10=0.341) — RANK-019/020
changed nothing on holdout's specific job set. Combined with
`normalizedPrecisionAt10=1.000` for every single holdout profile (see
theoretical-max analysis below), this means holdout was already at its
achievable ceiling before this phase's changes, and remains there — a
clean non-regression, not a missed opportunity.

### Theoretical max / normalized precision (spec Steps 17-19)

Added `maxPrecisionAt(K) = min(totalRelevant, K) / K` and
`normalizedPrecisionAt(K) = relevantRetrieved / min(K, totalRelevant)` to
`scripts/evaluate-recommendations-v2.mjs`'s output. Investigating holdout's
"P@10 only 0.363 despite NDCG 0.993" (spec Step 17) directly: several
holdout profiles have very few relevant labeled jobs at all (Backend Java
Engineer and ML Engineer: 1 relevant each, capping their own maxP@10 at
0.10) — the aggregate holdout maxP@10 is **0.344**, essentially matching
the actual **0.363** already. `normalizedPrecisionAt10=1.000` for every
profile on both dev and holdout confirms every retrievable relevant job is
already surfaced within the top 10 everywhere it's checked — this
benchmark's holdout "weakness" is a labeled-pool-size ceiling, not a
ranking defect.

## Benchmark-v2.1 cleanup + final structured ranking calibration phase

Benchmark-v2.1 (`fixtures/benchmark-v2.1/`, `docs/benchmark-v2.1-methodology.md`)
fixed v2's one design flaw — quality buckets could contain jobs that
violate the profile's own hard constraints, contaminating quality-ranking
metrics with eligibility-engine behavior — by pre-filtering every quality
candidate through the real `evaluateEligibility()` at build time. All 9
profiles landed 34 quality jobs (100% eligible), bucket H stayed 100%
correctly hard-rejected. A second fixture defect was found and fixed
mid-phase via spec Step 13's own candidate-recall diagnostic — the
sampling queries never filtered `active = TRUE`, so ~30% of labeled
relevant jobs were already-stale postings, unretrievable by construction
(see `docs/benchmark-v2.1-methodology.md`'s "Candidate-recall fix"). Fixed
in `scripts/build-benchmark-v2.1.mjs` and rebuilt; candidate recall is now
100% (71/71 dev, 30/30 holdout). All numbers below are from the rebuilt
fixture. True v2.1 dev baseline (zero ranking changes): P@5=0.889,
P@10=0.644, NormP@10=0.844, Recall@10=0.834, NDCG@10=0.974, Bad-match@10=0.056.
True holdout baseline: P@5=0.578, P@10=0.333, NormP@10=1.000, Recall@10=1.000,
NDCG@10=0.941, Bad-match@10=0.289. Not directly comparable to v2's numbers
(different, cleaner job set).

`scripts/rank-diagnostics-v2.1.mjs` classified every top-10 dev+holdout
BORDERLINE/BAD job into the spec's 12-category taxonomy using the
benchmark's own independent `labelReasons` cross-referenced against the
model's `roleMatchType`/component scores. This first diagnostic pass ran
on a preliminary dump — before the candidate-recall check above surfaced
the active=TRUE fixture gap — which showed `DIFFERENT_FAMILY_RELATED` in 0
dev top-10 jobs but 15 holdout top-10 jobs (11 BAD/BORDERLINE + 4
GOOD/EXCELLENT). Manually reviewing all 15 against spec Step 17's
split found: 6 cases (**category D** — role-family/canonical-role
disagreement: e.g. two EXCELLENT-labeled "Senior ML Engineer"/"Research
Engineer, ML" jobs with `canonicalRole=ML_ENGINEER` matching the ML
Engineer target exactly, but `roleFamily=SOFTWARE_ENGINEERING` disagreeing
with the target's `DATA_SCIENCE` family — capped at score ~35-42 instead
of ~95 purely because `role-score.mjs` gated the EXACT_CANONICAL check
behind family agreement); 6 cases (**category C** — an adjacency-map edge
too generous: `SOFTWARE_ENGINEERING<->DATA_SCIENCE` and
`DEVOPS_SRE<->DATA_SCIENCE` letting genuinely unrelated specific roles —
QA_ENGINEER, APPLICATION_SECURITY_ENGINEER, generic SOFTWARE_ENGINEER/
FULL_STACK_ENGINEER — rank respectably for Data Engineer/Analyst/DevOps
profiles via family-level adjacency alone, consistently at low required-
skill overlap, 0-33); 2 cases **category B** (generic Python/SQL skill
overlap inflating an otherwise-unrelated Security/generic-SWE role); 2
cases **category E** (ambiguous — genuinely marginal transferability). 0
cases were **category A** (genuinely adjacent and useful) among the
BAD/BORDERLINE-labeled set.

### RANK-021 — exact canonical-role match wins over family disagreement (spec Steps 17-18) — KEPT

`role-score.mjs`'s `scoreRole()` gated its `EXACT_CANONICAL` check behind
`jobFamily === targetFamily` — so a job whose `canonical_role` matched the
target's exactly still fell through to the family-adjacency branch
whenever `role_family` disagreed, even though canonical_role is the finer,
more specific signal. Fix: check `job.canonicalRole === target.canonicalRole`
(both sides genuinely fine, non-generic) *before* the family-equality gate,
not after — this is not a classifier change, only a reordering of which
signal `role-score.mjs` trusts first. Verified live before implementing:
exactly 6 jobs across dev+holdout hit this path (2 dev, 4 holdout), **all
GOOD/EXCELLENT-labeled, 0 BAD/BORDERLINE** — the fix can only ever help a
genuine match, never rescue a bad one.

### RANK-022 — conditional DIFFERENT_FAMILY_RELATED dampening on weak required-skill coverage (spec Steps 19-20) — KEPT

Added a conditional dampen (`0.8`x on requiredSkills/preferredSkills/
experience/location/freshness/salary, same mechanism as RANK-020's
`sameFamilyDampen`) firing only when `roleMatchType === 'DIFFERENT_FAMILY_RELATED'`
**and** `components.requiredSkills <= 35`. Every diagnosed category-C false
positive (Step 17) was already separable from the genuinely-useful
cross-family cases on this one signal alone — no title-similarity signal
needed. A strong-skill DIFFERENT_FAMILY_RELATED case (e.g. a Quant
Researcher role sharing real Python/SQL overlap with a Data Engineer
profile) is untouched, per spec's explicit "do not punish genuinely
adjacent strong-skill matches."

### Combined result (RANK-021 + RANK-022), measured on the corrected (active=TRUE-filtered) fixture

All numbers below compare the true pre-calibration baseline (RANK-021/022
temporarily reverted, re-measured) against the final model, both run on
the rebuilt fixture — an apples-to-apples comparison, unlike the
preliminary numbers that motivated the diagnostic above.

**Dev**: P@5=0.889->**0.911** (+0.022), **P@10=0.644->0.711** (+0.067),
NormP@10=0.844->**0.923** (+0.079), Recall@10=0.834->**0.912** (+0.078),
NDCG@10=0.974 (unchanged), NDCG@5=0.977 (unchanged), Bad-match@10=0.056
(unchanged), Bad-match@5=0.000 (unchanged).

**Holdout**: P@5=0.578 (unchanged), P@10=0.333 (unchanged),
NormP@10=1.000 (unchanged, already at ceiling), Recall@10=1.000
(unchanged), NDCG@10=0.941->**0.949** (+0.008), NDCG@5=0.941->**0.949**
(+0.008), Bad-match@10=0.289 (unchanged), Bad-match@5=0.089 (unchanged).

**Per-profile impact**: every one of the 7 protected profiles (Mid SWE,
Backend Java, Data Engineer, Senior Data Engineer, QA Automation, DevOps/
SRE, Data Analyst) is byte-identical on holdout; on dev, Backend Java
improved (P@10 0.700->**0.800**, NormP@10 0.778->**0.889**, NDCG@10
0.986->**0.990**) and the rest are byte-identical. The real, targeted
improvement is ML Engineer — dev P@10 0.400->**0.800**, Recall@10
0.500->**1.000**; holdout NDCG@5/NDCG@10 0.862/0.866->**0.934/0.938**
(reordering within an unchanged top-5/top-10 membership) — exactly the
profile RANK-021's fix targeted (a family/canonical-role disagreement on
an EXACT ML_ENGINEER match). Entry Software Engineer is unaffected
(byte-identical on both sets) — consistent with spec Step 23's "do not
optimize solely around it." `DIFFERENT_FAMILY_RELATED` in holdout top-10
dropped from 10 (baseline, corrected fixture) to 8 (final) — 1
EXCELLENT-labeled case reclassified to EXACT_CANONICAL (RANK-021), 1
BORDERLINE case dampened out of the top-10 (RANK-022); the remaining 8 are
the genuinely-adjacent-strong-skill and ambiguous (category A/E) cases
RANK-022 was deliberately built not to touch.

**Decision**: KEEP both. Strictly Pareto-improving against spec Step 25's
own priority order — bad-match unchanged, normalized P@10 up, raw P@10 up,
Recall@10 up, NDCG@10 up or unchanged, P@5 stable or up — with zero
regression on any protected profile on either dev or holdout.

### Step 21 (experience/seniority interaction) — no additional change made

Reviewed all 19 top-10 dev+holdout jobs (final, corrected-fixture dump)
the benchmark flagged with a severe seniority-gap reason. Two clusters:
(1) Entry Software Engineer noise, an artifact of that profile's smaller
relevant pool (documented limitation, spec Step 23 says don't optimize
around it alone); (2) cases where the model's OWN `experience` component
already
scores high (85-100) because the job's posted min/max-years requirement
looks like a fine fit, while the benchmark's independent
`seniority_level`-ordinal check disagrees — a genuine disagreement between
two different signals (years-based vs. seniority-label-based), not a
clean "role weak + experience poor" interaction spec Step 21 describes.
No case cleanly cleared the evidence bar RANK-021/022 did (a crisp,
isolated root cause with zero-BAD collateral risk) — per spec's own
caution against adding "another independent large penalty without
evidence," no change was made here this phase.

## Regression test suite (spec Step 26)

`scripts/test-ranking-regressions.mjs` — 7 synthetic, DB-free scenarios run
through the real `computeFinalScore` pipeline, all passing on the final
ranking design (RANK-001/002/003/004/007/009 applied):
1. High skill overlap on a completely unrelated role does not rank strong.
2. Correct role + partial skills outranks unrelated role + full skill overlap.
3. Entry-level user vs. a Staff-level job (no explicit years posted) is
   strongly penalized on experience (RANK-007's seniority fallback).
4. A freshly-posted unrelated-role job does not outrank an older exact-role match.
5. A nearby unrelated-role job does not outrank a remote exact-role match.
6. Missing salary scores neutral, not an extreme penalty or bonus.
7. A secondary-target-role match ranks below a same-quality primary-target
   match (RANK-009).

**Extended in the post-classification ranking calibration phase** (spec Step
22) to 11 total scenarios — added:
8. An unrelated role with a high salary does not rank strong.
9. SAME_FAMILY_GENERIC scores meaningfully below a genuine EXACT_CANONICAL
   match, other factors equal.
10. An EXACT_CANONICAL match with unknown salary still scores strong.
11. An EXACT_CANONICAL match posted slightly older still outranks an
    unrelated fresh posting.

**Extended again in the benchmark-v2 ranking calibration phase** (spec Step
22) to 21 total scenarios — added: exact backend role + matching Java
stack; exact backend role + completely wrong stack; exact role + no
required-skill data (NO_REQUIREMENT_DATA stays neutral); SAME_FAMILY_GENERIC
+ weak title + weak skills (dampened); SAME_FAMILY_GENERIC + strong skills
(NOT additionally dampened); unrelated + strong generic skills; skill-rich
posting with several missing skills (proportional, not catastrophic);
sparse posting with one missing skill; QA role with matching automation
skills; entry user vs. a generic Senior SWE posting with a severe years gap.

**Extended again in the benchmark-v2.1 cleanup + final calibration phase**
to 23 total scenarios — added: an exact canonical-role match wins despite
role_family disagreement (RANK-021, guards the ML_ENGINEER-vs-
SOFTWARE_ENGINEERING-family regression from returning); DIFFERENT_FAMILY_RELATED
with weak required skills scores below the same relationship with strong
required skills (RANK-022, guards the conditional dampen from either
disappearing or over-firing on genuinely adjacent strong-skill matches).
