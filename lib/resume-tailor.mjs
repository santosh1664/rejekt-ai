/**
 * Per-job resume tailoring (docs/auto-apply.md).
 *
 * Tsenta rewrites the resume for every job; its "aggressive" mode also adds
 * skills from the posting that the person never listed. This module takes
 * the honest road by default:
 *
 *   - every role, title, company, date and bullet is kept: nothing is cut,
 *     nothing is renamed
 *   - inside each role, bullets that carry the posting's skills move up
 *   - projects and skill groups are reordered the same way
 *   - a skill the posting asks for is added to the skills list only when the
 *     resume already shows it somewhere (a bullet, a project's stack)
 *   - skills the posting wants that the resume doesn't show are reported as
 *     gaps, never inserted
 *
 * mode 'ai' then asks a language model to reword bullets toward the posting, and checks
 * every rewritten bullet: it must not introduce a skill the resume doesn't
 * show or a number the original bullet didn't have. A bullet that fails is
 * put back as it was. The model is a local Ollama model by default (lib/llm.mjs,
 * docs/resume-model.md). When it isn't reachable, 'ai' behaves like 'honest'.
 */
import { extractSkills } from './skill-extract.mjs';
import { normalizeSkillName } from './skills.mjs';
import { withDefaults } from './resume-profiles.mjs';
import { completeJSON } from './llm.mjs';
import { tailorResumeToMatch } from './resume-match.mjs';

