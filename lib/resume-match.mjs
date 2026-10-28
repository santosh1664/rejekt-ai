/**
 * "Match the job": tailor a resume to a posting the way a resume writer (and
 * Tsenta) does it. See docs/resume-model.md for the analysis of the 20
 * resumes Tsenta sent that this is modeled on.
 *
 * What Tsenta did, measured on those 20 resumes against their postings:
 *   - Employers, job titles, dates and education never change.
 *   - ~73% of bullets stay word for word. ~13% are edited, mostly by extending
 *     the bullet with a clause in the posting's language (82% of the words
 *     added come from the posting). ~14% are new bullets, mostly in the
 *     current role (33 of 41), written in the same voice with tools and
 *     outcomes from the posting.
 *   - The skills section gets the posting's tools added to the matching
 *     groups (10–24 per resume when the posting lists tools).
 *   - The summary is rewritten for the role; data and analytics roles get the
 *     skills section moved above experience.
 *
 * This module does the same: skills and section order deterministically, and
 * the bullet and summary rewriting with the language model (lib/llm.mjs; a
 * local Ollama model by default). Without a model it still adds the skills
 * and reorders. Titles, companies and dates are never sent to the model.
 */
import { completeJSON } from './llm.mjs';
import { tailorResume, jobSkillMap, resumeEvidence, postingBrief, checkRewrite, itemSkills } from './resume-tailor.mjs';
import { extractSkills } from './skill-extract.mjs';
import { normalizeSkillName, mentions } from './skills.mjs';
import { withDefaults } from './resume-profiles.mjs';
import { pickFromBank, overlap } from './bullet-bank.mjs';
import { postingTerms } from './ats-score.mjs';

const clone = v => JSON.parse(JSON.stringify(v));
const NUM_RE = /\d+(?:[.,]\d+)?\s*[%xkKmM+]?/g;
const numbersIn = s => (String(s).match(NUM_RE) || []).map(n => n.replace(/\s+/g, '').toLowerCase());

const SOFT = /^(communication|collaboration|problem[- ]solving|problem decomposition|teamwork|leadership|ownership|curiosity|adaptability|attention to detail|analytical skills?|critical thinking|strategic thinking|stakeholder management|teaching|mentoring|self[- ]organi[sz]ation|product[- ]mindedness|high standards.*|aesthetic.*|cross-functional.*|self-starter|time management|.*\bexperience|.*\bmindset|.*\bskills)$/i;
const ACRONYMS = new Set(['json', 'yaml', 'xml', 'sql', 'nosql', 'api', 'apis', 'rest', 'aws', 'gcp', 'etl', 'elt', 'ci', 'cd', 'siem', 'sso', 'jwt', 'oauth', 'llm', 'llms', 'rag', 'ml', 'ai', 'ui', 'ux', 'sdk', 'iot', 'erp', 'crm', 'bi', 'kpi', 'html', 'css', 'http', 'tcp', 'dns', 'vpc', 'iam', 'ec2', 's3', 'rds', 'sqs', 'sns', 'eks', 'ecs', 'gpu', 'cpu', 'os', 'saas', 'pci', 'soc', 'hipaa', 'mlops', 'devops', 'ios']);
const SMALL = new Set(['as', 'of', 'and', 'or', 'with', 'for', 'to', 'in', 'on', 'the', 'a']);
const GROUP_FOR = {
  PROGRAMMING_LANGUAGES: 'Languages', BACKEND: 'Frameworks & Libraries', WEB_FRONTEND: 'Frameworks & Libraries',
  DATABASES: 'Databases', CLOUD: 'Cloud & DevOps', DEVOPS: 'Cloud & DevOps', INFRASTRUCTURE: 'Cloud & DevOps', OBSERVABILITY: 'Cloud & DevOps', NETWORKING: 'Cloud & DevOps',
  DATA_ENGINEERING: 'Data', BI_ANALYTICS: 'Data', MESSAGING: 'Frameworks & Libraries', ML_AI: 'AI/ML', QA_TESTING: 'Testing',
  SECURITY: 'Security', SOURCE_CONTROL: 'Tools', PROJECT_TOOLS: 'Tools', BUSINESS_OPERATIONS: 'Tools', INDUSTRIAL: 'Tools',
};
const DATA_ROLE = /\b(data|analytics?|analyst|bi|business intelligence|scientist|machine learning|ml)\b/i;

