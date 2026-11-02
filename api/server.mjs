/**
 * api/server.mjs
 *
 * Lightweight REST API for the Rejekt.ai engine.
 * Zero external dependencies — uses Node's built-in http module.
 *
 * Usage:
 *   node --env-file=.env.local api/server.mjs [--port 3001]
 *   npm run api
 *
 * Endpoints:
 *   GET  /health
 *   GET  /stats
 *   GET  /jobs               ?q= &category= &role_family= &canonical_role= &workplace_type= &employment_type= &remote= &ats= &company_id= &page= &limit= &sort=
 *   GET  /jobs/:id
 *   GET  /companies          ?ats= &active= &page= &limit=
 *   GET  /companies/:id
 *   GET  /users/:userId/preferences
 *   POST /users/:userId/preferences
 *   PUT  /users/:userId/preferences/:prefId
 *   GET  /users/:userId/alerts    ?seen= &saved= &applied= &page= &limit=
 *   PATCH /users/:userId/alerts/:jobId
 *   POST /users/:userId/match
 *   GET  /users/:userId/recommendations  ?limit= &cursor= &posted_within_days= &strict=
 *                                         &search= &exclude_search= &search_scope= &use_saved_search=
 *   GET  /users/:userId/feed-relevance    same filters as /recommendations; scores the feed + "what if" filter patches
 *   GET/PUT/DELETE /users/:userId/search  (saved feed keyword search — see docs/keyword-search.md)
 *   GET  /users/:userId/jobs/:jobId/match  (job detail: description + score breakdown + eligibility)
 *   GET  /users/:userId/applications      ?status=
 *   POST /users/:userId/applications      {jobId, status?, notes?}
 *   GET/PATCH/DELETE /users/:userId/applications/:applicationId   (GET: snapshot, history, resume sent)
 *   POST /users/:userId/applications/:id/tailor|answers|approve|skip|submit, GET …/resume[?format=pdf|?changes=1]
 *   GET  /users/:userId/applications/:id/changes   what tailoring changed: reworded bullets with the original, new bullets, added skills
 *   GET/PUT /users/:userId/auto-apply, POST …/auto-apply/lanes, PATCH/DELETE …/lanes/:laneId,
 *   POST …/auto-apply/preview (dry run), POST …/auto-apply/run   (docs/auto-apply.md)
 *   GET  /users/:userId/applied   ?q= &fields=company,title,link,posting &source=all|app|tsenta &groupBy=company &page=
 *   GET/POST /users/:userId/imports/tsenta   (is an export there / import it)   (docs/resume-model.md)
 *   GET  /users/:userId/resume-model         local model status + training-data counts
 *   GET/POST /users/:userId/resume-examples, DELETE …/:id   your own original → tailored resumes
 *   POST /jobs/import                     {url}  add a job (and its company's board) by pasting a link
 *   GET  /jobs/import/check               ?url=  which ATS a link belongs to, without fetching anything
 *   GET/POST /users/:userId/resume-profiles              list / create {name, copyFrom?}
 *   GET/PATCH/DELETE /users/:userId/resume-profiles/:id  one profile {name?, sections?, layout?, coverLetter?}
 *   GET  /users/:userId/resume-profiles/:id/resume[?edit=1|?format=pdf]   the resume page / PDF
 *   POST /users/:userId/resume-profiles/:id/render {sections?, layout?, edit?}   preview unsaved changes
 *   GET/PUT /users/:userId/resume-profiles/:id/original   the uploaded resume file (PUT: raw body, X-Filename header)
 *   POST /users/:userId/resume-profiles/:id/set-default
 *   POST /users/:userId/resume-profiles/:id/import-resume {text, filename?, mode: fill|replace}
 *   GET  /profile/fields                  application-default field definitions for forms
 *
 * The router is also exported and mounted under /v1 by server.mjs, so the
 * dashboard (public/app) talks to one origin. Running this file directly
 * still starts the standalone API on --port (default 3001).
 */

import { createServer }  from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';
import { query, closePool } from '../lib/db.mjs';
import { matchUserFull }    from '../matching/matcher.mjs';
import { generateRecommendations, explainJobMatch } from '../matching/recommend.mjs';

// ─── Recommendations cache (avoids rescoring 2000 jobs on every page refresh) ─
const _recCache = new Map(); // key → { ts, promise }
const REC_CACHE_TTL = 60_000; // 60 s
function _recCacheKey(userId, q) {
  return `${userId}|${q.posted_within_days||''}|${q.strict||''}|${q.use_saved_search||''}|${q.search||''}|${q.exclude_search||''}|${q.search_scope||''}`;
}
function _recCacheGet(key) {
  const e = _recCache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > REC_CACHE_TTL) { _recCache.delete(key); return null; }
  return e.promise;
}
function _recCacheSet(key, promise) {
  _recCache.set(key, { ts: Date.now(), promise });
  // Prune stale entries so the map doesn't grow forever
  if (_recCache.size > 200) {
    const cutoff = Date.now() - REC_CACHE_TTL;
    for (const [k, v] of _recCache) if (v.ts < cutoff) _recCache.delete(k);
  }
  return promise;
}


import { normalizeRoleInput, normalizeSkillName, normalizeUserLocation, isValidEducationLevel } from '../lib/profile-normalize.mjs';
import { EDUCATION_LEVELS } from '../lib/education.mjs';
import { evaluateProfileCompleteness } from '../matching/profile-completeness.mjs';
import { normalizeKeywordSearch } from '../matching/keyword-search.mjs';
import { getSavedKeywordSearch, saveKeywordSearch, clearKeywordSearch } from '../matching/saved-search.mjs';
import { importJobByUrl, previewJobByUrl } from '../lib/job-import.mjs';
import { detectAts, SUPPORTED_ATS } from '../lib/ats-detect.mjs';
import {
  listResumeProfiles, getResumeProfile, createResumeProfile, updateResumeProfile,
  setDefaultResumeProfile, deleteResumeProfile, getDefaultResumeProfile, APPLICATION_DEFAULT_FIELDS,
  saveResumeFile, getResumeFile, RESUME_FILE_MAX,
} from '../lib/resume-profiles.mjs';
import { extractResumeSections, mergeExtracted } from '../lib/resume-extract.mjs';
import {
  APPLICATION_STATUSES, APPLY_STATES, trackApplication, updateApplication, listApplications, getApplication, deleteApplication, setApplyState,
} from '../lib/applications.mjs';
import {
  getSettings as getAutoApplySettings, saveSettings as saveAutoApplySettings, saveLane, deleteLane, planRun, runForUser,
  prepareApplication, submitApplication, startApply, answerApplication, skipApplication, recentRuns, applyStateCounts, FILLABLE_ATS,
} from '../autoapply/engine.mjs';
import { renderResumeHTML, renderResumePDF, resumeFileName } from '../lib/resume-render.mjs';
import { normalizeLayout } from '../lib/resume-layout.mjs';
import { assessFeedRelevance } from '../matching/relevance.mjs';
import { searchApplied } from '../lib/applied-search.mjs';
import { importTsentaHistory, tsentaExportAvailable } from '../lib/import-tsenta.mjs';
import { llmStatus, llmConfig } from '../lib/llm.mjs';
import { rewriteStats, addManualExample, listManualExamples, deleteManualExample, resumeBeforeTailoring } from '../lib/rewrites.mjs';
import { diffResumes } from '../lib/resume-diff.mjs';
import { getAuthUrl, exchangeCode, getGmailStatus, disconnectGmail } from '../lib/gmail.mjs';
import { unsupportedClaims } from '../lib/resume-tailor.mjs';

