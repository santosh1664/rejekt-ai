/**
 * Auto-apply (docs/auto-apply.md).
 *
 *   plan     pick jobs per lane: score ≥ the lane's minimum, title rules,
 *            not already tracked, a form this worker can fill, inside the
 *            daily and per-company caps            → applications QUEUED
 *   prepare  tailor the lane's resume to the job, fill the cover letter,
 *            build the answer book                  → PREPARED
 *   submit   open the form in a browser and fill it. Lanes with "review
 *            before submit" stop here               → NEEDS_REVIEW
 *            otherwise (or once approved) it sends  → SUBMITTED (tracker: Applied)
 *            a CAPTCHA, an unanswered required question or a form error
 *                                                   → NEEDS_YOU
 *            anything else                          → FAILED (retried twice)
 *
 * Modeled on what Tsenta's auto-apply exposes (lanes, per-lane resume
 * profile, match threshold, daily cap, per-company cap, review before submit,
 * "needs you"), with honest tailoring and no CAPTCHA solving.
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '../lib/db.mjs';
import { generateRecommendations } from '../matching/recommend.mjs';
import { normalizeKeywordSearch } from '../matching/keyword-search.mjs';
import { detectAts } from '../lib/ats-detect.mjs';
import { normalizeSkillName } from '../lib/skills.mjs';
import { getResumeProfile, getDefaultResumeProfile, deriveMatchingFields, updateResumeProfile, normalizeQuestion } from '../lib/resume-profiles.mjs';
import { tailorForJob, TAILOR_MODES } from '../lib/resume-tailor.mjs';
import { atsScore } from '../lib/ats-score.mjs';
import { renderResumeHTML, renderResumePDF, renderCoverLetter, getBrowser, resumeFileName } from '../lib/resume-render.mjs';
import { trackApplication, updateApplication, setApplyState, recordEvent } from '../lib/applications.mjs';
import { recordRewrite, loadStyleExamples, loadBulletBank } from '../lib/rewrites.mjs';
import { buildAnswerBook } from './answers.mjs';
import { fillApplication } from './form-fill.mjs';
import { fillWorkday, workdayAuth } from './workday-fill.mjs';
import { ensureOnForm } from './account-create.mjs';

export const FILLABLE_ATS = ['greenhouse', 'lever', 'ashby', 'workday', 'rippling', 'recruitee', 'pinpoint', 'teamtailor', 'breezy', 'workable'];
// Platforms whose "it was sent" page we've seen recognised on a real submission. On the others the form fills
// (scripts/probe-autoapply.mjs) but every application waits for a person's Send, even in lanes that skip review,
// so a confirmation page we don't recognise can't turn into an unattended "no confirmation" or a double send.
// Add a platform here once its first approved applications come back Submitted.
export const SUBMIT_VERIFIED_ATS = ['greenhouse', 'lever', 'ashby', 'workday'];
// Assisted: these sites stop automated applications, so Rejekt.ai prepares the application (tailored resume,
// answers) and the person sends it on the company's site from Needs you. We never solve CAPTCHAs or get around
// bot checks. bamboohr: visible reCAPTCHA on every form; smartrecruiters: "Access is temporarily restricted"
// bot check; oraclecloud: email-first multi-step flow, not automated yet.
export const ASSISTED_ATS = {
  bamboohr: "BambooHR asks you to confirm you're not a robot",
  smartrecruiters: 'SmartRecruiters blocks automated applications',
  oraclecloud: "This company's Oracle careers site needs you to apply yourself",
};
const MAX_ATTEMPTS = 3;

// ─── Settings and lanes ──────────────────────────────────────────────────────

const SETTINGS_DEFAULTS = { enabled: false, dailyCap: 25, perCompanyCap30d: 3, acceptConsent: false, reviewBeforeSubmit: true };

export async function getSettings(userId) {
  const { rows } = await query(`SELECT * FROM auto_apply_settings WHERE user_id = $1`, [userId]);
  const r = rows[0];
  const settings = r ? { enabled: r.enabled, dailyCap: r.daily_cap, perCompanyCap30d: r.per_company_cap_30d, acceptConsent: r.accept_consent, reviewBeforeSubmit: r.review_before_submit, updatedAt: r.updated_at } : { ...SETTINGS_DEFAULTS, updatedAt: null };
  return { exists: !!r, ...settings, lanes: await listLanes(userId) };
}

export async function saveSettings(userId, patch = {}) {
  const cur = await getSettings(userId);
  const clampInt = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const next = {
    enabled: patch.enabled === undefined ? cur.enabled : !!patch.enabled,
    dailyCap: patch.dailyCap === undefined ? cur.dailyCap : clampInt(patch.dailyCap, 1, 100, cur.dailyCap),
    perCompanyCap30d: patch.perCompanyCap30d === undefined ? cur.perCompanyCap30d : clampInt(patch.perCompanyCap30d, 1, 20, cur.perCompanyCap30d),
    acceptConsent: patch.acceptConsent === undefined ? cur.acceptConsent : !!patch.acceptConsent,
    reviewBeforeSubmit: patch.reviewBeforeSubmit === undefined ? cur.reviewBeforeSubmit !== false : !!patch.reviewBeforeSubmit,
  };
  await query(
    `INSERT INTO auto_apply_settings (user_id, enabled, daily_cap, per_company_cap_30d, accept_consent, review_before_submit) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id) DO UPDATE SET enabled = $2, daily_cap = $3, per_company_cap_30d = $4, accept_consent = $5, review_before_submit = $6, updated_at = NOW()`,
    [userId, next.enabled, next.dailyCap, next.perCompanyCap30d, next.acceptConsent, next.reviewBeforeSubmit]);
  return getSettings(userId);
}

function shapeLane(r) {
  return {
    id: r.id, name: r.name, enabled: r.enabled, resumeProfileId: r.resume_profile_id, resumeProfileName: r.resume_profile_name || null,
    minScore: r.min_score, search: r.search || '', excludeSearch: r.exclude_search || '', excludeTitle: r.exclude_title || '',
    workplaceTypes: r.workplace_types || [], postedWithinDays: r.posted_within_days, tailorMode: r.tailor_mode,
    reviewBeforeSubmit: r.review_before_submit, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export async function listLanes(userId) {
  const { rows } = await query(
    `SELECT l.*, rp.name AS resume_profile_name FROM auto_apply_lanes l LEFT JOIN resume_profiles rp ON rp.id = l.resume_profile_id
      WHERE l.user_id = $1 ORDER BY l.created_at, l.id`, [userId]);
  return rows.map(shapeLane);
}

const WORKPLACES = ['REMOTE', 'HYBRID', 'ONSITE'];

function laneValues(input, cur = {}) {
  const pick = (k, d) => (input[k] === undefined ? d : input[k]);
  const int = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v) || lo)));
  const v = {
    name: String(pick('name', cur.name || 'Lane')).trim().slice(0, 80) || 'Lane',
    enabled: !!pick('enabled', cur.enabled ?? true),
    resumeProfileId: pick('resumeProfileId', cur.resumeProfileId ?? null) || null,
    minScore: int(pick('minScore', cur.minScore ?? 70), 40, 95),
    search: String(pick('search', cur.search || '')).slice(0, 500),
    excludeSearch: String(pick('excludeSearch', cur.excludeSearch || '')).slice(0, 500),
    excludeTitle: String(pick('excludeTitle', cur.excludeTitle ?? 'senior|sr.|staff|principal|lead|manager|director|head of|vp')).slice(0, 500),
    workplaceTypes: (pick('workplaceTypes', cur.workplaceTypes || []) || []).map(x => String(x).toUpperCase()).filter(x => WORKPLACES.includes(x)),
    postedWithinDays: int(pick('postedWithinDays', cur.postedWithinDays ?? 14), 1, 60),
    tailorMode: TAILOR_MODES.includes(pick('tailorMode', cur.tailorMode)) ? pick('tailorMode', cur.tailorMode) : 'match',
    reviewBeforeSubmit: !!pick('reviewBeforeSubmit', cur.reviewBeforeSubmit ?? true),
  };
  return v;
}

export async function saveLane(userId, laneId, input = {}) {
  let cur = {};
  if (laneId) {
    const lanes = await listLanes(userId);
    cur = lanes.find(l => l.id === laneId);
    if (!cur) return null;
  } else {
    const { rows } = await query(`SELECT COUNT(*)::int AS n FROM auto_apply_lanes WHERE user_id = $1`, [userId]);
    if (rows[0].n >= 5) return { error: 'You can have up to 5 lanes' };
  }
  const v = laneValues(input, cur);
  if (v.resumeProfileId && !(await getResumeProfile(userId, v.resumeProfileId))) return { error: 'Resume profile not found' };
  const params = [userId, v.name, v.enabled, v.resumeProfileId, v.minScore, v.search, v.excludeSearch, v.excludeTitle, v.workplaceTypes, v.postedWithinDays, v.tailorMode, v.reviewBeforeSubmit];
  if (laneId) {
    await query(
      `UPDATE auto_apply_lanes SET name = $2, enabled = $3, resume_profile_id = $4, min_score = $5, search = $6, exclude_search = $7,
              exclude_title = $8, workplace_types = $9, posted_within_days = $10, tailor_mode = $11, review_before_submit = $12, updated_at = NOW()
        WHERE user_id = $1 AND id = $13`, [...params, laneId]);
  } else {
    const { rows } = await query(
      `INSERT INTO auto_apply_lanes (user_id, name, enabled, resume_profile_id, min_score, search, exclude_search, exclude_title,
              workplace_types, posted_within_days, tailor_mode, review_before_submit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`, params);
    laneId = rows[0].id;
  }
  return (await listLanes(userId)).find(l => l.id === laneId);
}

export async function deleteLane(userId, laneId) {
  const { rowCount } = await query(`DELETE FROM auto_apply_lanes WHERE user_id = $1 AND id = $2`, [userId, laneId]);
  return rowCount > 0;
}

// ─── Plan ────────────────────────────────────────────────────────────────────

/** The URL of the application form, or null when this worker can't fill that ATS. */
export function applyUrlFor({ url, ats, slug, rawId }) {
  const det = detectAts(url || '');
  const which = det?.ats || ats;
  if (which === 'greenhouse') {
    const s = det?.ats === 'greenhouse' ? det.slug : slug;
    const id = (det?.ats === 'greenhouse' && det.jobId) || (url && new URL(url).searchParams.get('gh_jid')) || rawId;
    return s && id ? `https://job-boards.greenhouse.io/${s}/jobs/${id}` : null;
  }
  if (which === 'lever' && det?.ats === 'lever' && det.jobId) return `https://${det.host}/${det.slug}/${det.jobId}/apply`;
  if (which === 'ashby' && det?.ats === 'ashby' && det.jobId) return `https://jobs.ashbyhq.com/${det.slug}/${det.jobId}/application`;
  if (which === 'workday') {
    const d = det?.ats === 'workday' ? det : (url ? detectAts(url) : null);
    if (d?.meta?.tenant && d?.meta?.shard && d?.meta?.site) {
      const reqId = d.jobId || rawId;
      if (reqId && !url) return `https://${d.meta.tenant}.${d.meta.shard}.myworkdayjobs.com/${d.meta.site}`;
    }
    return url || null;   // the job page: its Apply button leads into the account step
  }
  // These forms are reached from the posting itself: on the page behind its Apply button, or at a fixed sub-path
  const base = url && url.replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (base && which === 'teamtailor') return base;   // (BambooHR's form is on the posting too, but behind a reCAPTCHA: assisted)
  if (base && which === 'breezy') return `${base}/apply`;
  if (base && which === 'pinpoint') return `${base}/applications/new`;
  if (base && which === 'rippling') return `${base}/apply`;
  if (base && which === 'recruitee') return `${base}/c/new`;
  if (base && which === 'workable') return `${base}/apply/`;   // the posting's APPLICATION tab
  // Test boards and plain HTML forms served from the developer's own machine.
  if (url && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(url) && process.env.AUTO_APPLY_ALLOW_LOCAL === '1') return url;
  return null;
}

