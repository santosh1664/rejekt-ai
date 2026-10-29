# Rejekt.ai

Rejekt.ai finds jobs straight from company career pages, scores each one against your resume, tailors your resume to the posting **without inventing anything**, and can send the application for you.

It runs on your own computer. Your resume and the job descriptions stay on your machine: the resume-rewriting model runs locally in [Ollama](https://ollama.com), and the only remote service is your PostgreSQL database.

## Contents

1. [What it does](#what-it-does)
2. [How it works](#how-it-works)
3. [Requirements](#requirements)
4. [Install](#install)
5. [Install the model](#install-the-model) (GitHub, Google Drive, or the base model)
6. [Use it](#use-it)
7. [Run the scan on a schedule](#run-the-scan-on-a-schedule)
8. [Move to another laptop](#move-to-another-laptop)
9. [Settings](#settings)
10. [How tailoring stays honest](#how-tailoring-stays-honest)
11. [Retrain the model](#retrain-the-model)
12. [Tests](#tests)
13. [Project layout](#project-layout)
14. [Troubleshooting](#troubleshooting)
15. [Privacy and security](#privacy-and-security)

---

## What it does

| | |
|---|---|
| **Scan** | Reads the career pages (Greenhouse, Lever, Ashby, Workday, Workable, SmartRecruiters, BambooHR, and more) of tens of thousands of employers on a schedule. Closed roles are marked inactive and kept in your history, never deleted. |
| **Match** | Scores every posting against your skills, titles, country and visa needs. Filters: date posted, country, workplace, job type, experience, salary, visa sponsorship, security clearance. |
| **Tailor** | One click rewrites your resume for a posting using only what your resume already shows. Skills the posting wants but your resume doesn't have are listed as gaps, never added. A role never gains bullets: a new one replaces a weaker one. |
| **ATS scan** | Scores the tailored resume from 0 to 10 against the posting, next to the untailored score, and says what is missing. |
| **Download** | Every tailored resume downloads as a PDF. "See what changed" shows each reworded bullet next to the original. |
| **Applied** | Everything you have sent, searchable, with the exact resume that went out. |
| **Auto-apply** | Lanes (titles, minimum match, workplace, how recent) pick jobs, tailor a resume, fill the form, and wait for your OK before sending if you want. |

## How it works

```
career pages ──scan──▶ PostgreSQL ──match──▶ Jobs list (filters, saved searches)
                                                  │
                                       "Tailor resume" (one click)
                                                  ▼
 your profile ─▶ local model (Ollama, jd-rewriter-v2) ─▶ guards ─▶ ATS scan ─▶ PDF
                                                                       │
                                  Applied list ◀── you apply / auto-apply lane
```

1. **Scanner** (`scanner.mjs`, `scanner/`, `providers/`) reads every company board, one provider per ATS, and stores postings in PostgreSQL.
2. **Matching** (`matching/`) ranks postings for your profile.
3. **Tailoring** (`lib/resume-match.mjs`, `lib/resume-tailor.mjs`) asks the local model to reword bullets, then rejects anything your resume doesn't support.
4. **ATS scoring** (`lib/ats-score.mjs`) grades the result 0–10.
5. **Rendering** (`lib/resume-render.mjs`) produces the PDF with headless Chrome.
6. **Auto-apply** (`autoapply/`) runs lanes you define and fills the application forms.

## Requirements

- **Node.js 20 or newer**
- **PostgreSQL 14 or newer** (local, [Neon](https://neon.tech), AWS RDS … anything that gives you a `DATABASE_URL`)
- **[Ollama](https://ollama.com)** for the resume-rewriting model (`brew install ollama` on macOS)
- **Google Chrome** (PDF resumes and the auto-apply form filler)
- macOS or Linux. About 6 GB of free disk for the model.

Only needed if you retrain the model yourself: a Mac with Apple silicon and Python 3 (see [Retrain the model](#retrain-the-model)).

## Install

### 1. Get the code

```bash
git clone https://github.com/santosh1664/rejekt-ai.git
cd rejekt-ai
npm install
```

The repo is private. If `git clone` asks for a login, sign in with the GitHub account that owns it, or run `gh auth login` first.

### 2. Configure

```bash
cp .env.example .env.local
```

Open `.env.local` and set `DATABASE_URL` to your PostgreSQL database. Everything else has a working default. Never commit `.env.local`: it is git-ignored on purpose.

### 3. Create the database tables and add companies to scan

```bash
npm run migrate     # creates the tables (safe to run again)
npm run seed        # adds a starter list of companies and their career-page boards
```

To grow the list, `npm run harvest` finds more boards from Common Crawl, and `npm run harvest:import` imports your own list of board URLs.

### 4. Install the model

See the next section. It takes one command.

### 5. Pull your first jobs

```bash
npm run scan
```

The first scan can take a while with a large company list. It resumes where it stopped if you interrupt it.

### 6. Start the app

```bash
npm start
```

`npm start` also starts Ollama if it is not running. Open **http://localhost:3000/app/**.

## Install the model

The resume-rewriting model is **jd-rewriter-v2**, a LoRA fine-tune of Qwen2.5-7B-Instruct, quantised to Q4_K_M (one 4.7 GB file, `jd-rewriter-v2-q4_k_m.gguf`). Pick one of the three ways below.

### Option A: GitHub release (one command)

GitHub limits release files to 2 GB, so the model is published as three parts under the release `model-v2`. The script downloads, joins, checks the SHA-256 and registers the model with Ollama:

```bash
gh auth login                  # once, because the repo is private
bash scripts/install-model.sh
```

### Option B: Google Drive (or any file you already downloaded)

1. Download `jd-rewriter-v2-q4_k_m.gguf` from the Drive link the owner shared with you. Large Drive files show a "can't scan for viruses" page: click **Download anyway**.
2. Check the file is not damaged. The result must be exactly this:

   ```bash
   shasum -a 256 ~/Downloads/jd-rewriter-v2-q4_k_m.gguf
   # 813e0920dfbc5a575528df9751e7fa26305a2423613f0f465dd628ccff6f0229
   ```

3. Register it with Ollama, giving the script the folder that holds the file:

   ```bash
   bash scripts/install-model.sh ~/Downloads
   ```

   The script sees the `.gguf`, skips the download, and runs `ollama create`. (It only checks the checksum on its own downloads, so do step 2 yourself.)

### Option C: no download, use the base model

It scored almost the same in testing (9.09 against 9.21 out of 10 on the ATS scan), because the guards in the code do most of the work:

```bash
ollama pull qwen2.5:7b-instruct
```

and in `.env.local`: `OLLAMA_MODEL=qwen2.5:7b-instruct`

### Switch the app to the model

For options A and B, confirm it is installed with `ollama list`, then make sure `.env.local` has:

```
OLLAMA_MODEL=jd-rewriter-v2
```

Restart `npm start`. The scan log page (`/scan-log.html`) shows which model is in use and whether Ollama is running.

## Use it

1. **Profile.** Upload your resume (PDF, DOCX or text). It is read into sections you can edit: summary, skills, experience, projects, education. This is the **default resume profile** every tailoring starts from. Set your visa and country needs here too.
2. **Jobs.** Search by title or skill, and narrow with the filters (posted, country, workplace, job type, experience, salary, visa, clearance). Searches are remembered under **Recent**, and clicking one brings its filters back. Open a job to see why it matched and which skills your resume does and doesn't show.
3. **Tailor resume.** Press **Tailor resume** on a job. It starts straight away with your default profile and takes about a minute (around 51 seconds on an Apple-silicon Mac). You get:
   - the **ATS scan**: score out of 10, the untailored score beside it, what was missing, and skills asked for that you don't have,
   - **Download PDF**, **Open PDF** and **See what changed**.
4. **Tracker and Applied.** Mark a job as applied and its tailored resume is kept under **Applied**, where each row has a **Resume ↓** link to download it again. Opening an application also has **Download resume**.
5. **Auto-apply.** Create a lane: the titles to look for (your recent titles show as chips), a minimum match, workplace types, how recent, and whether to review before sending. Auto-apply finds matching jobs, tailors a resume for each, and waits in **Waiting for your OK** until you approve.
6. **Scan log.** `http://localhost:3000/scan-log.html` shows scan history, per-board job counts, and whether Ollama and the model are running.

### Reading the ATS score

| Score | Meaning |
|---|---|
| 8.5 or more | Well matched. Send it. |
| 7 to 8.5 | Reasonable. Check "missing" for skills you do have and could add to your profile. |
| Below 7 | A weak fit, or the posting asks for things your resume doesn't show. |
| Capped at 6 | Something unsupported slipped in. Open "See what changed" and look. |

Gaps (skills you don't have) are listed but never counted against you or added to the resume.

## Run the scan on a schedule

On macOS, every four hours with launchd:

```bash
sed "s|__PROJECT_DIR__|$PWD|g" scripts/com.job-discovery-saas.scan.plist > ~/Library/LaunchAgents/com.job-discovery-saas.scan.plist
launchctl load ~/Library/LaunchAgents/com.job-discovery-saas.scan.plist
```

Stop it with `launchctl unload ~/Library/LaunchAgents/com.job-discovery-saas.scan.plist`. (The `com.job-discovery-saas.scan` job name is the original internal label and is kept so existing installs keep working.) On Linux, run `bash scripts/run-scan.sh` from cron.

## Move to another laptop

Your data lives in PostgreSQL, so nothing else needs copying except the model and your settings.

1. Clone the repo and run `npm install`.
2. Copy `.env.local` over a safe channel (it holds your database URL and keys). Don't email it or commit it.
3. Install the model with [Option A or B](#install-the-model). Everything in `ollama list` is per-machine.
4. `npm start`. Your profile, jobs and Applied list are already there, because they come from the database.

## Settings

All in `.env.local` (see `.env.example`):

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` | none (required) | PostgreSQL connection string |
| `PORT` | `3000` | Web server port |
| `OLLAMA_MODEL` | `qwen2.5:7b-instruct` | Model that rewrites bullets. Use `jd-rewriter-v2` after installing it |
| `OLLAMA_URL` | `http://localhost:11434` | Where Ollama is listening |
| `LLM_PROVIDER` | `ollama` | `anthropic`, `openrouter` or `huggingface` send resume text to those services |
| `SKIP_ATS` | none | Comma list of boards to skip, for example `workable` after a rate-limit ban |
| `WORKERS_<ATS>` | per board | How many boards of one type are scanned at once |
| `WORKABLE_GAP_MS` | per board | Pause between requests to one board. Raise it after a rate limit |
| `MISSED_SCANS_THRESHOLD` | `2` | Missed scans before a job is marked closed |

## How tailoring stays honest

- Only skills your resume already shows (in bullets, projects or the skills list) are used. A skill already listed inside a longer entry, such as `AWS (ECS, EC2, S3)`, is never added again as "also used".
- A role never gains bullets. A reworded or banked bullet only replaces a weaker one, and only if it names more of the posting's skills.
- Posting buzzwords, sentences copied from the job ad, and numbers you didn't write are rejected.
- Employers, titles and dates are never sent to the model or changed.
- The ATS score caps at 6 if anything unsupported slips in, so it can't be gamed with keywords.

Details: [docs/resume-model.md](docs/resume-model.md).

## Retrain the model

You don't need to. If you want to train on your own resume wording (Apple-silicon Mac, Python 3):

```bash
npm run ml:rewriter:generate       # best-of-N rewrites of real postings, scored by the ATS scanner
npm run ml:rewriter:export         # turn the best ones into a training set
NAME=my-rewriter DATA=ml/data/<export-folder> npm run ml:rewriter:train
NAME=my-rewriter npm run ml:rewriter:install     # converts to GGUF and registers with Ollama
npm run ml:rewriter:eval-ats       # compare models on the same postings
```

Then set `OLLAMA_MODEL=my-rewriter`. Training and the file formats are explained in [docs/resume-model.md](docs/resume-model.md).

## Tests

```bash
npm run test:resume-model    # resume tailoring, scoring, layout
npm run test:auto-apply      # auto-apply rules
npm run test:profiles        # some tests need a local test database, see docs/SETUP.md
```

## Project layout

```
server.mjs, api/        web server and REST API (docs/API.md)
public/app/             the dashboard (single page)
scanner/, providers/    career-page scanners, one provider per ATS
matching/               job scoring and recommendations
lib/                    resume tailoring, ATS scoring, rendering, search, database
autoapply/              lanes, form filling, answers
ml/                     model training, evaluation and the Modelfile
db/schema.sql           database tables
scripts/                installers, scheduled scan, tests
docs/                   design notes and reference
```

## Troubleshooting

| Problem | Fix |
|---|---|
| "Ollama isn't running", or bullets aren't rewritten | Run `ollama serve` (or just `npm start`), then `ollama list`. If the model is missing, run `bash scripts/install-model.sh`. |
| The app still uses the old model | Check `OLLAMA_MODEL` in `.env.local` and restart `npm start`. |
| The PDF opens as a web page, not a PDF | Chrome could not start. Install Google Chrome, run `npm install`, and restart. |
| A board shows errors on every company | It has probably rate-limited your IP (HTTP 429). Add it to `SKIP_ATS`, wait, then raise `WORKABLE_GAP_MS` (or the matching setting) before turning it back on. |
| Certificate error connecting to the database | Set `NODE_TLS_REJECT_UNAUTHORIZED=0` in `.env.local` (development only). |
| `install-model.sh`: "Checksum mismatch" | The download is damaged. Delete the download folder and run again. |
| `gh release download` says not found | Run `gh auth login` with the account that can see the private repo. |
| Port 3000 is in use | Set `PORT=3001` in `.env.local`. |

## Privacy and security

- Your resume, profile and applications live in your own database. Resume rewriting runs locally unless you switch `LLM_PROVIDER` to a hosted service.
- `.env.local`, your resume files, scan logs and imported application history are git-ignored. Never put a database URL, password or API key in a tracked file.
- The `jd-rewriter-v2` model was fine-tuned on resume rewrites written from the author's own resume, so treat the weights as personal data. Keep the GitHub release and any Drive link **private or restricted to named people**, never "anyone with the link".
- Rotate any key or password that was ever shown in a log, chat or commit.
