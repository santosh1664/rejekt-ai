/**
 * Training examples for the resume-rewriting model (docs/resume-model.md).
 *
 * Each example is one block (a role's or project's bullets, or the summary)
 * in the exact chat format the app uses at run time (REWRITER_SYSTEM +
 * blockPrompt), so a model fine-tuned on these sees the same prompts later.
 *
 * Two sources:
 *  - Rewrites made here (resume_rewrites, mode 'ai'): report.blocks already
 *    holds what went in and what was kept after the fact check.
 *  - Resumes Tsenta sent (source 'tsenta'): there's no "before", so each
 *    Tsenta bullet is matched to the most similar bullet in your own profile
 *    (same company or project). A pair is kept only when the bullets clearly
 *    describe the same work and the rewrite passes checkRewrite(): no skill
 *    or number your profile doesn't show. Tsenta's invented bullets drop out.
 */
import { createHash } from 'node:crypto';
import { REWRITER_SYSTEM, blockPrompt, checkRewrite, resumeEvidence, jobSkillMap } from './resume-tailor.mjs';
import { withDefaults } from './resume-profiles.mjs';
import { MATCH_SYSTEM, SUMMARY_SYSTEM, matchBlockPrompt, summaryPrompt } from './resume-match.mjs';

const words = s => new Set(String(s || '').toLowerCase().match(/[a-z0-9+#.]{2,}/g) || []);
export function similarity(a, b) {
  const A = words(a); const B = words(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const sameOrg = (a, b) => { const x = norm(a); const y = norm(b); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)); };

function example(job, block, output, meta) {
  return {
    messages: [
      { role: 'system', content: REWRITER_SYSTEM },
      { role: 'user', content: blockPrompt(job, block, jobSkillMap(job)) },
      { role: 'assistant', content: JSON.stringify({ bullets: output }) },
    ],
    meta,
  };
}

/** Match a sent resume's bullets to the profile's. Returns blocks of {input, output}. */
export function alignToProfile(sent, profile, { minSimilarity = 0.3 } = {}) {
  const S = withDefaults(sent); const P = withDefaults(profile);
  const { shown } = resumeEvidence(P);
  const blocks = []; let considered = 0; let rejected = 0; let unmatched = 0;
  const pair = (sentBullets, profBullets, head) => {
    const input = []; const output = []; const used = new Set();
    for (const sb of sentBullets || []) {
      considered++;
      let best = -1; let bestSim = 0;
      (profBullets || []).forEach((pb, i) => { if (used.has(i)) return; const sim = similarity(sb, pb); if (sim > bestSim) { bestSim = sim; best = i; } });
      if (best < 0 || bestSim < minSimilarity) { unmatched++; continue; }
      const orig = profBullets[best];
      if (checkRewrite(orig, sb, shown)) { rejected++; continue; }
      used.add(best); input.push(orig); output.push(sb.trim());
    }
    if (input.length && output.some((o, i) => o !== input[i])) blocks.push({ ...head, input, output });
  };
  for (const e of S.experience) {
    const p = P.experience.find(x => sameOrg(x.company, e.company) && (sameOrg(x.title, e.title) || P.experience.filter(y => sameOrg(y.company, e.company)).length === 1));
    if (p) pair(e.bullets, p.bullets, { kind: 'role', title: p.title, company: p.company });
    else unmatched += (e.bullets || []).length;
  }
  for (const x of S.projects) {
    const p = P.projects.find(y => similarity(y.name, x.name) >= 0.3 || sameOrg(y.name.split(/[–—-]/)[0], x.name.split(/[–—-]/)[0]));
    if (p) pair(x.bullets, p.bullets, { kind: 'project', name: p.name });
    else unmatched += (x.bullets || []).length;
  }
  return { blocks, stats: { considered, kept: blocks.reduce((n, b) => n + b.input.length, 0), rejected, unmatched } };
}

/**
 * rows: resume_rewrites rows. profile: the default resume profile's sections
 * (needed for Tsenta rows). opts: { includeTsenta, sentOnly }.
 * Returns { examples, stats }.
 */
export function buildExamples(rows, profile, { includeTsenta = true, sentOnly = false, style = 'match' } = {}) {
  if (style === 'match') return buildMatchExamples(rows, profile, { includeTsenta, sentOnly });
  const examples = []; const stats = { rows: rows.length, fromApp: 0, fromTsenta: 0, tsentaBullets: { considered: 0, kept: 0, rejected: 0, unmatched: 0 }, skippedRows: 0 };
  for (const r of rows) {
    if (sentOnly && !r.sent) { stats.skippedRows++; continue; }
    const job = { title: r.job_title, company: r.company, description: r.job_description || '' };
    const meta = { rewriteId: String(r.id), source: r.source, company: r.company, title: r.job_title, outcome: r.outcome || null, sent: !!r.sent };
    if (r.source === 'tsenta') {
      if (!includeTsenta || !profile || !r.job_description) { stats.skippedRows++; continue; }
      const { blocks, stats: s } = alignToProfile(r.resume_after, profile);
      for (const k of Object.keys(s)) stats.tsentaBullets[k] += s[k];
      for (const b of blocks) { examples.push(example(job, { ...b, bullets: b.input }, b.output, meta)); stats.fromTsenta++; }
    } else if (r.mode === 'ai' && Array.isArray(r.report?.blocks)) {
      for (const b of r.report.blocks) {
        if (!b.input?.length || b.output?.length !== b.input.length || b.output.every((o, i) => o === b.input[i])) continue;
        examples.push(example(job, { ...b, bullets: b.input }, b.output, meta)); stats.fromApp++;
      }
    } else stats.skippedRows++;
  }
  return { examples, stats };
}

/** Deterministic split by posting, so one posting's blocks never straddle train and test. */
export function splitExamples(examples, { valid = 0.1, test = 0.1 } = {}) {
  const out = { train: [], valid: [], test: [] };
  for (const ex of examples) {
    const h = parseInt(createHash('sha1').update(`${ex.meta.company}|${ex.meta.title}`).digest('hex').slice(0, 8), 16) / 0xffffffff;
    (h < test ? out.test : h < test + valid ? out.valid : out.train).push(ex);
  }
  // mlx-lm needs a non-empty validation set.
  if (!out.valid.length && out.train.length > 1) out.valid.push(out.train.pop());
  return out;
}

// ─── "Match the job" style (lib/resume-match.mjs) ───────────────────────────

/**
 * Line up a sent resume (e.g. Tsenta's) with the profile for the match style:
 * each profile role/project block gets its full bullet list as input, the
 * sent version of each bullet (or the bullet unchanged) as output, and the
 * sent bullets with no counterpart as `added`. Nothing is fact-checked: this
 * is the resume-writer style the user wants to learn.
 */
export function alignForMatch(sent, profile, { minSimilarity = 0.3 } = {}) {
  const S = withDefaults(sent); const P = withDefaults(profile);
  const blocks = [];
  const pair = (sentBullets, profBullets, head) => {
    if (!profBullets?.length) return;
    const output = [...profBullets]; const used = new Set(); const added = [];
    for (const sb of sentBullets || []) {
      let best = -1; let bestSim = 0;
      profBullets.forEach((pb, i) => { if (used.has(i)) return; const sim = similarity(sb, pb); if (sim > bestSim) { bestSim = sim; best = i; } });
      if (best >= 0 && bestSim >= minSimilarity) { used.add(best); output[best] = sb.trim(); } else added.push(sb.trim());
    }
    const edited = output.filter((o, i) => o !== profBullets[i]).length;
    if (edited || added.length) blocks.push({ ...head, input: [...profBullets], output, added, edited });
  };
  S.experience.forEach((e, i) => {
    const p = P.experience.find(x => sameOrg(x.company, e.company) && (sameOrg(x.title, e.title) || P.experience.filter(y => sameOrg(y.company, e.company)).length === 1));
    if (p) pair(e.bullets, p.bullets, { kind: 'role', title: p.title, company: p.company, current: !!p.current, index: P.experience.indexOf(p) });
  });
  S.projects.forEach(x => {
    const p = P.projects.find(y => similarity(y.name, x.name) >= 0.3 || sameOrg(y.name.split(/[–—-]/)[0], x.name.split(/[–—-]/)[0]));
    if (p) pair(x.bullets, p.bullets, { kind: 'project', name: p.name, index: P.projects.indexOf(p) });
  });
  return { blocks, summary: S.summary && S.summary !== P.summary ? { before: P.summary, after: S.summary } : null };
}

/**
 * A few real before → after pairs from the user's own history, to show a
 * small local model the style (few-shot). Prefers edits that extend a bullet
 * with the posting's language, plus one added bullet.
 */
export function pickStyleExamples(rows, profile, { max = 3 } = {}) {
  const edits = []; const adds = [];
  for (const r of rows) {
    if (!r.resume_after) continue;
    // Your own before → after examples are compared with their own "before".
    const manual = r.source === 'manual' && r.resume_before;
    for (const b of alignForMatch(r.resume_after, manual ? r.resume_before : profile).blocks) {
      b.output.forEach((o, i) => {
        if (o === b.input[i]) return;
        // Tsenta mostly extended bullets; you also tightened them, so any real rewrite counts.
        if (manual ? similarity(o, b.input[i]) < 0.9 : o.length > b.input[i].length + 20) edits.push({ before: b.input[i], after: o, job: r.job_title, manual: !!manual });
      });
      for (const a of b.added) adds.push({ after: a, job: r.job_title, where: b.title || b.name, manual: !!manual });
    }
  }
  const gain = e => (e.manual ? 1000 : 0) + (e.after.length - e.before.length);
  adds.sort((a, b) => (b.manual ? 1 : 0) - (a.manual ? 1 : 0));
  const seen = new Set(); const pick = [];
  for (const e of edits.sort((a, b) => gain(b) - gain(a))) {
    if (seen.has(e.before) || pick.length >= max) continue; seen.add(e.before); pick.push(e);
  }
  return { edits: pick, added: adds.slice(0, 1) };
}

/** Training examples in the "match the job" format: {"bullets": [...], "added": [...]}. */
export function buildMatchExamples(rows, profile, { includeTsenta = true, sentOnly = false } = {}) {
  const examples = []; const stats = { rows: rows.length, fromApp: 0, fromTsenta: 0, summaries: 0, skippedRows: 0 };
  const push = (job, block, output, added, meta) => {
    const budget = { edit: output.filter((o, i) => o !== block.bullets[i]).length, add: added.length };
    examples.push({
      messages: [
        { role: 'system', content: MATCH_SYSTEM },
        { role: 'user', content: matchBlockPrompt(job, block, budget, jobSkillMap(job)) },
        { role: 'assistant', content: JSON.stringify({ bullets: output, added }) },
      ], meta,
    });
  };
  for (const r of rows) {
    if (sentOnly && !r.sent) { stats.skippedRows++; continue; }
    const job = { title: r.job_title, company: r.company, description: r.job_description || '' };
    const meta = { rewriteId: String(r.id), source: r.source, company: r.company, title: r.job_title, outcome: r.outcome || null, sent: !!r.sent };
    if (r.source === 'tsenta' || r.source === 'manual') {
      // manual: an original and tailored resume you added yourself (gold examples).
      const manual = r.source === 'manual';
      const base = manual ? r.resume_before : profile;
      if ((!manual && !includeTsenta) || !base || !r.job_description) { stats.skippedRows++; continue; }
      const { blocks, summary } = alignForMatch(r.resume_after, base);
      for (const b of blocks) { push(job, { ...b, bullets: b.input }, b.output, b.added, meta); if (manual) stats.fromManual = (stats.fromManual || 0) + 1; else stats.fromTsenta++; }
      if (summary?.before) {
        const P = withDefaults(base);
        const title = P.experience[0]?.title || 'Software Engineer';
        const years = (String(summary.before).match(/\d+(?:\.\d+)?\+?\s+years?/i) || [])[0] || 'not stated';
        examples.push({ messages: [
          { role: 'system', content: SUMMARY_SYSTEM },
          { role: 'user', content: summaryPrompt(job, { title, years, summary: summary.before, highlights: P.experience.flatMap(e => (e.bullets || []).slice(0, 2)).slice(0, 5) }) },
          { role: 'assistant', content: JSON.stringify({ summary: summary.after }) },
        ], meta });
        stats.summaries++;
      }
    } else if (r.mode === 'match' && Array.isArray(r.report?.blocks)) {
      for (const b of r.report.blocks) {
        if (b.kind === 'summary' || !b.input?.length || b.output?.length !== b.input.length) continue;
        if (b.output.every((o, i) => o === b.input[i]) && !(b.added || []).length) continue;
        push(job, { ...b, bullets: b.input }, b.output, b.added || [], meta); stats.fromApp++;
      }
    } else stats.skippedRows++;
  }
  return { examples, stats };
}

// ─── Best-of-N (ml/generate-best-of-n.mjs) ──────────────────────────────────

/**
 * Training examples from best-of-N candidates: for each posting whose best
 * version scored at least `min` on the ATS scorer, every block becomes one
 * example with exactly the prompt the app sent, and the answer is what was
 * kept after the checks (bullets, plus only the new bullets the model wrote;
 * bullets that came back from the bullet bank are not model output). Blocks
 * the model left unchanged are skipped.
 */
export function buildBonExamples(candidates, { min = 9 } = {}) {
  const examples = []; const stats = { postings: candidates.length, kept: 0, below: 0, blocks: 0, summaries: 0 };
  for (const c of candidates) {
    if (!c.best || c.best.score < min) { stats.below++; continue; }
    stats.kept++;
    const meta = { company: c.job.company, title: c.job.title, listingId: c.listingId, score: c.best.score };
    for (const b of c.best.report?.blocks || []) {
      if (!b.prompt) continue;
      if (b.kind === 'summary') {
        examples.push({ messages: [{ role: 'system', content: SUMMARY_SYSTEM }, { role: 'user', content: b.prompt }, { role: 'assistant', content: JSON.stringify({ summary: b.output[0] }) }], meta });
        stats.summaries++; continue;
      }
      const added = b.modelAdded || [];
      if (b.output.every((o, i) => o === b.input[i]) && !added.length) continue;
      examples.push({ messages: [{ role: 'system', content: MATCH_SYSTEM }, { role: 'user', content: b.prompt }, { role: 'assistant', content: JSON.stringify({ bullets: b.output, added }) }], meta });
      stats.blocks++;
    }
  }
  return { examples, stats };
}