const splitTerms = s => String(s || '').split('|').map(t => t.trim().toLowerCase()).filter(Boolean);

async function laneProfile(userId, lane) {
  const rp = lane.resumeProfileId ? await getResumeProfile(userId, lane.resumeProfileId) : await getDefaultResumeProfile(userId);
  return rp;
}

function profileOverrideFrom(rp) {
  if (!rp) return null;
  const { profile, skills } = deriveMatchingFields(rp.sections);
  return {
    profile: { currentTitle: profile.current_title, totalExperienceYears: profile.total_experience_years, highestEducationLevel: profile.highest_education_level },
    userSkillNames: skills.map(normalizeSkillName),
  };
}

async function capsUsed(userId) {
  const [{ rows: today }, { rows: perCompany }] = await Promise.all([
    query(`SELECT COUNT(*)::int AS n FROM applications WHERE user_id = $1 AND source = 'auto'
            AND created_at >= date_trunc('day', NOW()) AND COALESCE(apply_state, '') <> 'SKIPPED'`, [userId]),
    query(`SELECT lower(COALESCE(job_snapshot->>'company', '')) AS company, COUNT(*)::int AS n FROM applications
            WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '30 days' AND (status <> 'SAVED' OR source = 'auto')
            GROUP BY 1`, [userId]),
  ]);
  return { today: today[0].n, perCompany: new Map(perCompany.map(r => [r.company, r.n])) };
}

