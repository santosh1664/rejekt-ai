/**
 * lib/resume-profiles.mjs
 *
 * Resume profiles: a user keeps one or more named profiles (e.g. "AI
 * Engineer", "Java Full Stack"), each with its own resume, cover letter and
 * profile sections. One profile is the default; saving it syncs the fields
 * the matching engine reads (user_profiles, user_skills).
 *
 * Sections mirror the profile structure observed in Tsenta's dashboard
 * (docs/profile.md): personal info, professional summary, education,
 * experience, projects, skills, certifications, custom sections, and
 * application defaults (what gets auto-filled on ATS forms).
 *
 * Everything above the "Store" divider is pure (no DB) and unit-tested by
 * scripts/test-profiles.mjs.
 */
import { normalizeLayout } from './resume-layout.mjs';
import { matchCountry, matchState } from './location.mjs';
import { query } from './db.mjs';
import { normalizeSkillName } from './skills.mjs';

// ─── Shape ──────────────────────────────────────────────────────────────────

export const APPLICATION_DEFAULT_FIELDS = {
  // Work authorization
  workCountry:            { group: 'authorization', label: 'Country you\'ll work in', type: 'text' },
  authorizationBasis:     { group: 'authorization', label: 'Authorization basis', type: 'select', options: ['Citizen', 'Permanent resident', 'Temporary work authorization', 'Not authorized'] },
  workPermit:             { group: 'authorization', label: 'Work permit or visa', type: 'text', hint: 'e.g. F-1 OPT, H-1B, TN' },
  workPermitStatus:       { group: 'authorization', label: 'Status', type: 'select', options: ['Valid', 'Pending', 'Expired', 'Not applicable'] },
  workPermitExpiry:       { group: 'authorization', label: 'Expires', type: 'date' },
  authorizedToWork:       { group: 'authorization', label: 'Authorized to work', type: 'bool' },
  needsSponsorship:       { group: 'authorization', label: 'Needs sponsorship now or later', type: 'bool' },
  citizenship:            { group: 'authorization', label: 'Citizenship', type: 'text' },
  // Logistics
  inPersonOk:             { group: 'logistics', label: 'In-person OK', type: 'bool' },
  canRelocate:            { group: 'logistics', label: 'Can relocate', type: 'bool' },
  startImmediately:       { group: 'logistics', label: 'Start immediately', type: 'bool' },
  noticePeriod:           { group: 'logistics', label: 'Notice period', type: 'text', hint: 'e.g. 2 weeks' },
  hasTransport:           { group: 'logistics', label: 'Has transport', type: 'bool' },
  needsAccommodations:    { group: 'logistics', label: 'Needs accommodations', type: 'bool' },
  salaryExpectation:      { group: 'logistics', label: 'Salary expectation', type: 'text' },
  // Background questions
  priorEmployee:          { group: 'background', label: 'Worked at the company before', type: 'bool' },
  govClearance:           { group: 'background', label: 'Holds a government clearance', type: 'bool' },
  govTies:                { group: 'background', label: 'Government ties / conflicts', type: 'bool' },
  over18:                 { group: 'background', label: '18 or older', type: 'bool' },
  referralSource:         { group: 'background', label: 'How you heard about jobs', type: 'text', hint: 'e.g. Company website' },
  // Voluntary self-identification (US EEO). Always optional.
  gender:                 { group: 'eeo', label: 'Gender', type: 'select', options: ['Male', 'Female', 'Non-binary', 'Prefer not to say'] },
  ethnicity:              { group: 'eeo', label: 'Ethnicity', type: 'select', options: ['Hispanic or Latino', 'White', 'Black or African American', 'Asian', 'Native Hawaiian or Other Pacific Islander', 'American Indian or Alaska Native', 'Two or more races', 'Prefer not to say'] },
  veteran:                { group: 'eeo', label: 'Veteran', type: 'select', options: ['Not a protected veteran', 'Protected veteran', 'Prefer not to say'] },
  disability:             { group: 'eeo', label: 'Disability', type: 'select', options: ['No', 'Yes', 'Prefer not to say'] },
};

export const EMPTY_SECTIONS = Object.freeze({
  personal: { fullName: '', headline: '', email: '', phone: '', city: '', state: '', country: '', linkedin: '', github: '', portfolio: '', openToWork: true },
  summary: '',
  education: [],      // { school, degree, field, startDate, endDate, gpa, description }
  experience: [],     // { company, title, location, startDate, endDate, current, bullets: [] }
  projects: [],       // { name, role, url, startDate, endDate, technologies: [], bullets: [] }
  skills: [],         // { group, items: [] }
  certifications: [], // { name, issuer, date, url }
  custom: [],         // { title, body }
  applicationDefaults: {},
  savedAnswers: [],   // { question, answer } — answers to form questions, reused by auto-apply
});

