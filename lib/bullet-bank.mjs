/**
 * Bullet bank: every bullet you've already written for each role and project,
 * collected from your resume profiles, the resumes Tsenta sent, and the
 * before/after examples you added (docs/resume-model.md).
 *
 * When you tailored your own resume (2026-10-23 example), most "new" bullets
 * weren't invented: they came back from earlier versions (Zensar went from 5
 * to 9 bullets that way). "Match the job" does the same: before asking the
 * model for anything new, it pulls the bank bullets that best fit the posting.
 */
import { withDefaults } from './resume-profiles.mjs';
import { jobSkillMap } from './resume-tailor.mjs';
import { extractSkills } from './skill-extract.mjs';

const words = s => new Set(String(s || '').toLowerCase().match(/[a-z][a-z0-9+#./-]{2,}/g) || []);
export function overlap(a, b) {
  const A = words(a); const B = words(b);
  if (!A.size || !B.size) return 0;
  let i = 0; for (const w of A) if (B.has(w)) i++;
  return i / (A.size + B.size - i);
}
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const sameOrg = (a, b) => { const x = norm(a); const y = norm(b); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)); };
const sameTitle = (a, b) => !a || !b || norm(a) === norm(b);
const projKey = name => norm(String(name || '').split(/[–—:-]/)[0]);

/** sources: resume sections (any shape withDefaults accepts). */
export function buildBank(sources) {
  const roles = []; const projects = [];
  const addTo = (list, match, make, bullets) => {
    let entry = list.find(match);
    if (!entry) { entry = make(); list.push(entry); }
    for (const b of bullets || []) {
      const t = String(b || '').trim();
      if (t.length < 30) continue;
      // Near-duplicates (the same bullet reworded) are kept once.
      if (entry.bullets.some(x => overlap(x, t) >= 0.6)) continue;
      entry.bullets.push(t);
    }
  };
  for (const src of sources) {
    if (!src) continue;
    const s = withDefaults(src);
    for (const e of s.experience) {
      addTo(roles, r => sameOrg(r.company, e.company) && sameTitle(r.title, e.title), () => ({ company: e.company, title: e.title, bullets: [] }), e.bullets);
    }
    for (const p of s.projects) addTo(projects, x => x.key === projKey(p.name), () => ({ key: projKey(p.name), name: p.name, bullets: [] }), p.bullets);
  }
  return { roles, projects };
}

/** Bank bullets for this role or project, best fit to the posting first. */
export function pickFromBank(bank, block, job, n) {
  if (!bank || n <= 0) return [];
  const pool = block.kind === 'role'
    ? bank.roles.filter(r => sameOrg(r.company, block.company) && sameTitle(r.title, block.title)).flatMap(r => r.bullets)
    : bank.projects.filter(p => p.key === projKey(block.name)).flatMap(p => p.bullets);
  if (!pool.length) return [];
  const jobSkills = jobSkillMap(job);
  const postingWords = words(`${job.title || ''} ${job.description || ''}`);
  const scored = pool
    .filter(b => !block.bullets.some(x => overlap(x, b) >= 0.45))
    .map(b => {
      const skillHits = extractSkills(b).filter(s => jobSkills.has(s.name)).length;
      const w = words(b); let hits = 0; for (const x of w) if (postingWords.has(x)) hits++;
      return { b, score: skillHits * 3 + hits / Math.max(4, w.size) * 4 };
    })
    .filter(x => x.score > 0.6)
    .sort((a, b) => b.score - a.score);
  const out = [];
  for (const { b } of scored) { if (out.length >= n) break; if (!out.some(x => overlap(x, b) >= 0.45)) out.push(b); }
  return out;
}