/**
 * Pick jobs for each enabled lane. dryRun: report only, write nothing.
 * Returns { lanes: [{ laneId, name, considered, picked: [...], skipped: {reason: n} }], queued, capLeft }.
 */
export async function planRun(userId, { dryRun = false, laneIds = null } = {}) {
  const settings = await getSettings(userId);
  const lanes = settings.lanes.filter(l => l.enabled && (!laneIds || laneIds.includes(l.id)));
  const used = await capsUsed(userId);
  let capLeft = Math.max(0, settings.dailyCap - used.today);
  const { rows: tracked } = await query(`SELECT job_id FROM applications WHERE user_id = $1 AND job_id IS NOT NULL`, [userId]);
  const taken = new Set(tracked.map(r => String(r.job_id)));
  const companyCount = new Map(used.perCompany);
  const out = { lanes: [], queued: 0, capLeft, dailyCap: settings.dailyCap, usedToday: used.today };

  for (const lane of lanes) {
    const rp = await laneProfile(userId, lane);
    const report = { laneId: lane.id, name: lane.name, resumeProfile: rp?.name || null, considered: 0, aboveThreshold: 0, picked: [], skipped: {} };
    const skip = (reason, job) => { report.skipped[reason] = (report.skipped[reason] || 0) + 1; if (job && dryRun && (report.examples ||= []).length < 8) report.examples.push({ title: job.title, company: job.company, reason }); };
    out.lanes.push(report);
    if (!rp) { report.error = 'No resume profile yet. Create one on the Profile screen.'; continue; }

    const ks = normalizeKeywordSearch({ include: splitTerms(lane.search), exclude: splitTerms(lane.excludeSearch), scope: 'title' });
    const rec = await generateRecommendations(userId, {
      limit: 100, postedWithinDays: lane.postedWithinDays,
      keywordSearch: ks.active ? { ...ks, source: 'request' } : undefined,
      profileOverride: profileOverrideFrom(rp),
    });
    const titleBlock = splitTerms(lane.excludeTitle);
    for (const job of rec.jobs) {
      report.considered++;
      if (job.matchScore < lane.minScore) { skip('below match threshold'); continue; }
      report.aboveThreshold++;
      if (taken.has(String(job.jobId))) { skip('already tracked', job); continue; }
      const t = ` ${String(job.title).toLowerCase()} `;
      if (titleBlock.some(w => t.includes(w.length <= 3 ? ` ${w} ` : w))) { skip('title excluded', job); continue; }
      if (lane.workplaceTypes.length && job.workplace && job.workplace !== 'UNKNOWN' && !lane.workplaceTypes.includes(job.workplace)) { skip('workplace', job); continue; }
      const { rows: jr } = await query(
        `SELECT j.url, j.ats, c.slug, j.raw->>'id' AS raw_id FROM jobs j LEFT JOIN companies c ON c.id = j.company_id WHERE j.id = $1`, [job.jobId]);
      const formUrl = jr[0] ? applyUrlFor({ url: jr[0].url, ats: jr[0].ats, slug: jr[0].slug, rawId: jr[0].raw_id }) : null;
      if (!formUrl && !ASSISTED_ATS[jr[0]?.ats]) { skip(`can't fill ${jr[0]?.ats || 'this'} forms yet`, job); continue; }
      const co = String(job.company || '').toLowerCase();
      if ((companyCount.get(co) || 0) >= settings.perCompanyCap30d) { skip('company cap (30 days)', job); continue; }
      if (capLeft <= 0) { skip('daily cap reached', job); continue; }

      capLeft--; taken.add(String(job.jobId)); companyCount.set(co, (companyCount.get(co) || 0) + 1);
      report.picked.push({ jobId: job.jobId, title: job.title, company: job.company, matchScore: job.matchScore, formUrl });
      if (!dryRun) {
        const r = await trackApplication(userId, Number(job.jobId), 'SAVED', {
          source: 'auto', laneId: lane.id, resumeProfileId: rp.id, applyState: 'QUEUED',
          eventDetail: { source: 'auto', lane: lane.name, matchScore: job.matchScore },
        });
        if (r.id) { await query(`UPDATE applications SET apply_detail = $2 WHERE id = $1`, [r.id, { formUrl, matchScore: job.matchScore }]); out.queued++; }
      }
    }
  }
  out.capLeft = capLeft;
  return out;
}

