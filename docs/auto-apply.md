# Application records, resume tailoring and auto-apply

Added 2026-10-23.

- **Code:**
  - `lib/applications.mjs`
  - `lib/resume-tailor.mjs`
  - `lib/resume-render.mjs`
  - `autoapply/` (`engine.mjs`, `answers.mjs`, `form-fill.mjs`, `run.mjs`)
  - the Auto-apply screen in `public/app/index.html`
- **Tests:** `npm run test:auto-apply` runs the pure checks. With a local
  database and Chrome, add `-- --db` to fill the local form copies in
  `fixtures/forms/`.

## 1. What's stored when you apply

### Before

An application row held only `job_id`, status and timestamps. Two things
lost the job you'd applied to:

- Every scan overwrites `jobs.description`.
- `job_id` is `ON DELETE SET NULL`, so a purged job left a blank row.

### Now

| Stored | When |
|---|---|
| `job_snapshot` (title, company, location, URL, ATS, workplace, type, salary, posted date, full description) | when a job is first tracked, and again when it moves to Applied. The migration backfills existing rows. |
| `application_events` | every status change, auto-apply step, tailoring and notes edit, each with a timestamp |
| `tailored_resume`, `resume_profile_id` | the exact resume version that was sent, and which profile it came from |
| `cover_letter`, `answers` | the letter and the form answers that were sent |
| `source`, `lane_id`, `apply_state`, `apply_detail`, `submitted_at` | auto-apply state, what it filled in, and why it stopped |

The application drawer in the tracker shows all of this: the history, the
resume sent (PDF), the answers, and the posting as it was saved.

## 2. Resume tailoring per job

This follows the same approach as Tsenta's optimized resume. Tsenta's
"aggressive" mode also adds skills from the posting that you never listed;
this project doesn't.

There are three modes, chosen per lane or per job:

### `honest` (default)

- Every role, title, company, date and bullet is kept.
- Bullets that use the posting's skills move up within each role.
- Projects and skill groups are reordered the same way.
- A skill the posting asks for is added to the skills list only if your
  resume already shows it, for example in a bullet or a project's stack.
- Required skills you don't show are reported as gaps and never inserted.

### `ai`

A language model rewords bullets toward the posting. By default it's a local
model run by Ollama on your computer (docs/resume-model.md); Claude can be
used instead with `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`. Each
rewritten bullet is then checked: if it introduces a skill your resume
doesn't show, or a number the original didn't have, the original is put
back. When no model is reachable, this mode falls back to `honest`.

### `off`

The resume is sent exactly as written.

### Output

The output is a one-column page with no tables or images, which ATS
software reads well. It renders as HTML and as a PDF through headless
Chrome. Endpoints:

- `POST /v1/users/:id/applications/:appId/tailor {mode, resumeProfileId}`
- `GET …/resume[?format=pdf]`

On a job's detail, **Tailor resume** does the same from the UI.

## 3. Auto-apply

### Settings and lanes

- **Per user:** on/off, applications per day (default 25), applications per
  company in 30 days (default 3), and whether to tick required "I agree"
  boxes (off by default).
- **Lanes:** one lane is one kind of role sent with one resume profile.
  Each lane has a minimum match score, title terms to include, terms to
  exclude, title words to skip (senior, staff, lead…), how recently the job
  was posted, workplace types, a tailoring mode, and "let me review before
  sending" (on by default).

### Pipeline (`autoapply/engine.mjs`)

1. **Plan.** For each lane, take the user's ranked feed (scored with the
   lane's resume profile) and keep jobs that:
   - score at or above the lane's minimum
   - pass the lane's title and term rules
   - aren't already tracked
   - are on a board it can fill (Greenhouse, Lever or Ashby)
   - fit within the daily and per-company caps

   These become applications in state `QUEUED`.
2. **Prepare.** Tailor the resume, fill in the cover-letter template, and
   build the answer book from the profile's saved application answers.
   State: `PREPARED`.
3. **Fill.** Open the real form in Chrome and fill every field it has an
   answer for, including the resume PDF. Then:
   - If the lane reviews first, it stops without sending. State:
     `NEEDS_REVIEW`.
   - Otherwise, or once you approve, it submits and waits for the board's
     confirmation. State: `SUBMITTED`, and the tracker shows Applied.
   - A CAPTCHA, a required question it has no answer for, or a form error
     moves it to `NEEDS_YOU`, with the reason and the questions shown.
     Answer them on the Auto-apply screen, and tick "save to my profile" so
     later forms reuse your answers.
   - Any other error is retried, up to three attempts, then marked
     `FAILED`.

### What it never does

It never solves CAPTCHAs and never guesses an answer it doesn't have.

### Running it

- In the app: **Preview** shows what the next run would pick (a dry run;
  nothing is written). **Run now** runs it.
- On a schedule: run `npm run autoapply` a few times a day, the same way
  you schedule the scanner. Options:
  - `-- --user <uuid>` runs one user
  - `-- --dry-run` plans only
- Running it needs Chrome, or `CHROME_PATH` pointing at a Chromium binary.
  Set `AUTO_APPLY_HEADFUL=1` to watch it fill forms.

### How the form filler was built

The scanner and filler in `autoapply/form-fill.mjs` were built from live,
read-only inspection of real Greenhouse, Lever and Ashby application forms,
with nothing submitted. Each board works a little differently:

| Board | How its forms behave |
|---|---|
| Greenhouse | React-select dropdowns that open a list tied to the field |
| Lever | an hCaptcha that appears only at submit, so it stops there and hands back to you |
| Ashby | required questions marked with a `required` class on the label; Yes/No questions are `button[data-option]` pairs |

Board markup changes over time. When a form stops filling, the reason
appears on the application.

## API

```
GET/PUT  /v1/users/:id/auto-apply                         settings, lanes, recent runs, running flag
POST     /v1/users/:id/auto-apply/lanes                   add a lane (max 5)
PATCH/DELETE /v1/users/:id/auto-apply/lanes/:laneId
POST     /v1/users/:id/auto-apply/preview                 dry run
POST     /v1/users/:id/auto-apply/run                     run now (background)
GET      /v1/users/:id/applications?source=auto
GET      /v1/users/:id/applications/:appId                snapshot, history, resume, answers
POST     /v1/users/:id/applications/:appId/tailor         {mode, resumeProfileId}
GET      /v1/users/:id/applications/:appId/resume         ?format=pdf
POST     /v1/users/:id/applications/:appId/answers        {answers, remember, approve}
POST     /v1/users/:id/applications/:appId/approve|skip|submit
```

## Testing locally

`AUTO_APPLY_ALLOW_LOCAL=1` lets the engine fill forms served from
`localhost` (`fixtures/forms/`). The test suite uses this, and it's how the
UI was checked end to end. Never set it in production.

## What changed (tailored resumes)

Added 2026-10-24. "See what changed" (in the tailoring panel and on each
application) opens the tailored resume with the changes marked:

- **Yellow:** reworded for this job. Click or hover to see your original text.
- **Green:** a new bullet, or a skill added to the skills section.
- A bar at the top counts reworded, new and unchanged bullets, and can turn the
  highlights off. Neither the bar nor the highlights print.

The comparison is with the profile as it was when the resume was tailored
(`resume_rewrites.resume_before`), or the current profile for imported
applications. Bullets are matched by wording, not position, so a bullet that
only moved up counts as unchanged (`lib/resume-diff.mjs`).

API: `GET /v1/users/:id/applications/:appId/changes` (JSON list with
originals) and `GET …/resume?changes=1` (the page).