const PORT = (() => {
  const idx = process.argv.indexOf('--port');
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : (parseInt(process.env.PORT) || 3001);
})();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function json(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type':  'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function parseQuery(url) {
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  const obj = {};
  for (const [k, v] of new URLSearchParams(url.slice(idx + 1))) obj[k] = v;
  return obj;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function paginate(q) {
  const limit  = Math.min(parseInt(q.limit  ?? 25), 200);
  const page   = Math.max(parseInt(q.page   ?? 1),  1);
  return { limit, page, offset: (page - 1) * limit };
}

// ─── Handlers ────────────────────────────────────────────────────────────────

async function handleHealth(req, res) {
  try {
    await query('SELECT 1');
    json(res, 200, { ok: true, ts: new Date().toISOString() });
  } catch (e) {
    json(res, 503, { ok: false, error: e.message });
  }
}

async function handleStats(req, res) {
  const [co, jo, run] = await Promise.all([
    query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE active) AS active,
                  COUNT(DISTINCT ats) AS ats_count FROM companies`),
    query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE active) AS active,
                  COUNT(*) FILTER (WHERE NOT active) AS closed,
                  COUNT(*) FILTER (WHERE discovered > NOW()-INTERVAL '24h') AS new_24h,
                  COUNT(*) FILTER (WHERE remote) AS remote FROM jobs`),
    query(`SELECT started_at, companies_scanned, jobs_new, jobs_closed, status
             FROM scan_runs ORDER BY started_at DESC LIMIT 1`),
  ]);
  json(res, 200, { companies: co.rows[0], jobs: jo.rows[0], last_run: run.rows[0] ?? null });
}

async function handleListJobs(req, res, q) {
  const { limit, offset } = paginate(q);
  const conditions = ['j.active = TRUE', '(j.status = \'READY\' OR j.status IS NULL)'];
  const params     = [];

  let searchParamIdx = null;
  if (q.q) {
    params.push(q.q);
    searchParamIdx = params.length;
    conditions.push(`j.search_vector @@ plainto_tsquery('english', $${searchParamIdx})`);
  }
  if (q.category)  { params.push(q.category);          conditions.push(`j.category = $${params.length}`); }
  if (q.role_family) { params.push(q.role_family); conditions.push(`j.role_family = $${params.length}`); }
  // Optional finer filter (spec Step 25) — role_family keeps working unchanged above.
  if (q.canonical_role) { params.push(q.canonical_role); conditions.push(`j.canonical_role = $${params.length}`); }
  if (q.workplace_type) { params.push(q.workplace_type); conditions.push(`j.workplace_type = $${params.length}`); }
  if (q.employment_type) { params.push(q.employment_type); conditions.push(`j.employment_type = $${params.length}`); }
  if (q.sponsorship_status) { params.push(q.sponsorship_status); conditions.push(`j.sponsorship_status = $${params.length}`); }
  if (q.skills) {
    const skills = String(q.skills).split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
    if (skills.length) {
      params.push(skills);
      conditions.push(`EXISTS (
        SELECT 1 FROM job_skills js JOIN skills s ON s.id = js.skill_id
         WHERE js.job_id = j.id AND s.normalized_name = ANY($${params.length}::text[])
      )`);
    }
  }
  if (q.experience_max) { params.push(Number(q.experience_max)); conditions.push(`(j.min_exp_years IS NULL OR j.min_exp_years <= $${params.length})`); }
  if (q.salary_min) { params.push(Number(q.salary_min)); conditions.push(`(j.salary_max_annual IS NULL OR j.salary_max_annual >= $${params.length})`); }
  if (q.state) {
    params.push(q.state.toUpperCase());
    conditions.push(`EXISTS (SELECT 1 FROM job_locations jl WHERE jl.job_id = j.id AND jl.state_code = $${params.length})`);
  }
  if (q.ats)       { params.push(q.ats);               conditions.push(`j.ats = $${params.length}`); }
  if (q.company_id){ params.push(parseInt(q.company_id)); conditions.push(`j.company_id = $${params.length}`); }
  if (q.remote === 'true')  conditions.push('j.remote = TRUE');
  if (q.remote === 'false') conditions.push('j.remote = FALSE');

  const where = `WHERE ${conditions.join(' AND ')}`;
  // A search term's exact COUNT(*) needs to visit every matching row — GIN
  // can't index-only count a tsvector match (MVCC visibility still needs a
  // heap fetch per row) — so for a common term (e.g. "manager") this alone
  // was enough to hit the statement timeout, independent of how the ranked
  // results below are bounded. Cap it the same way: count up to
  // CANDIDATE_CAP matches and report that as "total" when there are more —
  // standard "1000+ results" behavior for broad text search.
  const CANDIDATE_CAP = 1000;
  const countSql = searchParamIdx
    ? `SELECT COUNT(*) AS n FROM (SELECT 1 FROM jobs j ${where} LIMIT ${CANDIDATE_CAP}) t`
    : `SELECT COUNT(*) AS n FROM jobs j ${where}`;
  try {
    const countQ = await query(countSql, params);
    const dataParams = [...params, limit, offset];

    const rankedSearch = searchParamIdx && !q.sort;
    const sort = q.sort === 'oldest' ? 'j.discovered ASC, j.id ASC'
      : q.sort === 'salary' ? 'j.salary_max_annual DESC NULLS LAST, j.discovered DESC'
        : q.sort === 'experience' ? 'j.min_exp_years ASC NULLS FIRST, j.discovered DESC'
          : rankedSearch ? `ts_rank_cd(j.search_vector, plainto_tsquery('english', $${searchParamIdx})) DESC, j.discovered DESC`
            : 'j.discovered DESC, j.id DESC';
    const cols = `j.id, j.url, j.title, j.company, j.company_id, j.location,
              j.remote, j.ats, j.category, j.role_family, j.canonical_role, j.role_specialization, j.normalized_title,
              j.workplace_type, j.employment_type, j.min_exp_years, j.max_exp_years,
              j.salary_min_annual, j.salary_max_annual, j.salary_currency,
              j.sponsorship_status, j.posted_at, j.discovered, j.last_seen`;
    // ts_rank_cd has to be computed for every matching row before a LIMIT can
    // apply — for a common term (e.g. "data" matches ~1/3 of jobs) that means
    // ranking tens of thousands of rows, which is what made this endpoint
    // time out. Bounding to the CANDIDATE_CAP most recent matches (cheap via
    // idx_jobs_discovered) before ranking keeps latency flat regardless of
    // how common the search term is, at the cost of not ranking matches
    // older than that recency window — an acceptable trade for a jobs feed
    // where recency already matters. Only applies to the default (unsorted)
    // ranked-search path; an explicit ?sort= alongside ?q= keeps the plain
    // filter+sort query since no rank computation is involved.
    const dataSql = rankedSearch
      ? `WITH candidates AS (
           SELECT j.id, j.discovered, j.search_vector FROM jobs j ${where}
           ORDER BY j.discovered DESC LIMIT ${CANDIDATE_CAP}
         ),
         page AS (
           SELECT id, ts_rank_cd(search_vector, plainto_tsquery('english', $${searchParamIdx})) AS rank
             FROM candidates
            ORDER BY rank DESC, discovered DESC
            LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}
         )
         SELECT ${cols} FROM page p JOIN jobs j ON j.id = p.id
         ORDER BY p.rank DESC`
      : `SELECT ${cols}
         FROM jobs j ${where}
        ORDER BY ${sort}
        LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`;
    const dataQ = await query(dataSql, dataParams);
    json(res, 200, { total: parseInt(countQ.rows[0].n), jobs: dataQ.rows });
  } catch (err) {
    console.error('[api] /jobs query failed', {
      query: q,
      code: err.code,
      message: err.message,
      detail: err.detail,
      hint: err.hint,
      countSql,
      params,
    });
    throw err;
  }
}

async function handleGetJob(req, res, id) {
  const { rows } = await query(
    `SELECT j.*, c.name AS company_name FROM jobs j
      LEFT JOIN companies c ON c.id = j.company_id WHERE j.id = $1`, [id]
  );
  if (!rows.length) return json(res, 404, { error: 'Not found' });
  json(res, 200, rows[0]);
}

async function handleListCompanies(req, res, q) {
  const { limit, offset } = paginate(q);
  const conditions = [];
  const params     = [];
  if (q.ats)             { params.push(q.ats); conditions.push(`ats = $${params.length}`); }
  if (q.active !== undefined) { params.push(q.active !== 'false'); conditions.push(`active = $${params.length}`); }

  const where  = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const countQ = await query(`SELECT COUNT(*) AS n FROM companies ${where}`, params);
  params.push(limit, offset);

  const dataQ = await query(
    `SELECT id, name, ats, slug, active, priority, last_scan, discovered
       FROM companies ${where} ORDER BY name
      LIMIT $${params.length - 1} OFFSET $${params.length}`, params
  );
  json(res, 200, { total: parseInt(countQ.rows[0].n), companies: dataQ.rows });
}

