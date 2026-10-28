/**
 * Resume rewrites kept as training data (docs/resume-model.md).
 *
 * Every time a resume is tailored for an application, the posting, the resume
 * before and after, and the rewrite report are stored. When the application is
 * sent the row is marked sent, and later tracker moves (Interviewing, Offer,
 * Rejected, No reply) are copied in as the outcome, so the dataset export can
 * weight rewrites that led somewhere.
 */
import { query } from './db.mjs';
import { pickStyleExamples } from './rewriter-dataset.mjs';
import { buildBank } from './bullet-bank.mjs';
import { extractResumeSections } from './resume-extract.mjs';
import { withDefaults } from './resume-profiles.mjs';

export async function recordRewrite(userId, { applicationId = null, source = 'app', mode = null, model = null, job = {}, before = null, after, report = null, sent = false }) {
  const { rows } = await query(
    `INSERT INTO resume_rewrites (user_id, application_id, source, mode, model, job_title, company, job_description, resume_before, resume_after, report, sent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [userId, applicationId, source, mode, model, job.title || null, job.company || null, job.description || null, before, after, report, sent]);
  return rows[0].id;
}

/** Called when an application's tracker status changes. */
export async function noteApplicationStatus(applicationId, status) {
  if (status === 'APPLIED') {
    // The latest rewrite for this application is the one that went out.
    await query(
      `UPDATE resume_rewrites SET sent = TRUE WHERE id = (SELECT id FROM resume_rewrites WHERE application_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1)`,
      [applicationId]);
  } else if (['INTERVIEWING', 'OFFER', 'REJECTED', 'GHOSTED'].includes(status)) {
    await query(`UPDATE resume_rewrites SET outcome = $2 WHERE application_id = $1 AND sent`, [applicationId, status]);
  }
}

export async function rewriteStats(userId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE source = 'app')::int AS from_app,
            COUNT(*) FILTER (WHERE source = 'tsenta')::int AS from_tsenta,
            COUNT(*) FILTER (WHERE source = 'manual')::int AS from_you,
            COUNT(*) FILTER (WHERE mode = 'ai')::int AS model_rewrites,
            COUNT(*) FILTER (WHERE sent)::int AS sent,
            COUNT(*) FILTER (WHERE outcome IN ('INTERVIEWING','OFFER'))::int AS led_to_interview
       FROM resume_rewrites WHERE user_id = $1`, [userId]);
  return rows[0];
}

export async function listRewritesForExport(userId) {
  const { rows } = await query(
    `SELECT id, application_id, source, mode, model, job_title, company, job_description, resume_before, resume_after, report, sent, outcome, created_at
       FROM resume_rewrites WHERE user_id = $1 ORDER BY created_at`, [userId]);
  return rows;
}

const styleCache = new Map();
const bankCache = new Map();
const forget = userId => { styleCache.delete(userId); bankCache.delete(userId); };

/**
 * Before → after examples for the model's instructions: your own examples
 * first, then your Tsenta history. Cached for 10 minutes.
 */
export async function loadStyleExamples(userId, profileSections) {
  const hit = styleCache.get(userId);
  if (hit && Date.now() - hit.at < 600_000) return hit.value;
  const { rows } = await query(
    `SELECT source, job_title, resume_before, resume_after FROM resume_rewrites
      WHERE user_id = $1 AND source IN ('manual', 'tsenta')
      ORDER BY (source = 'manual') DESC, created_at DESC LIMIT 20`, [userId]);
  const value = rows.length && profileSections ? pickStyleExamples(rows, profileSections) : null;
  styleCache.set(userId, { at: Date.now(), value });
  return value;
}

/**
 * The bullet bank (lib/bullet-bank.mjs): every bullet you've written for each
 * role and project, from all your resume profiles, your own examples (before
 * and after), and the resumes Tsenta sent. Rewrites made here are left out so
 * model-written bullets don't feed back in. Cached for 10 minutes.
 */
export async function loadBulletBank(userId) {
  const hit = bankCache.get(userId);
  if (hit && Date.now() - hit.at < 600_000) return hit.value;
  const [{ rows: profiles }, { rows }] = await Promise.all([
    query(`SELECT sections FROM resume_profiles WHERE user_id = $1 ORDER BY is_default DESC, created_at`, [userId]),
    query(`SELECT source, resume_before, resume_after FROM resume_rewrites
            WHERE user_id = $1 AND source IN ('manual', 'tsenta')
            ORDER BY (source = 'manual') DESC, created_at DESC LIMIT 60`, [userId]),
  ]);
  const value = buildBank([
    ...profiles.map(p => p.sections),
    ...rows.flatMap(r => (r.source === 'manual' ? [r.resume_before, r.resume_after] : [r.resume_after])),
  ]);
  bankCache.set(userId, { at: Date.now(), value });
  return value;
}

// ─── Your own before → after examples (docs/resume-model.md) ────────────────
const asSections = v => (typeof v === 'string' ? (v.trim() ? extractResumeSections(v) : null) : v && typeof v === 'object' ? withDefaults(v) : null);
const bulletCount = s => s ? s.experience.reduce((n, e) => n + (e.bullets || []).length, 0) + s.projects.reduce((n, p) => n + (p.bullets || []).length, 0) : 0;

/**
 * Save an original resume and the version you tailored for one posting.
 * original / tailored: resume text (pasted or from a PDF) or resume sections.
 * They become gold training examples, few-shot style examples, and bank bullets.
 */
export async function addManualExample(userId, { original, tailored, jobDescription = '', jobTitle = '', company = '' }) {
  const before = asSections(original); const after = asSections(tailored);
  if (!before || !after) return { error: 'Both the original and the tailored resume are needed', code: 400 };
  if (!bulletCount(before) || !bulletCount(after)) return { error: 'No experience bullets were found in one of the resumes', code: 400 };
  const id = await recordRewrite(userId, {
    source: 'manual', mode: 'match', job: { title: String(jobTitle).slice(0, 200) || null, company: String(company).slice(0, 200) || null, description: String(jobDescription).slice(0, 40000) || null },
    before, after, report: { kind: 'manual' }, sent: true,
  });
  forget(userId);
  return { id: String(id), bullets: { original: bulletCount(before), tailored: bulletCount(after) }, hasPosting: !!String(jobDescription).trim() };
}

export async function listManualExamples(userId) {
  const { rows } = await query(
    `SELECT id, job_title, company, (job_description IS NOT NULL AND job_description <> '') AS has_posting, resume_before, resume_after, created_at
       FROM resume_rewrites WHERE user_id = $1 AND source = 'manual' ORDER BY created_at DESC`, [userId]);
  return rows.map(r => ({ id: String(r.id), jobTitle: r.job_title, company: r.company, hasPosting: r.has_posting, bullets: { original: bulletCount(withDefaults(r.resume_before)), tailored: bulletCount(withDefaults(r.resume_after)) }, createdAt: r.created_at }));
}

export async function deleteManualExample(userId, id) {
  const { rowCount } = await query(`DELETE FROM resume_rewrites WHERE user_id = $1 AND id = $2 AND source = 'manual'`, [userId, id]);
  forget(userId);
  return rowCount > 0;
}

/** The resume as it was before the latest tailoring of an application (for "What changed"). */
export async function resumeBeforeTailoring(applicationId) {
  const { rows } = await query(
    `SELECT resume_before FROM resume_rewrites WHERE application_id = $1 AND resume_before IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1`, [applicationId]);
  return rows[0]?.resume_before || null;
}