// ─── Prepare ─────────────────────────────────────────────────────────────────

async function loadApp(appId) {
  const { rows } = await query(
    `SELECT a.*, l.tailor_mode, l.review_before_submit, l.name AS lane_name FROM applications a
       LEFT JOIN auto_apply_lanes l ON l.id = a.lane_id WHERE a.id = $1`, [appId]);
  return rows[0] || null;
}

async function jobForTailoring(app) {
  const snap = app.job_snapshot || {};
  let skills = [];
  if (app.job_id) {
    const { rows } = await query(
      `SELECT s.normalized_name AS name, js.importance FROM job_skills js JOIN skills s ON s.id = js.skill_id WHERE js.job_id = $1`, [app.job_id]).catch(() => ({ rows: [] }));
    skills = rows;
  }
  if (!skills.length && Array.isArray(snap.skills)) skills = snap.skills;
  return { title: snap.title, company: snap.company, description: snap.description, skills };
}

/**
 * Tailor the resume and build the answers for one application.
 * mode: the lane's tailoring mode, or an explicit one for manual use.
 */
export async function prepareApplication(userId, appId, { mode = null, track = false } = {}) { // `mode` is kept for old callers; there is one way to tailor now
  const app = await loadApp(appId);
  if (!app || app.user_id !== userId) return { error: 'Not found', code: 404 };
  const rp = app.resume_profile_id ? await getResumeProfile(userId, app.resume_profile_id) : await getDefaultResumeProfile(userId);
  if (!rp) return { error: 'No resume profile', code: 400 };
  // Nothing to tailor: an empty profile would come out as a page of posting skills.
  const bullets = (rp.sections?.experience || []).reduce((n, e) => n + (e.bullets || []).length, 0) + (rp.sections?.projects || []).reduce((n, p) => n + (p.bullets || []).length, 0);
  if (!bullets) return { error: `The "${rp.name}" resume profile is empty. Upload your resume on Profile → Resume first.`, code: 400 };
  const job = await jobForTailoring(app);
  const tailorMode = 'match';
  const styleExamples = tailorMode === 'match' ? await loadStyleExamples(userId, rp.sections).catch(() => null) : null;
  const bank = tailorMode === 'match' ? await loadBulletBank(userId).catch(() => null) : null;
  const tailored = await tailorForJob(rp.sections, job, tailorMode, { styleExamples, bank });
  // ATS scan of the finished resume against this posting, next to the untailored resume's score.
  const scan = atsScore(tailored.sections, job, { original: rp.sections });
  tailored.report.ats = { score: scan.score, before: atsScore(rp.sections, job, { original: rp.sections }).score, parts: scan.parts, missing: scan.missing, gaps: scan.gaps, issues: scan.issues };
  const coverLetter = renderCoverLetter(rp.coverLetter, job);
  await query(
    `UPDATE applications SET tailored_resume = $2, cover_letter = $3, resume_profile_id = $4, updated_at = NOW() WHERE id = $1`,
    [appId, { sections: tailored.sections, sectionOrder: tailored.sectionOrder, report: tailored.report, profileName: rp.name }, coverLetter || null, rp.id]);
  await recordRewrite(userId, {
    applicationId: appId, mode: tailored.report.mode, model: tailored.report.model || null, job,
    before: rp.sections, after: tailored.sections, report: tailored.report, sent: app.status === 'APPLIED',
  });
  if (app.source === 'auto' || track) await setApplyState(appId, userId, 'PREPARED', { ...(app.apply_detail || {}), tailoring: tailored.report.mode });
  else await recordEvent(appId, userId, { kind: 'resume', detail: { tailored: tailored.report.mode, profile: rp.name } });
  return { ok: true, report: tailored.report, resumeProfileName: rp.name };
}

