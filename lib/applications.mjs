/**
 * Application records (docs/auto-apply.md).
 *
 * Every tracked job keeps a frozen copy of the posting (job_snapshot), a
 * status history (application_events), and, once something is sent, the
 * resume and cover letter that went with it. The live jobs row is not
 * trusted for any of this: rescans overwrite its description and it can be
 * removed.
 */
import { query } from './db.mjs';
import { noteApplicationStatus } from './rewrites.mjs';

export const APPLICATION_STATUSES = ['SAVED', 'APPLIED', 'GHOSTED', 'INTERVIEWING', 'OFFER', 'REJECTED', 'ARCHIVED'];
export const APPLY_STATES = ['QUEUED', 'PREPARED', 'NEEDS_REVIEW', 'SUBMITTING', 'SUBMITTED', 'NEEDS_YOU', 'FAILED', 'SKIPPED'];

const SNAPSHOT_SQL = `
  SELECT jsonb_build_object(
           'title', j.title, 'company', j.company, 'location', j.location, 'url', j.url, 'ats', j.ats,
           'workplace', j.workplace_type, 'employmentType', j.employment_type,
           'salaryMinAnnual', j.salary_min_annual, 'salaryMaxAnnual', j.salary_max_annual,
           'postedAt', j.posted_at, 'description', COALESCE(NULLIF(j.description_clean, ''), j.description),
           'capturedAt', NOW()) AS snap
    FROM jobs j WHERE j.id = $1`;

export async function snapshotJob(jobId) {
  const { rows } = await query(SNAPSHOT_SQL, [jobId]);
  return rows[0]?.snap ?? null;
}

// What the form looked like during an attempt, for the admin portal. The newest 8 per application, 30 days.
let shotsReady;
const ensureShots = () => shotsReady ||= query(`CREATE TABLE IF NOT EXISTS application_shots (
  id BIGSERIAL PRIMARY KEY, application_id BIGINT NOT NULL REFERENCES applications(id) ON DELETE CASCADE, label TEXT, jpeg BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
  .then(() => query(`CREATE INDEX IF NOT EXISTS idx_application_shots_app ON application_shots(application_id, created_at)`));
export async function saveShot(applicationId, label, jpeg) {
  await ensureShots();
  await query(`INSERT INTO application_shots (application_id, label, jpeg) VALUES ($1, $2, $3)`, [applicationId, label, jpeg]);
  await query(`DELETE FROM application_shots WHERE application_id = $1 AND id NOT IN (SELECT id FROM application_shots WHERE application_id = $1 ORDER BY id DESC LIMIT 8)`, [applicationId]);
  await query(`DELETE FROM application_shots WHERE created_at < NOW() - INTERVAL '30 days'`);
}
export async function listShots(applicationId) {
  await ensureShots();
  return (await query(`SELECT id, label, created_at FROM application_shots WHERE application_id = $1 ORDER BY id DESC`, [applicationId])).rows;
}
export async function getShot(applicationId, id) {
  await ensureShots();
  return (await query(`SELECT jpeg FROM application_shots WHERE application_id = $1 AND id = $2`, [applicationId, id])).rows[0]?.jpeg || null;
}

export async function recordEvent(applicationId, userId, { from = null, to = null, kind = 'status', detail = null } = {}) {
  await query(
    `INSERT INTO application_events (application_id, user_id, from_status, to_status, kind, detail) VALUES ($1, $2, $3, $4, $5, $6)`,
    [applicationId, userId, from, to, kind, detail]);
}

async function recordInteraction(userId, jobId, status) {
  const type = status === 'SAVED' ? 'SAVE' : status === 'ARCHIVED' ? null : 'APPLY';
  if (type && jobId) await query(`INSERT INTO user_job_interactions (user_id, job_id, interaction_type) VALUES ($1, $2, $3)`, [userId, jobId, type]);
}

/**
 * Track a job. One row per (user, job): tracking it again moves its status.
 * The snapshot is taken on insert and refreshed when the job first reaches
 * APPLIED, so it holds the posting as it read when you applied.
 * Returns { id, created } or { error, code }.
 */
export async function trackApplication(userId, jobId, status = 'SAVED', opts = {}) {
  status = String(status).toUpperCase();
  if (!APPLICATION_STATUSES.includes(status)) return { error: `status must be one of ${APPLICATION_STATUSES.join('/')}`, code: 400 };
  const snap = await snapshotJob(jobId);
  if (!snap) return { error: 'Job not found', code: 404 };

  const { rows: existing } = await query(
    `SELECT id, status, applied_at FROM applications WHERE user_id = $1 AND job_id = $2 ORDER BY id LIMIT 1`, [userId, jobId]);
  let id; let created = false;
  if (existing.length) {
    const prev = existing[0];
    id = prev.id;
    const firstApply = status === 'APPLIED' && !prev.applied_at;
    await query(
      `UPDATE applications SET status = $2, notes = COALESCE($3, notes),
              applied_at = CASE WHEN $2 = 'APPLIED' AND applied_at IS NULL THEN NOW() ELSE applied_at END,
              job_snapshot = CASE WHEN $4 THEN $5::jsonb ELSE COALESCE(job_snapshot, $5::jsonb) END,
              resume_profile_id = COALESCE($6, resume_profile_id),
              updated_at = NOW()
        WHERE id = $1`, [id, status, opts.notes ?? null, firstApply, snap, opts.resumeProfileId ?? null]);
    if (prev.status !== status) { await recordEvent(id, userId, { from: prev.status, to: status, detail: opts.eventDetail ?? null }); await noteApplicationStatus(id, status); }
  } else {
    const { rows } = await query(
      `INSERT INTO applications (user_id, job_id, status, applied_at, application_url, notes, job_snapshot, source, resume_profile_id, lane_id, apply_state)
       VALUES ($1, $2, $3, CASE WHEN $3 = 'APPLIED' THEN NOW() END, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [userId, jobId, status, snap.url, opts.notes ?? null, snap, opts.source || 'manual',
        opts.resumeProfileId ?? null, opts.laneId ?? null, opts.applyState ?? null]);
    id = rows[0].id; created = true;
    await recordEvent(id, userId, { from: null, to: status, detail: opts.eventDetail ?? (opts.source === 'auto' ? { source: 'auto' } : null) });
  }
  await recordInteraction(userId, jobId, status);
  return { id: String(id), created };
}

