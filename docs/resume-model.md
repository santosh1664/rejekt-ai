# Resume model, training data and the Applied screen

Added 2026-10-23.

- **Code:**
  - `lib/llm.mjs`
  - `lib/resume-tailor.mjs` (rewriting and the fact check)
  - `lib/resume-match.mjs`, `lib/bullet-bank.mjs` ("Match the job")
  - `lib/ats-score.mjs`, `ml/generate-best-of-n.mjs`, `ml/eval-ats.mjs`, `ml/build-posting-idf.mjs` (best-of-N training)
  - `lib/rewrites.mjs`, `lib/rewriter-dataset.mjs`
  - `lib/import-tsenta.mjs`, `lib/applied-search.mjs`
  - `ml/export-rewriter-dataset.mjs`, `ml/finetune-rewriter.sh`, `ml/eval-rewriter.mjs`
  - the Applied screen in `public/app/index.html`
- **Tests:** `npm run test:resume-model` (add `-- --db` for the database and API checks)

## 1. Tailoring modes

| Mode | What it does |
|---|---|
| **Match the job** (default) | Rewrites the resume for the posting the way a resume writer, and Tsenta, does: adds the posting's skills, works its language into your bullets, writes new bullets for the current and previous role, rewrites the summary, and puts skills first for data roles. **Since 2026-10-25 it only uses skills your resume already shows** (bullets, projects, stacks): posting skills it can't support are listed in `report.gaps`, never added, and any rewrite, new bullet, bank bullet or summary that names an unshown skill or adds filler is refused. **Since 2026-10-28 a role or project never gains bullets:** each new or bank bullet replaces the least relevant old bullet below the top two (a block with only two bullets gets none). |
| Reorder only | Moves the bullets and skills the posting cares about to the top, and adds nothing. |
| Reword, no new skills | Rewords bullets toward the posting. Any rewrite that adds a skill or number your resume doesn't show is undone. |
| Use as is | Sends the profile unchanged. |

The mode is set per auto-apply lane and per job in the tailoring panel.

### How Tsenta customized your resumes

This was measured on the 20 resumes Tsenta sent (`data/imports/tsenta/details.jsonl`), each compared with its posting and with the other resumes built from the same base profile.

- **Never changes:** employers, job titles, dates and education.
- **Bullets kept as they are:** 326 of 447 bullets (73%) went out word for word.
- **Bullets edited:** 59 (13%), mostly by extending the bullet with a clause in the posting's language. For example, "…GitLab CI" became "…GitLab CI, operating Git-based workflows and CI/CD for every release". Of the words added, 82% come straight from the posting.
- **Bullets added:** 62 (14%) were new or heavily rewritten, mostly in the current role (33 against 8 in the previous role). They're written in the same voice, with the posting's tools.
- **Skills:** 10–24 of the posting's tools are added to the skill groups whenever the posting lists them.
- **Summary:** rewritten for the role. It usually keeps "Software Engineer with 3+ years…" and leads with the posting's focus.
- **Section order:** data and analytics roles get skills above experience.

### How you customized your own resume

Measured on 2026-10-23 by comparing your original Software Engineer resume with the version you tailored for an AI role:

- **Every bullet changed:** 0 of 29 bullets went out word for word (Tsenta left 73% untouched).
- **Edits:** bullets were tightened and ended with a clause in the posting's language, such as "keeping API contracts documented and consistent for consuming teams". The current role is in present tense, and posting tools like TypeScript and Terraform were worked in.
- **Bullets added:** 7, and every one came from an earlier version of your resume (the bullets Tsenta sent), not newly written. Citigroup went from 6 to 8 bullets, Zensar from 5 to 9, and the junior role from 4 to 5.
- **Metrics:** several were dropped (25%, 40%, 90%, 60%); none were added. 115,600 became 115.6K.
- **Summary:** longer (90 → 103 words), with years of experience, the posting's tools, and the degree at the end.
- **Skills:** regrouped around the posting (for example "Generative AI & Agentic AI", "AI Evaluation"), with posting tools added and unrelated ones (React.js, Angular, NLTK) removed.
- **Never changed:** employers, titles and education.

### How "Match the job" reproduces it (`lib/resume-match.mjs`)

1. **Skills.** The posting's skills (from its text and its tag list) are added to the group that fits, such as Terraform next to Docker and Kubernetes. Soft skills are left out, names are tidied (JSON, YAML), and at most 15 are added, the required ones first.
2. **Bullets you wrote before (`lib/bullet-bank.mjs`).** The bullet bank holds every bullet you've written for each role and project, from all your resume profiles, your own examples (below) and the resumes Tsenta sent. Bullets the model wrote here are left out. For each role, the bank bullets that best fit the posting come back first:
   - current role: up to 2
   - previous role: up to 4
   - older roles and the main project: up to 1