// ─── Submit ──────────────────────────────────────────────────────────────────

/**
 * Fill (and, unless the lane reviews first, send) one prepared application.
 * approve: the person approved it after review, so it's sent.
 */
export async function submitApplication(userId, appId, { approve = false, browser = null } = {}) {
  const app = await loadApp(appId);
  if (!app || app.user_id !== userId) return { error: 'Not found', code: 404 };
  if (!app.tailored_resume) { const p = await prepareApplication(userId, appId); if (p.error) return p; return submitApplication(userId, appId, { approve, browser }); }
  const detail = app.apply_detail || {};
  const formUrl = (app.job_snapshot?.ats === 'workday' ? null : detail.formUrl) || (app.job_snapshot?.url && applyUrlFor({ url: app.job_snapshot.url, ats: app.job_snapshot.ats }));
  if (!formUrl) {
    const why = ASSISTED_ATS[app.job_snapshot?.ats];
    await setApplyState(appId, userId, 'NEEDS_YOU', { ...detail, assisted: !!why, jobUrl: app.job_snapshot?.url || null,
      reason: why ? `${why}, so this one is yours to send: your tailored resume is ready. Open the job, apply on the company's site, then mark it applied.`
                  : "This form can't be filled automatically. Apply on the company's site." });
    return { outcome: 'NEEDS_YOU' };
  }

  browser ||= await getBrowser();
  if (!browser) {
    await setApplyState(appId, userId, app.apply_state || 'PREPARED', { ...detail, reason: 'No browser available: install Chrome, or set CHROME_PATH' });
    return { error: 'No browser available', code: 503 };
  }
  const rp = await getResumeProfile(userId, app.resume_profile_id);
  // Credentials for ATS account creation (Phase 4)
  // Email: prefer profile email, fall back to the Gmail account they connected via OAuth
  const [{ rows: upRows }, { rows: gmailRows }] = await Promise.all([
    query(`SELECT email, ats_password FROM user_profiles WHERE user_id = $1`, [userId]).catch(() => ({ rows: [] })),
    query(`SELECT gmail_email FROM user_gmail_tokens WHERE user_id = $1`, [userId]).catch(() => ({ rows: [] })),
  ]);
  const atsEmail = upRows[0]?.email || gmailRows[0]?.gmail_email || rp?.sections?.personal?.email || null;
  const userCreds = atsEmail
    ? { email: atsEmail, password: upRows[0]?.ats_password || null, fullName: rp?.sections?.personal?.fullName }
    : null;
  const settings = await getSettings(userId);
  const tailored = app.tailored_resume;
  const ats = app.job_snapshot?.ats || detectAts(app.job_snapshot?.url || '')?.ats;
  // review first: a lane's own setting, or for the Apply button (no lane) the account's "Review before sending"
  const reviewFirst = app.lane_id ? app.review_before_submit !== false : settings.reviewBeforeSubmit !== false;
  const send = approve || (!reviewFirst && SUBMIT_VERIFIED_ATS.includes(ats));
  const book = buildAnswerBook(rp?.sections || tailored.sections, app.job_snapshot || {}, { coverLetter: app.cover_letter || '', overrides: app.answers?.overrides || {} });

  const dir = await mkdtemp(join(tmpdir(), 'autoapply-'));
  // the file the employer receives: Name_Role.pdf (e.g. Durgasantosh_G_Senior_Data_Engineer.pdf)
  const fullName = rp?.sections?.personal?.fullName || tailored.sections?.personal?.fullName;
  const files = { resume: join(dir, resumeFileName(fullName, app.job_snapshot?.title)), coverLetter: null };
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });   // Workday hides footer buttons behind its sticky bar on short windows
  await setApplyState(appId, userId, 'SUBMITTING', detail, { attempts: (app.attempts || 0) + 1 });
  let result;
  try {
    const pdf = await renderResumePDF(renderResumeHTML(tailored.sections, { sectionOrder: tailored.sectionOrder, layout: rp?.layout }));
    await writeFile(files.resume, pdf);
    if (app.cover_letter) {
      files.coverLetter = join(dir, resumeFileName(fullName, app.job_snapshot?.title, 'Cover_Letter'));
      const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      const letterHtml = `<!doctype html><meta charset=utf-8><body style="font:11pt/1.5 Arial;max-width:6.5in;margin:0 auto;white-space:pre-wrap">${esc(app.cover_letter)}</body>`;
      await writeFile(files.coverLetter, await renderResumePDF(letterHtml));
    }
    // Phase 4: handle ATS login wall (creates account + reads OTP via Gmail)
    const isWd = detectAts(formUrl || '')?.ats === 'workday';
    const seen = {};
    const wallResult = isWd
      ? (userCreds?.password ? await workdayAuth(page, formUrl, userCreds, userId, seen) : { ok: false, reason: 'Workday needs an account. Add a Workday password in Settings.' })
      : await ensureOnForm(page, formUrl, userCreds, userId);
    if (seen.description) await query(`UPDATE applications SET job_snapshot = jsonb_set(COALESCE(job_snapshot, '{}'::jsonb), '{description}', to_jsonb($1::text))
      WHERE id = $2 AND COALESCE(job_snapshot->>'description', '') = ''`, [seen.description.trim(), appId]).catch(() => {});
    if (!wallResult.ok) {
      result = wallResult.applied   // the account shows this job as applied already
        ? { outcome: 'SUBMITTED', filled: [], missing: [], reason: wallResult.reason, confirmation: 'Already applied on Workday' }
        : { outcome: 'NEEDS_YOU', filled: [], missing: [], reason: wallResult.reason };
    } else {
      const isWorkday = detectAts(formUrl || '')?.ats === 'workday';
      if (isWorkday) {
        result = await fillWorkday(page, formUrl, book, files, {
          alreadyOnPage: true, submit: send, acceptConsent: settings.acceptConsent,
          llmContext: { job: app.job_snapshot || {}, resumeSections: (tailored.sections || rp?.sections || {}) },
        });
      } else {
        result = await fillApplication(page, formUrl, book, files, {
          submit: send, acceptConsent: settings.acceptConsent, alreadyOnPage: true,
          llmContext: { job: app.job_snapshot || {}, resumeSections: (tailored.sections || rp?.sections || {}) },
        });
      }
    }
  } catch (err) {
    // a step that waited on the page and gave up (e.g. "locator.click: Timeout 30000ms exceeded"): say what it means
    const msg = err.message.split('\n')[0];
    result = { outcome: 'FAILED', filled: [], missing: [], reason: /Timeout \d+ms exceeded/.test(msg)
      ? "The application page didn't respond as expected (a button never became clickable). Nothing was sent. Try again, or open the application and send it yourself."
      : msg };
  } finally {
    await page.close().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  const base = { formUrl, appliedWith: atsEmail, matchScore: detail.matchScore, filled: result.filled, missing: result.missing, reason: result.reason || null, at: new Date().toISOString() };
  if (result.outcome === 'SUBMITTED') {
    await setApplyState(appId, userId, 'SUBMITTED', { ...base, confirmation: result.confirmation }, { submitted_at: new Date() });
    await updateApplication(userId, appId, { status: 'APPLIED' });
  } else if (result.outcome === 'FILLED') {
    await setApplyState(appId, userId, 'NEEDS_REVIEW', base);
  } else if (result.outcome === 'NEEDS_YOU') {
    await setApplyState(appId, userId, 'NEEDS_YOU', base);
  } else {
    // Once the Submit button was clicked a retry could send a duplicate, so that failure is final.
    const clicked = /^Submitted, but/.test(result.reason || '');
    const attempts = clicked ? MAX_ATTEMPTS : (app.attempts || 0) + 1;
    await setApplyState(appId, userId, attempts >= MAX_ATTEMPTS ? 'FAILED' : 'PREPARED', { ...base, attempts, willRetry: attempts < MAX_ATTEMPTS });
  }
  return { outcome: result.outcome, reason: result.reason, filled: result.filled.length, missing: result.missing };
}

