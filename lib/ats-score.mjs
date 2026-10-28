/**
 * ATS score (0–10) for a tailored resume against one posting.
 *
 * Deterministic, so it can rank and filter thousands of model outputs
 * (ml/generate-best-of-n.mjs) and compare models (ml/eval-ats.mjs). The parts
 * follow what an ATS and a recruiter's first read reward (career-ops
 * modes/pdf.md, "ATS Rules" and "Recruiter Review Gates"):
 *
 *   coverage   3.0  the posting's skills the ORIGINAL resume supports appear on the tailored one (required ones count double).
 *                   Skills the original never showed are gaps: they don't count for or against coverage, and adding one costs integrity
 *   evidence   1.5  those skills appear in the summary or bullets, not only in the skills list
 *   placement  1.5  the summary names the top keywords; each role's first bullet names one
 *   integrity  3.0  titles, companies and dates unchanged; every original bullet still there;
 *                   no new numbers; nothing pasted from the posting; no skill the original didn't show;
 *                   no buzzword filler; no near-duplicate bullets. Any unsupported skill caps the whole score at 6.
 *   writing    1.0  no clichés, varied bullet openings, sensible bullet and summary length
 *
 * Integrity needs the original resume; without it that part is scored on the
 * copy check alone.
 */
import { readFileSync } from 'node:fs';
import { withDefaults } from './resume-profiles.mjs';
import { jobSkillMap, resumeEvidence, FILLER_RE, bulletOverlap, itemSkills } from './resume-tailor.mjs';
import { extractSkills } from './skill-extract.mjs';
import { normalizeSkillName, mentions } from './skills.mjs';
import { BANNED_WORDS, copiesPosting } from './resume-match.mjs';
import { overlap } from './bullet-bank.mjs';

const WEIGHT = { REQUIRED: 2, PREFERRED: 1.5, MENTIONED: 1 };
const NUM_RE = /\d+(?:[.,]\d+)?\s*[%xkKmM+]?/g;
const nums = s => (String(s || '').match(NUM_RE) || []).map(n => n.toLowerCase().replace(/[\s,]/g, ''));
const skillsIn = t => new Set(extractSkills(String(t || '')).map(s => s.name));
// below the 9+ bar that ml/export-rewriter-dataset.mjs trains on
const UNSUPPORTED_CAP = 6;
// A skills-list item as the taxonomy names it ("Vector Databases" and "vector database" are the same skill).
const canon = item => extractSkills(String(item || ''))[0]?.name || normalizeSkillName(item);
const round1 = x => Math.round(x * 10) / 10;