/** Change status and/or notes. Returns the job id, or null when not found. */
export async function updateApplication(userId, appId, { status, notes } = {}) {
  const { rows: cur } = await query(`SELECT id, status, job_id, applied_at FROM applications WHERE user_id = $1 AND id = $2`, [userId, appId]);
  if (!cur.length) return { notFound: true };
  const prev = cur[0];
  const sets = []; const params = [userId, appId];
  if (status !== undefined) {
    status = String(status).toUpperCase();
    if (!APPLICATION_STATUSES.includes(status)) return { error: `status must be one of ${APPLICATION_STATUSES.join('/')}` };
    params.push(status); sets.push(`status = $${params.length}`);
    sets.push(`applied_at = CASE WHEN $${params.length} = 'APPLIED' AND applied_at IS NULL THEN NOW() ELSE applied_at END`);
    // applied by hand (e.g. an assisted application sent on the company's site): it stops waiting in Needs you
    sets.push(`apply_state = CASE WHEN $${params.length} = 'APPLIED' AND apply_state IN ('QUEUED','PREPARED','NEEDS_YOU','NEEDS_REVIEW','FAILED') THEN NULL ELSE apply_state END`);
    if (status === 'APPLIED' && !prev.applied_at && prev.job_id) {
      const snap = await snapshotJob(prev.job_id);
      if (snap) { params.push(snap); sets.push(`job_snapshot = $${params.length}::jsonb`); }
    }
  }
  if (notes !== undefined) { params.push(notes); sets.push(`notes = $${params.length}`); }
  if (!sets.length) return { error: 'Nothing to update' };
  sets.push('updated_at = NOW()');
  await query(`UPDATE applications SET ${sets.join(', ')} WHERE user_id = $1 AND id = $2`, params);
  if (status && status !== prev.status) {
    await recordEvent(prev.id, userId, { from: prev.status, to: status });
    await recordInteraction(userId, prev.job_id, status);
    await noteApplicationStatus(prev.id, status);
  }
  if (notes !== undefined) await recordEvent(prev.id, userId, { kind: 'note' });
  return { ok: true };
}

const LIST_SELECT = `
  SELECT a.id, a.status, a.applied_at, a.created_at, a.updated_at, a.notes, a.source, a.apply_state,
         a.apply_detail, a.resume_profile_id, a.lane_id, a.submitted_at, a.job_snapshot,
         (a.tailored_resume IS NOT NULL) AS has_tailored_resume,
         j.id AS job_id, j.title, j.company, j.location, j.url, j.workplace_type,
         j.salary_min_annual, j.salary_max_annual, j.active AS job_active
    FROM applications a LEFT JOIN jobs j ON j.id = a.job_id`;