/**
 * The person's answers to a NEEDS_YOU or NEEDS_REVIEW application.
 * answers: { "question label": "answer" }. remember: also save them to the
 * resume profile so later forms reuse them. Then it's queued to send.
 */
export async function answerApplication(userId, appId, { answers = {}, remember = true, approve = true } = {}) {
  const app = await loadApp(appId);
  if (!app || app.user_id !== userId) return { error: 'Not found', code: 404 };
  const overrides = { ...(app.answers?.overrides || {}) };
  const entries = Object.entries(answers).filter(([q, a]) => q && a !== undefined && a !== null && String(a).trim() !== '');
  for (const [q, a] of entries) overrides[normalizeQuestion(q)] = String(a);
  await query(`UPDATE applications SET answers = $2, updated_at = NOW() WHERE id = $1`, [appId, { ...(app.answers || {}), overrides, approved: !!approve }]);
  if (remember && entries.length && app.resume_profile_id) {
    const rp = await getResumeProfile(userId, app.resume_profile_id);
    if (rp) {
      const saved = [...(rp.sections.savedAnswers || []), ...entries.map(([question, answer]) => ({ question, answer: String(answer) }))];
      await updateResumeProfile(userId, rp.id, { sections: { savedAnswers: saved } });
    }
  }
  await setApplyState(appId, userId, 'PREPARED', { ...(app.apply_detail || {}), approved: !!approve, answered: entries.length });
  return { ok: true, answered: entries.length };
}

