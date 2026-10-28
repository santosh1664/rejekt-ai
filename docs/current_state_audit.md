# Resume rewriter: current state audit (2026-10-25)

Read-only audit for the "Qwen2.5-7B Resume Writer v2.0" brief. Nothing here was run on a GPU, retrained, or replaced.

## 1. The brief's assumptions vs. this repo

| Brief assumes | Repo actually has |
|---|---|
| Colab T4, Unsloth, TRL, PEFT | **MLX LoRA on Apple silicon** (`ml/finetune-rewriter.sh`), 4-bit `mlx-community/Qwen2.5-7B-Instruct-4bit`, 8 layers, ~200 iters |
| FastAPI + React | **Node/Express** (`server.mjs`, `api/server.mjs`) + a single-file vanilla JS UI (`public/app/index.html`) |
| Python services | JS modules in `lib/` (`resume-tailor.mjs`, `resume-match.mjs`, `ats-score.mjs`, ...) |
| LoRA adapter, optional GGUF | Adapter in `ml/out/jd-rewriter/adapter/` (checkpoints at iters 100, 200), fused weights, and `jd-rewriter-q4_k_m.gguf` served by **Ollama** as `jd-rewriter` |
| 62/6/19 split | Confirmed: `ml/data/rewriter/{train 62, valid 6, test 19}.jsonl`, from 87 examples (66 postings, 70 blocks, 17 summaries) |

## 2. Architecture today

`lib/llm.mjs` (Ollama default) -> `lib/resume-tailor.mjs` (modes `off | honest | ai | match`; `honest` reorders, `ai` rewords with a fact check) and `lib/resume-match.mjs` (`match`). Default mode everywhere is **`match`** (`api/server.mjs:593`, `autoapply/engine.mjs:97,274`). Scoring: `lib/ats-score.mjs` (0-10). Training data: `ml/generate-best-of-n.mjs` -> `ml/export-rewriter-dataset.mjs --style bon` (keeps versions scoring >= 9).

## 3. Root causes of the Docplanner defects

1. **DEFECT-001/002/003/004 are the default mode working as designed.** `resume-match.mjs` is documented as "tailor a resume the way Tsenta does": add the posting's skills to the skills section, work posting language into bullets, write new bullets for the current role. That is keyword stuffing, unsupported skills (Node.js, Terraform) and expansion by construction. The same text also appears in `docs/resume-model.md` section 1.
2. **The training target rewards the same behaviour.** `ats-score.mjs` gives 4.0/10 to posting-skill coverage, 1.5 to "summary names top keywords" and 1.5 to placement. Best-of-N keeps outputs scoring >= 9, so the adapter was selected for keyword insertion. Only 19 of 66 postings passed the bar (`stats.json`: kept 19, below 47). Integrity is 2.0/10, so a high-coverage output with invented content can still pass.
3. **Possible external source.** If the "generated resume" in the report is one Tsenta sent, none of this code produced it. `unsupportedClaims()` exists to flag those.
4. **DEFECT-005 (unsupported causality) and DEFECT-006 (no traceability)** are not checked anywhere. Facts are validated by skill-name and number sets only; there are no evidence IDs.

What the `ai` mode already enforces (and I tightened today): same bullet count/order, no new skills, no new numbers, no posting filler words, no rewrite that duplicates another bullet. Titles, companies and dates are never sent to the model.

## 4. Confirmed gaps against the brief

- No evidence registry / IDs, no requirement-to-evidence status (direct / partial / related / missing), no gap report, no change log per claim.
- No `contributed -> led` / `built -> architected` check (scope inflation), no personal-vs-professional check (Test 8), no causality check.
- Dedup was word-overlap only (added today), within one block; nothing across a role.
- Dataset: no group-based split (no resume/JD identity recorded), no contamination check, one user's resume dominates, no hard negatives stored, no rejected-output store.
- No export round-trip test; no benchmark of 100-200 pairs (the 19 test examples are the only held-out data and come from the same pipeline).
- Missing info needed before training: is the Docplanner source resume and the "existing generated" resume saved in the repo? Not found. The `ml/data/all/your-resume` folder is the closest candidate.

## 5. Training readiness

Not ready to retrain. 62 train examples selected by a keyword-weighted score would reproduce the defect. Order of work: (a) fix the objective/selection, (b) build the benchmark, (c) only then retrain on MLX (the existing script) with the old adapter kept.

## 6. Ordered checklist (proposed)

1. Make `ai` (reword, no new skills) the default instead of `match`, or gate `match` behind an explicit opt-in. Smallest change that removes DEFECT-001..004.
2. Add the Docplanner resume + JD as a regression fixture (needs the source files) with pass/fail asserts for the 6 defects.
3. Add evidence IDs and per-bullet `source_evidence_ids` to the block output (`report.blocks` already records input/output per block).
4. Extend `checkRewrite`: scope-verb inflation, project-tech under a job, changed metric qualifiers.
5. Requirement matcher + gap report (skills already have a taxonomy: `lib/skills.mjs`, `jobSkillMap`).
6. Rework `ats-score.mjs` weights: integrity as a hard gate, coverage only counts skills the source supports.
7. Rebuild dataset selection with that score; add group split + stored rejected outputs; audit report.
8. Benchmark of 100+ pairs, then baselines E0-E2, then optional MLX retrain (E3).
9. UI review panel (accept / restore / edit per bullet) in the existing page.

## 7. Decisions needed

- **Stack:** implement in the existing Node code (recommended), or add a Python/FastAPI service as the brief describes? The latter is a large rebuild with no functional gain here.
- **Default mode:** OK to switch the default from `match` to `ai`?
- **Files:** where are the Docplanner source resume and the generated one?