/** Skills the posting names: taxonomy matches plus the posting's own tags. */
export function postingSkills(job) {
  const out = new Map();
  for (const s of extractSkills([job.title, job.description].filter(Boolean).join('\n'))) out.set(s.name, { name: s.canonicalName, category: s.category, importance: s.importance });
  for (const raw of job.skills || []) {
    const label = typeof raw === 'string' ? raw : raw.canonicalName || raw.name;
    if (!label || SOFT.test(label.trim()) || label.length > 40) continue;
    const n = normalizeSkillName(label);
    if (n && !out.has(n)) {
      const known = extractSkills(label)[0];
      out.set(n, { name: known?.canonicalName || prettyTag(label), category: known?.category || null, importance: raw.importance || 'MENTIONED' });
    }
  }
  return out;
}
const prettyTag = t => (/[A-Z]/.test(t) ? t : t.replace(/[a-z0-9]+/g, (w, i) => (ACRONYMS.has(w) ? w.toUpperCase() : w === 'devops' ? 'DevOps' : SMALL.has(w) && i > 0 ? w : w[0].toUpperCase() + w.slice(1))));

/**
 * Put the posting's skills into the resume's skills section, in the group
 * that fits (an existing group holding the same kind of skill, else a new
 * one). Returns the names added. Max `limit` additions; required first.
 */
export function addPostingSkills(sections, job, { limit = 15, allow = () => true, gaps = [] } = {}) {
  const s = sections; const listed = new Set(s.skills.flatMap(g => [g.group, ...g.items].flatMap(i => [...itemSkills(i)])));
  const groupCategory = new Map(s.skills.map(g => {
    const cats = {}; for (const item of g.items) { const c = extractSkills(item)[0]?.category; if (c) cats[c] = (cats[c] || 0) + 1; }
    return [g, cats];
  }));
  const rank = { REQUIRED: 0, PREFERRED: 1, MENTIONED: 2 };
  const seenNames = new Set(s.skills.flatMap(g => g.items.map(x => x.toLowerCase())));
  const wanted = [...postingSkills(job).entries()].filter(([n, sk]) => !listed.has(n) && (allow(n, sk) || (gaps.push(sk.name), false)) && !seenNames.has(sk.name.toLowerCase()) && (seenNames.add(sk.name.toLowerCase()), true)).sort((a, b) => (rank[a[1].importance] ?? 2) - (rank[b[1].importance] ?? 2)).slice(0, limit);
  const added = [];
  for (const [n, sk] of wanted) {
    let target = null;
    if (sk.category) {
      let best = 0;
      for (const [g, cats] of groupCategory) if ((cats[sk.category] || 0) > best) { best = cats[sk.category]; target = g; }
      if (!target) {
        const name = GROUP_FOR[sk.category] || 'Tools';
        target = s.skills.find(g => g.group.toLowerCase() === name.toLowerCase());
        if (!target) { target = { group: name, items: [] }; s.skills.push(target); groupCategory.set(target, { [sk.category]: 1 }); }
      }
    } else {
      target = s.skills.find(g => /tool|other|additional/i.test(g.group)) || s.skills.at(-1);
      if (!target) { target = { group: 'Tools', items: [] }; s.skills.push(target); }
    }
    target.items.push(sk.name); listed.add(n); added.push(sk.name);
  }
  return added;
}

