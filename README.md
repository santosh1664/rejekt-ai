# Rejekt.ai

Rejekt.ai finds jobs straight from company career pages, scores each one against your resume, tailors your resume to the posting **without inventing anything**, and can send the application for you.

It runs on your own computer. Your resume and the job descriptions stay on your machine: the resume-rewriting model runs locally in [Ollama](https://ollama.com), and the only remote service is your PostgreSQL database.

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

## Requirements

- **Node.js 20 or newer**
- **PostgreSQL 14 or newer** (local, [Neon](https://neon.tech), AWS RDS … anything that gives you a `DATABASE_URL`)
- **[Ollama](https://ollama.com)** for the resume-rewriting model
- **Google Chrome** (PDF resumes and the auto-apply form filler)
- macOS or Linux. About 6 GB of free disk for the model.

Only needed if you retrain the model yourself: a Mac with Apple silicon and Python 3 (see [docs/resume-model.md](docs/resume-model.md)).

## Install

### 1. Get the code

```bash
git clone https://github.com/santosh1664/rejekt-ai.git
cd rejekt-ai
npm install
```

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

The resume-rewriting model is **jd-rewriter-v2**, a LoRA fine-tune of Qwen2.5-7B-Instruct (4.7 GB). GitHub limits release files to 2 GB, so it is published as three parts. One command downloads, joins, checks and registers them:

```bash
bash scripts/install-model.sh
```

Then check it is installed with `ollama list`, and make sure `.env.local` has:

```
OLLAMA_MODEL=jd-rewriter-v2
```

**No download?** Use the base model instead. It scored almost the same in testing (9.09 against 9.21 out of 10 on the ATS scan), because the guards in the code do most of the work:

```bash
ollama pull qwen2.5:7b-instruct
# and in .env.local:  OLLAMA_MODEL=qwen2.5:7b-instruct
```

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

## Use it

1. **Profile.** Upload your resume (PDF, DOCX or text). It is read into sections you can edit: summary, skills, experience, projects, education. This is the **default resume profile** every tailoring starts from. Set your visa and country needs here too.
2. **Jobs.** Search by title or skill, and narrow with the filters. Searches are remembered, and each saved search brings its filters back with one click. Open a job to see why it matched and which skills your resume does and doesn't show.
3. **Tailor resume.** Press **Tailor resume** on a job. It starts straight away with your default profile and takes about a minute. You get:
   - the **ATS scan** (score, what was missing, skills asked for that you don't have),
   - **Download PDF**, **Open PDF** and **See what changed**.
4. **Tracker and Applied.** Mark a job as applied and its tailored resume is kept under **Applied**, where each row has a **Resume ↓** link to download it again.
5. **Auto-apply.** Create a lane: the titles to look for, a minimum match, workplace types, and whether to review before sending. Auto-apply finds matching jobs, tailors a resume for each, and waits in **Waiting for your OK** until you approve.
6. **Scan log.** `http://localhost:3000/scan-log.html` shows scan history, per-board job counts, and whether Ollama and the model are running.

### Keep the scan running

Scan on a schedule (macOS, every four hours):

```bash
sed "s|__PROJECT_DIR__|$PWD|g" scripts/com.job-discovery-saas.scan.plist > ~/Library/LaunchAgents/com.job-discovery-saas.scan.plist
launchctl load ~/Library/LaunchAgents/com.job-discovery-saas.scan.plist
```

(The `com.job-discovery-saas.scan` job name is the original internal label and is kept so existing installs keep working.)

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
| `MISSED_SCANS_THRESHOLD` | `2` | Missed scans before a job is marked closed |

## How tailoring stays honest

- Only skills your resume already shows (in bullets, projects or the skills list) are used. A skill already listed inside a longer entry, such as `AWS (ECS, EC2, S3)`, is never added again.
- Posting buzzwords, sentences copied from the job ad, and numbers you didn't write are rejected.
- Employers, titles and dates are never sent to the model or changed.
- The ATS score caps at 6 if anything unsupported slips in, so it can't be gamed with keywords.

Details: [docs/resume-model.md](docs/resume-model.md).

## Tests

```bash
npm run test:resume-model    # resume tailoring, scoring, layout
npm run test:auto-apply      # auto-apply rules
npm run test:profiles        # some tests need a local test database, see docs/SETUP.md
```

## Project layout

```
server.mjs, api/        web server and REST API
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

- **"Ollama isn't running" or bullets aren't rewritten.** Run `ollama serve` (or just `npm start`), then `ollama list`. If the model is missing, run `bash scripts/install-model.sh`.
- **The PDF opens as a web page, not a PDF.** Chrome could not start. Install Google Chrome, then run `npm install`, and restart.
- **A board shows errors on every company.** It has probably rate-limited your IP (HTTP 429). Add it to `SKIP_ATS`, wait, then raise `WORKABLE_GAP_MS` (or the matching setting) before turning it back on.
- **The database refuses the connection with a certificate error.** Set `NODE_TLS_REJECT_UNAUTHORIZED=0` in `.env.local` (development only).

## Privacy

Your resume, profile and applications live in your own database. Resume rewriting runs locally unless you switch `LLM_PROVIDER` to a hosted service. `.env.local`, your resume files, scan logs and imported application history are git-ignored.

The `jd-rewriter-v2` model was fine-tuned on resume rewrites written from the author's own resume, so treat the weights as personal data and don't re-share them publicly.
