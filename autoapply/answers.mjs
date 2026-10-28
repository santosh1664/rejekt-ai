/**
 * Form-question answering for auto-apply (docs/auto-apply.md). Pure.
 *
 * classifyQuestion() maps a field's label to a known question;
 * resolveAnswer() picks the value from the profile's answer book. When a
 * required question isn't known and has no saved answer, the application
 * stops and asks the person (NEEDS_YOU) instead of guessing. Their answer is
 * saved to the profile and reused on later forms.
 */
import { withDefaults, normalizeQuestion, totalExperienceYears } from '../lib/resume-profiles.mjs';

/** Everything a form may ask, from the resume profile. */
export function buildAnswerBook(sections, job = {}, { coverLetter = '', overrides = {} } = {}) {
  const s = withDefaults(sections);
  const p = s.personal; const ad = s.applicationDefaults || {};
  const names = p.fullName.trim().split(/\s+/);
  const latestEdu = s.education[0] || {};
  const current = s.experience.find(e => e.current) || s.experience[0] || {};
  return {
    firstName: names[0] || '', lastName: names.length > 1 ? names[names.length - 1] : '', fullName: p.fullName,
    email: p.email, phone: p.phone,
    location: [p.city, p.state, p.country].filter(Boolean).join(', '), city: p.city, state: p.state, country: p.country,
    linkedin: p.linkedin, github: p.github, website: p.portfolio || p.github || '',
    currentCompany: current.company || '', currentTitle: current.title || '',
    yearsExperience: s.experience.length ? String(Math.floor(totalExperienceYears(s.experience) || 0)) : '',
    school: latestEdu.school || '', degree: latestEdu.degree || '', discipline: latestEdu.field || '',
    graduationYear: (latestEdu.endDate || '').slice(0, 4), gpa: latestEdu.gpa || '',
    coverLetterText: coverLetter,
    authorizedToWork: ad.authorizedToWork, needsSponsorship: ad.needsSponsorship,
    visaStatus: [ad.workPermit, ad.workPermitStatus && ad.workPermitStatus !== 'Not applicable' ? ad.workPermitStatus : ''].filter(Boolean).join(', ') || ad.authorizationBasis || '',
    citizenship: ad.citizenship || '',
    canRelocate: ad.canRelocate, inPersonOk: ad.inPersonOk, startImmediately: ad.startImmediately,
    noticePeriod: ad.noticePeriod || (ad.startImmediately ? 'Immediately' : ''),
    salaryExpectation: ad.salaryExpectation || '',
    priorEmployee: ad.priorEmployee, govClearance: ad.govClearance, govTies: ad.govTies,
    over18: ad.over18, referralSource: ad.referralSource || '',
    hasTransport: ad.hasTransport, needsAccommodations: ad.needsAccommodations,
    gender: ad.gender || '', ethnicity: ad.ethnicity || '', veteran: ad.veteran || '', disability: ad.disability || '',
    companyName: job.company || '', jobTitle: job.title || '',
    savedAnswers: s.savedAnswers || [],
    overrides, // { normalizedQuestion: value } — the person's edits on a reviewed application
  };
}

