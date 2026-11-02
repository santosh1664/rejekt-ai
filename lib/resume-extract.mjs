/**
 * lib/resume-extract.mjs
 *
 * Turns plain resume text (from PDF/DOCX/TXT extraction in server.mjs) into
 * resume-profile sections (lib/resume-profiles.mjs): personal info, summary,
 * education, experience, projects, grouped skills, certifications, and any
 * other headed section as a custom section.
 *
 * Deterministic heuristics, no network/LLM: section headings split the text,
 * date ranges anchor entries, bullets attach to the current entry. Output is
 * a starting point the user reviews on the Profile screen — every field stays
 * editable — so it prefers leaving a field empty over guessing wrong.
 */

const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const DATE = `(?:(?:${MONTHS})\\.?\\s+\\d{4}|\\d{1,2}\\/\\d{4}|\\d{4}-\\d{2}|\\d{4})`;
const RANGE_RE = new RegExp(`(${DATE})\\s*(?:[-–—]|to)\\s*(${DATE}|present|current|now|till date|ongoing)`, 'i');
const SINGLE_DATE_RE = new RegExp(`(?:^|\\s|\\(|,)(${DATE})(?:\\)|$|\\s)`, 'i');
const BULLET_RE = /^\s*(?:[•●▪◦·\-*–]|\d+[.)])\s+/;

const SECTION_PATTERNS = [
  ['summary', /^(professional\s+|career\s+|executive\s+)?(summary|profile|objective|about( me)?)$/i],
  ['experience', /^((work|professional|relevant|industry|software engineering|engineering|technical)\s+)?(experience|employment( history)?|work history)$/i],
  ['education', /^(education|academic background|education\s*&\s*training)$/i],
  ['skills', /^((technical|core|key)\s+)?(skills|competencies|technologies|tech stack|skills\s*&\s*tools|technical skills\s*&\s*tools)$/i],
  ['projects', /^([a-z&/, -]{0,32}\s)?projects?(\s*(&|and)\s*[a-z]+)?$/i],
  ['certifications', /^(certifications?|licen[sc]es(\s*&\s*certifications)?|certifications\s*&\s*licen[sc]es)$/i],
  ['custom', /^(publications?|awards?|honou?rs|achievements|leadership|volunteer(ing)?( experience)?|research|activities|languages|interests)(\s*&\s*\w+)?$/i],
];