3. **Rewording.** Each role or project goes to the model with the posting. Every bullet may be reworded, and the model may write at most 1 new bullet for the current and previous roles. A rewrite may drop a metric, as you did, but never adds or changes a number. New bullets go in third place, where a reader looks, and one that already appears elsewhere is dropped. Every original bullet stays.
4. **Summary.** It's rewritten for the posting in 70–110 words, opening with your title and years of experience exactly as they are, so the summary keeps "Software Engineer". It may end with your degree.
5. **Never sent to the model:** employers, titles and dates, so they can't change.
6. **Examples from your history.** The instructions include a few real before-and-after examples, which helps a small local model match the style. Your own examples come first, then your Tsenta history.
7. **Without a model,** the skills are still added, bullets from the bank are still brought back, and the resume is reordered. The report says the bullets weren't reworded.

The report on each application shows:

- skill coverage before and after
- the skills added
- how many bullets were reworded
- the added bullets, where each one went, and which ones you wrote before

### Your own examples

Add an original resume and the version you tailored for one job on Profile → Resume, under "How you tailor a resume". PDF, Word or plain text all work. From the command line:

```
npm run resume:example -- --user <id> --original base.pdf --tailored tailored.pdf --jd posting.txt --title "Software Engineer, AI" --company Acme
```

Each pair is used three ways:

- **Style:** its before → after bullets go into the model's instructions ahead of Tsenta's.
- **Bullet bank:** both versions' bullets can come back for later postings.
- **Training:** with the posting included, it becomes gold examples in the dataset export. Without the posting it's used for style and the bank only.

API: `GET/POST /v1/users/:id/resume-examples`, `DELETE /v1/users/:id/resume-examples/:exampleId`. The POST body is `{ original, tailored, jobTitle, company, jobDescription }`, where each resume is text or resume sections.

### Set up (once)

```
brew install ollama            # or the installer from ollama.com
ollama pull qwen2.5:7b-instruct
```

Optional settings in `.env.local`:

```
OLLAMA_MODEL=qwen2.5:7b-instruct    # or your fine-tuned jd-rewriter
OLLAMA_URL=http://localhost:11434
LLM_PROVIDER=anthropic              # to use Claude instead (needs ANTHROPIC_API_KEY)
```

The Applied screen shows whether the model is running and which one it is.
So does the tailoring panel when you pick "Rewrite with local model".

## 2. Training data: every posting and resume is kept

| Table | What it holds |
|---|---|
| `resume_rewrites` | One row per tailoring: the posting, the resume before, the resume after, and the report. The report includes each block's input and the bullets kept. When the application moves to Applied, the row is marked `sent`. Later moves (Interviewing, Offer, Rejected, No reply) are stored as `outcome`. |
| `applications` | As before: the posting snapshot, the resume and cover letter sent, the answers and the history (docs/auto-apply.md). |

### Export a dataset

```
npm run ml:rewriter:export -- --user <your user id>            # "match the job" style (default)
npm run ml:rewriter:export -- --user <your user id> --style honest
```

In the match style, each Tsenta resume becomes examples in the exact
format the app uses: the posting and your role's bullets go in, and the
bullets Tsenta reworded or added come out, plus the summary it wrote. Your 20
Tsenta resumes give about 100 examples. Every "Match the job" rewrite you
send adds more.

The honest style (below) is kept for the "Reword, no new skills" mode.

This writes `ml/data/rewriter/{train,valid,test}.jsonl` in chat format, one
example per block. They use exactly the prompts the app sends, so a model
trained on them sees the same thing at run time. The data comes from:

- **Your own examples:** each block's original bullets go in, and your tailored
  bullets and added bullets come out. These are the best examples.
- **Rewrites made here:** the bullets that went in, and the bullets kept after
  the fact check.
- **Resumes Tsenta sent:** there's no "before" for these. Each Tsenta bullet is
  matched to the closest bullet in your own default profile, for the same
  company or project. A pair is kept only if they clearly describe the same
  work and the Tsenta version passes the fact check. Tsenta's invented bullets
  and added skills are dropped, so the model doesn't learn to pad.

The split is by posting, so one posting's blocks never land in both train
and test. `stats.json` reports how many Tsenta bullets were kept, dropped,
or had no match. Use `--sent-only` to limit the export to resumes that were
actually sent, or `--no-tsenta` to skip Tsenta's resumes.

### Fine-tune Qwen on your best rewrites (Mac with Apple silicon)

Your 8,020 Tsenta applications are near-copies of one base resume, and Tsenta
left 73% of bullets unchanged, so training on them directly would teach
Tsenta's habits. Instead the model learns from its own best work (best-of-N):

1. **Postings.** `data/imports/tsenta/postings.jsonl` holds 300 varied postings
   pulled from your Tsenta history on 2026-10-23: 70 AI/ML, 55 backend, 50
   general software, 40 full-stack, 30 data engineering and smaller groups for
   frontend, DevOps, analyst, mobile and QA. At most 2 per company.
2. **Generate (overnight).** Each posting is tailored 3 times with Qwen at a
   higher temperature, and every version is graded by the ATS scorer below. The
   best version per posting is kept. Roughly 1 minute per version on an M2 Pro,
   so 120 postings take about 6 hours. Stop with Ctrl+C and run again to resume.
