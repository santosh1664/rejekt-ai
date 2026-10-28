/**
 * Import your Tsenta application history (docs/resume-model.md).
 *
 * Reads data/imports/tsenta/applications.jsonl (every submitted application:
 * company, title, link, board, date) and details.jsonl (for the most recent
 * ones: the full posting and the resume Tsenta sent). Each becomes an
 * application with source 'tsenta' and status Applied, so the Applied screen
 * can search them next to applications made here. Sent resumes are also stored
 * as resume_rewrites (source 'tsenta') for the training-data export.
 *
 * Re-running the import updates rows instead of duplicating them.
 * Personal details that aren't resume content (date of birth, home address,
 * EEO and work-authorization answers) were stripped before the files were
 * written and are dropped again here if present.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { query } from './db.mjs';
import { normalizeSections } from './resume-profiles.mjs';

export const TSENTA_DIR = process.env.TSENTA_IMPORT_DIR || new URL('../data/imports/tsenta/', import.meta.url).pathname;

const readJsonl = file => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);

/** HTML job description → plain text with line breaks and bullets. */
export function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ').replace(/<\/li>/gi, '')
    .replace(/<\/(ul|ol)>/gi, '\n\n')
    .replace(/<\/(p|div|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Tsenta's resume JSON → this app's resume sections. */
export function convertTsentaResume(p = {}) {
  const pi = p.personalInformation || {};
  return normalizeSections({
    personal: {
      fullName: [pi.firstName, pi.lastName].filter(Boolean).join(' '),
      email: pi.email, phone: pi.phone, city: pi.city, state: pi.state, country: pi.country,
      linkedin: pi.linkedinUrl, github: pi.githubUrl, portfolio: pi.website,
    },
    summary: pi.summary || '',
    experience: (p.workExperience || []).map(e => ({
      company: e.company, title: e.role, location: e.location, startDate: e.startDate,
      endDate: e.isCurrentRole ? '' : e.endDate, current: !!e.isCurrentRole, bullets: e.responsibilities || [],
    })),
    education: (p.education || []).map(e => ({
      school: e.university, degree: e.degree, field: e.major, startDate: e.startDate, endDate: e.endDate, gpa: e.gpa,
    })),
    projects: (p.projects || []).map(x => ({
      name: x.title, url: x.liveUrl || x.githubUrl || '', startDate: x.startDate, endDate: x.isOngoing ? '' : x.endDate,
      technologies: x.technologies || [], bullets: x.details || [],
    })),
    skills: (p.skillCategories || []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map(g => ({ group: g.name, items: g.skills || [] })),
    certifications: (p.certifications || []).map(c => ({ name: c.name, issuer: c.issuingOrganization, date: c.issueDate, url: c.credentialUrl })),
    custom: (p.customSections || []).map(c => ({ title: c.title || c.name || 'Other', body: Array.isArray(c.items) ? c.items.join('\n') : (c.content || c.body || '') })),
  });
}

function snapshotFor(a, job) {
  const loc = (job?.locations?.length ? job.locations : a.locations) || [];
  const annual = v => (v == null || v === '' ? null : Number(v));
  return {
    title: (job?.title || a.jobTitle || '').trim(), company: a.companyName || job?.companyName || null,
    location: loc.join(' · ') || null, url: job?.url || a.url || null, ats: a.atsType || null,
    workplace: job?.workplaceType || a.workplaceType || null, employmentType: job?.employmentType || null,
    salaryMinAnnual: job?.salaryPeriod === 'yearly' ? annual(job.salaryMin) : null,
    salaryMaxAnnual: job?.salaryPeriod === 'yearly' ? annual(job.salaryMax) : null,
    postedAt: job?.datePosted || null,
    description: job?.description ? htmlToText(job.description) : null,
    skills: job?.skillTags || [],
    importedFrom: 'tsenta', tsentaListingId: a.listingId || null,
    capturedAt: job ? new Date().toISOString() : null,
  };
}

/**
 * Import for one user. Returns { applications, inserted, updated, withDescription, withResume }.
 * dir is the folder holding applications.jsonl and details.jsonl.
 */
export async function importTsentaHistory(userId, { dir = TSENTA_DIR, batchSize = 500 } = {}) {
  const apps = readJsonl(join(dir, 'applications.jsonl'));
  if (!apps.length) return { error: `No Tsenta export found in ${dir}`, code: 404 };
  const details = new Map(readJsonl(join(dir, 'details.jsonl')).map(d => [d.applicationId, d]));

  let inserted = 0; let updated = 0; let withDescription = 0; let withResume = 0;
  for (let i = 0; i < apps.length; i += batchSize) {
    const slice = apps.slice(i, i + batchSize);
    const params = []; const values = [];
    for (const a of slice) {
      const d = details.get(a.applicationId);
      const snap = snapshotFor(a, d?.job);
      const resume = d?.resume ? { sections: convertTsentaResume(d.resume), sectionOrder: null, source: 'tsenta', profileName: 'Resume Tsenta sent' } : null;
      if (snap.description) withDescription++;
      if (resume) withResume++;
      const base = params.length;
      params.push(userId, a.applicationId, snap, a.url || snap.url, a.createdAt, a.updatedAt, resume);
      values.push(`($${base + 1}::uuid, NULL, 'APPLIED', 'tsenta', $${base + 2}, $${base + 3}::jsonb, $${base + 4}, $${base + 5}::timestamptz, $${base + 6}::timestamptz, $${base + 7}::jsonb, NULL)`);
    }
    const { rows } = await query(
      `INSERT INTO applications (user_id, job_id, status, source, external_application_id, job_snapshot, application_url, applied_at, submitted_at, tailored_resume, apply_state)
       VALUES ${values.join(',')}
       ON CONFLICT (user_id, source, external_application_id) WHERE external_application_id IS NOT NULL
       DO UPDATE SET job_snapshot = CASE WHEN EXCLUDED.job_snapshot->>'description' IS NOT NULL OR applications.job_snapshot->>'description' IS NULL
                                         THEN EXCLUDED.job_snapshot ELSE applications.job_snapshot END,
                     tailored_resume = COALESCE(EXCLUDED.tailored_resume, applications.tailored_resume),
                     application_url = EXCLUDED.application_url, submitted_at = EXCLUDED.submitted_at
       RETURNING id, (xmax = 0) AS inserted, external_application_id`, params);
    for (const r of rows) (r.inserted ? inserted++ : updated++);
    // Keep the dates as Tsenta had them so sorting by date is meaningful.
    await query(
      `UPDATE applications a SET created_at = a.applied_at, updated_at = a.submitted_at
        WHERE a.id = ANY($1::bigint[]) AND a.created_at > a.applied_at`, [rows.filter(r => r.inserted).map(r => r.id)]);
    const fresh = rows.filter(r => r.inserted).map(r => r.id);
    if (fresh.length) {
      await query(
        `INSERT INTO application_events (application_id, user_id, from_status, to_status, kind, detail, created_at)
         SELECT a.id, a.user_id, NULL, 'APPLIED', 'status', '{"source":"tsenta"}'::jsonb, a.applied_at FROM applications a WHERE a.id = ANY($1::bigint[])`, [fresh]);
    }
  }

  // Sent resumes → training-data rows (replaced on re-import).
  const { rows: withRes } = await query(
    `SELECT id, external_application_id, job_snapshot, tailored_resume FROM applications
      WHERE user_id = $1 AND source = 'tsenta' AND tailored_resume IS NOT NULL`, [userId]);
  if (withRes.length) {
    await query(`DELETE FROM resume_rewrites WHERE user_id = $1 AND source = 'tsenta'`, [userId]);
    for (const r of withRes) {
      await query(
        `INSERT INTO resume_rewrites (user_id, application_id, source, mode, model, job_title, company, job_description, resume_after, sent)
         VALUES ($1, $2, 'tsenta', 'tsenta', 'tsenta', $3, $4, $5, $6, TRUE)`,
        [userId, r.id, r.job_snapshot?.title || null, r.job_snapshot?.company || null, r.job_snapshot?.description || null, r.tailored_resume.sections]);
    }
  }
  return { applications: apps.length, inserted, updated, withDescription, withResume };
}

let availCache = null;
export function tsentaExportAvailable(dir = TSENTA_DIR) {
  const f = join(dir, 'applications.jsonl');
  if (!existsSync(f)) return null;
  const mtime = statSync(f).mtimeMs;
  if (availCache?.dir === dir && availCache.mtime === mtime) return availCache.value;
  const n = readFileSync(f, 'utf8').split('\n').filter(Boolean).length;
  const value = { applications: n, details: readJsonl(join(dir, 'details.jsonl')).length };
  availCache = { dir, mtime, value };
  return value;
}
