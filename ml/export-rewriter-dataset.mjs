/**
 * Export resume-rewrite training data (docs/resume-model.md).
 *
 *   npm run ml:rewriter:export -- --user <uuid>
 *       [--out ml/data/rewriter] [--style match|honest] [--no-tsenta] [--sent-only]
 *
 * --style match (default): the resume-writer style of lib/resume-match.mjs,
 *   learned from the resumes Tsenta sent and from "Match the job" rewrites.
 * --style honest: rewordings only, every bullet fact-checked.
 * --style bon: the best-of-N versions from ml/generate-best-of-n.mjs that
 *   scored --min (default 9) or more on the ATS scorer. Needs no database.
 *
 * Writes train.jsonl / valid.jsonl / test.jsonl in the chat format mlx-lm
 * and most fine-tuning tools read ({"messages": [...]}), plus stats.json.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { query, closePool } from '../lib/db.mjs';
import { listRewritesForExport } from '../lib/rewrites.mjs';
import { getDefaultResumeProfile } from '../lib/resume-profiles.mjs';
import { buildExamples, splitExamples, buildBonExamples } from '../lib/rewriter-dataset.mjs';

const args = process.argv.slice(2);
const val = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const out = val('--out') || new URL('./data/rewriter/', import.meta.url).pathname;

function write(examples, extra) {
  const split = splitExamples(examples);
  mkdirSync(out, { recursive: true });
  for (const [name, list] of Object.entries(split)) {
    writeFileSync(join(out, `${name}.jsonl`), list.map(ex => JSON.stringify({ messages: ex.messages })).join('\n') + (list.length ? '\n' : ''));
  }
  writeFileSync(join(out, 'stats.json'), JSON.stringify({ ...extra, examples: examples.length, train: split.train.length, valid: split.valid.length, test: split.test.length, exportedAt: new Date().toISOString() }, null, 2));
  writeFileSync(join(out, 'test-meta.jsonl'), split.test.map(ex => JSON.stringify(ex.meta)).join('\n'));
  return split;
}

if (val('--style') === 'bon') {
  const file = val('--from') || new URL('./data/bon/candidates.jsonl', import.meta.url).pathname;
  if (!existsSync(file)) { console.error(`No ${file}. Run npm run ml:rewriter:generate first.`); process.exit(1); }
  const min = +(val('--min') || 9);
  const candidates = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  // Re-score with the current scorer (fixes made after a version was generated apply too).
  let original = null; const origFile = join(dirname(file), 'original.json');
  if (existsSync(origFile)) original = JSON.parse(readFileSync(origFile, 'utf8'));
  else if (val('--user')) {
    const { loadBulletBank } = await import('../lib/rewrites.mjs');
    const sections = (await getDefaultResumeProfile(val('--user')))?.sections;
    const bank = sections ? await loadBulletBank(val('--user')).catch(() => null) : null;
    if (sections) original = { sections, allowed: bank ? [...bank.roles, ...bank.projects].flatMap(x => x.bullets).join(' ') : '' };
    await closePool();
  }
  if (original) {
    const { atsScore } = await import('../lib/ats-score.mjs');
    let changed = 0;
    for (const c of candidates) {
      const s = atsScore(c.best.sections, c.job, { original: original.sections, allowed: original.allowed });
      if (s.score !== c.best.score) changed++;
      Object.assign(c.best, { score: s.score, parts: s.parts, issues: s.issues });
    }
    console.log(`Re-scored ${candidates.length} postings with the current ATS scorer (${changed} changed).`);
  } else console.log('Scores as generated (pass --user <id> to re-score with the current scorer).');
  const { examples, stats } = buildBonExamples(candidates, { min });
  const split = write(examples, { style: 'bon', min, ...stats });
  console.log(`best-of-N: ${stats.kept} of ${stats.postings} postings scored ${min}+ → ${examples.length} examples (${stats.blocks} sections, ${stats.summaries} summaries)`);
  console.log(`train ${split.train.length} · valid ${split.valid.length} · test ${split.test.length} → ${out}`);
  if (examples.length < 200) console.log('Fewer than ~200 examples: generate more (raise --limit) before training, or the model will overfit.');
  process.exit(0);
}

try {
  let userId = val('--user');
  if (!userId) {
    const { rows } = await query(`SELECT user_id, COUNT(*)::int AS n FROM resume_rewrites GROUP BY 1 ORDER BY n DESC`);
    if (rows.length !== 1) { console.error(rows.length ? 'Several users have rewrites; pass --user <uuid>.' : 'No rewrites stored yet.'); process.exit(1); }
    userId = rows[0].user_id;
  }
  const profile = (await getDefaultResumeProfile(userId))?.sections || null;
  if (!profile) console.warn('No resume profile: Tsenta rows need one to be aligned, so they are skipped.');
  const rows = await listRewritesForExport(userId);
  const style = val('--style') || 'match';
  const { examples, stats } = buildExamples(rows, profile, { includeTsenta: !args.includes('--no-tsenta'), sentOnly: args.includes('--sent-only'), style });
  const split = splitExamples(examples);
  mkdirSync(out, { recursive: true });
  for (const [name, list] of Object.entries(split)) {
    writeFileSync(join(out, `${name}.jsonl`), list.map(ex => JSON.stringify({ messages: ex.messages })).join('\n') + (list.length ? '\n' : ''));
  }
  writeFileSync(join(out, 'stats.json'), JSON.stringify({ userId, style, ...stats, examples: examples.length, train: split.train.length, valid: split.valid.length, test: split.test.length, exportedAt: new Date().toISOString() }, null, 2));
  writeFileSync(join(out, 'test-meta.jsonl'), split.test.map(ex => JSON.stringify(ex.meta)).join('\n'));
  console.log(`${style} style: ${examples.length} examples (${stats.fromApp} from rewrites made here, ${stats.fromTsenta} from Tsenta resumes${stats.summaries ? `, ${stats.summaries} summaries` : ''})`);
  if (stats.tsentaBullets) console.log(`Tsenta bullets: ${stats.tsentaBullets.kept} kept, ${stats.tsentaBullets.rejected} dropped by the fact check, ${stats.tsentaBullets.unmatched} with no matching bullet in your profile`);
  console.log(`train ${split.train.length} · valid ${split.valid.length} · test ${split.test.length} → ${out}`);
  if (examples.length < 200) console.log('Fewer than ~200 examples: fine-tuning will overfit. Keep using the base model and let examples accumulate.');
} finally {
  await closePool();
}