export const MATCH_SYSTEM = `You are a professional resume writer tailoring one section of a resume to a job posting.
You receive the posting, one role (or project) and its bullets.
Return JSON: {"bullets": [...], "added": [...]}
- "bullets": the same bullets, same count, same order. Rewrite at most the number of bullets you are told to; leave every other bullet exactly as given. Rewrite a bullet by tightening it and working in the posting's tools, terms and responsibilities, usually by ending it with a clause in the posting's language (who it served, what it enabled), or by rephrasing it toward the posting. Use present tense for a current role. Each rewritten bullet must still describe the same work as the original, with the tools it names; never replace a bullet with different work (put new work in "added"). You may drop a metric that doesn't help this posting, but never add or change a number.
- "added": new bullets (no more than you are told) about work in this role that the posting asks for. Write them like the existing bullets: start with a strong past-tense verb (present tense for a current role), one sentence, concrete tools and the result, believable for this role at this company. Only include a number if it is modest and consistent with the rest of the resume.
- Use the posting's exact words for things the bullet already shows ("LLM workflows with retrieval" becomes "RAG pipelines and LLM orchestration" when the posting says RAG). The first bullet should carry the posting's most important keyword the role supports.
- When you extend a bullet, the clause must say something concrete in the posting's terms. Never add vague endings like "enhancing user experience", "streamlining the process" or "providing actionable insights". Never copy sentences from the posting or name the company you are applying to.
- Start bullets with different verbs. Prefer plain verbs (built, ran, cut, led, used) and name the tool.
- Never use: leveraged, spearheaded, facilitated, robust, seamless, cutting-edge, innovative, synergy, passionate, results-oriented, proven track record, best practices, utilize.
- Only name tools, languages and frameworks that appear in the bullets you were given. If the posting asks for a tool the work doesn't show, leave it out.
- No first person, no markdown, no bullet symbols. Do not mention the posting or the company you are applying to.
Example: "Built REST APIs in Spring Boot for payment workflows." for a data engineering posting becomes "Built REST APIs in Spring Boot for payment workflows, feeding validated events into ETL pipelines that land data in the warehouse."`;

// Cliché words (career-ops modes/_writing.md). A rewrite that brings one in is refused.
export const BANNED_WORDS = /\b(leverag(e|ed|es|ing)|spearhead(ed|ing|s)?|facilitat(e|ed|es|ing)|robust|seamless(ly)?|cutting-edge|innovative|synerg(y|ies)|passionate|results-oriented|proven track record|best practices|utiliz(e|ed|es|ing))\b/i;

/** Few-shot: real before → after pairs from this person's own history (lib/rewriter-dataset.mjs pickStyleExamples). */
export function withStyleExamples(system, ex) {
  if (!ex || (!ex.edits?.length && !ex.added?.length)) return system;
  const lines = ['', 'Examples from earlier tailoring of this same resume (follow this style):'];
  for (const e of ex.edits || []) lines.push(`For a ${e.job || 'similar'} posting:\n  Before: ${e.before}\n  After: ${e.after}`);
  for (const a of ex.added || []) lines.push(`A bullet added for a ${a.job || 'similar'} posting: ${a.after}`);
  return system + '\n' + lines.join('\n');
}

