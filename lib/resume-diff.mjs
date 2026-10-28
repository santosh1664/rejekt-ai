/**
 * What tailoring changed in a resume (docs/auto-apply.md, "What changed").
 *
 * diffResumes(before, after) compares the profile as it was when the resume
 * was tailored with the tailored version, and returns:
 *   changes  { "<path in after>": { type: 'edited' | 'added', original? } }
 *            paths like "summary", "experience.0.bullets.2", "skills.1.items.4"
 *   list     the same, readable: [{ type, where, text, original }]
 *   counts   { edited, added, skillsAdded, kept }
 *
 * Bullets are matched by wording, not position, because tailoring moves the
 * best-matching bullet to the top of each role.
 */
import { withDefaults } from './resume-profiles.mjs';
import { overlap } from './bullet-bank.mjs';

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

function diffBullets(before, after, base, where, out) {
  const left = before.map((t, i) => ({ t, i, used: false }));
  after.forEach((t, j) => {
    const path = `${base}.bullets.${j}`;
    const same = left.find(x => !x.used && x.t === t);
    if (same) { same.used = true; out.counts.kept++; return; }
    let best = null; let bestSim = 0;
    for (const x of left) { if (x.used) continue; const s = overlap(x.t, t); if (s > bestSim) { bestSim = s; best = x; } }
    if (best && bestSim >= 0.15) {
      best.used = true; out.counts.edited++;
      out.changes[path] = { type: 'edited', original: best.t };
      out.list.push({ type: 'edited', where, text: t, original: best.t });
    } else {
      out.counts.added++;
      out.changes[path] = { type: 'added' };
      out.list.push({ type: 'added', where, text: t });
    }
  });
}

export function diffResumes(beforeSections, afterSections) {
  const B = withDefaults(beforeSections || {}); const A = withDefaults(afterSections || {});
  const out = { changes: {}, list: [], counts: { edited: 0, added: 0, skillsAdded: 0, kept: 0 } };
  if (A.summary && A.summary !== B.summary) {
    out.changes.summary = B.summary ? { type: 'edited', original: B.summary } : { type: 'added' };
    out.list.push({ type: B.summary ? 'edited' : 'added', where: 'Summary', text: A.summary, original: B.summary || undefined });
    out.counts[B.summary ? 'edited' : 'added']++;
  }
  A.experience.forEach((e, i) => {
    const o = B.experience.find(x => norm(x.company) === norm(e.company) && norm(x.title) === norm(e.title))
      || B.experience.find(x => norm(x.company) === norm(e.company));
    diffBullets(o?.bullets || [], e.bullets || [], `experience.${i}`, [e.title, e.company].filter(Boolean).join(', '), out);
  });
  A.projects.forEach((p, i) => {
    const o = B.projects.find(x => norm(x.name) === norm(p.name)) || B.projects.find(x => norm(x.name).slice(0, 12) === norm(p.name).slice(0, 12));
    diffBullets(o?.bullets || [], p.bullets || [], `projects.${i}`, p.name, out);
  });
  const had = new Set(B.skills.flatMap(g => g.items.map(norm)));
  A.skills.forEach((g, gi) => g.items.forEach((item, ii) => {
    if (had.has(norm(item))) return;
    out.changes[`skills.${gi}.items.${ii}`] = { type: 'added' };
    out.counts.skillsAdded++;
    out.list.push({ type: 'skill', where: g.group || 'Skills', text: item });
  }));
  return out;
}