3. **Export.** Only versions scoring 9 or more become training examples, one per
   role, project and summary, using exactly the prompts the app sends.
4. **Train.** LoRA on Qwen2.5 7B Instruct with MLX, merged and installed in
   Ollama as `jd-rewriter`, with the same chat template as `qwen2.5:7b-instruct`.
5. **Compare.** Both models tailor your resume for 20 postings neither trained on,
   and the ATS scorer grades them.

```
npm run ml:rewriter:generate -- --user <your user id>     # 2. overnight; --limit 200 for more data
npm run ml:rewriter:export -- --style bon                 # 3. add --min 8.5 if too few reach 9
npm run ml:rewriter:train                                 # 4. about 30–60 min, needs ~25 GB free disk
npm run ml:rewriter:eval-ats -- --user <your user id>     # 5.
```

If `jd-rewriter` scores higher, set `OLLAMA_MODEL=jd-rewriter` in `.env.local`
and restart the app.

- **Memory:** training Qwen 7B (4-bit) fits in 16 GB with 8 LoRA layers and
  gradient checkpointing. Quit Ollama and other heavy apps while it trains. On 8
  GB, use `BASE_MODEL=mlx-community/Qwen2.5-3B-Instruct-4bit BASE_OLLAMA=qwen2.5:3b-instruct`.
- **Enough data:** aim for 150+ training examples (about 40+ postings scoring
  9+). Below that the model memorizes; generate more first.
- **More postings:** pull more with Tsenta's `get-jobs-by-ids` (12 per call with
  `descriptionMaxChars: 4000`), append them to `postings.jsonl`, and run
  `npm run ml:rewriter:idf` to refresh the keyword weights.

#### ATS score (`lib/ats-score.mjs`)

A 0–10 score that the generator uses to pick the best version and the
comparison uses to grade models. The parts follow career-ops' ATS rules and
recruiter review gates:

| Part | Points | What earns them |
|---|---|---|
| Coverage | 4 | The posting's skills (required ones count double) and key terms appear on the resume. Key terms are the posting's words and phrases weighted by how rare they are across all postings (`data/posting-idf.json`); using 60% of them counts as full marks. |
| Evidence | 1.5 | Those skills appear in the summary or bullets, not only in the skills list. |
| Placement | 1.5 | The summary names the top keywords, and each role's first bullet names one. |
| Integrity | 2 | Employers, titles and dates are unchanged; every original bullet is still there; no new numbers (bullets you wrote before count as yours); nothing pasted from the posting. |
| Writing | 1 | No clichés, varied bullet openings, bullets of 60–320 characters, a summary of 35–130 words. |

Your untailored resume scores a median of 6.5 across the 300 postings.

#### The older evaluation

`npm run ml:rewriter:eval` scores a model on the exported test set, block by
block:

| Measure | What it means |
|---|---|
| valid | right JSON and the right number of bullets |
| honest | share of bullets that pass the fact check |
| changed | share of bullets actually reworded |
| skillGain | posting skills surfaced per bullet |
| closeness | word overlap with the reference rewrite |

## 3. Applied: everything you've sent

The Applied screen in the left menu lists every application with the posting
and the resume that went out. It follows Tsenta's submitted list:

- **One search box:** a phrase is matched in company, job title, job link and
  posting text. Links are also compared on letters and digits only, so
  "acme health" finds `acme-health.wd5.myworkdayjobs.com`.
- **Field filters:** the chips limit the search to some fields and show how
  many applications matched in each.
- **Results:** each row shows which fields matched, the posting text around a
  match, and whether the posting and resume were saved.
- **By company:** one row per company, with how many roles you applied to
  there. Clicking one lists them.
- **Opening a row:** shows the history, the posting, and the resume sent
  (PDF or page). From there you can move the application to Interviewing,
  Offer and so on.
- **API:** `GET /v1/users/:id/applied?q=&fields=&source=all|app|tsenta&groupBy=company&page=`

### Your Tsenta history

`data/imports/tsenta/` holds your Tsenta export. This folder is in
`.gitignore` because it's personal.

- `applications.jsonl` has all 8,020 submitted applications as of
  2026-10-23: company, title, link, board and dates.
- `details.jsonl` has the full posting for the 50 most recent, and the resume
  Tsenta sent for the 20 most recent.

Before the files were written, these were removed: date of birth, home
address, EEO answers, and work-authorization and salary answers.

Import it with the button on the Applied screen, or with
`npm run import:tsenta -- --user <id>`. Running it again updates the rows
instead of duplicating them.

- **Tracker:** imported applications stay off the Tracker board until you
  move one, for example to Interviewing.
- **Added skills:** for a resume Tsenta sent, the application lists the skills it added beyond your own profile, so you can see at a glance what that version of the resume claims.

More postings and resumes can be pulled from Tsenta later with the same
tools: `get-jobs-by-ids` for postings, and `get-application-status` with
`optimizedProfile` for resumes. Append them to `details.jsonl` and re-import.