const str = (v, max = 500) => (v == null ? '' : String(v).trim().slice(0, max));
const bool = v => v === true || v === 'true' || v === 'yes' || v === 'Yes';
const arr = (v, max = 50) => (Array.isArray(v) ? v.slice(0, max) : []);
const strList = (v, maxItems = 30, maxLen = 600) => arr(v, maxItems).map(x => str(x, maxLen)).filter(Boolean);
// "2023-08", "2023-08-15", "Aug 2023", "2023" → "YYYY-MM" (or "YYYY"); anything else kept as typed.
export function normalizeMonth(v) {
  const s = str(v, 40);
  if (!s) return '';
  if (/^(present|current|now)$/i.test(s)) return '';
  let m = s.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}`;
  m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{4})$/);
  if (m) {
    const idx = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[1].slice(0, 3).toLowerCase());
    if (idx >= 0) return `${m[2]}-${String(idx + 1).padStart(2, '0')}`;
  }
  m = s.match(/^(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[2]}-${m[1].padStart(2, '0')}`;
  if (/^\d{4}$/.test(s)) return s;
  return s;
}

/**
 * Validates + normalizes a (partial) sections object. Unknown keys are
 * dropped; every list is capped so one request can't store unbounded data.
 * @param {object} input
 * @param {{ partial?: boolean }} opts  partial: only return keys present in input
 */
export function normalizeSections(input = {}, { partial = false, keepEmpty = false } = {}) {
  // keepEmpty: the inline editor's preview keeps blank entries and bullets the user just added.
  const keepIf = fn => (keepEmpty ? () => true : fn);
  const list = (v, n, m) => (keepEmpty ? arr(v, n).map(x => str(x, m)) : strList(v, n, m));
  const out = {};
  const has = k => Object.prototype.hasOwnProperty.call(input, k);
  const want = k => !partial || has(k);

  if (want('personal')) {
    const p = input.personal || {};
    out.personal = {
      fullName: str(p.fullName, 120), headline: str(p.headline, 160), email: str(p.email, 200), phone: str(p.phone, 40),
      city: str(p.city, 80), state: str(p.state, 80), country: str(p.country, 80),
      linkedin: str(p.linkedin, 300), github: str(p.github, 300), portfolio: str(p.portfolio, 300),
      openToWork: p.openToWork === undefined ? true : bool(p.openToWork),
    };
  }
  if (want('summary')) out.summary = str(input.summary, 4000);
  if (want('education')) {
    out.education = arr(input.education, 20).map(e => ({
      school: str(e?.school, 200), degree: str(e?.degree, 160), field: str(e?.field, 160),
      startDate: normalizeMonth(e?.startDate), endDate: normalizeMonth(e?.endDate), gpa: str(e?.gpa, 20), description: str(e?.description, 2000),
    })).filter(keepIf(e => e.school || e.degree));
  }
  if (want('experience')) {
    out.experience = arr(input.experience, 30).map(e => ({
      company: str(e?.company, 200), title: str(e?.title, 200), location: str(e?.location, 160),
      startDate: normalizeMonth(e?.startDate), endDate: bool(e?.current) ? '' : normalizeMonth(e?.endDate), current: bool(e?.current),
      bullets: list(e?.bullets, 25, 800),
    })).filter(keepIf(e => e.company || e.title));
  }
  if (want('projects')) {
    out.projects = arr(input.projects, 30).map(p => ({
      name: str(p?.name, 200), role: str(p?.role, 160), url: str(p?.url, 300),
      startDate: normalizeMonth(p?.startDate), endDate: normalizeMonth(p?.endDate),
      technologies: list(p?.technologies, 30, 60), bullets: list(p?.bullets, 20, 800),
    })).filter(keepIf(p => p.name));
  }
  if (want('skills')) {
    // Accept either [{group, items}] or a flat string list (one "Skills" group).
    const raw = arr(input.skills, 20);
    const groups = raw.length && typeof raw[0] === 'string' ? [{ group: 'Skills', items: raw }] : raw;
    out.skills = groups.map(g => ({ group: str(g?.group, 80) || 'Skills', items: dedupe(strList(g?.items, 80, 80)) }))
      .filter(keepIf(g => g.items.length));
  }
  if (want('certifications')) {
    out.certifications = arr(input.certifications, 30).map(c => ({ name: str(c?.name, 200), issuer: str(c?.issuer, 160), date: normalizeMonth(c?.date), url: str(c?.url, 300) }))
      .filter(keepIf(c => c.name));
  }
  if (want('custom')) out.custom = arr(input.custom, 10).map(c => ({ title: str(c?.title, 120), body: str(c?.body, 4000) })).filter(keepIf(c => c.title || c.body));
  if (want('savedAnswers')) {
    out.savedAnswers = dedupeBy(arr(input.savedAnswers, 200).map(x => ({ question: str(x?.question, 300), answer: str(x?.answer, 2000) }))
      .filter(x => x.question && x.answer), x => normalizeQuestion(x.question));
  }
  if (want('applicationDefaults')) {
    const a = input.applicationDefaults || {};
    out.applicationDefaults = {};
    for (const [key, def] of Object.entries(APPLICATION_DEFAULT_FIELDS)) {
      if (a[key] === undefined || a[key] === null || a[key] === '') continue;
      if (def.type === 'bool') out.applicationDefaults[key] = bool(a[key]);
      else if (def.type === 'date') out.applicationDefaults[key] = str(a[key], 10);
      else if (def.type === 'select') { if (def.options.includes(a[key])) out.applicationDefaults[key] = a[key]; }
      else out.applicationDefaults[key] = str(a[key], 120);
    }
  }
  return out;
}