async function handleGetCompany(req, res, id) {
  const { rows } = await query(
    `SELECT c.*, COUNT(j.id) AS job_count FROM companies c
      LEFT JOIN jobs j ON j.company_id = c.id AND j.active = TRUE
     WHERE c.id = $1 GROUP BY c.id`, [id]
  );
  if (!rows.length) return json(res, 404, { error: 'Not found' });
  json(res, 200, rows[0]);
}

async function handleGetPrefs(req, res, userId) {
  const { rows } = await query(
    `SELECT * FROM user_preferences WHERE user_id = $1 ORDER BY created_at DESC`, [userId]
  );
  json(res, 200, rows);
}

async function handleCreatePref(req, res, userId, body) {
  const { rows } = await query(
    `INSERT INTO user_preferences
       (user_id, title_keywords, locations, remote_only, categories,
        exclude_companies, min_match_score, notify_email, notify_push)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [userId, body.title_keywords??[], body.locations??[], body.remote_only??false,
     body.categories??['engineering'], body.exclude_companies??[],
     body.min_match_score??50, body.notify_email??true, body.notify_push??true]
  );
  json(res, 201, rows[0]);
}

async function handleUpdatePref(req, res, userId, prefId, body) {
  const sets = []; const params = [userId, prefId];
  for (const f of ['title_keywords','locations','remote_only','categories',
                    'exclude_companies','min_match_score','notify_email','notify_push','active']) {
    if (body[f] !== undefined) { params.push(body[f]); sets.push(`${f} = $${params.length}`); }
  }
  if (!sets.length) return json(res, 400, { error: 'Nothing to update' });
  sets.push('updated_at = NOW()');
  const { rows } = await query(
    `UPDATE user_preferences SET ${sets.join(', ')} WHERE user_id=$1 AND id=$2 RETURNING *`, params
  );
  if (!rows.length) return json(res, 404, { error: 'Not found' });
  json(res, 200, rows[0]);
}

async function handleGetAlerts(req, res, userId, q) {
  const { limit, offset } = paginate(q);
  const conditions = ['a.user_id = $1'];
  const params     = [userId];
  if (q.seen    !== undefined) { params.push(q.seen === 'true');    conditions.push(`a.seen = $${params.length}`); }
  if (q.saved   !== undefined) { params.push(q.saved === 'true');   conditions.push(`a.saved = $${params.length}`); }
  if (q.applied !== undefined) { params.push(q.applied === 'true'); conditions.push(`a.applied = $${params.length}`); }

  const where  = conditions.join(' AND ');
  const countQ = await query(`SELECT COUNT(*) AS n FROM user_job_alerts a WHERE ${where}`, params);
  params.push(limit, offset);

  const dataQ = await query(
    `SELECT a.id, a.job_id, a.score, a.seen, a.saved, a.applied, a.created_at,
            j.url, j.title, j.company, j.location, j.remote, j.category,
            j.posted_at, j.active AS job_active
       FROM user_job_alerts a JOIN jobs j ON j.id = a.job_id
      WHERE ${where}
      ORDER BY a.score DESC, a.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`, params
  );
  json(res, 200, { total: parseInt(countQ.rows[0].n), alerts: dataQ.rows });
}

async function handleUpdateAlert(req, res, userId, jobId, body) {
  const sets = []; const params = [userId, jobId];
  if (body.seen    !== undefined) { params.push(body.seen);    sets.push(`seen    = $${params.length}`); }
  if (body.saved   !== undefined) { params.push(body.saved);   sets.push(`saved   = $${params.length}`); }
  if (body.applied !== undefined) { params.push(body.applied); sets.push(`applied = $${params.length}`); }
  if (!sets.length) return json(res, 400, { error: 'Nothing to update' });
  const { rows } = await query(
    `UPDATE user_job_alerts SET ${sets.join(', ')} WHERE user_id=$1 AND job_id=$2 RETURNING *`, params
  );
  if (!rows.length) return json(res, 404, { error: 'Not found' });
  json(res, 200, rows[0]);
}

async function handleTriggerMatch(req, res, userId) {
  matchUserFull(userId, { verbose: true })
    .then(({ matched }) => console.error(`  match for ${userId}: ${matched} hits`))
    .catch((err) => console.error(`  match error: ${err.message}`));
  json(res, 202, { queued: true, message: 'Matching started in background' });
}

/**
 * Keyword search for the feed. Explicit ?search= / ?exclude_search= on the
 * request is a PREVIEW (changes nothing that's saved) and takes precedence;
 * otherwise the user's saved search applies unless ?use_saved_search=false.
 * Terms are "|"-separated: ?search=react|frontend
 */
async function resolveKeywordSearch(userId, q) {
  if (q.search !== undefined || q.exclude_search !== undefined) {
    const ks = normalizeKeywordSearch({ include: q.search, exclude: q.exclude_search, scope: q.search_scope });
    return { ks: { ...ks, source: 'request' }, errors: ks.errors };
  }
  if (q.use_saved_search === 'false') return { ks: null, errors: [] };
  return { ks: await getSavedKeywordSearch(userId), errors: [] };
}

async function handleRecommendations(req, res, userId, q) {
  const { ks, errors } = await resolveKeywordSearch(userId, q);
  if (errors.length) return json(res, 400, { errors });

  // First page with no cursor? Serve from cache (or prime it).
  const firstPage = !q.cursor;
  if (firstPage) {
    const cacheKey = _recCacheKey(userId, q);
    let cached = _recCacheGet(cacheKey);
    if (!cached) {
      cached = generateRecommendations(userId, {
        limit: 100, cursor: null, postedWithinDays: q.posted_within_days,
        strictEducation: q.strict === 'true', keywordSearch: ks,
      });
      _recCacheSet(cacheKey, cached);
    }
    const full = await cached;
    // Slice to the requested limit from the cached full page
    const limit = Math.min(Number(q.limit) || 25, 100);
    const sliced = { ...full, jobs: full.jobs.slice(0, limit), nextCursor: full.jobs.length > limit ? String(limit) : null };
    return json(res, 200, sliced);
  }

  // Subsequent pages: use cursor to slice from cache or fetch fresh
  const cacheKey = _recCacheKey(userId, { ...q, cursor: undefined });
  const cached = _recCacheGet(cacheKey);
  if (cached) {
    const full = await cached;
    const offset = Number(q.cursor) || 0;
    const limit = Math.min(Number(q.limit) || 25, 100);
    const jobs = full.jobs.slice(offset, offset + limit);
    return json(res, 200, { ...full, jobs, nextCursor: offset + limit < full.jobs.length ? String(offset + limit) : null });
  }

  const result = await generateRecommendations(userId, {
    limit: q.limit, cursor: q.cursor, postedWithinDays: q.posted_within_days,
    strictEducation: q.strict === 'true', keywordSearch: ks,
  });
  json(res, 200, result);
}

// Bust the cache for a user (called when profile/preferences change)
function bustRecCache(userId) { for (const k of _recCache.keys()) if (k.startsWith(userId + '|')) _recCache.delete(k); }

async function handleFeedRelevance(req, res, userId, q) {
  const { ks, errors } = await resolveKeywordSearch(userId, q);
  if (errors.length) return json(res, 400, { errors });
  json(res, 200, await assessFeedRelevance(userId, { postedWithinDays: q.posted_within_days, keywordSearch: ks }));
}

async function handleGetKeywordSearch(req, res, userId) {
  const saved = await getSavedKeywordSearch(userId);
  json(res, 200, saved ?? { include: [], exclude: [], scope: 'title', active: false });
}

/**
 * Replaces the saved keyword search (send empty arrays to clear). The search
 * is run against the user's REAL feed first and refused (422) when it
 * returns no jobs — saving it would silently leave the user staring at an
 * empty feed.
 */
async function handlePutKeywordSearch(req, res, userId, body) {
  const ks = normalizeKeywordSearch({ include: body.include, exclude: body.exclude, scope: body.scope });
  if (ks.errors.length) return json(res, 400, { errors: ks.errors });
  if (!ks.active) {
    await clearKeywordSearch(userId);
    return json(res, 200, { saved: false, cleared: true, keywordSearch: null });
  }
  const preview = await generateRecommendations(userId, { limit: 3, keywordSearch: { ...ks, source: 'request' } });
  if (preview.zeroResultReason === 'NO_PROFILE') {
    return json(res, 404, { error: 'Create the profile first via PUT /users/:userId/profile' });
  }
  if (preview.total === 0) {
    return json(res, 422, {
      saved: false, refused: true,
      zeroResultReason: preview.zeroResultReason,
      activeFilters: preview.activeFilters,
      message: preview.zeroResultReason === 'NO_MATCHING_JOBS'
        ? 'No active job matches this keyword. Try a broader term or scope "title_description".'
        : 'This keyword matches jobs, but your other filters remove all of them. Loosen one of activeFilters or pick a broader keyword.',
    });
  }
  const saved = await saveKeywordSearch(userId, ks);
  json(res, 200, {
    saved: true, keywordSearch: saved, searchWarnings: preview.searchWarnings,
    preview: { total: preview.total, jobs: preview.jobs.map(({ jobId, title, company, matchScore, keywordMatch }) => ({ jobId, title, company, matchScore, keywordMatch })) },
  });
}

const IMPORT_STATUS = { INVALID_URL: 400, PAGE_UNREADABLE: 422, ATS_NOT_SUPPORTED: 422, BOARD_UNREACHABLE: 502, SCAN_FAILED: 502 };

async function handleImportJob(req, res, body) {
  if (!body?.url) return json(res, 400, { error: 'url is required' });
  const result = await importJobByUrl(String(body.url), { description: body.description });
  json(res, result.ok ? 200 : (IMPORT_STATUS[result.code] || 400), result);
}

async function handleImportPreview(req, res, body) {
  if (!body?.url) return json(res, 400, { error: 'url is required' });
  const result = await previewJobByUrl(String(body.url));
  json(res, result.ok ? 200 : (IMPORT_STATUS[result.code] || 422), result);
}

function handleImportCheck(req, res, q) {
  const det = detectAts(q.url || '');
  json(res, 200, { url: q.url || null, ...(det || { ats: null, supported: false }), supportedAts: SUPPORTED_ATS });
}

async function handleJobMatch(req, res, userId, jobId) {
  const result = await explainJobMatch(userId, jobId);
  if (!result) return json(res, 404, { error: 'Not found' });
  json(res, 200, result);
}

// ─── Applications tracker (lib/applications.mjs) ─────────────────────────────
export { APPLICATION_STATUSES };

async function handleListApplications(req, res, userId, q) {
  const split = v => (v ? String(v).split(',').map(x => x.trim().toUpperCase()).filter(Boolean) : null);
  const statuses = split(q.status)?.filter(v => APPLICATION_STATUSES.includes(v));
  const applyStates = split(q.applyState)?.filter(v => APPLY_STATES.includes(v));
  json(res, 200, await listApplications(userId, { statuses, applyStates, source: q.source || null }));
}

/**
 * Track a job. One application row per (user, job): posting the same job
 * again updates its status instead of duplicating it. Moving to APPLIED also
 * records an APPLY interaction, which is what removes the job from the feed.
 */
async function handleUpsertApplication(req, res, userId, body) {
  const jobId = Number(body.jobId);
  if (!Number.isInteger(jobId) || jobId <= 0) return json(res, 400, { error: 'jobId is required' });
  const r = await trackApplication(userId, jobId, body.status || 'SAVED', {
    notes: body.notes, resumeProfileId: UUID_RE.test(body.resumeProfileId || '') ? body.resumeProfileId : null,
  });
  if (r.error) return json(res, r.code, { error: r.error });
  json(res, r.created ? 201 : 200, await getApplication(userId, r.id));
}

async function handleUpdateApplication(req, res, userId, appId, body) {
  const r = await updateApplication(userId, appId, { status: body.status, notes: body.notes });
  if (r.notFound) return json(res, 404, { error: 'Not found' });
  if (r.error) return json(res, 400, { error: r.error });
  json(res, 200, await getApplication(userId, appId));
}

async function handleGetApplication(req, res, userId, appId) {
  const app = await getApplication(userId, appId);
  if (!app) return json(res, 404, { error: 'Not found' });
  // Resumes written elsewhere (Tsenta) are checked against your own profile.
  if (app.source === 'tsenta' && app.tailoredResume?.sections && UUID_RE.test(userId)) {
    const rp = await getDefaultResumeProfile(userId);
    app.claimsCheck = rp ? { profileName: rp.name, unsupported: unsupportedClaims(app.tailoredResume.sections, rp.sections) } : null;
  }
  json(res, 200, app);
}

// ─── Applied search, Tsenta import, resume model (docs/resume-model.md) ─────
async function handleApplied(req, res, userId, q) {
  if (!UUID_RE.test(userId)) return json(res, 404, { error: 'Not found' });
  const fields = q.fields ? String(q.fields).split(',').map(s => s.trim()).filter(Boolean) : null;
  json(res, 200, await searchApplied(userId, { q: q.q, fields, source: q.source, status: q.status, groupBy: q.groupBy, page: q.page, limit: q.limit }));
}

async function handleTsentaImport(req, res, userId, method) {
  if (!UUID_RE.test(userId)) return json(res, 404, { error: 'Not found' });
  if (method === 'GET') {
    const { rows: [r] } = await query(`SELECT COUNT(*)::int AS n FROM applications WHERE user_id = $1 AND source = 'tsenta'`, [userId]);
    return json(res, 200, { available: tsentaExportAvailable(), imported: r.n });
  }
  if (method === 'POST') {
    const r = await importTsentaHistory(userId);
    return r.error ? json(res, r.code || 400, { error: r.error }) : json(res, 200, r);
  }
  return json(res, 405, { error: 'Method not allowed' });
}

async function handleResumeModel(req, res, userId) {
  const status = await llmStatus();
  const stats = userId && UUID_RE.test(userId) ? await rewriteStats(userId) : null;
  json(res, 200, { ...status, config: { provider: llmConfig().provider, model: llmConfig().model }, trainingData: stats });
}

async function handleResumeExamples(req, res, userId, method, id, body) {
  if (!UUID_RE.test(userId)) return json(res, 404, { error: 'Not found' });
  if (!id && method === 'GET') return json(res, 200, { examples: await listManualExamples(userId) });
  if (!id && method === 'POST') {
    const r = await addManualExample(userId, body || {});
    return r.error ? json(res, r.code || 400, { error: r.error }) : json(res, 201, r);
  }
  if (id && method === 'DELETE') {
    if (!/^\d+$/.test(id)) return json(res, 404, { error: 'Not found' });
    const ok = await deleteManualExample(userId, id);
    return json(res, ok ? 200 : 404, { deleted: ok });
  }
  return json(res, 405, { error: 'Method not allowed' });
}

async function handleDeleteApplication(req, res, userId, appId) {
  const deleted = await deleteApplication(userId, appId);
  json(res, deleted ? 200 : 404, { deleted });
}


// ─── Auto-apply and resume tailoring (docs/auto-apply.md) ────────────────────
const runningAutoApply = new Set();

async function handleAutoApply(req, res, userId, method, sub, laneId, body) {
  if (!UUID_RE.test(userId)) return json(res, 404, { error: 'Not found' });
  if (!sub) {
    if (method === 'GET') {
      const [settings, counts, runs] = await Promise.all([getAutoApplySettings(userId), applyStateCounts(userId), recentRuns(userId, 5)]);
      return json(res, 200, { ...settings, counts, runs, running: runningAutoApply.has(userId), fillableAts: FILLABLE_ATS });
    }
    if (method === 'PUT' || method === 'PATCH') return json(res, 200, await saveAutoApplySettings(userId, body || {}));
  }
  if (sub === 'lanes') {
    if (laneId && !UUID_RE.test(laneId)) return json(res, 404, { error: 'Not found' });
    if (method === 'POST' && !laneId) { const r = await saveLane(userId, null, body || {}); return r?.error ? json(res, 400, r) : json(res, 201, r); }
    if ((method === 'PATCH' || method === 'PUT') && laneId) { const r = await saveLane(userId, laneId, body || {}); return !r ? json(res, 404, { error: 'Not found' }) : r.error ? json(res, 400, r) : json(res, 200, r); }
    if (method === 'DELETE' && laneId) { const ok = await deleteLane(userId, laneId); return json(res, ok ? 200 : 404, { deleted: ok }); }
  }
  if (sub === 'preview' && method === 'POST') return json(res, 200, await planRun(userId, { dryRun: true }));
  if (sub === 'run' && method === 'POST') {
    if (runningAutoApply.has(userId)) return json(res, 409, { error: 'A run is already in progress' });
    runningAutoApply.add(userId);
    runForUser(userId, {}).catch(err => console.error('auto-apply run failed:', err)).finally(() => runningAutoApply.delete(userId));
    return json(res, 202, { started: true });
  }
  return json(res, 405, { error: 'Method not allowed' });
}

async function handleApplicationAction(req, res, userId, appId, action, method, body, q) {
  if (!UUID_RE.test(userId)) return json(res, 404, { error: 'Not found' });
  const fail = r => json(res, r.code || 400, { error: r.error });
  if (action === 'tailor' && method === 'POST') {
    if (body?.resumeProfileId) {
      if (!UUID_RE.test(body.resumeProfileId) || !(await getResumeProfile(userId, body.resumeProfileId))) return json(res, 400, { error: 'Resume profile not found' });
      await query(`UPDATE applications SET resume_profile_id = $3 WHERE user_id = $1 AND id = $2`, [userId, appId, body.resumeProfileId]);
    }
    const r = await prepareApplication(userId, String(appId), { mode: body?.mode || 'match' });
    return r.error ? fail(r) : json(res, 200, { ...r, application: await getApplication(userId, appId) });
  }
  if ((action === 'resume' || action === 'changes') && method === 'GET') {
    const app = await getApplication(userId, appId);
    if (!app) return json(res, 404, { error: 'Not found' });
    let sections = app.tailoredResume?.sections; let order = app.tailoredResume?.sectionOrder;
    // The profile's page layout (template, font, sections…) applies to tailored resumes too.
    const rp = app.resumeProfileId ? await getResumeProfile(userId, app.resumeProfileId) : await getDefaultResumeProfile(userId);
    if (!sections) { sections = rp?.sections; order = null; }
    if (!sections) return json(res, 404, { error: 'No resume yet' });
    // ?changes=1: highlight what tailoring changed, with the original text on click (lib/resume-diff.mjs).
    let changes = null;
    if ((q.changes === '1' || action === 'changes') && app.tailoredResume?.sections) {
      const before = (await resumeBeforeTailoring(appId)) || rp?.sections;
      if (before) changes = diffResumes(before, sections);
    }
    if (action === 'changes') return json(res, 200, changes ? { counts: changes.counts, changes: changes.list } : { counts: null, changes: [] });
    const html = renderResumeHTML(sections, { sectionOrder: order, layout: rp?.layout, changes, title: `${sections.personal?.fullName || 'Resume'} — ${app.job?.company || ''}` });
    if (q.format === 'pdf' && !changes) {
      const pdf = await renderResumePDF(html);
      if (pdf) {
        const fname = resumeFileName(app.job?.company, app.job?.title);   // downloading an application's resume: Company_Role.pdf
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length, 'Content-Disposition': `${q.download === '1' ? 'attachment' : 'inline'}; filename="${fname}"` });
        return res.end(pdf);
      }
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }
  if (action === 'answers' && method === 'POST') {
    const r = await answerApplication(userId, String(appId), { answers: body?.answers || {}, remember: body?.remember !== false, approve: body?.approve !== false });
    if (!r.error && body?.approve !== false) startApply(userId, appId, { approve: true });   // send now, not on the next scheduled run
    return r.error ? fail(r) : json(res, 200, { ...r, application: await getApplication(userId, appId) });
  }
  if (action === 'approve' && method === 'POST') {
    const r = await answerApplication(userId, String(appId), { answers: body?.answers || {}, remember: body?.remember !== false, approve: true });
    if (!r.error) startApply(userId, appId, { approve: true });
    return r.error ? fail(r) : json(res, 200, { ...r, application: await getApplication(userId, appId) });
  }
  if (action === 'skip' && method === 'POST') {
    const r = await skipApplication(userId, String(appId));
    return r.error ? fail(r) : json(res, 200, await getApplication(userId, appId));
  }
  if (action === 'apply' && method === 'POST') {
    // The Apply button / Try again: tailor, fill, stop at review. All on the server.
    const app = await getApplication(userId, appId);
    if (!app) return json(res, 404, { error: 'Not found' });
    // queued before answering, so the page that reloads right after the click already shows it In flight
    await setApplyState(String(appId), userId, 'QUEUED', app.applyDetail || {});
    startApply(userId, appId, { approve: false });
    return json(res, 202, { started: true });
  }
  if (action === 'submit' && method === 'POST') {
    // Fill (and send, when approved) now, in the background.
    const app = await getApplication(userId, appId);
    if (!app) return json(res, 404, { error: 'Not found' });
    submitApplication(userId, String(appId), { approve: body?.approve === true }).catch(err => console.error('submit failed:', err));
    return json(res, 202, { started: true });
  }
  return json(res, 405, { error: 'Method not allowed' });
}

// ─── Resume profiles (docs/profile.md) ───────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function sendResume(res, sections, { layout, editable = false, pdf = false, filename = 'Resume.pdf', sectionOrder = null, title = null } = {}) {
  const html = renderResumeHTML(sections, { layout, editable, sectionOrder, title });
  if (pdf) {
    const buf = await renderResumePDF(html);
    if (buf) {
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': buf.length, 'Content-Disposition': `attachment; filename="${filename}"` });
      return res.end(buf);
    }
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  return res.end(html);
}

async function handleResumeProfiles(req, res, userId, method, profileId, action, body) {
  if (!UUID_RE.test(userId) || (profileId && !UUID_RE.test(profileId))) return json(res, 404, { error: 'Not found' });
  try {
    if (!profileId) {
      if (method === 'GET') return json(res, 200, await listResumeProfiles(userId));
      if (method === 'POST') return json(res, 201, await createResumeProfile(userId, body));
    } else if (!action) {
      if (method === 'GET') {
        const p = await getResumeProfile(userId, profileId);
        return p ? json(res, 200, p) : json(res, 404, { error: 'Not found' });
      }
      if (method === 'PATCH' || method === 'PUT') {
        const p = await updateResumeProfile(userId, profileId, body);
        return p ? json(res, 200, p) : json(res, 404, { error: 'Not found' });
      }
      if (method === 'DELETE') {
        const r = await deleteResumeProfile(userId, profileId);
        return json(res, r.deleted ? 200 : r.status, r);
      }
    } else if (action === 'resume' && method === 'GET') {
      // The profile's resume as a page (?edit=1 for the inline editor) or a PDF (?format=pdf).
      const p = await getResumeProfile(userId, profileId);
      if (!p) return json(res, 404, { error: 'Not found' });
      const q = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
      return sendResume(res, p.sections, { layout: p.layout, editable: q.edit === '1', pdf: q.format === 'pdf', filename: resumeFileName(p.sections.personal?.fullName, p.name) });   // profile download: Name_ProfileRole.pdf
    } else if (action === 'original' && method === 'GET') {
      // The resume file exactly as uploaded.
      const f = await getResumeFile(userId, profileId);
      if (!f) return json(res, 404, { error: 'No uploaded file is kept for this profile. Upload it again with Replace.' });
      const ascii = f.name.replace(/[^\x20-\x7E]/g, '_');
      res.writeHead(200, { 'Content-Type': f.contentType, 'Content-Length': f.data.length,
        'Content-Disposition': `${new URL(req.url, 'http://x').searchParams.get('inline') === '1' ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`, 'Cache-Control': 'no-store' });
      return res.end(f.data);
    } else if (action === 'original' && method === 'PUT') {
      // Raw file body; the name comes in X-Filename (URI-encoded).
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > RESUME_FILE_MAX) return json(res, 413, { error: 'The file is over 10 MB' }); chunks.push(c); }
      let name = ''; try { name = decodeURIComponent(req.headers['x-filename'] || ''); } catch { name = ''; }
      const r = await saveResumeFile(userId, profileId, { name, contentType: req.headers['content-type'], data: Buffer.concat(chunks) });
      return r.error ? json(res, r.code || 400, { error: r.error }) : json(res, 200, r);
    } else if (action === 'render' && method === 'POST') {
      // Preview of unsaved changes: { sections?, layout?, edit? } over the stored profile.
      const p = await getResumeProfile(userId, profileId);
      if (!p) return json(res, 404, { error: 'Not found' });
      // Unsaved sections are rendered as sent (the renderer validates them); blank new entries stay in edit mode.
      const sections = body?.sections && typeof body.sections === 'object' ? { ...p.sections, ...body.sections } : p.sections;
      const layout = body?.layout ? normalizeLayout({ ...p.layout, ...body.layout }) : p.layout;
      return sendResume(res, sections, { layout, editable: body?.edit === true });
    } else if (action === 'set-default' && method === 'POST') {
      const p = await setDefaultResumeProfile(userId, profileId);
      return p ? json(res, 200, p) : json(res, 404, { error: 'Not found' });
    } else if (action === 'import-resume' && method === 'POST') {
      if (!body?.text || String(body.text).trim().length < 30) return json(res, 400, { error: 'Resume text is empty — was the file a scanned image?' });
      const current = await getResumeProfile(userId, profileId);
      if (!current) return json(res, 404, { error: 'Not found' });
      const extracted = extractResumeSections(String(body.text));
      const merged = mergeExtracted(current.sections, extracted, body.mode === 'replace' ? 'replace' : 'fill');
      const updated = await updateResumeProfile(userId, profileId, { sections: merged, resumeText: String(body.text), resumeFilename: body.filename ?? current.resumeFilename });
      return json(res, 200, { profile: updated, extracted: {
        education: extracted.education.length, experience: extracted.experience.length, projects: extracted.projects.length,
        skills: extracted.skills.reduce((n, g) => n + g.items.length, 0), certifications: extracted.certifications.length,
      } });
    }
    return json(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    if (err.status) return json(res, err.status, { error: err.message });
    throw err;
  }
}

async function handleDeleteKeywordSearch(req, res, userId) {
  const cleared = await clearKeywordSearch(userId);
  json(res, 200, { cleared });
}

async function handleGetProfile(req, res, userId) {
  const { rows } = await query(
    `SELECT pref.*, p.*, (p.ats_password IS NOT NULL AND length(p.ats_password) > 0) AS ats_password_saved FROM user_profiles p
      LEFT JOIN user_profile_preferences pref ON pref.user_profile_id = p.id
     WHERE p.user_id = $1`, [userId]
  );
  json(res, 200, rows[0] || null);
}

/** Validates/normalizes the subset of profile fields the caller sent. Never invents a value for a field the caller didn't send. */
function validateProfileBody(body) {
  const errors = [];
  if (body.highest_education_level !== undefined && body.highest_education_level !== null && !isValidEducationLevel(body.highest_education_level)) {
    errors.push(`highest_education_level must be one of ${EDUCATION_LEVELS.join('/')}`);
  }
  if (body.current_city !== undefined || body.current_state !== undefined || body.current_country !== undefined) {
    const normalized = normalizeUserLocation({ city: body.current_city, state: body.current_state, country: body.current_country });
    body.current_city = normalized.city;
    body.current_state = normalized.stateCode;
    body.current_country = normalized.countryCode;
  }
  return errors;
}

async function handleUpsertProfile(req, res, userId, body) {
  const errors = validateProfileBody(body);
  if (errors.length) return json(res, 400, { errors });

  const profile = await query(
    `INSERT INTO user_profiles (user_id, current_title, total_experience_years,
       highest_education_level, current_city, current_state, current_country,
       work_authorization, needs_sponsorship, full_name, email, phone, summary, open_to_work)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,COALESCE($14, TRUE))
     ON CONFLICT (user_id) DO UPDATE SET current_title=EXCLUDED.current_title,
       total_experience_years=EXCLUDED.total_experience_years,
       highest_education_level=EXCLUDED.highest_education_level,
       current_city=EXCLUDED.current_city, current_state=EXCLUDED.current_state,
       current_country=EXCLUDED.current_country, work_authorization=EXCLUDED.work_authorization,
       needs_sponsorship=EXCLUDED.needs_sponsorship,
       full_name=EXCLUDED.full_name, email=EXCLUDED.email, phone=EXCLUDED.phone,
       summary=EXCLUDED.summary, open_to_work=EXCLUDED.open_to_work, updated_at=NOW()
     RETURNING *`, [userId, body.current_title ?? null, body.total_experience_years ?? null,
      body.highest_education_level ?? null, body.current_city ?? null, body.current_state ?? null,
      body.current_country ?? null, body.work_authorization ?? null, body.needs_sponsorship ?? null,
      body.full_name ?? null, body.email ?? null, body.phone ?? null, body.summary ?? null, body.open_to_work ?? null]
  );
  // Street address and postal code live next to city/state/country (see db/migrate-address.mjs)
  if (body.address_line1 !== undefined || body.postal_code !== undefined) {
    await query(`UPDATE user_profiles SET address_line1 = COALESCE($2, address_line1), postal_code = COALESCE($3, postal_code) WHERE user_id = $1`,
      [userId, body.address_line1 ?? null, body.postal_code ?? null]).catch(() => {});
  }
  // Persist ats_password if provided (stored separately)
  if (body.ats_password) {
    await query(
      `UPDATE user_profiles SET ats_password = $2 WHERE user_id = $1`,
      [userId, body.ats_password]
    ).catch(() => {});
  }
  // require_sponsorship mirrors user_profiles.needs_sponsorship (the
  // authoritative field — see docs/profile-recommendation-model.md) so any
  // caller still reading the legacy preferences column sees a consistent value.
  await query(
    `INSERT INTO user_profile_preferences
       (user_profile_id, preferred_workplace_types, preferred_employment_types,
        preferred_states, preferred_cities, remote_only, min_salary, salary_is_hard_constraint,
        max_experience_required, require_sponsorship, exclude_clearance_jobs, excluded_companies,
        excluded_role_families, allowed_countries)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (user_profile_id) DO UPDATE SET
       preferred_workplace_types=EXCLUDED.preferred_workplace_types,
       preferred_employment_types=EXCLUDED.preferred_employment_types,
       preferred_states=EXCLUDED.preferred_states, preferred_cities=EXCLUDED.preferred_cities,
       remote_only=EXCLUDED.remote_only, min_salary=EXCLUDED.min_salary,
       salary_is_hard_constraint=EXCLUDED.salary_is_hard_constraint,
       max_experience_required=EXCLUDED.max_experience_required,
       require_sponsorship=EXCLUDED.require_sponsorship,
       exclude_clearance_jobs=EXCLUDED.exclude_clearance_jobs,
       excluded_companies=EXCLUDED.excluded_companies,
       excluded_role_families=EXCLUDED.excluded_role_families,
       allowed_countries=EXCLUDED.allowed_countries, updated_at=NOW()`,
    [profile.rows[0].id, body.preferred_workplace_types ?? [], body.preferred_employment_types ?? [],
      body.preferred_states ?? [], body.preferred_cities ?? [], body.remote_only ?? false,
      body.min_salary ?? null, body.salary_is_hard_constraint ?? false, body.max_experience_required ?? null,
      body.needs_sponsorship ?? false, body.exclude_clearance_jobs ?? false, body.excluded_companies ?? [],
      body.excluded_role_families ?? [], body.allowed_countries ?? []]
  );
  return handleGetProfile(req, res, userId);
}

/** Resolves user_profiles.id for a user_id, or null if no profile exists yet. */
async function getProfileId(userId) {
  const { rows } = await query(`SELECT id FROM user_profiles WHERE user_id = $1`, [userId]);
  return rows[0]?.id ?? null;
}

async function handleGetTargetRoles(req, res, userId) {
  const profileId = await getProfileId(userId);
  if (!profileId) return json(res, 200, []);
  const { rows } = await query(
    `SELECT id, canonical_role, role_family, priority FROM user_target_roles
      WHERE user_profile_id = $1 ORDER BY priority ASC`, [profileId]
  );
  json(res, 200, rows);
}

/** PUT replaces the full target-role list — same semantics as skill_extract.mjs's per-job replace: recompute the whole set, don't accumulate stale rows. */
async function handlePutTargetRoles(req, res, userId, body) {
  const profileId = await getProfileId(userId);
  if (!profileId) return json(res, 404, { error: 'Create the profile first via PUT /users/:userId/profile' });
  const roles = Array.isArray(body.roles) ? body.roles : [];
  for (const r of roles) {
    if (!r.title && !r.canonicalRole && !r.roleFamily) return json(res, 400, { error: 'Each role needs a title, canonicalRole, or roleFamily' });
  }
  await query(`DELETE FROM user_target_roles WHERE user_profile_id = $1`, [profileId]);
  for (const [index, r] of roles.entries()) {
    const normalized = r.canonicalRole || r.roleFamily ? { roleFamily: r.roleFamily ?? null, canonicalRole: r.canonicalRole ?? null } : normalizeRoleInput(r.title);
    await query(
      `INSERT INTO user_target_roles (user_profile_id, canonical_role, role_family, priority)
       VALUES ($1,$2,$3,$4)`,
      [profileId, normalized.canonicalRole, normalized.roleFamily, r.priority ?? index + 1]
    );
  }
  return handleGetTargetRoles(req, res, userId);
}

async function handleGetSkills(req, res, userId) {
  const profileId = await getProfileId(userId);
  if (!profileId) return json(res, 200, []);
  const { rows } = await query(
    `SELECT s.canonical_name, s.normalized_name, s.category, us.proficiency, us.years_experience, us.source, us.confidence
       FROM user_skills us JOIN skills s ON s.id = us.skill_id
      WHERE us.user_profile_id = $1 ORDER BY s.canonical_name`, [profileId]
  );
  json(res, 200, rows);
}

/** PUT replaces the full skill list. Aliases are normalized (Postgres -> PostgreSQL) so duplicates under different spellings can't accumulate. */
async function handlePutSkills(req, res, userId, body) {
  const profileId = await getProfileId(userId);
  if (!profileId) return json(res, 404, { error: 'Create the profile first via PUT /users/:userId/profile' });
  const skillsIn = Array.isArray(body.skills) ? body.skills : [];
  if (skillsIn.some(s => !s.name)) return json(res, 400, { error: 'Each skill needs a name' });

  await query(`DELETE FROM user_skills WHERE user_profile_id = $1`, [profileId]);
  const seen = new Set();
  for (const s of skillsIn) {
    const normalizedName = normalizeSkillName(s.name);
    if (seen.has(normalizedName)) continue; // de-dupe aliases of the same skill within one request
    seen.add(normalizedName);
    const { rows: skillRows } = await query(
      `INSERT INTO skills (canonical_name, normalized_name)
       VALUES ($1,$2) ON CONFLICT (normalized_name) DO UPDATE SET canonical_name = skills.canonical_name
       RETURNING id`, [s.name, normalizedName]
    );
    await query(
      `INSERT INTO user_skills (user_profile_id, skill_id, proficiency, years_experience, source, confidence)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_profile_id, skill_id) DO UPDATE SET
         proficiency=EXCLUDED.proficiency, years_experience=EXCLUDED.years_experience,
         source=EXCLUDED.source, confidence=EXCLUDED.confidence`,
      [profileId, skillRows[0].id, s.proficiency ?? null, s.yearsExperience ?? null, s.source ?? 'user_entered', s.confidence ?? 1.0]
    );
  }
  return handleGetSkills(req, res, userId);
}

async function handleGetProfileCompleteness(req, res, userId) {
  const profileId = await getProfileId(userId);
  if (!profileId) return json(res, 200, { completeEnoughForRecommendations: false, missing: ['No profile created yet — PUT /users/:userId/profile first.'], warnings: [] });
  const [{ rows: profileRows }, { rows: roleRows }, { rows: skillRows }] = await Promise.all([
    query(`SELECT current_title, total_experience_years, highest_education_level, current_country FROM user_profiles WHERE id = $1`, [profileId]),
    query(`SELECT id FROM user_target_roles WHERE user_profile_id = $1`, [profileId]),
    query(`SELECT skill_id FROM user_skills WHERE user_profile_id = $1`, [profileId]),
  ]);
  const p = profileRows[0];
  const result = evaluateProfileCompleteness(
    { currentTitle: p.current_title, totalExperienceYears: p.total_experience_years, highestEducationLevel: p.highest_education_level },
    roleRows, skillRows, { currentCountry: p.current_country }
  );
  json(res, 200, result);
}

/** Dedicated preferences sub-resource for partial updates without resending the whole profile — see docs/profile-recommendation-model.md's legacy-migration note on why this is /profile/preferences, not the legacy /preferences path. */
async function handleGetProfilePreferences(req, res, userId) {
  const { rows } = await query(
    `SELECT pref.* FROM user_profile_preferences pref
       JOIN user_profiles p ON p.id = pref.user_profile_id
      WHERE p.user_id = $1`, [userId]
  );
  json(res, 200, rows[0] || null);
}

async function handlePutProfilePreferences(req, res, userId, body) {
  const profileId = await getProfileId(userId);
  if (!profileId) return json(res, 404, { error: 'Create the profile first via PUT /users/:userId/profile' });
  const fields = {
    preferred_workplace_types: body.preferred_workplace_types, preferred_employment_types: body.preferred_employment_types,
    preferred_states: body.preferred_states, preferred_cities: body.preferred_cities, remote_only: body.remote_only,
    min_salary: body.min_salary, salary_is_hard_constraint: body.salary_is_hard_constraint,
    max_experience_required: body.max_experience_required, exclude_clearance_jobs: body.exclude_clearance_jobs,
    excluded_companies: body.excluded_companies, excluded_role_families: body.excluded_role_families,
    allowed_countries: body.allowed_countries,
  };
  const sets = []; const params = [userId];
  for (const [col, value] of Object.entries(fields)) {
    if (value !== undefined) { params.push(value); sets.push(`${col} = $${params.length}`); }
  }
  if (!sets.length) return json(res, 400, { error: 'Nothing to update' });
  sets.push('updated_at = NOW()');
  params[0] = profileId; // reuse the already-resolved id instead of a redundant subquery
  await query(
    `UPDATE user_profile_preferences SET ${sets.join(', ')} WHERE user_profile_id = $1`, params
  );
  return handleGetProfilePreferences(req, res, userId);
}

async function handleInteraction(req, res, userId, jobId, body) {
  const allowed = new Set(['VIEW', 'SAVE', 'SKIP', 'APPLY', 'HIDE', 'CLICK']);
  const type = String(body.interaction_type || '').toUpperCase();
  if (!allowed.has(type)) return json(res, 400, { error: 'Invalid interaction_type' });
  const { rows } = await query(
    `INSERT INTO user_job_interactions (user_id, job_id, interaction_type)
     VALUES ($1, $2, $3) RETURNING *`, [userId, jobId, type]
  );
  json(res, 201, rows[0]);
}

// ─── Router ──────────────────────────────────────────────────────────────────

export async function router(req, res) {
  // Same-origin only: the dashboard calls /v1 on its own host, so no CORS headers (they used to allow any site)
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const path   = req.url.split('?')[0].replace(/\/$/, '') || '/';
  const q      = parseQuery(req.url);
  const method = req.method;

  // Every per-user route is /users/<id>/…: only that user may touch it (req.user comes from the session, server.mjs)
  const owner = path.match(/^\/users\/([^/]+)/);
  if (owner && owner[1] !== req.user?.id) return json(res, 403, { error: 'Not your account' });

  try {
    if (path === '/health'   && method === 'GET') return await handleHealth(req, res);
    if (path === '/stats'    && method === 'GET') return await handleStats(req, res);
    if (path === '/jobs'     && method === 'GET') return await handleListJobs(req, res, q);
    if (path === '/companies'&& method === 'GET') return await handleListCompanies(req, res, q);
    if (path === '/jobs/import' && method === 'POST') return await handleImportJob(req, res, await parseBody(req));
    if (path === '/jobs/import/preview' && method === 'POST') return await handleImportPreview(req, res, await parseBody(req));
    if (path === '/jobs/import/check' && method === 'GET') return handleImportCheck(req, res, q);
    if (path === '/profile/fields' && method === 'GET') return json(res, 200, APPLICATION_DEFAULT_FIELDS);

    let m;
    if ((m = path.match(/^\/jobs\/(\d+)$/))       && method === 'GET')   return await handleGetJob(req, res, +m[1]);
    if ((m = path.match(/^\/companies\/(\d+)$/))  && method === 'GET')   return await handleGetCompany(req, res, +m[1]);

    if ((m = path.match(/^\/users\/([^/]+)\/preferences$/))) {
      if (method === 'GET')  return await handleGetPrefs(req, res, m[1]);
      if (method === 'POST') return await handleCreatePref(req, res, m[1], await parseBody(req));
    }
    if ((m = path.match(/^\/users\/([^/]+)\/preferences\/([^/]+)$/)) && method === 'PUT')
      return await handleUpdatePref(req, res, m[1], m[2], await parseBody(req));

    if ((m = path.match(/^\/users\/([^/]+)\/alerts$/)) && method === 'GET')
      return await handleGetAlerts(req, res, m[1], q);
    if ((m = path.match(/^\/users\/([^/]+)\/alerts\/(\d+)$/)) && method === 'PATCH')
      return await handleUpdateAlert(req, res, m[1], +m[2], await parseBody(req));

    if ((m = path.match(/^\/users\/([^/]+)\/match$/)) && method === 'POST')
      return await handleTriggerMatch(req, res, m[1]);
    if ((m = path.match(/^\/users\/([^/]+)\/feed-relevance$/)) && method === 'GET')
      return await handleFeedRelevance(req, res, m[1], q);
    if ((m = path.match(/^\/users\/([^/]+)\/recommendations$/)) && method === 'GET')
      return await handleRecommendations(req, res, m[1], q);
    if ((m = path.match(/^\/users\/([^/]+)\/jobs\/(\d+)\/match$/)) && method === 'GET')
      return await handleJobMatch(req, res, m[1], +m[2]);
    if ((m = path.match(/^\/users\/([^/]+)\/applications$/))) {
      if (method === 'GET') return await handleListApplications(req, res, m[1], q);
      if (method === 'POST') return await handleUpsertApplication(req, res, m[1], await parseBody(req));
    }
    if ((m = path.match(/^\/users\/([^/]+)\/applications\/(\d+)$/))) {
      if (method === 'GET') return await handleGetApplication(req, res, m[1], +m[2]);
      if (method === 'PATCH') return await handleUpdateApplication(req, res, m[1], +m[2], await parseBody(req));
      if (method === 'DELETE') return await handleDeleteApplication(req, res, m[1], +m[2]);
    }
    if ((m = path.match(/^\/users\/([^/]+)\/applications\/(\d+)\/(tailor|resume|changes|answers|approve|skip|submit|apply)$/)))
      return await handleApplicationAction(req, res, m[1], +m[2], m[3], method, ['POST', 'PATCH', 'PUT'].includes(method) ? await parseBody(req) : null, q);
    if ((m = path.match(/^\/users\/([^/]+)\/applied$/)) && method === 'GET') return await handleApplied(req, res, m[1], q);
    if ((m = path.match(/^\/users\/([^/]+)\/imports\/tsenta$/))) return await handleTsentaImport(req, res, m[1], method);
    if ((m = path.match(/^\/users\/([^/]+)\/resume-model$/)) && method === 'GET') return await handleResumeModel(req, res, m[1]);
    if ((m = path.match(/^\/users\/([^/]+)\/resume-examples(?:\/([^/]+))?$/)))
      return await handleResumeExamples(req, res, m[1], method, m[2], method === 'POST' ? await parseBody(req) : null);
    if ((m = path.match(/^\/users\/([^/]+)\/auto-apply(?:\/(lanes|preview|run))?(?:\/([^/]+))?$/)))
      return await handleAutoApply(req, res, m[1], method, m[2], m[3], ['POST', 'PATCH', 'PUT'].includes(method) ? await parseBody(req) : null);
    if ((m = path.match(/^\/users\/([^/]+)\/resume-profiles(?:\/([^/]+))?(?:\/(set-default|import-resume|resume|render|original))?$/)))
      return await handleResumeProfiles(req, res, m[1], method, m[2], m[3], ['POST', 'PATCH', 'PUT'].includes(method) && m[3] !== 'original' ? await parseBody(req) : null);
    if ((m = path.match(/^\/users\/([^/]+)\/search$/))) {
      if (method === 'GET') return await handleGetKeywordSearch(req, res, m[1]);
      if (method === 'PUT') return await handlePutKeywordSearch(req, res, m[1], await parseBody(req));
      if (method === 'DELETE') return await handleDeleteKeywordSearch(req, res, m[1]);
    }
    if ((m = path.match(/^\/users\/([^/]+)\/profile$/))) {
      if (method === 'GET') return await handleGetProfile(req, res, m[1]);
      if (method === 'PUT' || method === 'POST') return await handleUpsertProfile(req, res, m[1], await parseBody(req));
    }
    // /profile/preferences (not bare /preferences, which stays the legacy
    // user_preferences table below) — see docs/profile-recommendation-model.md.
    if ((m = path.match(/^\/users\/([^/]+)\/profile\/preferences$/))) {
      if (method === 'GET') return await handleGetProfilePreferences(req, res, m[1]);
      if (method === 'PUT') return await handlePutProfilePreferences(req, res, m[1], await parseBody(req));
    }
    if ((m = path.match(/^\/users\/([^/]+)\/target-roles$/))) {
      if (method === 'GET') return await handleGetTargetRoles(req, res, m[1]);
      if (method === 'PUT') return await handlePutTargetRoles(req, res, m[1], await parseBody(req));
    }
    if ((m = path.match(/^\/users\/([^/]+)\/skills$/))) {
      if (method === 'GET') return await handleGetSkills(req, res, m[1]);
      if (method === 'PUT') return await handlePutSkills(req, res, m[1], await parseBody(req));
    }
    if ((m = path.match(/^\/users\/([^/]+)\/profile\/completeness$/)) && method === 'GET')
      return await handleGetProfileCompleteness(req, res, m[1]);
    if ((m = path.match(/^\/users\/([^/]+)\/jobs\/(\d+)\/interactions$/)) && method === 'POST')
      return await handleInteraction(req, res, m[1], +m[2], await parseBody(req));

    // Gmail OAuth
    if ((m = path.match(/^\/users\/([^/]+)\/gmail(?:\/(auth-url|status))?$/)))
      return await handleGmail(req, res, m[1], method, m[2]);
    if (path === '/auth/gmail/callback' && method === 'GET')
      return await handleGmailCallback(req, res, q);

    json(res, 404, { error: 'Not found' });

  } catch (err) {
    console.error('API error:', err.message);
    json(res, 500, { error: 'Internal server error' });
  }
}

// ─── Gmail OAuth (lib/gmail.mjs) ─────────────────────────────────────────────

async function handleGmail(req, res, userId, method, sub) {
  if (method === 'GET' && sub === 'auth-url') {
    let url;
    try { url = await getAuthUrl(userId); }
    catch (e) { return json(res, 503, { error: e.message }); }
    return json(res, 200, { url });
  }
  if (method === 'GET' && sub === 'status') {
    const status = await getGmailStatus(userId);
    return json(res, 200, status);
  }
  if (method === 'DELETE' && !sub) {
    await disconnectGmail(userId);
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'Not found' });
}

async function handleGmailCallback(req, res, q) {
  const code  = q.code;
  const state = q.state;  // userId
  const error = q.error;
  if (error) return json(res, 400, { error: `Google OAuth error: ${error}` });
  if (!code || !state) return json(res, 400, { error: 'Missing code or state' });
  try {
    const { email } = await exchangeCode(state, code, req.user?.id);
    // Redirect back to app with success indicator
    res.writeHead(302, { Location: `/app/?gmail=connected&email=${encodeURIComponent(email || '')}#/settings` });
    return res.end();
  } catch (e) {
    console.error('Gmail callback error:', e.message);
    res.writeHead(302, { Location: `/app/?gmail=error&reason=${encodeURIComponent(e.message.slice(0, 100))}#/settings` });
    return res.end();
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1]);
if (isMain) startStandalone();

function startStandalone() {
  const server = createServer(router);
  server.listen(PORT, () => {
    console.error(`\n🚀  Rejekt.ai REST API  →  http://localhost:${PORT}`);
    console.error(`   GET /health  /stats  /jobs  /companies`);
    console.error(`   GET/POST /users/:id/preferences`);
    console.error(`   GET /users/:id/alerts   POST /users/:id/match\n`);
  });
  process.on('SIGTERM', async () => { server.close(); await closePool(); process.exit(0); });
}