export function matchBlockPrompt(job, block, { edit, add }, jobSkills = jobSkillMap(job)) {
  const head = block.kind === 'role' ? `Role: ${block.title || ''} at ${block.company || ''}${block.current ? ' (current role)' : ''}` : `Project: ${block.name || ''}`;
  const terms = postingTerms(job, 10);
  return `${postingBrief(job, jobSkills)}
${terms.length ? `Key terms of this posting (use the ones this work supports, in the posting's wording): ${terms.join(', ')}\n` : ''}
${head}
Rewrite at most ${edit} bullet${edit === 1 ? '' : 's'}. Add at most ${add} new bullet${add === 1 ? '' : 's'}.
Bullets:
${JSON.stringify(block.bullets)}`;
}

export const SUMMARY_SYSTEM = `You are a professional resume writer. Rewrite the resume summary for one job posting.
- 3 or 4 sentences, 70 to 110 words. Open with the person's professional title exactly as given, then their years of experience exactly as given.
- Lead with the experience most relevant to the posting and use the posting's language and tools. Work in the posting's top 5 keywords that the resume supports. It should answer: what role is this person targeting, and what proves they fit?
- Never use: leveraged, spearheaded, robust, seamless, cutting-edge, innovative, passionate, results-oriented, proven track record, best practices.
- If a degree is given, you may end with it (for example "Holds an M.S. in Computer Science.").
- No first person, no markdown, no company name of the posting.
Return JSON: {"summary": "..."}`;

export function summaryPrompt(job, { title, years, summary, highlights, degree, keywords }, jobSkills = jobSkillMap(job)) {
  return `${postingBrief(job, jobSkills)}
${keywords?.length ? `Name these posting keywords (all are on the resume): ${keywords.join(', ')}\n` : ''}
Professional title: ${title}
Years of experience: ${years}${degree ? `\nDegree: ${degree}` : ''}
Current summary: ${summary || '(none)'}
Strongest points from the resume: ${JSON.stringify(highlights)}`;
}

/**
 * How many bullets to rewrite and add per block, following how you tailored
 * your own resume: every bullet is reworded, a few earlier bullets come back
 * from the bullet bank (`bank`), and the model writes at most one new one.
 */
export function blockBudget(kind, index, bulletCount) {
  if (kind === 'role') return { edit: bulletCount, add: index <= 1 ? 1 : 0, bank: index === 0 ? 2 : index === 1 ? 4 : 1 };
  return { edit: bulletCount, add: 0, bank: index === 0 ? 1 : 0 };
}

/** Check one block's reply. Returns { bullets, added, edited, problems }. */
export function acceptMatchReply(original, reply, { edit, add }) {
  const problems = [];
  const out = [...original]; let edited = 0;
  const next = Array.isArray(reply?.bullets) ? reply.bullets : null;
  if (!next || next.length !== original.length) problems.push('the model changed the number of bullets');
  else {
    next.forEach((cand, i) => {
      const c = typeof cand === 'string' ? cand.replace(/^[\s•\-*]+/, '').trim() : '';
      if (!c || c === original[i]) return;
      if (edited >= edit) return;                                  // over budget: keep the original
      // Dropping a metric is fine (you did it too); adding or changing one is not.
      const had = numbersIn(original[i]).map(n => n.replace(/[^0-9.]/g, ''));
      const fresh = numbersIn(c).filter(n => !had.includes(n.replace(/[^0-9.]/g, '')) && !sameAmount(n, had));
      if (fresh.length) { problems.push(`a rewrite added the number ${fresh.join(', ')}`); return; }
      if (c.length > Math.max(450, original[i].length * 1.9)) { problems.push('a rewrite was too long'); return; }
      // A rewrite must still describe the same work: you reword and extend, you
      // don't swap a bullet for a different one. (Your own edits keep at least
      // 19% of the words; the model's replacements kept 7–11%.)
      const same = overlap(original[i], c);
      const tools = extractSkills(original[i]).map(s => s.name);
      const keptTool = !tools.length || extractSkills(c).some(s => tools.includes(s.name));
      if (same < 0.15 || (same < 0.25 && !keptTool)) { problems.push('a rewrite replaced a bullet with different work, so the original was kept'); return; }
      if (/^(i|my|we)\b/i.test(c)) { problems.push('a rewrite used first person'); return; }
      if (BANNED_WORDS.test(c) && !BANNED_WORDS.test(original[i])) { problems.push(`a rewrite used "${c.match(BANNED_WORDS)[0]}"`); return; }
      out[i] = c; edited++;
    });
  }
  const added = (Array.isArray(reply?.added) ? reply.added : [])
    .map(x => (typeof x === 'string' ? x.replace(/^[\s•\-*]+/, '').trim() : ''))
    .filter(x => x.length >= 30 && x.length <= 340 && !/^(i|my|we)\b/i.test(x) && !BANNED_WORDS.test(x) && !original.includes(x))
    .slice(0, add);
  return { bullets: out, added, edited, problems };
}

// 115,600 and 115.6K are the same number written two ways.
function sameAmount(n, had) {
  const v = x => { const m = String(x).toLowerCase().replace(/,/g, '').match(/^([0-9.]+)\s*([km]?)/); return m ? +m[1] * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1) : NaN; };
  const a = v(n); return had.some(h => Math.abs(v(h) - a) <= Math.max(1, a * 0.01));
}

/**
 * Posting text copied into the resume: the posting company's name, or 6+ words
 * in a row taken from the posting ("identifying and classifying behavioral
 * patterns of medical professionals"). Rewording toward the posting is the
 * goal; pasting its sentences in as your own work is not.
 */
export function copiesPosting(text, job) {
  const t = String(text || '').toLowerCase();
  const company = String(job.company || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim();
  if (company.length >= 3 && new RegExp(`\\b${company.replace(/\s+/g, '\\s+')}\\b`).test(t.replace(/[^a-z0-9 ]+/g, ' '))) return `names ${job.company}`;
  const toks = s => String(s || '').toLowerCase().match(/[a-z0-9+#]+/g) || [];
  const post = toks(job.description); const grams = new Set();
  for (let i = 0; i + 6 <= post.length; i++) grams.add(post.slice(i, i + 6).join(' '));
  const w = toks(t);
  for (let i = 0; i + 6 <= w.length; i++) { const g = w.slice(i, i + 6).join(' '); if (grams.has(g)) return `copies "${g}" from the posting`; }
  return null;
}

// ─── Polish: the same small fixes whichever model wrote the text ─────────────

// Clichés (career-ops modes/_writing.md) swapped for plain words, keeping case.
const SWAPS = [
  [/\bleverag(e|es|ed|ing)\b/gi, { e: 'use', es: 'uses', ed: 'used', ing: 'using' }],
  [/\butiliz(e|es|ed|ing)\b/gi, { e: 'use', es: 'uses', ed: 'used', ing: 'using' }],
  [/\bspearhead(|s|ed|ing)\b/gi, { '': 'lead', s: 'leads', ed: 'led', ing: 'leading' }],
  [/\bfacilitat(e|es|ed|ing)\b/gi, { e: 'support', es: 'supports', ed: 'supported', ing: 'supporting' }],
];
const WORDS = [[/\brobust\b/gi, 'reliable'], [/\bseamlessly\b/gi, 'smoothly'], [/\bseamless\b/gi, 'smooth'], [/\bcutting-edge\b/gi, 'modern'], [/\binnovative\b/gi, 'new'], [/\bbest practices\b/gi, 'established practices']];
const keepCase = (src, word) => (src[0] === src[0].toUpperCase() ? word[0].toUpperCase() + word.slice(1) : word);
export function plainWords(text) {
  let t = String(text || '');
  for (const [re, map] of SWAPS) t = t.replace(re, (m, suf) => keepCase(m, map[suf.toLowerCase()]));
  for (const [re, w] of WORDS) t = t.replace(re, m => keepCase(m, w));
  return t.replace(/\ba reliable\b/g, 'a reliable').replace(/\ban (reliable|new|modern|smooth)\b/gi, (m, w) => `${m[0]} ${w}`);
}

/**
 * Put each role's best-matching bullet first (an ATS and a recruiter read the
 * first bullet of a role most), and make sure the summary names the posting's
 * top keywords the resume supports. Nothing is added that isn't already on
 * the resume, and no bullet is removed.
 */
export function polishForPosting(out, job, jobSkills, supported) {
  const changes = { clichés: 0, firstBullets: 0, summaryKeywords: [] };
  const fix = x => { const y = plainWords(x); if (y !== x) changes.clichés++; return y; };
  out.summary = out.summary ? fix(out.summary) : out.summary;
  for (const block of [...out.experience, ...out.projects]) block.bullets = (block.bullets || []).map(fix);
  const hits = b => extractSkills(b).filter(s => jobSkills.has(s.name)).length;
  for (const e of out.experience) {
    const b = e.bullets || [];
    if (b.length < 2 || hits(b[0])) continue;
    let best = -1; let bestHits = 0;
    b.forEach((x, i) => { const h = hits(x); if (h > bestHits) { bestHits = h; best = i; } });
    if (best > 0) { e.bullets = [b[best], ...b.filter((_, i) => i !== best)]; changes.firstBullets++; }
  }
  const W = { REQUIRED: 3, PREFERRED: 2, MENTIONED: 1 };
  const top = [...jobSkills.entries()].filter(([n]) => supported.has(n)).sort((a, b) => (W[b[1].importance] || 1) - (W[a[1].importance] || 1)).slice(0, 5);
  if (out.summary && top.length) {
    const inSum = new Set(extractSkills(out.summary).map(s => s.name));
    const missing = top.filter(([n]) => !inSum.has(n)).map(([, v]) => v.canonicalName);
    const need = Math.min(3, top.length) - (top.length - missing.length);
    const words = out.summary.split(/\s+/).length;
    if (need > 0 && words < 118) {
      const add = missing.slice(0, Math.max(need, Math.min(missing.length, 4)));
      const list = add.length > 1 ? `${add.slice(0, -1).join(', ')} and ${add.at(-1)}` : add[0];
      out.summary = `${out.summary.replace(/\s+$/, '')} Hands-on with ${list}.`;
      changes.summaryKeywords = add;
    }
  }
  return changes;
}

function degreeLine(sections) {
  const ed = withDefaults(sections).education[0];
  if (!ed) return null;
  return [ed.degree, ed.field && !String(ed.degree || '').toLowerCase().includes(String(ed.field).toLowerCase()) ? `in ${ed.field}` : ''].filter(Boolean).join(' ') || null;
}

function yearsPhrase(summary, sections) {
  const m = String(summary || '').match(/\d+(?:\.\d+)?\+?\s+years?/i);
  if (m) return m[0];
  const exp = withDefaults(sections).experience;
  const first = exp.map(e => e.startDate).filter(Boolean).sort()[0];
  if (!first) return null;
  const yrs = Math.max(1, Math.floor((Date.now() - new Date(`${first}-01`).getTime()) / 3.156e10));
  return `${yrs}+ years`;
}

/**
 * Tailor `sections` to `job` (title, company, description, skills[]).
 * opts: { complete, llm } — the model call is injectable for tests.
 * Returns { sections, sectionOrder, report } like tailorResume().
 */
export async function tailorResumeToMatch(sections, job, opts = {}) {
  const base = tailorResume(sections, job, { mode: 'honest' });
  const out = clone(base.sections);
  const jobSkills = jobSkillMap(job);
  const before = resumeEvidence(withDefaults(sections)).shown;
  const report = {
    ...base.report, mode: 'match', editedBullets: 0, addedBullets: [], addedSkills: [], problems: [], blocks: [],
  };

  // 1. Skills from the posting into the right groups.
  // Only skills the resume already shows somewhere (bullets, projects, stacks) are listed; the rest are gaps, never claims.
  const profText = JSON.stringify(withDefaults(sections)).toLowerCase();
  const supported = (n, sk) => before.has(n) || mentions(profText, sk.name);
  const gaps = [];
  report.addedSkills = addPostingSkills(out, job, { allow: supported, gaps });
  report.gaps = gaps;

  // 2. Bullets and summary with the model.
  const complete = opts.complete || completeJSON;
  let model = null; let firstError = null;
  const ask = async (system, prompt) => {
    try { const r = await complete({ system, prompt, temperature: opts.temperature ?? 0.4 }, opts.llm || {}); model = `${r.provider}:${r.model}`; return r.json; }
    catch (err) { firstError ||= err.message; return null; }
  };
  const matchSystem = withStyleExamples(MATCH_SYSTEM, opts.styleExamples);
  const blocks = [
    ...out.experience.map((e, i) => ({ kind: 'role', i, title: e.title, company: e.company, current: !!e.current, bullets: e.bullets || [] })),
    ...out.projects.map((p, i) => ({ kind: 'project', i, name: p.name, bullets: p.bullets || [] })),
  ];
  for (const block of blocks) {
    if (!block.bullets.length) continue;
    const budget = blockBudget(block.kind, block.i, block.bullets.length);
    // Bullets you've written before for this role come back first (lib/bullet-bank.mjs).
    const fromBank = pickFromBank(opts.bank, block, job, budget.bank || 0).filter(b => extractSkills(b).every(x => before.has(x.name)));
    if (!budget.edit && !budget.add && !fromBank.length) continue;
    const blockPrompt = matchBlockPrompt(job, block, budget, jobSkills);
    const reply = (budget.edit || budget.add) && !(firstError && !model) ? await ask(matchSystem, blockPrompt) : null;
    // Extra new bullets are read so one refused below doesn't use up the slot.
    const r = reply ? acceptMatchReply(block.bullets, reply, { ...budget, add: budget.add ? budget.add + 2 : 0 }) : { bullets: [...block.bullets], added: [], edited: 0, problems: [] };
    // Rewrites and new bullets must not paste the posting in (copiesPosting), and a
    // new bullet may only name tools from your resume or the posting.
    r.bullets = r.bullets.map((b, i) => {
      if (b === block.bullets[i]) return b;
      const why = copiesPosting(b, job);
      if (why) { r.problems.push(`a rewrite ${why}, so the original was kept`); r.edited--; return block.bullets[i]; }
      const bad = checkRewrite(block.bullets[i], b, before);   // new skill or filler; number edits are handled in acceptMatchReply
      if (bad && !/numbers/.test(bad)) { r.problems.push(`a rewrite ${bad}, so the original was kept`); r.edited--; return block.bullets[i]; }
      return b;
    });
    r.added = r.added.filter(a => {
      const why = copiesPosting(a, job);
      if (why) { r.problems.push(`a new bullet ${why}, so it was dropped`); return false; }
      const foreign = extractSkills(a).filter(x => !before.has(x.name)).map(x => x.canonicalName || x.name);
      if (foreign.length) { r.problems.push(`a new bullet named ${foreign.join(', ')}, which your resume doesn't show, so it was dropped`); return false; }
      return true;
    }).slice(0, budget.add);
    r.added = [...fromBank.filter(b => !r.added.some(a => overlap(a, b) >= 0.45)), ...r.added];
    // A new bullet that already appears elsewhere in the resume is dropped.
    const everywhere = new Set([...out.experience.flatMap(e => e.bullets || []), ...out.projects.flatMap(x => x.bullets || [])].map(x => x.toLowerCase()));
    r.added = r.added.filter(a => !everywhere.has(a.toLowerCase()));
    report.problems.push(...r.problems);
    report.editedBullets += r.edited;
    // New bullets go right after the first two, where a reader looks.
    // A block never grows: a new bullet takes the place of an old one below the top two, and only
    // when it names more of the posting's skills than the bullet it replaces.
    const hitsOf = b => extractSkills(b).filter(x => jobSkills.has(x.name)).length;
    const room = r.bullets.map((b, i) => i).slice(2).sort((a, b) => hitsOf(r.bullets[a]) - hitsOf(r.bullets[b]) || b - a);
    const swaps = [];
    r.added = r.added.sort((a, b) => hitsOf(b) - hitsOf(a)).filter(a => { const k = room[swaps.length]; if (k !== undefined && hitsOf(a) > hitsOf(r.bullets[k])) { swaps.push(k); return true; } return false; });
    const drop = new Set(swaps);
    const merged = [...r.bullets.slice(0, 2), ...r.added, ...r.bullets.slice(2).filter((_, k) => !drop.has(k + 2))];
    if (block.kind === 'role') out.experience[block.i].bullets = merged; else out.projects[block.i].bullets = merged;
    for (const text of r.added) report.addedBullets.push({ where: block.kind === 'role' ? `${block.title}, ${block.company}` : block.name, text, from: fromBank.includes(text) ? 'bank' : 'model' });
    report.blocks.push({ kind: block.kind, title: block.title, company: block.company, name: block.name, current: block.current, budget, input: block.bullets, output: r.bullets, added: r.added, fromBank, ...(opts.recordPrompts ? { prompt: blockPrompt, modelAdded: r.added.filter(a => !fromBank.includes(a)) } : {}) });
  }
  if (model) {
    const title = out.experience[0]?.title || out.personal?.headline || 'Software Engineer';
    const years = yearsPhrase(out.summary, sections);
    const highlights = out.experience.flatMap(e => (e.bullets || []).slice(0, 2)).slice(0, 5);
    const W = { REQUIRED: 3, PREFERRED: 2, MENTIONED: 1 };
    const keywords = [...jobSkills.entries()].filter(([n]) => before.has(n)).sort((a, b) => (W[b[1].importance] || 1) - (W[a[1].importance] || 1)).slice(0, 5).map(([, v]) => v.canonicalName);
    const prompt = summaryPrompt(job, { title, years: years || 'not stated', summary: out.summary, highlights, degree: degreeLine(sections), keywords }, jobSkills);
    let reply = await ask(SUMMARY_SYSTEM, prompt);
    let s = typeof reply?.summary === 'string' ? reply.summary.trim() : '';
    // A summary that opens with the posting's title ("Data Scientist with 3+ years…")
    // gets your title back; one with a cliché or pasted posting text is asked for again.
    const fixTitle = x => (x && !x.slice(0, 90).toLowerCase().includes(title.toLowerCase()) ? x.replace(/^(?:an?\s+)?[A-Z][\w&/,.\- ]{1,60}?(?=\s+with\s+\d)/, title) : x);
    s = fixTitle(s);
    if (s && (BANNED_WORDS.test(s) || copiesPosting(s, job))) {
      reply = await ask(SUMMARY_SYSTEM, `${prompt}\n\nYour last summary was refused: ${BANNED_WORDS.test(s) ? `it used "${s.match(BANNED_WORDS)[0]}"` : copiesPosting(s, job)}. Write it again. Start with "${title} with ${years || ''}".`);
      const again = fixTitle(typeof reply?.summary === 'string' ? reply.summary.trim() : '');
      if (again && !BANNED_WORDS.test(again) && !copiesPosting(again, job)) s = again;
      else { report.problems.push('the summary rewrite used clichés or posting text, so the original was kept'); report.rejectedSummary = s.slice(0, 900); s = ''; }
    }
    // The title must appear near the start ("AI-focused Software Engineer with…" is fine)
    // and the years must be the same number.
    const unsupportedInSummary = s ? extractSkills(s).filter(x => !before.has(x.name)).map(x => x.canonicalName || x.name) : [];
    if (unsupportedInSummary.length) { report.problems.push(`the summary rewrite named ${unsupportedInSummary.join(', ')}, which your resume doesn't show, so the original was kept`); s = ''; }
    const head = s.slice(0, 90).toLowerCase();
    const yearsNum = years ? (years.match(/\d+(?:\.\d+)?\+?/) || [])[0] : null;
    if (s && s.length <= 900 && head.includes(title.toLowerCase()) && (!yearsNum || s.slice(0, 160).includes(yearsNum))) {
      report.blocks.push({ kind: 'summary', input: [out.summary || ''], output: [s], ...(opts.recordPrompts ? { prompt } : {}) });
      out.summary = s; report.summaryRewritten = true;
    } else if (s) { report.problems.push('the summary rewrite changed the title or years, so the original was kept'); report.rejectedSummary = s.slice(0, 900); }
  }

  // Polish: plain words instead of clichés, best-matching bullet first, top keywords in the summary.
  report.polish = polishForPosting(out, job, jobSkills, before);

  // 3. Section order: skills first for data and analytics roles, as Tsenta did.
  const sectionOrder = DATA_ROLE.test(job.title || '')
    ? ['summary', 'skills', 'experience', 'projects', 'education', 'certifications', 'custom']
    : ['summary', 'experience', 'skills', 'projects', 'education', 'certifications', 'custom'];

  const after = resumeEvidence(out).shown;
  const total = jobSkills.size;
  const covered = set => [...jobSkills.keys()].filter(n => set.has(n)).length;
  report.coverageBefore = total ? Math.round(100 * covered(before) / total) : null;
  report.coverage = total ? Math.round(100 * covered(after) / total) : null;
  report.notOnProfile = [...after].filter(n => !before.has(n) && jobSkills.has(n)).map(n => jobSkills.get(n).canonicalName);
  if (model) report.model = model;
  else report.aiSkipped = `The rewriting model wasn't used: ${firstError || 'no response'}. Skills were still added and the resume reordered`;
  report.prominenceAfter = null;
  return { sections: out, sectionOrder, report };
}