export const TAILOR_MODES = ['off', 'honest', 'ai', 'match'];
// Sentences end at . ! or ? followed by a space and a capital letter or digit,
// so "rejekt.ai", "Node.js" and "3.5 years" stay inside their sentence.
export const splitSentences = text => String(text || '').trim().split(/(?<=[.!?])\s+(?=[A-Z0-9(“"])/).map(x => x.trim()).filter(Boolean);

export const TAILORED_SECTION_ORDER = ['summary', 'skills', 'experience', 'projects', 'education', 'certifications', 'custom'];
const WEIGHT = { REQUIRED: 3, PREFERRED: 2, MENTIONED: 1 };

const clone = v => JSON.parse(JSON.stringify(v));
const skillsIn = text => new Set(extractSkills(text || '').map(s => s.name));
/** Every skill one skills-list entry names: "AWS (ECS, EC2, S3)" is AWS, ECS, EC2 and S3, not just the whole string. */
export const itemSkills = item => {
  const names = new Set([normalizeSkillName(item), ...skillsIn(item)]);
  for (const n of [...names]) if (/[a-z]{4,}s$/.test(n)) names.add(n.slice(0, -1)); // "Vector Databases" also covers "vector database"
  return names;
};

/** Skills the posting asks for: name → { canonicalName, importance, weight }. */
export function jobSkillMap(job) {
  const text = [job.title, job.description].filter(Boolean).join('\n');
  const map = new Map();
  for (const s of extractSkills(text)) map.set(s.name, { canonicalName: s.canonicalName, importance: s.importance, weight: WEIGHT[s.importance] || 1 });
  for (const raw of job.skills || []) {
    const name = normalizeSkillName(typeof raw === 'string' ? raw : raw.name || raw.canonicalName || '');
    if (name && !map.has(name)) map.set(name, { canonicalName: typeof raw === 'string' ? raw : raw.canonicalName || raw.name, importance: raw.importance || 'MENTIONED', weight: WEIGHT[raw.importance] || 1 });
  }
  return map;
}

/** Everything the resume shows: listed skills plus skills named in its text. */
export function resumeEvidence(sections) {
  const s = withDefaults(sections);
  const listed = new Set();
  for (const g of s.skills) { for (const n of itemSkills(g.group)) listed.add(n); for (const item of g.items) for (const n of itemSkills(item)) listed.add(n); }
  const shown = new Set(listed);
  const texts = [
    s.summary,
    ...s.experience.flatMap(e => [e.title, ...(e.bullets || [])]),
    ...s.projects.flatMap(p => [p.name, ...(p.technologies || []), ...(p.bullets || [])]),
    ...s.certifications.map(c => c.name),
    ...s.custom.map(c => c.body),
  ];
  for (const name of skillsIn(texts.join('\n'))) shown.add(name);
  for (const p of s.projects) for (const t of p.technologies || []) shown.add(normalizeSkillName(t));
  return { listed, shown };
}

function scoreText(text, jobSkills) {
  let score = 0; const hits = [];
  for (const name of skillsIn(text)) {
    const js = jobSkills.get(name);
    if (js) { score += js.weight; hits.push(js.canonicalName); }
  }
  return { score, hits };
}

/** Stable sort by score, highest first. */
function rankBy(items, scoreOf) {
  return items.map((item, i) => ({ item, i, score: scoreOf(item) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(x => x.item);
}

/** How many of the posting's skills sit in the first two bullets of each role. */
function prominence(experience, jobSkills) {
  const seen = new Set();
  for (const e of experience) for (const b of (e.bullets || []).slice(0, 2)) for (const n of skillsIn(b)) if (jobSkills.has(n)) seen.add(n);
  return seen.size;
}

/**
 * Tailor a profile's sections to one job. Pure and synchronous (mode 'ai'
 * goes through tailorResumeWithAI). Returns { sections, sectionOrder, report }.
 */
export function tailorResume(sections, job, { mode = 'honest' } = {}) {
  const base = withDefaults(clone(sections));
  const jobSkills = jobSkillMap(job);
  const { listed, shown } = resumeEvidence(base);
  const matched = [...jobSkills.entries()].filter(([n]) => shown.has(n));
  const missing = [...jobSkills.entries()].filter(([n]) => !shown.has(n));
  const report = {
    mode,
    jobSkills: jobSkills.size,
    matched: matched.map(([, v]) => v.canonicalName),
    missingRequired: missing.filter(([, v]) => v.importance === 'REQUIRED').map(([, v]) => v.canonicalName),
    missingPreferred: missing.filter(([, v]) => v.importance !== 'REQUIRED').map(([, v]) => v.canonicalName),
    coverage: jobSkills.size ? Math.round(100 * matched.length / jobSkills.size) : null,
    addedToSkills: [], bulletsMoved: 0, rewrittenBullets: 0, revertedBullets: [],
    prominenceBefore: prominence(base.experience, jobSkills), prominenceAfter: null,
  };
  if (mode === 'off' || !jobSkills.size) {
    report.prominenceAfter = report.prominenceBefore;
    return { sections: base, sectionOrder: null, report };
  }

  const out = clone(base);
  // Experience: roles stay in date order; bullets inside each role are ranked.
  for (const e of out.experience) {
    const before = e.bullets || [];
    e.bullets = rankBy(before, b => scoreText(b, jobSkills).score);
    report.bulletsMoved += e.bullets.filter((b, i) => b !== before[i]).length;
  }
  // Projects: most relevant first, bullets ranked the same way.
  out.projects = rankBy(out.projects, p => scoreText([p.name, ...(p.technologies || []), ...(p.bullets || [])].join('\n'), jobSkills).score);
  for (const p of out.projects) p.bullets = rankBy(p.bullets || [], b => scoreText(b, jobSkills).score);

  // Skills: matched items first in each group, groups with more matches first.
  const isMatch = item => [...itemSkills(item)].some(n => jobSkills.has(n));
  for (const g of out.skills) g.items = rankBy(g.items, item => (isMatch(item) ? 1 : 0));
  // Skills the posting wants that the resume shows in its text but doesn't list.
  const unlisted = matched.filter(([n]) => !listed.has(n)).map(([, v]) => v.canonicalName);
  if (unlisted.length) {
    out.skills.push({ group: 'Also used', items: unlisted });
    report.addedToSkills = unlisted;
  }
  out.skills = rankBy(out.skills, g => g.items.filter(isMatch).length);

  // Summary: same sentences, the most relevant one first.
  if (out.summary) {
    const sentences = splitSentences(out.summary);
    if (sentences.length > 1) {
      const ranked = rankBy(sentences.slice(1), x => scoreText(x, jobSkills).score);
      out.summary = [sentences[0], ...ranked].join(' ');
    }
  }

  report.prominenceAfter = prominence(out.experience, jobSkills);
  return { sections: out, sectionOrder: TAILORED_SECTION_ORDER, report };
}

// ─── AI rewording (optional) ────────────────────────────────────────────────

const NUM_RE = /\d+(?:[.,]\d+)?\s*[%xkKmM+]?/g;
const numbersIn = s => new Set((String(s).match(NUM_RE) || []).map(n => n.replace(/\s+/g, '').toLowerCase()));

// Culture/buzzwords a rewrite must not add on its own (they carry no evidence); fine if the original already had them.
export const FILLER_RE = /\b(mindset|passion(?:ate)?|builder|results?-driven|self-starter|synerg\w*|next-generation|world-class|cutting-edge|innovati\w+|excellence|thought leader)\b/gi;
const words = s => new Set(String(s).toLowerCase().match(/[a-z0-9+#.]{3,}/g) || []);
/** Word-overlap (Jaccard) of two bullets; used to catch the same achievement written twice. */
export function bulletOverlap(a, b) {
  const x = words(a), y = words(b); let hit = 0;
  for (const w of x) if (y.has(w)) hit++;
  return hit / ((x.size + y.size - hit) || 1);
}

/**
 * Check one rewritten bullet against the original and the resume's evidence.
 * Returns null when it's acceptable, or the reason it isn't.
 */
export function checkRewrite(original, rewritten, shown) {
  if (typeof rewritten !== 'string' || !rewritten.trim()) return 'empty';
  if (rewritten.length > Math.max(400, original.length * 1.6)) return 'too long';
  const newSkills = [...skillsIn(rewritten)].filter(n => !shown.has(n));
  if (newSkills.length) return `adds skills the resume doesn't show: ${newSkills.join(', ')}`;
  const filler = [...new Set(rewritten.match(FILLER_RE) || [])].filter(w => !new RegExp(`\\b${w}`, 'i').test(original));
  if (filler.length) return `adds filler wording: ${filler.join(', ')}`;
  const origNums = numbersIn(original);
  const newNums = [...numbersIn(rewritten)].filter(n => !origNums.has(n));
  if (newNums.length) return `adds numbers the original didn't have: ${newNums.join(', ')}`;
  return null;
}

// The rewriter works one block at a time (a role's bullets, a project's
// bullets, or the summary). Small prompts suit a local 7B model, and the same
// format is what ml/export-rewriter-dataset.mjs writes for fine-tuning, so a
// fine-tuned model sees exactly what it was trained on.
export const REWRITER_SYSTEM = `You rewrite resume bullets so they speak to one job posting.
Strict rules:
- Return exactly as many bullets as you were given, in the same order.
- Keep each bullet's facts: the same work, tools and numbers. Never add a tool, language, framework, certification or number that the bullet does not already contain.
- You may use the posting's wording for things the bullet already says, lead with the most relevant part, and tighten wording.
- Do not add buzzwords or culture phrases from the posting (for example "builder mindset" or "passion for innovation"). Show fit through what the bullet actually did.
- Do not repeat a point or a number that another bullet already makes.
- Plain sentences. No markdown, no leading symbols, no first person.
Reply with JSON only: {"bullets": ["..."]}`;

export function postingBrief(job, jobSkills = jobSkillMap(job)) {
  const skills = [...jobSkills.values()].map(v => `${v.canonicalName}${v.importance === 'REQUIRED' ? ' (required)' : ''}`);
  return `Posting: ${job.title || ''}${job.company ? ` at ${job.company}` : ''}
Skills it asks for: ${skills.join(', ') || 'none listed'}
Posting text (shortened):
${String(job.description || '').replace(/\s+/g, ' ').slice(0, 3500)}`;
}

/** The user prompt for one block. kind: 'role' | 'project' | 'summary'. */
export function blockPrompt(job, block, jobSkills) {
  const head = block.kind === 'role' ? `Role: ${block.title || ''} at ${block.company || ''}`
    : block.kind === 'project' ? `Project: ${block.name || ''}` : 'Resume summary (each sentence is one bullet)';
  return `${postingBrief(job, jobSkills)}

${head}
Bullets:
${JSON.stringify(block.bullets)}`;
}



/**
 * Tailor, then have the language model (lib/llm.mjs: a local Ollama model by
 * default) reword each block toward the posting. Every rewritten bullet goes
 * through checkRewrite(); one that adds a skill or number the resume doesn't
 * show keeps its original wording. Titles, companies and dates are never sent
 * for rewriting, so they can't change.
 * opts: { complete } — injectable for tests (defaults to completeJSON).
 */
export async function tailorResumeWithAI(sections, job, opts = {}) {
  const result = tailorResume(sections, job, { mode: 'honest' });
  const complete = opts.complete || completeJSON;
  const jobSkills = jobSkillMap(job);
  const { shown } = resumeEvidence(result.sections);
  const out = result.sections;
  const blocks = [
    ...out.experience.map((e, i) => ({ kind: 'role', i, title: e.title, company: e.company, bullets: e.bullets || [] })),
    ...out.projects.map((p, i) => ({ kind: 'project', i, name: p.name, bullets: p.bullets || [] })),
  ];
  if (out.summary) blocks.push({ kind: 'summary', bullets: splitSentences(out.summary) });

  let model = null; let failures = 0; let firstError = null;
  for (const block of blocks) {
    if (!block.bullets.length) continue;
    let reply;
    try {
      const r = await complete({ system: REWRITER_SYSTEM, prompt: blockPrompt(job, block, jobSkills) }, opts.llm || {});
      reply = r.json; model = `${r.provider}:${r.model}`;
    } catch (err) {
      failures++; firstError ||= err.message;
      // Nothing reachable: stop early instead of timing out once per block.
      if (failures === 1 && /reachable|not pulled|not set|ECONNREFUSED/i.test(err.message)) break;
      continue;
    }
    const next = Array.isArray(reply?.bullets) ? reply.bullets : null;
    if (!next || next.length !== block.bullets.length) {
      result.report.revertedBullets.push({ original: block.kind === 'summary' ? 'summary' : (block.title || block.name || block.kind), reason: 'the model changed the number of bullets' });
      continue;
    }
    const kept = block.bullets.map((orig, j, all) => {
      const cand = typeof next[j] === 'string' ? next[j].replace(/^[\s•\-*]+/, '').trim() : '';
      let why = checkRewrite(orig, cand, shown);
      // a rewrite that now says what a different original bullet says is a duplicate
      if (!why && all.some((o, k) => k !== j && bulletOverlap(cand, o) >= 0.7 && bulletOverlap(cand, o) > bulletOverlap(orig, o) + 0.15)) why = 'duplicates another bullet';
      if (why) { result.report.revertedBullets.push({ original: orig, reason: why }); return orig; }
      if (cand !== orig) result.report.rewrittenBullets++;
      return cand;
    });
    // Kept for training data (ml/export-rewriter-dataset.mjs): what went in and what was kept.
    (result.report.blocks ||= []).push({ kind: block.kind, title: block.title, company: block.company, name: block.name, input: block.bullets, output: kept });
    if (block.kind === 'role') out.experience[block.i].bullets = kept;
    else if (block.kind === 'project') out.projects[block.i].bullets = kept;
    else out.summary = kept.join(' ');
  }
  if (!model) {
    result.report.mode = 'honest';
    result.report.aiSkipped = `The rewriting model wasn't used: ${firstError || 'no response'}`;
    return result;
  }
  result.report.mode = 'ai';
  result.report.model = model;
  if (failures) result.report.aiPartial = `${failures} block${failures === 1 ? '' : 's'} kept as reordered (${firstError})`;
  result.report.prominenceAfter = prominence(out.experience, jobSkills);
  return result;
}

/** Entry point used by the API and auto-apply. */
export async function tailorForJob(sections, job, mode = 'honest', opts = {}) {
  if (!TAILOR_MODES.includes(mode)) mode = 'honest';
  if (mode === 'match') return tailorResumeToMatch(sections, job, opts);
  return mode === 'ai' ? tailorResumeWithAI(sections, job, opts) : tailorResume(sections, job, { mode });
}

/**
 * Skills a sent resume claims that the person's own profile doesn't show
 * anywhere (skills list, bullets, project stacks). Used to flag resumes
 * written elsewhere, such as Tsenta's "optimized" ones.
 * Returns the claimed names as written in the resume.
 */
export function unsupportedClaims(sentSections, profileSections) {
  const sent = withDefaults(sentSections); const prof = withDefaults(profileSections);
  const { shown } = resumeEvidence(prof);
  // Anything the profile literally mentions counts too, so names outside the
  // skill taxonomy ("Spring Security", "JUnit/Mockito") aren't flagged.
  const profText = ` ${[prof.summary, ...prof.skills.flatMap(g => g.items), ...prof.experience.flatMap(e => [e.title, ...(e.bullets || [])]),
    ...prof.projects.flatMap(p => [p.name, ...(p.technologies || []), ...(p.bullets || [])]), ...prof.certifications.map(c => c.name)].join(' \n ').toLowerCase()} `;
  const mentioned = item => {
    const parts = String(item).toLowerCase().split(/\s*[/,]\s*|\s+\(|\)/).map(x => x.trim().replace(/s$/, '')).filter(x => x.length >= 2);
    const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Short names ("Go", "R", "C#") must stand alone; longer ones can sit inside other words ("JUnit/Mockito").
    return parts.length > 0 && parts.every(x => (x.length <= 3 ? new RegExp(`(^|[^a-z0-9])${esc(x)}([^a-z0-9]|$)`).test(profText) : profText.includes(x)));
  };
  const out = new Map();
  for (const g of sent.skills) for (const item of g.items) {
    const n = normalizeSkillName(item);
    if (n && !shown.has(n) && !mentioned(item)) out.set(n, item);
  }
  const text = [sent.summary, ...sent.experience.flatMap(e => e.bullets || []), ...sent.projects.flatMap(p => [...(p.technologies || []), ...(p.bullets || [])])].join('\n');
  for (const s of extractSkills(text)) if (!shown.has(s.name) && !out.has(s.name) && !mentioned(s.canonicalName)) out.set(s.name, s.canonicalName);
  return [...out.values()];
}