/** Lowercased question text without punctuation or a trailing asterisk. */
export function normalizeQuestion(q) {
  return String(q || '').toLowerCase().replace(/\*/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Later entries win, so re-answering a question replaces the old answer.
function dedupeBy(list, key) {
  const m = new Map();
  for (const x of list) { const k = key(x); m.delete(k); m.set(k, x); }
  return [...m.values()];
}

function dedupe(list) {
  const seen = new Set();
  return list.filter(x => { const k = x.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

/** Sections for the inline editor's preview: like withDefaults, but blank new entries and bullets stay. */
export function forEditing(sections = {}) {
  return { ...structuredClone(EMPTY_SECTIONS), ...normalizeSections(sections, { partial: true, keepEmpty: true }), personal: { ...EMPTY_SECTIONS.personal, ...(normalizeSections({ personal: sections.personal || {} }).personal) } };
}

export function withDefaults(sections = {}) {
  return { ...structuredClone(EMPTY_SECTIONS), ...normalizeSections(sections, { partial: true }), personal: { ...EMPTY_SECTIONS.personal, ...(normalizeSections({ personal: sections.personal || {} }).personal) } };
}

// ─── Derived values ─────────────────────────────────────────────────────────

/** "United States" / "USA" / "us" → "US"; unknown names → null (left unchanged in matching). */
export function countryToCode(country) {
  const c = String(country || '').trim();
  if (!c) return null;
  if (/^[A-Za-z]{2}$/.test(c)) return c.toUpperCase();
  return matchCountry(c);
}

const monthIndex = ym => {
  const m = String(ym || '').match(/^(\d{4})(?:-(\d{2}))?$/);
  return m ? Number(m[1]) * 12 + (m[2] ? Number(m[2]) - 1 : 0) : null;
};

/**
 * Total professional experience in years (one decimal), merging overlapping
 * roles so two concurrent jobs don't double-count. Internships count.
 */
export function totalExperienceYears(experience, now = new Date()) {
  const nowIdx = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const ranges = (experience || [])
    .map(e => [monthIndex(e.startDate), e.current || !e.endDate ? nowIdx : monthIndex(e.endDate)])
    .filter(([s, e]) => s != null && e != null && e >= s)
    .sort((a, b) => a[0] - b[0]);
  let months = 0, curS = null, curE = null;
  for (const [s, e] of ranges) {
    if (curS == null) { curS = s; curE = e; continue; }
    if (s <= curE + 1) curE = Math.max(curE, e);
    else { months += curE - curS + 1; curS = s; curE = e; }
  }
  if (curS != null) months += curE - curS + 1;
  return months ? Math.round((months / 12) * 10) / 10 : null;
}

const DEGREE_LEVELS = [
  ['DOCTORATE', /\b(ph\.?\s?d|doctor(ate)?|d\.?phil)\b/i],
  ['MASTERS', /\b(master|m\.?\s?s\.?(?![a-z])|m\.?sc|m\.?eng|mba|m\.?tech|m\.?a\.?(?![a-z]))\b/i],
  ['BACHELORS', /\b(bachelor|b\.?\s?s\.?(?![a-z])|b\.?sc|b\.?eng|b\.?tech|b\.?a\.?(?![a-z])|b\.?e\.?(?![a-z]))\b/i],
  ['ASSOCIATE', /\bassociate\b/i],
  ['HIGH_SCHOOL', /\b(high school|ged|diploma)\b/i],
];
export function highestEducationLevel(education) {
  const levels = (education || []).map(e => DEGREE_LEVELS.find(([, re]) => re.test(`${e.degree} ${e.school}`))?.[0]).filter(Boolean);
  for (const [level] of DEGREE_LEVELS) if (levels.includes(level)) return level;
  return null;
}

export function currentTitle(experience) {
  const sorted = [...(experience || [])].sort((a, b) =>
    (b.current ? 1 : 0) - (a.current ? 1 : 0) || (monthIndex(b.endDate) ?? Infinity) - (monthIndex(a.endDate) ?? Infinity) || (monthIndex(b.startDate) ?? 0) - (monthIndex(a.startDate) ?? 0));
  return sorted[0]?.title || null;
}

export function allSkills(sections) {
  return dedupe((sections.skills || []).flatMap(g => g.items));
}

/**
 * Profile completeness as a checklist, so the UI can say exactly what's
 * missing (Tsenta shows "91% complete →").
 */
export function completeness(sections, { hasResume = false } = {}) {
  const s = withDefaults(sections);
  const p = s.personal;
  const items = [
    { key: 'name', label: 'Full name', done: !!p.fullName },
    { key: 'contact', label: 'Email and phone', done: !!(p.email && p.phone) },
    { key: 'location', label: 'Location', done: !!(p.city || p.country) },
    { key: 'summary', label: 'Professional summary', done: s.summary.length >= 80 },
    { key: 'education', label: 'At least one education entry', done: s.education.length > 0 },
    { key: 'experience', label: 'At least one experience entry with bullet points', done: s.experience.some(e => e.bullets.length > 0) },
    { key: 'skills', label: 'At least 5 skills', done: allSkills(s).length >= 5 },
    { key: 'authorization', label: 'Work authorization answered', done: s.applicationDefaults.authorizedToWork !== undefined && s.applicationDefaults.needsSponsorship !== undefined },
    { key: 'links', label: 'LinkedIn or portfolio link', done: !!(p.linkedin || p.portfolio || p.github) },
    { key: 'resume', label: 'Resume uploaded', done: !!hasResume },
  ];
  const done = items.filter(i => i.done).length;
  return { percent: Math.round((done / items.length) * 100), items };
}

/** Fields the matching engine reads, derived from a (default) resume profile. */
export function deriveMatchingFields(sections) {
  const s = withDefaults(sections);
  const ad = s.applicationDefaults;
  return {
    profile: {
      full_name: s.personal.fullName || null, email: s.personal.email || null, phone: s.personal.phone || null,
      summary: s.summary || null, open_to_work: s.personal.openToWork,
      current_title: currentTitle(s.experience),
      total_experience_years: totalExperienceYears(s.experience),
      highest_education_level: highestEducationLevel(s.education),
      // Matching stores a two-letter country (CHAR(2)) and state codes: "United States" → US, "Texas" → TX.
      current_city: s.personal.city || null,
      current_state: s.personal.state ? (matchState(s.personal.state) || s.personal.state) : null,
      current_country: countryToCode(s.personal.country),
      work_authorization: [ad.authorizationBasis, ad.workPermit].filter(Boolean).join(' · ') || null,
      needs_sponsorship: ad.needsSponsorship ?? null,
    },
    skills: allSkills(s),
  };
}

// ─── Store ──────────────────────────────────────────────────────────────────

function shape(row, { full = false } = {}) {
  const sections = withDefaults(row.sections || {});
  const base = {
    id: row.id, name: row.name, isDefault: row.is_default, createdAt: row.created_at, updatedAt: row.updated_at,
    resumeFilename: row.resume_filename, hasResume: !!row.resume_text,
    completeness: completeness(sections, { hasResume: !!row.resume_text }),
  };
  return full ? { ...base, sections, layout: normalizeLayout(row.layout || {}), coverLetter: row.cover_letter || '', resumeText: row.resume_text || '' } : base;
}

export async function listResumeProfiles(userId) {
  const { rows } = await query(
    `SELECT * FROM resume_profiles WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC`, [userId]);
  return rows.map(r => shape(r));
}

export async function getResumeProfile(userId, profileId) {
  const { rows } = await query(`SELECT * FROM resume_profiles WHERE user_id = $1 AND id = $2`, [userId, profileId]);
  if (!rows[0]) return null;
  const p = shape(rows[0], { full: true });
  const { rows: f } = await query(`SELECT name, content_type, octet_length(data) AS bytes, uploaded_at FROM resume_files WHERE profile_id = $1`, [profileId]);
  p.originalFile = f[0] ? { name: f[0].name, contentType: f[0].content_type, bytes: Number(f[0].bytes), uploadedAt: f[0].uploaded_at } : null;
  return p;
}

// ─── The uploaded resume file ───────────────────────────────────────────────
export const RESUME_FILE_TYPES = {
  'application/pdf': 'pdf', 'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'text/plain': 'txt',
};
export const RESUME_FILE_MAX = 10 * 1024 * 1024;

/** Keeps the file as uploaded (one per profile; a new upload replaces it). */
export async function saveResumeFile(userId, profileId, { name, contentType, data }) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!RESUME_FILE_TYPES[type]) return { error: 'Only PDF, Word or plain-text files', code: 415 };
  if (!data?.length) return { error: 'The file is empty', code: 400 };
  if (data.length > RESUME_FILE_MAX) return { error: 'The file is over 10 MB', code: 413 };
  const { rowCount } = await query(`SELECT 1 FROM resume_profiles WHERE user_id = $1 AND id = $2`, [userId, profileId]);
  if (!rowCount) return { error: 'Not found', code: 404 };
  const safeName = str(name, 200).replace(/[\\/\r\n"]/g, '_') || `resume.${RESUME_FILE_TYPES[type]}`;
  await query(
    `INSERT INTO resume_files (profile_id, user_id, name, content_type, data) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (profile_id) DO UPDATE SET name = EXCLUDED.name, content_type = EXCLUDED.content_type, data = EXCLUDED.data, uploaded_at = NOW()`,
    [profileId, userId, safeName, type, data]);
  return { ok: true, name: safeName, contentType: type, bytes: data.length };
}

export async function getResumeFile(userId, profileId) {
  const { rows } = await query(`SELECT name, content_type, data FROM resume_files WHERE user_id = $1 AND profile_id = $2`, [userId, profileId]);
  return rows[0] ? { name: rows[0].name, contentType: rows[0].content_type, data: rows[0].data } : null;
}

export async function getDefaultResumeProfile(userId) {
  const { rows } = await query(`SELECT * FROM resume_profiles WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1`, [userId]);
  return rows[0] ? shape(rows[0], { full: true }) : null;
}

/** Creates a profile. The user's first profile becomes the default. copyFrom duplicates another profile's content. */
export async function createResumeProfile(userId, { name, copyFrom, sections } = {}) {
  let base = normalizeSections(sections || {}, { partial: true });
  let coverLetter = '', resumeText = null, resumeFilename = null, layout = {};
  if (copyFrom) {
    const src = await getResumeProfile(userId, copyFrom);
    if (!src) throw Object.assign(new Error('Profile to copy not found'), { status: 404 });
    base = src.sections; coverLetter = src.coverLetter; resumeText = src.resumeText || null; resumeFilename = src.resumeFilename; layout = src.layout;
  }
  const { rows: count } = await query(`SELECT COUNT(*)::int AS n FROM resume_profiles WHERE user_id = $1`, [userId]);
  if (count[0].n >= 10) throw Object.assign(new Error('You can keep up to 10 profiles'), { status: 400 });
  const { rows } = await query(
    `INSERT INTO resume_profiles (user_id, name, is_default, sections, cover_letter, resume_text, resume_filename, layout)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [userId, str(name, 80) || (count[0].n ? `Profile ${count[0].n + 1}` : 'Default'), count[0].n === 0, JSON.stringify(base), coverLetter, resumeText, resumeFilename, JSON.stringify(normalizeLayout(layout))]);
  const created = shape(rows[0], { full: true });
  if (created.isDefault) await syncMatchingProfile(userId, created.sections);
  return created;
}

/**
 * Updates name / cover letter / resume and replaces any section keys sent
 * (other sections are kept). Saving the default profile re-syncs matching.
 */
export async function updateResumeProfile(userId, profileId, patch = {}) {
  const current = await getResumeProfile(userId, profileId);
  if (!current) return null;
  const sections = { ...current.sections, ...normalizeSections(patch.sections || {}, { partial: true }) };
  const { rows } = await query(
    `UPDATE resume_profiles SET name = $3, sections = $4, cover_letter = $5,
            resume_text = $6, resume_filename = $7, layout = $8, updated_at = NOW()
      WHERE user_id = $1 AND id = $2 RETURNING *`,
    [userId, profileId, patch.name !== undefined ? (str(patch.name, 80) || current.name) : current.name, JSON.stringify(sections),
      patch.coverLetter !== undefined ? str(patch.coverLetter, 10000) : current.coverLetter,
      patch.resumeText !== undefined ? (str(patch.resumeText, 100000) || null) : (current.resumeText || null),
      patch.resumeFilename !== undefined ? (str(patch.resumeFilename, 200) || null) : current.resumeFilename,
      JSON.stringify(patch.layout !== undefined ? normalizeLayout({ ...current.layout, ...patch.layout }) : current.layout)]);
  const updated = shape(rows[0], { full: true });
  if (updated.isDefault) await syncMatchingProfile(userId, updated.sections);
  return updated;
}

export async function setDefaultResumeProfile(userId, profileId) {
  const target = await getResumeProfile(userId, profileId);
  if (!target) return null;
  // Two steps: the one-default unique index is checked row by row, so flipping
  // both rows in one UPDATE can fail depending on the order rows are visited.
  await query(`UPDATE resume_profiles SET is_default = FALSE WHERE user_id = $1 AND is_default AND id <> $2`, [userId, profileId]);
  await query(`UPDATE resume_profiles SET is_default = TRUE, updated_at = NOW() WHERE user_id = $1 AND id = $2`, [userId, profileId]);
  await syncMatchingProfile(userId, target.sections);
  return getResumeProfile(userId, profileId);
}

/** Deletes a profile. The last profile can't be deleted; deleting the default promotes the oldest remaining one. */
export async function deleteResumeProfile(userId, profileId) {
  const all = await listResumeProfiles(userId);
  const target = all.find(p => p.id === profileId);
  if (!target) return { deleted: false, status: 404 };
  if (all.length === 1) return { deleted: false, status: 400, error: 'You need at least one profile' };
  await query(`DELETE FROM resume_profiles WHERE user_id = $1 AND id = $2`, [userId, profileId]);
  if (target.isDefault) {
    const next = all.find(p => p.id !== profileId);
    await setDefaultResumeProfile(userId, next.id);
  }
  return { deleted: true };
}

/**
 * Pushes the default profile into what matching reads: user_profiles columns
 * (only the ones the profile actually knows — never blanks out a value the
 * user set elsewhere) and the user_skills list.
 */
export async function syncMatchingProfile(userId, sections) {
  const { profile, skills } = deriveMatchingFields(sections);
  const fields = Object.entries(profile).filter(([, v]) => v !== null && v !== undefined && v !== '');
  const cols = fields.map(([k]) => k);
  const { rows } = await query(
    `INSERT INTO user_profiles (user_id${cols.map(c => `, ${c}`).join('')})
     VALUES ($1${cols.map((_, i) => `, $${i + 2}`).join('')})
     ON CONFLICT (user_id) DO UPDATE SET ${cols.map(c => `${c} = EXCLUDED.${c}`).concat('updated_at = NOW()').join(', ')}
     RETURNING id`,
    [userId, ...fields.map(([, v]) => v)]);
  const profileId = rows[0].id;
  await query(`INSERT INTO user_profile_preferences (user_profile_id) VALUES ($1) ON CONFLICT (user_profile_id) DO NOTHING`, [profileId]);
  if (skills.length) {
    await query(`DELETE FROM user_skills WHERE user_profile_id = $1`, [profileId]);
    const seen = new Set();
    for (const name of skills) {
      const normalized = normalizeSkillName(name);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      const { rows: s } = await query(
        `INSERT INTO skills (canonical_name, normalized_name) VALUES ($1, $2)
         ON CONFLICT (normalized_name) DO UPDATE SET canonical_name = skills.canonical_name RETURNING id`, [name, normalized]);
      await query(
        `INSERT INTO user_skills (user_profile_id, skill_id, source, confidence) VALUES ($1, $2, 'resume_profile', 1.0)
         ON CONFLICT (user_profile_id, skill_id) DO NOTHING`, [profileId, s[0].id]);
    }
  }
  return profileId;
}