// Order matters: the first rule that matches wins.
const RULES = [
  ['resumeFile', (l, f) => f.type === 'file' && /resume|cv\b|curriculum/.test(l)],
  ['coverLetterFile', (l, f) => f.type === 'file' && /cover/.test(l)],
  ['otherFile', (l, f) => f.type === 'file'],
  ['coverLetterText', l => /cover letter/.test(l)],
  ['consent', (l, f) => f.type === 'checkbox' && !f.group && /\b(agree|acknowledge|consent|privacy|terms|certify|attest|confirm that)\b/.test(l)],
  ['hispanic', l => /hispanic|latin[oax]/.test(l) && !/race/.test(l)],
  ['ethnicity', l => /\brace\b|ethnic/.test(l)],
  ['gender', l => /\bgender\b|\bsex\b/.test(l) && !/orientation|transgender/.test(l)],
  ['veteran', l => /veteran/.test(l)],
  ['disability', l => /disabilit/.test(l)],
  ['needsSponsorship', l => /sponsor/.test(l)],
  ['authorizedToWork', l => /(authori[sz]ed|eligible|legally (able|permitted)|right) to work|work authori[sz]ation|employment eligibility/.test(l)],
  ['visaStatus', l => /visa|immigration status|work permit/.test(l)],
  ['citizenship', l => /citizenship|citizen of/.test(l)],
  ['over18', l => /\b18\b.*(years|older|age)|(age|older).*\b18\b|legal age/.test(l)],
  ['canRelocate', l => /relocat/.test(l)],
  ['inPersonOk', l => /in[- ]person|on[- ]?site|in the office|commute|hybrid|days (a|per) week in/.test(l)],
  ['noticePeriod', l => /notice period|start date|when can you start|available to start|earliest (date|start)/.test(l)],
  ['salaryExpectation', l => /salary|compensation|pay (expectation|requirement)|desired pay/.test(l)],
  ['priorEmployee', l => /(previously|ever|formerly) (been )?(employed|worked)|former employee|worked (for|at|with) .{0,40} (before|previously)/.test(l)],
  ['govClearance', l => /clearance/.test(l)],
  ['govTies', l => /government (official|employee)|public official|conflict of interest|related to .{0,40}(government|official)/.test(l)],
  ['needsAccommodations', l => /accommodation/.test(l)],
  ['hasTransport', l => /transportation|reliable transport/.test(l)],
  ['referralSource', l => /how did you (hear|find|learn)|where did you (hear|find|learn)|referral source/.test(l)],
  ['firstName', l => /preferred (first )?name|first name|given name/.test(l)],
  ['lastName', l => /last name|family name|surname/.test(l)],
  ['email', l => /e-?mail/.test(l)],
  ['phone', l => /phone|mobile|cell/.test(l)],
  ['linkedin', l => /linkedin/.test(l)],
  ['github', l => /github/.test(l)],
  ['website', l => /website|portfolio|personal (site|url)|blog|other (url|link)/.test(l)],
  ['currentCompany', l => /current (company|employer)|most recent (company|employer)/.test(l)],
  ['currentTitle', l => /current (job )?title|current (role|position)|most recent (title|role)/.test(l)],
  ['yearsExperience', l => /years of (professional |relevant |industry |work )?experience|how many years/.test(l)],
  ['school', l => /\b(school|university|college|institution)\b/.test(l)],
  ['degree', l => /\bdegree\b/.test(l)],
  ['discipline', l => /discipline|major|field of study|area of study/.test(l)],
  ['graduationYear', l => /graduat/.test(l)],
  ['gpa', l => /\bgpa\b|grade point/.test(l)],
  ['country', l => /^country\b|country of residence|country you (live|reside)/.test(l)],
  ['location', l => /^(current )?location|\bcity\b|where (are you|do you) (currently )?(located|based|live)|address/.test(l)],
  ['fullName', l => /^(full |legal )?name\b|your name/.test(l)],
];

/**
 * @param {string} label
 * @param {{ type?: string, group?: boolean }} field
 * @returns {string|null} a known question key
 */
export function classifyQuestion(label, field = {}) {
  const l = normalizeQuestion(label);
  if (!l) return null;
  for (const [key, test] of RULES) if (test(l, field)) return key;
  return null;
}

const YES = /^(yes|y|true)\b/i;
const NO = /^(no|n|false)\b/i;
const DECLINE = /decline|prefer not|don.?t wish|do not wish|not to (self[- ]?)?(identify|disclose|answer)|choose not|rather not/i;