export async function skipApplication(userId, appId) {
  const app = await loadApp(appId);
  if (!app || app.user_id !== userId) return { error: 'Not found', code: 404 };
  await setApplyState(appId, userId, 'SKIPPED', app.apply_detail);
  await query(`UPDATE applications SET status = 'ARCHIVED', updated_at = NOW() WHERE id = $1`, [appId]);
  return { ok: true };
}

// ─── Apply pipeline (the Apply button, Submit, Try again) ────────────────────

const APPLY_TIMEOUT_MS = 6 * 60_000;   // tailor + up to 3 fills; a stuck browser must not hold an application forever
const running = new Set();             // application ids being worked on by this process
export const isRunning = id => running.has(String(id));

/**
 * Run one application end to end in the background, owned by the server so a closed tab or a
 * failed request can't strand it: tailor → fill the form → stop at NEEDS_REVIEW (approve=false),
 * or send it (approve=true, after the person checked it) → SUBMITTED. Fill errors are retried up
 * to MAX_ATTEMPTS and then land in FAILED, so every path ends in a visible state.
 * Returns false when it's already running.
 */
export function startApply(userId, appId, { approve = false } = {}) {
  appId = String(appId);
  if (running.has(appId)) return false;
  running.add(appId);
  const stop = async reason => { await setApplyState(appId, userId, 'FAILED', { ...((await loadApp(appId))?.apply_detail || {}), reason, at: new Date().toISOString() }).catch(() => {}); };
  let timer;
  const work = (async () => {
    let app = await loadApp(appId);
    if (!app || app.user_id !== userId) return;
    await query(`UPDATE applications SET attempts = 0 WHERE id = $1`, [appId]);
    if (!approve || !app.tailored_resume) {
      if (app.apply_state !== 'QUEUED') await setApplyState(appId, userId, 'QUEUED', app.apply_detail || {});   // the Apply button already queued it
      const p = await prepareApplication(userId, appId, { track: true });
      if (p.error) return stop(p.error);
    }
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const r = await submitApplication(userId, appId, { approve });
      if (r.error) return stop(r.error);
      if (r.outcome !== 'FAILED') return;          // NEEDS_REVIEW, NEEDS_YOU or SUBMITTED: a stopping point the person can see
      if ((await loadApp(appId))?.apply_state === 'FAILED') return;   // out of attempts
      await new Promise(r => setTimeout(r, 3000));
    }
  })();
  Promise.race([work, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('Timed out. The form took too long to fill. Try again.')), APPLY_TIMEOUT_MS); })])
    .catch(err => stop(String(err.message).split('\n')[0]))
    .finally(() => { clearTimeout(timer); running.delete(appId); });
  return true;
}

