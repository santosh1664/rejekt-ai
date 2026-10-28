# Dashboard (`/app`)

Added 2026-10-23, redesigned the same day with its own visual identity (see
"Design" below) and the full profile system (docs/profile.md). A four-screen
job-search dashboard under the Rejekt.ai
brand, modeled on the structure of Tsenta's dashboard. It's built on this
project's own API and matching. No Tsenta code, assets, name or copy is used.

Run `npm run migrate` (it adds columns and tables), then `npm run web` and
open http://localhost:3000/app.

## Screens

| Screen | Route | What it does | API |
|--------|-------|--------------|-----|
| Dashboard | `#/dashboard` | Search bar with scope, exclude row and filter pills; top 5 matches as cards with a match ring, Pass/Apply; applications table with status tabs | `GET /v1/users/:id/recommendations`, `GET /v1/users/:id/applications` |
| Jobs | `#/jobs` (`#/browse` alias) | Full ranked feed as a two-pane list and detail view, with Save/Apply and Load more | same feed, `cursor=` paging |
| Job details | drawer on any screen | Meta grid, **why it matches** (score ring, 7 component bars, reasons, missing skills, eligibility blockers), skills, visa, description; View posting / Not interested / Save / Apply | `GET /v1/users/:id/jobs/:jobId/match` |
| Tracker | `#/tracker` | Board: Saved, Applied, Ghosted, Interviewing, Offer, Rejected. Drag-and-drop or a per-card menu, search, CSV export. A card opens the application: history, the posting as saved, the resume and answers sent | `GET/POST/PATCH/DELETE /v1/users/:id/applications` |
| Applied | `#/applied` | Every application sent, with the posting and the resume. Search company, title, link and posting text with per-field counts and snippets; group by company; import Tsenta history; resume-model status. See docs/resume-model.md | `/v1/users/:id/applied`, `/v1/users/:id/imports/tsenta`, `/v1/users/:id/resume-model` |
| Auto-apply | `#/auto-apply` | On/off, daily and per-company limits, lanes (role + resume profile + rules), Preview and Run now, a "Needs you" queue with the questions to answer, "Waiting for your OK" with what was filled in, and the Sent list. See docs/auto-apply.md | `/v1/users/:id/auto-apply*`, `/v1/users/:id/applications/:appId/*` |
| Profile | `#/profile` | Multiple resume profiles (switch, copy, rename, default, delete); details with experience, education, projects, certifications, skills, custom sections and application answers; resume import; cover-letter template; % complete. See docs/profile.md | `/v1/users/:id/resume-profiles*`, target-roles, `POST /api/parse-resume` |

Behavior notes:

- **Pass** records a SKIP interaction, so the job never comes back.
- **Not interested** records HIDE.
- **Apply** opens the posting in a new tab and marks the job Applied. That
  records an APPLY interaction, which removes it from the feed.
- **Save** adds the job to the tracker as Saved and leaves it in the feed.
- The filter pills write the user's saved preferences
  (`/profile/preferences`, or `needs_sponsorship` on the profile), so they
  persist across sessions. The one exception is **Date**, which is kept per
  browser.
- **Save search** uses the validated saved keyword search
  (docs/keyword-search.md). A search that would empty the feed is refused with
  the reason.

## How the structure was derived (evidence)

The evidence came from Tsenta's public dashboard bundle (a Vite/React SPA) and
the signed-in dashboard, observed read-only on 2026-10-23.

- **Route table** (from the `paths` chunk): `/dashboard`, `/recommendations`,
  `/auto-apply`, `/tracker`, `/my-profile`, `/resume`, `/networking`, `/inbox`,
  `/history`, `/applications`, plus a newer `/dashboard/v2/*` set. This project
  implements dashboard, recommendations (Browse), tracker and profile.
- **API surface** (from the api chunks):
  - `GET /api/v1/v2/home/for-you`
  - `PUT /users/{uid}/feed-filters`
  - `applications/list`, `list/counts`, `{id}/detail`, `skip-bulk`, `reapply`
  - `jobs/{jobId}/status`
  - `resume-profiles`, `profile/{education, work-experience, skills}`
  - `tracked-applications/export`
- **Layout**: top nav; search with a scope picker (Title + description) and an
  "Exclude: hide jobs mentioning…" row; filter pills (Date, Location,
  Workplace, Companies, Degree, Max experience, Sponsors visa, Role, Job type,
  Employment type); pastel job cards with a match-% ring; a right-side job
  details drawer; a Pipeline board (Applied / Ghosted / Interviewing /
  Rejected / Offer); a profile header with % complete.

## Not built (Tsenta has these)

- Networking
- Inbox
- Plans and credits

The project has no authentication yet. The dashboard makes a random user ID
per browser (`localStorage jd.userId`). Put real auth in front of `/v1`
before deploying anywhere public.

## Tests

- `npm run test:dashboard-api` runs against a local database: the
  applications tracker, job detail, the `/app` + `/v1` mount and the feed
  display fields.
- `npm run test:keyword-search -- --db` covers search.

## Design

Rejekt.ai's own identity:

- **Colors:** cool blue-gray paper `#EDF0F5`, white surfaces, navy ink
  `#101A33`, cobalt `#2B45C9` for actions, marigold `#F0B000` reserved for
  strong matches, and a deep-navy dark mode.
- **Type:** Bricolage Grotesque for headings, job titles and scores; Figtree
  for everything else.
- **Layout:**
  - a left navigation rail, which becomes a bottom bar on phones
  - jobs in a two-pane list and detail view, like an email client: arrow keys
    move through the list, and on narrow screens the detail opens as a drawer
  - the tracker as a board with a colored rule per stage
  - the profile with a section index and editable sections, and experience
    and education drawn as a timeline
- **Signature element:** the match score as a large number above a
  10-segment signal meter. It's marigold at 80+, cobalt at 65–79 and gray
  below that, so the strongest matches stand out in a list.