/** Pick the option that matches a value. options: [{ label, value }]. */
export function chooseOption(options, wanted) {
  if (wanted === null || wanted === undefined || wanted === '') return null;
  const opts = options.filter(o => o.label && !/^(select|choose|--|please select)/i.test(o.label.trim()));
  if (typeof wanted === 'boolean') return opts.find(o => (wanted ? YES : NO).test(o.label.trim())) || null;
  const w = String(wanted).trim(); const wl = w.toLowerCase();
  if (/^prefer not/i.test(w)) return opts.find(o => DECLINE.test(o.label)) || null;
  const exact = opts.find(o => o.label.trim().toLowerCase() === wl || String(o.value).toLowerCase() === wl);
  if (exact) return exact;
  const SYN = {
    male: /^(male|man)\b/i, female: /^(female|woman)\b/i, 'non-binary': /non[- ]?binary/i,
    'not a protected veteran': /not a (protected )?veteran|i am not a|^no\b/i,
    'protected veteran': /identify as (one or more|a protected)|i am a (protected )?veteran|^yes\b/i,
    no: /^no\b/i, yes: /^yes\b/i,
    asian: /asian/i, white: /^white/i, 'black or african american': /black/i, 'hispanic or latino': /hispanic|latin/i,
    'two or more races': /two or more/i, 'native hawaiian or other pacific islander': /hawaiian|pacific/i,
    'american indian or alaska native': /american indian|alaska/i,
  };
  if (SYN[wl]) { const m = opts.find(o => SYN[wl].test(o.label.trim())); if (m) return m; }
  const starts = opts.find(o => o.label.trim().toLowerCase().startsWith(wl));
  if (starts) return starts;
  return opts.find(o => o.label.toLowerCase().includes(wl) || (wl.length > 3 && wl.includes(o.label.trim().toLowerCase()))) || null;
}

function tokens(s) { return new Set(normalizeQuestion(s).split(' ').filter(w => w.length > 2)); }
function similar(a, b) {
  const A = tokens(a); const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / (A.size + B.size - n);
}

/** A previously saved answer to the same (or nearly the same) question. */
export function findSavedAnswer(book, label) {
  const q = normalizeQuestion(label);
  if (book.overrides && Object.prototype.hasOwnProperty.call(book.overrides, q)) return book.overrides[q];
  let best = null; let bestScore = 0;
  for (const sa of book.savedAnswers || []) {
    const sc = normalizeQuestion(sa.question) === q ? 1 : similar(sa.question, label);
    if (sc > bestScore) { best = sa.answer; bestScore = sc; }
  }
  return bestScore >= 0.85 ? best : null;
}

/**
 * What to put in one field.
 * field: { label, type, tag, options?, required, group? }
 * Returns { key, value, source } where value is null when nothing fits.
 * value is a string, a boolean, or { option } for choice fields.
 */
export function resolveAnswer(field, book, { acceptConsent = false } = {}) {
  const saved = findSavedAnswer(book, field.label);
  const key = classifyQuestion(field.label, field);
  let value = null; let source = null;
  if (saved !== null && saved !== undefined) { value = saved; source = 'saved'; }
  else if (key === 'consent') { value = acceptConsent ? true : null; source = acceptConsent ? 'consent setting' : null; }
  else if (key === 'hispanic') {
    if (book.ethnicity) value = book.ethnicity === 'Prefer not to say' ? 'Prefer not to say' : book.ethnicity === 'Hispanic or Latino';
    source = 'profile';
  } else if (key && !['resumeFile', 'coverLetterFile', 'otherFile'].includes(key)) {
    value = book[key]; source = 'profile';
    if (value === '' || value === undefined) value = null;
  }
  if (key === 'coverLetterText' && !value) value = null;

  const isChoice = field.tag === 'select' || field.type === 'radio' || field.type === 'buttons' || (field.type === 'checkbox' && field.group);
  if (isChoice && value !== null && field.options?.length) {
    // "Will you need sponsorship?" answered from a boolean, EEO from a label.
    const opt = chooseOption(field.options, value);
    return { key, value: opt ? { option: opt } : null, source: opt ? source : null, wanted: value };
  }
  if (field.type === 'checkbox' && !field.group) {
    if (typeof value === 'string') value = YES.test(value) ? true : NO.test(value) ? false : null;
    return { key, value: typeof value === 'boolean' ? value : null, source };
  }
  if (typeof value === 'boolean') value = value ? 'Yes' : 'No';
  return { key, value: value === null ? null : String(value), source };
}