const TITLE_WORDS = /\b(engineer|developer|programmer|analyst|manager|intern|scientist|architect|lead|consultant|designer|specialist|associate|administrator|director|officer|coordinator|technician|assistant|researcher|founder|head|sde|swe)\b/i;
const SCHOOL_WORDS = /\b(university|college|institute|school|academy|polytechnic|iit|nit|vit|mit)\b/i;
const DEGREE_RE = /\b(ph\.?\s?d\.?|doctor(?:ate)? of [a-z ]+|master(?:'s)?(?: of [a-z ]+)?|bachelor(?:'s)?(?: of [a-z ]+)?|m\.?\s?s\.?(?![a-z])|m\.?sc\.?|m\.?eng\.?|m\.?tech\.?|mba|b\.?\s?s\.?(?![a-z])|b\.?sc\.?|b\.?eng\.?|b\.?tech\.?|b\.?e\.?(?![a-z])|b\.?a\.?(?![a-z])|associate(?:'s)? degree|high school diploma)\b/i;
const LOCATION_RE = /^(?:[Rr]emote|[Hh]ybrid|[A-Z][a-zA-Z .'-]+,\s*(?:[A-Z]{2}|[A-Z][a-zA-Z ]+))$/;
const COUNTRIES = /^(USA|US|United States|India|Canada|United Kingdom|UK|Germany|France|Ireland|Netherlands|Spain|Poland|Australia|Singapore|Japan|China|Mexico|Brazil|Israel|UAE)$/;
const ORG_WORDS = /\b(technologies|technology|tech|inc|corp|corporation|llc|ltd|labs|solutions|systems|group|bank|software|consulting|services|partners|holdings|global|limited|co)\b\.?/i;
const FIELD_WORDS = /(science|engineering|studies|arts|business|mathematics|technology|design|management|economics|physics|chemistry|biology|finance|marketing|informatics|systems|analytics)/i;

const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
// "-- 1 of 2 --" page markers that pdf-parse inserts.
const PAGE_MARK = /^\s*-*\s*(page\s+)?\d+\s*(of|\/)\s*\d+\s*-*\s*$/i;
// Small-caps headings come out of some PDFs as "P ROFESSIONAL S UMMARY".
const unspaceSmallCaps = l => (/^[A-Z&\s/,-]+$/.test(l.trim()) && /\b[A-Z] [A-Z]{2,}/.test(l) ? l.replace(/\b([A-Z]) (?=[A-Z]{2,})/g, '$1') : l);

// Joins a line that wrapped onto the next one. Keeps the hyphen in compounds
// ("multi-step", "agent-integrated"), drops it in split words ("imple-menting").
const KEEP_HYPHEN_RIGHT = /^(based|integrated|facing|driven|step|steps|time|stack|level|processing|aware|oriented|ready|specific|scale|end|grade|owned|first|side|wide|making|free|related|enabled|powered|assisted|quality|term|like|world|to|on|off|up|in|out|of|the|and|or|demand|service|services|tier|commerce|learning|language|tuning|tuned|class|source|code|call|calling|shot|context|reader|compatible|aligned|latency|grained|house|hoc|world)\b/i;
const KEEP_HYPHEN_LEFT = /(?:^|\s)(multi|agent|end|event|real|cross|full|self|semi|non|pre|re|co|high|low|long|short|user|client|server|ui|ai|job|data|cloud|rule|state|test|open|well|front|back|in|on|off|cost|role|task|type|team|tool|web|api|rag|llm|ml|risk|time|zero|one|two|three|first|second|third|large|small|mid|third|state-of|fine|few|day|year|month|week|pci|sub|post|anti|inter|over|under)$/i;
function joinWrapped(prev, next) {
  const n = clean(next);
  if (/-$/.test(prev) && !/\s-$/.test(prev)) {
    const left = prev.slice(0, -1);
    const keep = /^[A-Z0-9]/.test(n) || KEEP_HYPHEN_RIGHT.test(n) || KEEP_HYPHEN_LEFT.test(left) || /-\S*$/.test(left.split(/\s/).pop());
    return keep ? `${prev}${n}` : `${left}${n}`;
  }
  return `${prev} ${n}`;
}
const ENDS_OPEN = /([,\-–(/&]|\b(and|or|of|to|the|for|with|by|in|on|from|across|a|an|via|using|into|that|as|at|while|through|over|under|per|than|their|its|our|by about))$/i;
const ENDS_CLOSED = /[.!?:;)\]"”']$/;
const stripBullet = s => clean(String(s).replace(BULLET_RE, ''));

function headingOf(line) {
  const t = clean(line).replace(/[:|]+$/, '').trim();
  if (!t || t.length > 45 || /[.@]/.test(t)) return null;
  for (const [key, re] of SECTION_PATTERNS) if (re.test(t)) return { key, title: titleCase(t) };
  return null;
}
const titleCase = s => s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

/** Splits text into { header: [...lines], sections: [{key, title, lines}] }. */
export function splitSections(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').map(l => l.replace(/\t/g, ' ').trimEnd())
    .filter(l => l.trim() && !PAGE_MARK.test(l))
    .map(unspaceSmallCaps);
  const header = [];
  const sections = [];
  let current = null;
  for (const line of lines) {
    const h = headingOf(line);
    if (h) { current = { ...h, lines: [] }; sections.push(current); continue; }
    if (current) current.lines.push(line); else header.push(line);
  }
  return { header, sections };
}

/** Pulls a date range out of a string → { startDate, endDate, current, rest }. */
export function takeDates(s) {
  const m = s.match(RANGE_RE);
  if (m) {
    const end = m[2];
    const current = /present|current|now|till date|ongoing/i.test(end);
    return { startDate: toMonth(m[1]), endDate: current ? '' : toMonth(end), current, rest: clean(s.replace(m[0], ' ').replace(/[|,–—-]\s*$/, '').replace(/\(\s*\)/, '')) };
  }
  const single = s.match(SINGLE_DATE_RE);
  if (single && /\d{4}/.test(single[1])) return { startDate: '', endDate: toMonth(single[1]), current: false, rest: clean(s.replace(single[1], ' ').replace(/[|,–—-]\s*$/, '').replace(/\(\s*\)/, '')) };
  return { startDate: '', endDate: '', current: false, rest: clean(s) };
}

function toMonth(s) {
  const t = clean(s).replace('.', '');
  let m = t.match(new RegExp(`^(${MONTHS})\\s+(\\d{4})$`, 'i'));
  if (m) {
    const idx = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[1].slice(0, 3).toLowerCase());
    return `${m[2]}-${String(idx + 1).padStart(2, '0')}`;
  }
  m = t.match(/^(\d{1,2})\/(\d{4})$/); if (m) return `${m[2]}-${m[1].padStart(2, '0')}`;
  m = t.match(/^(\d{4})-(\d{2})$/); if (m) return t;
  return /^\d{4}$/.test(t) ? t : '';
}

/**
 * Splits a header line on the usual separators, then re-joins "City, ST" /
 * "City, Country" pairs the comma split broke apart. withAt: also split on
 * " at " ("Engineer at Acme") — off for education ("University of X at Y").
 */
function splitParts(s, { withAt = true } = {}) {
  const raw = clean(s).split(withAt ? /\s+[|•·]\s+|\s+[–—]\s+|\s+-\s+|\s{3,}|,\s+(?=[A-Z])|\s+at\s+/ : /\s+[|•·]\s+|\s+[–—]\s+|\s+-\s+|\s{3,}|,\s+(?=[A-Z])/).map(clean).filter(Boolean);
  const out = [];
  for (const part of raw) {
    const prev = out[out.length - 1];
    if (prev && (/^[A-Z]{2}$/.test(part) || COUNTRIES.test(part)) && /^[A-Z][a-zA-Z .'-]+$/.test(prev) && !TITLE_WORDS.test(prev) && !SCHOOL_WORDS.test(prev) && !ORG_WORDS.test(prev)) out[out.length - 1] = `${prev}, ${part}`;
    else out.push(part);
  }
  return out;
}

/**
 * Groups a section's lines into entries: non-bullet header lines, then
 * bullets. A non-bullet line also starts a new entry when the current
 * header already has its dates, or when startsNew(line, entry) says so.
 */
function looksLikeHeader(raw) {
  const t = clean(raw);
  return RANGE_RE.test(t) || (/\s[|]\s|\s[–—]\s|\sat\s/.test(t) && t.length < 130 && !ENDS_CLOSED.test(t))
    || (TITLE_WORDS.test(t) && t.split(/\s+/).length <= 7 && /^[A-Z]/.test(t) && !ENDS_CLOSED.test(t));
}
function entries(lines, startsNew = () => false, belongsToHead = () => false) {
  const out = [];
  let cur = null;
  let inBullet = false;       // the previous line was a bullet (or its continuation)
  let prevLen = 0;            // length of that previous physical line
  for (const raw of lines) {
    const isBullet = BULLET_RE.test(raw);
    const hasRange = RANGE_RE.test(raw);
    if (!isBullet && inBullet && !hasRange) {
      // The bullet wrapped onto this line: it starts lowercase, or the bullet's
      // line ended mid-sentence and this line doesn't look like a new entry.
      const last = cur.bullets[cur.bullets.length - 1];
      // Only a long line can have wrapped (it ran out of page width).
      if (/^[a-z(]/.test(raw.trim()) || (prevLen >= 70 && (ENDS_OPEN.test(last) || (!ENDS_CLOSED.test(last) && !looksLikeHeader(raw))))) {
        cur.bullets[cur.bullets.length - 1] = joinWrapped(last, raw);
        prevLen = clean(raw).length;
        continue;
      }
    }
    if (isBullet) {
      if (!cur) cur = { head: [], bullets: [] }, out.push(cur);
      cur.bullets.push(stripBullet(raw)); inBullet = true; prevLen = clean(raw).length;
      continue;
    }
    inBullet = false;
    const headHasDates = cur?.head.some(h => RANGE_RE.test(h));
    // A title or degree on its own line under a "Company – Place  Dates" line belongs to that entry.
    const attach = cur && !cur.bullets.length && headHasDates && !hasRange && belongsToHead(raw, cur);
    if (!attach && (!cur || cur.bullets.length || cur.head.length >= 3 || (headHasDates && !hasRange) || startsNew(raw, cur))) { cur = { head: [], bullets: [] }; out.push(cur); }
    cur.head.push(clean(raw));
  }
  return out;
}

const titleLine = (raw, cur) => TITLE_WORDS.test(raw) && clean(raw).split(/\s+/).length <= 8 && !cur.head.some(h => TITLE_WORDS.test(h.replace(RANGE_RE, '')));
function parseExperience(lines) {
  return entries(lines, () => false, titleLine).map(({ head, bullets }) => {
    let dates = { startDate: '', endDate: '', current: false };
    const parts = [];
    for (const h of head) {
      const d = takeDates(h);
      if (d.startDate || d.endDate) dates = d;
      parts.push(...splitParts(d.rest));
    }
    const location = parts.find(p => (LOCATION_RE.test(p) || COUNTRIES.test(p)) && !TITLE_WORDS.test(p)) || '';
    const rest = parts.filter(p => p !== location);
    const title = rest.find(p => TITLE_WORDS.test(p)) || '';
    const company = rest.find(p => p !== title) || '';
    return { company, title, location, startDate: dates.startDate, endDate: dates.endDate, current: dates.current, bullets };
  }).filter(e => e.company || e.title);
}

function parseEducation(lines) {
  // Two schools back to back with no bullets: a school line starts a new entry.
  const newSchool = (line, cur) => SCHOOL_WORDS.test(line) && cur.head.some(h => SCHOOL_WORDS.test(h));
  const degreeLine = (raw, cur) => DEGREE_RE.test(raw) && !SCHOOL_WORDS.test(raw) && !cur.head.some(h => DEGREE_RE.test(h));
  return entries(lines, newSchool, degreeLine).map(({ head, bullets }) => {
    let dates = { startDate: '', endDate: '' };
    const parts = [];
    let gpa = '';
    for (const h of head) {
      const g = h.match(/\b(?:c?gpa|grade)\s*[:\-]?\s*(\d(?:\.\d{1,2})?(?:\s*\/\s*\d+(?:\.\d+)?)?)/i);
      if (g) gpa = g[1].replace(/\s+/g, '');
      const d = takeDates(h.replace(/\b(?:c?gpa|grade)\s*[:\-]?\s*\d(?:\.\d{1,2})?(?:\s*\/\s*\d+(?:\.\d+)?)?/i, ''));
      if (d.startDate || d.endDate) dates = d;
      parts.push(...splitParts(d.rest, { withAt: false }));
    }
    const school = parts.find(p => SCHOOL_WORDS.test(p)) || '';
    const degreePart = parts.find(p => DEGREE_RE.test(p)) || '';
    let degree = '', field = '';
    if (degreePart) {
      const m = degreePart.match(/^(.*?)(?:\s+in\s+|,\s*|\s+[-–—]\s+)(.+)$/i);
      if (m && DEGREE_RE.test(m[1])) { degree = clean(m[1]); field = clean(m[2]); }
      else {
        // "B.S. Computer Science" → degree "B.S.", field "Computer Science"
        const d = degreePart.match(DEGREE_RE);
        const after = clean(degreePart.slice(d.index + d[0].length).replace(/^[\s,.:-]+/, ''));
        degree = clean(degreePart.slice(0, d.index + d[0].length));
        if (after && FIELD_WORDS.test(after)) field = after;
      }
    }
    if (!field && degree) field = parts.find(p => p !== school && p !== degreePart && FIELD_WORDS.test(p) && !SCHOOL_WORDS.test(p)) || '';
    return { school, degree, field, startDate: dates.startDate, endDate: dates.endDate, gpa, description: bullets.join('\n') };
  }).filter(e => e.school || e.degree);
}

// "Python, LangChain, FastAPI" is a stack; "AI-Powered Interview Platform" is part of the name.
const looksLikeStack = s => { const items = s.split(/,\s*/).map(clean).filter(Boolean); return items.length >= 2 && items.every(x => x.split(/\s+/).length <= 3); };
function parseProjects(lines) {
  const projectLine = (raw, cur) => !TITLE_WORDS.test(raw) && clean(raw).split(/\s+/).length <= 8 && cur.head.length === 1;
  return entries(lines, () => false, projectLine).map(({ head, bullets }) => {
    let dates = { startDate: '', endDate: '' };
    let technologies = [];
    let url = '';
    const names = []; const extra = [];
    head.forEach((h, idx) => {
      const u = h.match(/https?:\/\/\S+|github\.com\/\S+|\bwww\.[a-z0-9-]+\.[a-z.]{2,}\S*/i); if (u) url = u[0];
      const d = takeDates(h.replace(u?.[0] || '\u0000', ''));
      if (d.startDate || d.endDate) dates = d;
      const rest = d.rest.replace(/\(\s*live\s*\)/i, '').trim();
      const sep = rest.match(/^(.*?)(?:\s+[|]\s+|\s+[–—]\s+|\s+-\s+)(.+)$/);
      if (sep && looksLikeStack(sep[2])) { technologies = sep[2].split(/,\s*/).map(clean).filter(Boolean); if (clean(sep[1])) names.push(clean(sep[1])); }
      else if (clean(rest)) (idx === 0 || !names.length ? names : extra).push(clean(rest));
    });
    return { name: names[0] || '', role: extra.join(' '), url, startDate: dates.startDate, endDate: dates.endDate, technologies, bullets };
  }).filter(p => p.name);
}

// Splits on commas/semicolons/pipes that aren't inside parentheses.
function splitItems(s) {
  const out = []; let depth = 0; let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++; else if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && /[,;|•·]/.test(ch)) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map(clean).filter(x => x && x.length <= 80);
}
const SKILL_LABEL = /^([A-Za-z][A-Za-z /&+,-]{1,48}):\s*(.+)$/;
function parseSkills(rawLines) {
  // Re-join wrapped lines (a line without "Label:" continues the previous one),
  // and split "Databases: … | Vector Databases: …" into two groups.
  const lines = [];
  for (const raw of rawLines) {
    const l = stripBullet(raw);
    if (lines.length && !SKILL_LABEL.test(l) && !BULLET_RE.test(raw) && SKILL_LABEL.test(lines[lines.length - 1])) lines[lines.length - 1] = joinWrapped(lines[lines.length - 1], l);
    else lines.push(l);
  }
  const split = lines.flatMap(l => l.split(/\s+\|\s+(?=[A-Za-z][A-Za-z /&+-]{1,40}:)/));
  const groups = [];
  for (const line of split) {
    const m = line.match(SKILL_LABEL);
    const items = splitItems(m ? m[2] : line);
    if (!items.length) continue;
    if (m) groups.push({ group: clean(m[1]), items });
    else {
      const last = groups[groups.length - 1];
      if (last && last.group === 'Skills') last.items.push(...items); else groups.push({ group: 'Skills', items });
    }
  }
  return groups;
}

function parseCertifications(lines) {
  return lines.map(stripBullet).map(l => l.replace(/\s*\b(credential verification|verify credential|verify|view credential)\b\s*$/i, '')).filter(Boolean).map(line => {
    const d = takeDates(line);
    // Spaced hyphen or pipe separates the issuer; an en dash usually belongs
    // to the cert name ("AWS Certified Developer – Associate").
    const [name, ...issuer] = d.rest.replace(/,\s*$/, '').split(/\s+\|\s+|\s+-\s+/);
    return { name: clean(name), issuer: clean(issuer.join(' - ').replace(/,\s*$/, '')), date: d.endDate || d.startDate, url: '' };
  }).filter(c => c.name);
}

const NAME_EXCLUDE = /^(resume|curriculum vitae|cv)$/i;
function parsePersonal(header, text) {
  const email = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)?.[0] || '';
  const phone = text.match(/(\+?\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/)?.[0] || '';
  const linkedin = text.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[\w-]+\/?/i)?.[0] || '';
  const github = text.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/[\w-]+\/?/i)?.[0] || '';
  const portfolio = (header.join(' ').match(/https?:\/\/(?!(?:www\.)?(?:linkedin|github)\.com)[^\s|,]+/i)?.[0])
    || (header.join(' | ').replace(/[^\s|@]+@[^\s|]+/g, '').match(/(?:^|[\s|])((?:www\.)?(?!linkedin\.|github\.)[a-z0-9-]+\.(?:info|com|dev|io|me|net|org|ai|app|site|tech|co)(?:\/[^\s|,]*)?)(?=$|[\s|,])/i)?.[1]) || '';
  let fullName = '';
  for (const line of header.slice(0, 4)) {
    const t = clean(line.split(/\s+[|•·]\s+/)[0]);
    if (NAME_EXCLUDE.test(t) || /@|\d|http/.test(t)) continue;
    if (/^[A-Za-z][A-Za-z'.-]*(\s+[A-Za-z][A-Za-z'.-]*){1,3}$/.test(t)) { fullName = t.split(/\s+/).map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' '); break; }
  }
  const loc = header.join(' | ').match(/([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)*),\s*([A-Z]{2})\b/);
  const headline = header.slice(1, 3).map(clean).find(l => TITLE_WORDS.test(l) && !/@|\d{3}/.test(l) && l.length < 90) || '';
  return { fullName, headline, email, phone, city: loc?.[1] || '', state: loc?.[2] || '', country: loc ? 'US' : '', linkedin, github, portfolio, openToWork: true };
}

/**
 * @param {string} text  plain text of a resume
 * @returns sections for lib/resume-profiles.mjs normalizeSections()
 */
export function extractResumeSections(text) {
  const { header, sections } = splitSections(text);
  const out = { personal: parsePersonal(header, String(text || '')), summary: '', education: [], experience: [], projects: [], skills: [], certifications: [], custom: [] };
  for (const s of sections) {
    if (s.key === 'summary') out.summary = clean(s.lines.map(stripBullet).join(' '));
    else if (s.key === 'experience') out.experience.push(...parseExperience(s.lines));
    else if (s.key === 'education') out.education.push(...parseEducation(s.lines));
    else if (s.key === 'projects') out.projects.push(...parseProjects(s.lines));
    else if (s.key === 'skills') out.skills.push(...parseSkills(s.lines));
    else if (s.key === 'certifications') out.certifications.push(...parseCertifications(s.lines));
    else out.custom.push({ title: s.title, body: s.lines.map(l => (BULLET_RE.test(l) ? `• ${stripBullet(l)}` : clean(l))).join('\n') });
  }
  return out;
}

/**
 * Merges extracted sections into existing ones without destroying user edits:
 * mode 'fill' only fills empty fields/lists; mode 'replace' overwrites every
 * section the resume produced something for.
 */
// An experience entry an earlier, bad parse left behind: no job title, or a "company" that is really a sentence
// (a bullet point landed in it). "Fill" treats a section made only of these as empty, so a good parse can replace it.
const brokenRole = (e) => !String(e?.title || '').trim() || String(e?.company || '').length > 80 || /[.!?]\s*$/.test(String(e?.company || '').trim());

export function mergeExtracted(existing, extracted, mode = 'fill') {
  const out = { ...existing };
  const empty = v => v == null || v === '' || (Array.isArray(v) && v.length === 0);
  const unusable = (key, v) => empty(v) || (key === 'experience' && Array.isArray(v) && v.every(brokenRole));
  for (const key of ['summary', 'education', 'experience', 'projects', 'skills', 'certifications', 'custom']) {
    if (empty(extracted[key])) continue;
    if (mode === 'replace' || unusable(key, existing[key])) out[key] = extracted[key];
  }
  const p = { ...(existing.personal || {}) };
  for (const [k, v] of Object.entries(extracted.personal || {})) if (!empty(v) && k !== 'openToWork' && (mode === 'replace' || empty(p[k]))) p[k] = v;
  out.personal = p;
  return out;
}