// Key terms of a posting beyond named tools (career-ops: "extract 15-20 keywords
// from the JD"): the most frequent words and two-word phrases of the job part
// of the posting, with the company blurb, benefits and EEO text cut off.
const STOP = new Set(('a an and are as at be by for from has have in is it its of on or our that the their this to we will with you your who what how all any can may more must not other such than then them they these those through using use used within without about across also both each into like make making new one per same should some well work working team teams role ability strong experience years year including include etc plus preferred required requirements qualifications responsibilities knowledge skills skill understanding familiarity proficiency proficient excellent good great hands highly help join looking ideal candidate based level related relevant degree bachelor bachelors master masters equivalent field computer science job position company opportunity day best part where when while impact improve value values mission people clear lead deliver real-world solutions solution problems problem big world million millions every everything ensure across want need needs able just very most only want first time things thing way ways today future meaningful professional hiring u.s environment fast-paced passion passionate love culture growth grow career benefits remote office location hybrid onsite please apply applicants including candidates employer applicable committed back month here why take seeking someone around decisions against change associates').split(' '));
const BOILER = /\b(benefits?|equal (employment )?opportunity|eeo|401\(?k\)?|compensation|salary|pay range|paid time off|pto|medical|dental|vision|insurance|parental leave|disability|veteran|accommodation|privacy policy|about us|hiring process|inclusive|inclusion|diversity|why you('|’)?ll love|authentic self|we offer|perks)\b/i;
const stem = w => w.replace(/(ing|ings|ed|es|s)$/, '');
// Job part of a posting: from the first responsibilities/requirements heading on.
const JOB_HEAD = /\b(what you('|’)?ll do|what you will do|responsibilities|key responsibilities|the role|about the role|your role|requirements|qualifications|what we('|’)?re looking for|what you bring|you have|you will|skills|duties)\b/i;
// Unigrams and two-word phrases of a text, lowercased, stop words dropped.
export function termsOf(text, extraStop = []) {
  const out = [];
  for (const l of String(text || '').replace(/&nbsp;|\bnbsp\b/gi, ' ').split(/\n+|(?<=[.!?;:])\s+/)) {
    // Two-word phrases only from words that stand next to each other in the text.
    const w = (l.toLowerCase().match(/[a-z][a-z0-9+#./-]*/g) || []).map(x => x.replace(/[./-]+$/, ''));
    const ok = x => x.length > 2 && !STOP.has(x) && !extraStop.includes(x);
    for (let i = 0; i < w.length; i++) {
      if (!ok(w[i])) continue;
      out.push(w[i]);
      if (i + 1 < w.length && ok(w[i + 1])) out.push(`${w[i]} ${w[i + 1]}`);
    }
  }
  return out;
}
let IDF = null;
function idf() {
  if (IDF) return IDF;
  try { const j = JSON.parse(readFileSync(new URL('../data/posting-idf.json', import.meta.url), 'utf8')); IDF = { n: j.postings, df: new Map(Object.entries(j.df)) }; }
  catch { IDF = { n: 0, df: new Map() }; }
  return IDF;
}
export function postingTerms(job, n = 15) {
  const text = String(job.description || '');
  const all = text.split(/\n+/);
  const start = all.findIndex(l => JOB_HEAD.test(l) && l.length < 160);
  const body = (start > 0 ? all.slice(start) : all).filter(l => !BOILER.test(l)).join('\n');
  const company = String(job.company || '').toLowerCase().split(/\W+/).filter(w => w.length > 2);
  const tf = new Map();
  for (const t of termsOf(`${job.title || ''}\n${body}`, company)) tf.set(t, (tf.get(t) || 0) + 1);
  const { n: N, df } = idf();
  const score = (t, c) => {
    if (!N) return c * (t.includes(' ') ? 1.5 : 1);
    const d = df.get(t) || 0;
    if (d > N * 0.25) return 0;                     // in a quarter of all postings: says nothing
    if (t.includes(' ') && d < 2 && c < 2) return 0; // one-off phrase
    return c * Math.log((N + 1) / (d + 1)) * (t.includes(' ') ? 1.3 : 1);
  };
  const out = [];
  for (const [t] of [...tf.entries()].map(([t, c]) => [t, score(t, c)]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])) {
    if (out.length >= n) break;
    if (out.some(o => o.includes(t) || t.includes(o))) continue;
    out.push(t);
  }
  return out;
}
const hasTerm = (text, term) => term.split(' ').every(w => new RegExp(`\\b${stem(w).replace(/[+#.]/g, m => `\\${m}`)}`, 'i').test(text));

/**
 * opts.original  the resume before tailoring (enables the integrity checks)
 * opts.allowed   extra text whose numbers count as already yours (bullets you
 *                wrote before that came back from the bullet bank)
 */
export function atsScore(tailored, job, { original = null, allowed = '' } = {}) {
  const T = withDefaults(tailored);
  const issues = [];
  const want = jobSkillMap(job);                         // name -> { canonicalName, importance }
  const listed = new Set(T.skills.flatMap(g => g.items.flatMap(i => [canon(i), ...itemSkills(i)])));
  const bulletsText = [...T.experience.flatMap(e => e.bullets || []), ...T.projects.flatMap(p => [...(p.bullets || []), ...(p.technologies || [])])].join('\n');
  const inBody = skillsIn(`${T.summary || ''}\n${bulletsText}`);
  const anywhere = new Set([...listed, ...inBody]);

  // Skills the original resume shows. A posting skill outside this set is a gap, never credit.
  const supported = original ? new Set([...resumeEvidence(withDefaults(original)).shown, ...withDefaults(original).skills.flatMap(g => g.items.flatMap(i => [canon(i), ...itemSkills(i)]))]) : null;
  const gaps = [];
  const origText = original ? JSON.stringify(withDefaults(original)).toLowerCase() : '';
  // a listed item the taxonomy doesn't know (e.g. "Vector Databases") is fine if the original's own text says it
  const unsupportedAdded = supported ? [...anywhere].filter(n => !supported.has(n) && !mentions(origText, n)) : [];

  // 1. Coverage and 2. evidence
  let total = 0; let got = 0; let shownW = 0;
  const missing = [];
  for (const [name, v] of want) {
    if (supported && !supported.has(name)) { gaps.push(v.canonicalName); continue; }
    const w = WEIGHT[v.importance] || 1; total += w;
    if (anywhere.has(name)) { got += w; if (inBody.has(name)) shownW += w; }
    else missing.push(v.canonicalName);
  }
  const terms = postingTerms(job);
  const resumeText = [T.summary, bulletsText, T.skills.flatMap(g => g.items).join(', ')].join('\n');
  const termHits = terms.filter(t => hasTerm(resumeText, t));
  // An ATS doesn't need every term: 60% of them counts as full marks.
  const termCov = terms.length ? Math.min(1, termHits.length / (0.6 * terms.length)) : 1;
  const skillCov = total ? got / total : termCov;
  const coverage = 0.6 * skillCov + 0.4 * termCov;
  const missTerms = terms.filter(t => !termHits.includes(t));
  if (missTerms.length > terms.length / 3) issues.push(`posting terms not used: ${missTerms.slice(0, 8).join(', ')}`);
  const evidence = got ? shownW / got : (total ? 0 : 1);
  if (missing.length) issues.push(`missing from the resume: ${missing.slice(0, 8).join(', ')}`);
  if (gaps.length) issues.push(`posting skills the original doesn't show (gaps, not scored): ${gaps.slice(0, 8).join(', ')}`);
  if (total && evidence < 0.6) issues.push('many matching skills appear only in the skills list, not in any bullet');

  // 3. Placement
  const top = [...want.entries()].sort((a, b) => (WEIGHT[b[1].importance] || 1) - (WEIGHT[a[1].importance] || 1)).slice(0, 5).map(([n]) => n);
  const inSummary = skillsIn(T.summary);
  const sumPart = top.length ? Math.min(1, top.filter(n => inSummary.has(n)).length / Math.min(3, top.length)) : 1;
  const roles = T.experience.filter(e => (e.bullets || []).length);
  const firstPart = roles.length && want.size ? roles.filter(e => [...skillsIn(e.bullets[0])].some(n => want.has(n))).length / roles.length : 1;
  const placement = (sumPart + firstPart) / 2;
  if (sumPart < 1) issues.push('the summary names few of the posting\'s top keywords');
  if (firstPart < 1) issues.push('some roles lead with a bullet that names none of the posting\'s skills');

  // 4. Integrity
  let integrity = 1;
  const copied = [T.summary, ...T.experience.flatMap(e => e.bullets || []), ...T.projects.flatMap(p => p.bullets || [])].map(b => copiesPosting(b, job)).filter(Boolean);
  if (copied.length) { integrity -= Math.min(0.6, 0.3 * copied.length); issues.push(`posting text pasted in (${copied[0]})`); }
  if (original) {
    const O = withDefaults(original);
    const key = e => `${e.company}|${e.title}|${e.startDate}|${e.endDate}`.toLowerCase();
    if (O.experience.map(key).join() !== T.experience.map(key).join()) { integrity -= 0.5; issues.push('an employer, title or date changed'); }
    // Pair roles and projects by name, not position: tailoring may put the most
    // relevant project first.
    const k = x => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const roleOf = e => T.experience.find(t => k(t.company) === k(e.company) && k(t.title) === k(e.title));
    const projOf = p => T.projects.find(t => k(t.name) === k(p.name)) || T.projects.find(t => k(t.name).slice(0, 12) === k(p.name).slice(0, 12));
    const blocks = [...O.experience.map(e => [e.bullets || [], roleOf(e)?.bullets || []]), ...O.projects.map(p => [p.bullets || [], projOf(p)?.bullets || []])];
    const orig = blocks.flatMap(([a]) => a).length;
    const kept = blocks.reduce((n, [a, b]) => n + a.filter(x => b.some(y => y === x || overlap(x, y) >= 0.15)).length, 0);
    if (orig && kept < orig) { integrity -= 0.5 * (1 - kept / orig) * 2; issues.push(`${orig - kept} original bullet(s) dropped or replaced`); }
    const had = new Set(nums([O.summary, ...O.experience.flatMap(e => e.bullets || []), ...O.projects.flatMap(p => p.bullets || []), allowed].join(' ')).map(n => n.replace(/[^0-9.]/g, '')));
    const added = nums([T.summary, ...T.experience.flatMap(e => e.bullets || []), ...T.projects.flatMap(p => p.bullets || [])].join(' ')).map(n => n.replace(/[^0-9.]/g, '')).filter(n => n && !had.has(n));
    if (added.length) { integrity -= Math.min(0.5, 0.15 * added.length); issues.push(`new numbers: ${[...new Set(added)].slice(0, 5).join(', ')}`); }
  }
  if (unsupportedAdded.length) { integrity -= Math.min(1, 0.34 * unsupportedAdded.length); issues.push(`skills added that the original doesn't show: ${unsupportedAdded.slice(0, 8).join(', ')}`); }
  const filler = [T.summary, ...T.experience.flatMap(e => e.bullets || []), ...T.projects.flatMap(p => p.bullets || [])].flatMap(b => String(b || '').match(FILLER_RE) || []).map(w => w.toLowerCase());
  const origFiller = original ? new Set([withDefaults(original).summary, ...withDefaults(original).experience.flatMap(e => e.bullets || [])].flatMap(b => String(b || '').match(FILLER_RE) || []).map(w => w.toLowerCase())) : new Set();
  const newFiller = filler.filter(w => !origFiller.has(w));
  if (newFiller.length) { integrity -= Math.min(0.4, 0.1 * newFiller.length); issues.push(`buzzword filler: ${[...new Set(newFiller)].join(', ')}`); }
  let dupes = 0;
  for (const e of [...T.experience, ...T.projects]) { const b = e.bullets || []; for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) if (bulletOverlap(b[i], b[j]) >= 0.7) dupes++; }
  if (dupes) { integrity -= Math.min(0.4, 0.2 * dupes); issues.push(`${dupes} near-duplicate bullet pair(s)`); }
  integrity = Math.max(0, integrity);

  // 5. Writing
  let writing = 1;
  const allBullets = [...T.experience.flatMap(e => e.bullets || []), ...T.projects.flatMap(p => p.bullets || [])];
  const cliches = [T.summary, ...allBullets].map(b => (String(b || '').match(BANNED_WORDS) || [])[0]).filter(Boolean);
  if (cliches.length) { writing -= Math.min(0.4, 0.1 * cliches.length); issues.push(`clichés: ${[...new Set(cliches.map(c => c.toLowerCase()))].join(', ')}`); }
  const variety = roles.length ? roles.reduce((n, e) => n + new Set(e.bullets.map(b => b.split(/\s+/)[0].toLowerCase())).size / e.bullets.length, 0) / roles.length : 1;
  if (variety < 0.8) { writing -= 0.2; issues.push('several bullets in a role start with the same verb'); }
  const okLen = allBullets.length ? allBullets.filter(b => b.length >= 60 && b.length <= 320).length / allBullets.length : 1;
  if (okLen < 0.9) { writing -= 0.2; issues.push('some bullets are very short or very long'); }
  const words = String(T.summary || '').split(/\s+/).filter(Boolean).length;
  if (words && (words < 35 || words > 130)) { writing -= 0.2; issues.push(`summary is ${words} words`); }
  writing = Math.max(0, writing);

  const parts = { coverage: 3 * coverage, evidence: 1.5 * evidence, placement: 1.5 * placement, integrity: 3 * integrity, writing: 1 * writing };
  let score = round1(Object.values(parts).reduce((a, b) => a + b, 0));
  // Hard gate: a high keyword score must never make up for an invented skill.
  if (unsupportedAdded.length) score = Math.min(score, UNSUPPORTED_CAP);
  return { score, gaps, unsupportedAdded, parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, round1(v)])), keywords: want.size, terms, missing, missingTerms: missTerms, issues };
}