/**
 * Nothing may sit in QUEUED / PREPARED / SUBMITTING forever. A server restart, or a run that
 * died, leaves applications nobody is working on; move them to FAILED so "Try again" shows up.
 * Applications started by the Apply button belong to this process; auto-apply runs may live in
 * the CLI, so those are only reaped when stuck filling for a long time.
 */
export async function reapStuckApplications() {
  const { rows } = await query(
    `SELECT id, user_id, apply_detail FROM applications
      WHERE (source <> 'auto' AND apply_state IN ('QUEUED','PREPARED','SUBMITTING') AND updated_at < NOW() - INTERVAL '1 minute')
         OR (source = 'auto' AND apply_state = 'SUBMITTING' AND updated_at < NOW() - INTERVAL '15 minutes')`);
  let n = 0;
  for (const r of rows) {
    if (running.has(String(r.id))) continue;
    await setApplyState(r.id, r.user_id, 'FAILED', { ...(r.apply_detail || {}), reason: 'Interrupted (the server restarted or the run stopped). Try again.', at: new Date().toISOString() });
    n++;
  }
  return n;
}

// ─── Run ─────────────────────────────────────────────────────────────────────

/**
 * One full pass for a user: plan, prepare, then fill/send what's ready.
 * Applications the person approved are sent; lanes that review first stop
 * at NEEDS_REVIEW.
 */
export async function runForUser(userId, { dryRun = false, limit = 50, log = () => {} } = {}) {
  const settings = await getSettings(userId);
  const { rows: runRows } = await query(`INSERT INTO auto_apply_runs (user_id, dry_run) VALUES ($1, $2) RETURNING id`, [userId, dryRun]);
  const runId = runRows[0].id;
  const summary = { plan: null, prepared: 0, outcomes: {}, errors: [] };
  try {
    if (!dryRun && !settings.enabled) { summary.skipped = 'Auto-apply is off'; return summary; }
    summary.plan = await planRun(userId, { dryRun });
    log(`planned ${summary.plan.queued} (cap left ${summary.plan.capLeft})`);
    if (dryRun) return summary;

    const { rows: queued } = await query(`SELECT id FROM applications WHERE user_id = $1 AND apply_state = 'QUEUED' ORDER BY id LIMIT $2`, [userId, limit]);
    for (const { id } of queued) {
      const r = await prepareApplication(userId, id);
      if (r.error) summary.errors.push({ id: String(id), error: r.error }); else summary.prepared++;
    }
    const { rows: ready } = await query(
      `SELECT id, (answers->>'approved')::boolean AS approved FROM applications
        WHERE user_id = $1 AND apply_state = 'PREPARED' AND source = 'auto' ORDER BY id LIMIT $2`, [userId, limit]);
    for (const { id, approved } of ready) {
      if (running.has(String(id))) continue;
      const r = await submitApplication(userId, String(id), { approve: !!approved });
      if (r.error) { summary.errors.push({ id: String(id), error: r.error }); if (r.code === 503) break; continue; }
      summary.outcomes[r.outcome] = (summary.outcomes[r.outcome] || 0) + 1;
      log(`#${id}: ${r.outcome}${r.reason ? ` — ${r.reason}` : ''}`);
    }
    return summary;
  } finally {
    await query(`UPDATE auto_apply_runs SET finished_at = NOW(), summary = $2 WHERE id = $1`, [runId, summary]);
  }
}

export async function recentRuns(userId, limit = 10) {
  const { rows } = await query(`SELECT id, dry_run, started_at, finished_at, summary FROM auto_apply_runs WHERE user_id = $1 ORDER BY started_at DESC LIMIT $2`, [userId, limit]);
  return rows.map(r => ({ id: String(r.id), dryRun: r.dry_run, startedAt: r.started_at, finishedAt: r.finished_at, summary: r.summary }));
}

/** Counts per auto-apply state, for the dashboard. */
export async function applyStateCounts(userId) {
  const { rows } = await query(`SELECT apply_state, COUNT(*)::int AS n FROM applications WHERE user_id = $1 AND apply_state IS NOT NULL GROUP BY 1`, [userId]);
  return Object.fromEntries(rows.map(r => [r.apply_state, r.n]));
}