export function shapeApplication(r, { full = false } = {}) {
  const snap = r.job_snapshot || {};
  // The live job row wins for display fields when it still exists; the
  // snapshot fills in when it doesn't.
  const job = (r.job_id != null || r.job_snapshot) ? {
    jobId: r.job_id == null ? null : String(r.job_id),
    title: r.title ?? snap.title ?? null, company: r.company ?? snap.company ?? null,
    locationText: r.location ?? snap.location ?? null, url: r.url ?? snap.url ?? null,
    workplace: r.workplace_type ?? snap.workplace ?? null,
    salary: { minAnnual: r.salary_min_annual ?? snap.salaryMinAnnual ?? null, maxAnnual: r.salary_max_annual ?? snap.salaryMaxAnnual ?? null },
    active: r.job_id == null ? false : r.job_active,
    removed: r.job_id == null,
  } : null;
  const out = {
    id: String(r.id), status: r.status, appliedAt: r.applied_at, createdAt: r.created_at, updatedAt: r.updated_at, notes: r.notes,
    source: r.source || 'manual', applyState: r.apply_state || null, applyDetail: r.apply_detail || null,
    resumeProfileId: r.resume_profile_id || null, laneId: r.lane_id || null, submittedAt: r.submitted_at || null,
    hasTailoredResume: !!r.has_tailored_resume, hasSnapshot: !!r.job_snapshot,
    job,
  };
  if (full) {
    out.snapshot = r.job_snapshot || null;
    out.tailoredResume = r.tailored_resume || null;
    out.coverLetter = r.cover_letter || null;
    out.answers = r.answers || null;
  }
  return out;
}

// Imported history (Tsenta) stays off the tracker until you move a card on
// from Applied; it lives on the Applied screen (lib/applied-search.mjs).
const UNTOUCHED_IMPORT = `NOT (a.source = 'tsenta' AND a.status = 'APPLIED')`;

export async function listApplications(userId, { statuses = null, applyStates = null, source = null, limit = 500, includeImported = false } = {}) {
  const params = [userId]; const where = ['a.user_id = $1'];
  if (!includeImported && source !== 'tsenta') where.push(UNTOUCHED_IMPORT);
  if (statuses?.length) { params.push(statuses); where.push(`a.status = ANY($${params.length}::text[])`); }
  if (applyStates?.length) { params.push(applyStates); where.push(`a.apply_state = ANY($${params.length}::text[])`); }
  if (source) { params.push(source); where.push(`a.source = $${params.length}`); }
  params.push(Math.min(limit, 1000));
  const [{ rows }, { rows: countRows }] = await Promise.all([
    query(`${LIST_SELECT} WHERE ${where.join(' AND ')} ORDER BY a.updated_at DESC LIMIT $${params.length}`, params),
    query(`SELECT status, COUNT(*)::int AS n FROM applications a WHERE user_id = $1 AND ${includeImported ? 'TRUE' : UNTOUCHED_IMPORT} GROUP BY status`, [userId]),
  ]);
  const counts = Object.fromEntries(APPLICATION_STATUSES.map(s => [s, 0]));
  for (const r of countRows) counts[r.status] = r.n;
  return { counts, applications: rows.map(r => shapeApplication(r)) };
}

/** Full record: snapshot with description, events, resume and letter sent. */
export async function getApplication(userId, appId) {
  const { rows } = await query(
    `SELECT a.*, (a.tailored_resume IS NOT NULL) AS has_tailored_resume,
            j.title, j.company, j.location, j.url, j.workplace_type, j.salary_min_annual, j.salary_max_annual, j.active AS job_active,
            rp.name AS resume_profile_name, l.name AS lane_name
       FROM applications a LEFT JOIN jobs j ON j.id = a.job_id
       LEFT JOIN resume_profiles rp ON rp.id = a.resume_profile_id
       LEFT JOIN auto_apply_lanes l ON l.id = a.lane_id
      WHERE a.user_id = $1 AND a.id = $2`, [userId, appId]);
  if (!rows.length) return null;
  const { rows: events } = await query(
    `SELECT from_status, to_status, kind, detail, created_at FROM application_events WHERE application_id = $1 ORDER BY created_at, id`, [appId]);
  return {
    ...shapeApplication(rows[0], { full: true }),
    resumeProfileName: rows[0].resume_profile_name || null, laneName: rows[0].lane_name || null,
    events: events.map(e => ({ from: e.from_status, to: e.to_status, kind: e.kind, detail: e.detail, at: e.created_at })),
  };
}

export async function deleteApplication(userId, appId) {
  const { rowCount } = await query(`DELETE FROM applications WHERE user_id = $1 AND id = $2`, [userId, appId]);
  return rowCount > 0;
}

/** Auto-apply state change plus its event. */
export async function setApplyState(appId, userId, state, detail = null, extra = {}) {
  const sets = ['apply_state = $3', 'apply_detail = $4', 'updated_at = NOW()'];
  const params = [appId, userId, state, detail];
  for (const [col, val] of Object.entries(extra)) { params.push(val); sets.push(`${col} = $${params.length}`); }
  const { rows } = await query(
    `UPDATE applications a SET ${sets.join(', ')} FROM (SELECT apply_state AS prev FROM applications WHERE id = $1) p
      WHERE a.id = $1 AND a.user_id = $2 RETURNING p.prev`, params);
  if (rows.length) await recordEvent(appId, userId, { from: rows[0].prev, to: state, kind: 'auto_apply', detail });
  return rows.length > 0;
}
