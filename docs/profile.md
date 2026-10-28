# Profiles and resume import

Added 2026-10-23.

- **Code:** `lib/resume-profiles.mjs`, `lib/resume-extract.mjs`, the
  resume-profile endpoints in `api/server.mjs`, and the Profile screen in
  `public/app/index.html`
- **Tests:** `npm run test:profiles` (add `-- --db` for API tests against a
  local database)
- **Fixtures:** `fixtures/resumes/`

## Model

A user keeps up to 10 named **resume profiles**, for example "AI Engineer" and
"Java Full Stack". Each one has its own resume file text, cover-letter
template, and these sections, stored as validated JSON in
`resume_profiles.sections`:

| Section | Fields |
|---|---|
| personal | fullName, headline, email, phone, city, state, country, linkedin, github, portfolio, openToWork |
| summary | text |
| experience[] | company, title, location, startDate, endDate, current, bullets[] |
| education[] | school, degree, field, startDate, endDate, gpa, description |
| projects[] | name, role, url, startDate, endDate, technologies[], bullets[] |
| skills[] | { group, items[] } |
| certifications[] | name, issuer, date, url |
| custom[] | title, body (awards, publications, volunteering…) |
| applicationDefaults | work authorization (basis, permit/visa, status, expiry, authorized, needs sponsorship, citizenship), availability (in-person, relocate, start now, notice, transport, accommodations, salary), background (prior employee, clearance, government ties), voluntary EEO (gender, ethnicity, veteran, disability) |

Section list and application-default fields follow what Tsenta's profile page
holds. The field definitions are in `APPLICATION_DEFAULT_FIELDS` and are
served to forms by `GET /profile/fields`.

Dates are normalized to `YYYY-MM` (or `YYYY`) from inputs like "Aug 2023",
"8/2023" or "2023-08-15".

### Default profile drives matching

Saving the default profile, or making a profile the default, syncs the
fields matching reads. Values the profile doesn't know never blank out
existing ones.

| Matching field | Comes from |
|---|---|
| `user_profiles.current_title` | the current or latest role |
| `user_profiles.total_experience_years` | experience dates, with overlapping roles merged |
| `user_profiles.highest_education_level` | the education entries |
| city, state, country, contact details and summary | the personal section |
| `user_profiles.needs_sponsorship` and `work_authorization` | application answers |
| `user_skills` | every skill in every group |

### Completeness

There are 10 checklist items:

- name
- email and phone
- location
- summary of at least 80 characters
- an education entry
- an experience entry with bullets
- at least 5 skills
- the work-authorization answers
- a profile link
- an uploaded resume

The percent shown is items done ÷ 10, and the UI lists what's still missing.

## Resume import

1. `POST /api/parse-resume` (server.mjs) extracts text from PDF, DOCX or TXT.
   It now also returns `text` and `sections`.
2. `POST /v1/users/:id/resume-profiles/:pid/import-resume {text, filename, mode}`
   runs `extractResumeSections()` and merges the result. In `fill` mode
   (default) only empty fields and sections are filled, so user edits survive.
   In `replace` mode, sections the resume has overwrite what's there.

The extractor is deterministic, with no LLM involved:

- Section headings split the text (Summary, Experience, Education, Skills,
  Projects, Certifications; anything else such as Awards becomes a custom
  section).
- Date ranges anchor entries.
- Bullet lines attach to the current entry, and wrapped bullet lines are
  re-joined.
- Header lines are split on `|`, dashes, wide gaps and commas, with
  "City, ST" re-joined.
- It prefers leaving a field empty over guessing. Everything stays editable.

It's tested on two differently formatted resumes in `fixtures/resumes/`.

## Resume tab: layout and editing

Added 2026-10-24, following Tsenta's resume page. The Resume tab shows the
profile's resume as a page, with:

- **Your resume / Original upload:** the resume as it is sent, or the file you
  uploaded. Uploads are kept as they are (PDF, Word or text, up to 10 MB, one
  per profile, in `resume_files`); a PDF is shown as itself, and **Download
  original** gives the file back. Profiles imported before 2026-10-24 kept only
  the text: upload again with Replace to keep the file.
- **Toolbar:** template (Classic or Compact), font, size (8.5–12pt), left or
  justified text, and **Fit to one page**, which shrinks the spacing and then
  the text (not below 8.5pt) until the resume fits one page. Below the page, a
  note says when it runs past one page.
- **Sections:** drag to reorder, the eye to hide, and **Add custom section**.
- **More:** show or hide each header detail (city, state, country, email,
  phone, LinkedIn, GitHub, website) and show links as labels ("LinkedIn"
  instead of the address).
- **Edit text:** every field on the page becomes editable in place. Enter adds
  a bullet, Backspace on an empty bullet removes it, ⋮⋮ drags a bullet, ×
  deletes a bullet or entry, and "+ Add" adds roles, projects, schools, skill
  groups and certifications. Nothing is saved until **Save changes**.
- **Replace** uploads a new resume (keep or replace what's written), and
  **Download PDF** prints the resume as shown.

The layout is saved per profile (`resume_profiles.layout`,
`lib/resume-layout.mjs`) and used everywhere the resume is rendered: the
preview, tailored resumes for applications, and the PDFs auto-apply uploads.
If you never reorder sections yourself, tailoring still decides the order per
job (skills first for data roles).

API:

- `PATCH /v1/users/:id/resume-profiles/:pid` `{ layout: {...} }` merges layout changes
- `GET /v1/users/:id/resume-profiles/:pid/resume` gives the page; add `?format=pdf` for the PDF or `?edit=1` for the editor
- `POST /v1/users/:id/resume-profiles/:pid/render` `{ sections?, layout?, edit? }` previews unsaved changes
- `PUT /v1/users/:id/resume-profiles/:pid/original` (raw file body, `Content-Type`, `X-Filename`) keeps the uploaded file; `GET` downloads it (`?inline=1` to open it in the browser)

Tests: `npm run test:resume-layout` (add `-- --db` for the API).

## API

```
GET    /v1/users/:id/resume-profiles                         list (with completeness)
POST   /v1/users/:id/resume-profiles                         {name, copyFrom?}; first one becomes the default
GET    /v1/users/:id/resume-profiles/:pid                    full profile
PATCH  /v1/users/:id/resume-profiles/:pid                    {name?, sections?: {only the keys to replace}, coverLetter?}
DELETE /v1/users/:id/resume-profiles/:pid                    not the last one; deleting the default promotes another
POST   /v1/users/:id/resume-profiles/:pid/set-default
POST   /v1/users/:id/resume-profiles/:pid/import-resume      {text, filename?, mode: fill|replace}
GET    /v1/profile/fields                                    application-answer field definitions
```
