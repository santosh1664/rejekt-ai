/**
 * Best-of-N training data for the resume rewriter (docs/resume-model.md).
 *
 * For each job posting, tailor your resume N times with the local model at a
 * higher temperature, score every version with the ATS scorer
 * (lib/ats-score.mjs), and keep the best one. Only versions scoring at least
 * --min (default 9) become training examples, so the fine-tuned model learns
 * from its own best work, never its mistakes.
 *
 *   npm run ml:rewriter:generate -- --user <your user id>
 *   npm run ml:rewriter:generate -- --resume path/to/resume.pdf     (without the database)
 *
 * Options:
 *   --postings <file>   postings to use (default data/imports/tsenta/postings.jsonl)
 *   --n 3               versions per posting
 *   --min 9             lowest ATS score kept for training
 *   --limit 120         stop after this many postings (it resumes where it left off)
 *   --temperature 0.7
 *   --out ml/data/bon   where results go (candidates.jsonl, one line per posting)
 *
 * About a minute per version with qwen2.5:7b-instruct on an M2 Pro, so 120
 * postings × 3 versions is roughly 6 hours. Stop it any time with Ctrl+C and run
 * it again to continue. Then: npm run ml:rewriter:export -- --style bon
 */
import { readFileSync, existsSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tailorResumeToMatch } from '../lib/resume-match.mjs';
import { atsScore } from '../lib/ats-score.mjs';
import { buildBank } from '../lib/bullet-bank.mjs';
import { extractResumeSections } from '../lib/resume-extract.mjs';
import { llmStatus, llmConfig } from '../lib/llm.mjs';

const args = process.argv.slice(2);
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const root = new URL('..', import.meta.url).pathname;
const N = +val('--n', 3); const MIN = +val('--min', 9); const LIMIT = +val('--limit', 120);
const TEMP = +val('--temperature', 0.7);
const OUT = val('--out', root + 'ml/data/bon');
const POSTINGS = val('--postings', root + 'data/imports/tsenta/postings.jsonl');

async function loadResume() {
  const user = val('--user'); const file = val('--resume');
  if (file) {
    const require = createRequire(import.meta.url);
    const buf = readFileSync(file);
    const text = /\.pdf$/i.test(file) ? (await new (require('pdf-parse').PDFParse)({ data: buf }).getText()).text
      : /\.docx?$/i.test(file) ? (await require('mammoth').extractRawText({ buffer: buf })).value : buf.toString('utf8');
    const sections = extractResumeSections(text);
    return { sections, bank: buildBank([sections]), styleExamples: null, close: async () => {} };
  }
  if (!user) { console.error('Pass --user <your user id> (uses your default resume profile) or --resume <file>.'); process.exit(1); }
  const { getDefaultResumeProfile } = await import('../lib/resume-profiles.mjs');
  const { loadBulletBank, loadStyleExamples } = await import('../lib/rewrites.mjs');
  const { closePool } = await import('../lib/db.mjs');
  const rp = await getDefaultResumeProfile(user);
  if (!rp?.sections?.experience?.length) { console.error('Your default resume profile is empty. Upload your resume on Profile → Resume first.'); process.exit(1); }
  return { sections: rp.sections, bank: await loadBulletBank(user).catch(() => buildBank([rp.sections])), styleExamples: await loadStyleExamples(user, rp.sections).catch(() => null), close: closePool };
}

const status = await llmStatus();
if (!status.ok) { console.error(`The model isn't reachable (${status.reason || "no response"}). Start Ollama: ollama serve`); process.exit(1); }
if (!existsSync(POSTINGS)) { console.error(`No postings at ${POSTINGS}.`); process.exit(1); }
const { sections, bank, styleExamples, close } = await loadResume();
const allowed = [...bank.roles, ...bank.projects].flatMap(x => x.bullets).join(' ');

mkdirSync(OUT, { recursive: true });
// The resume as it was before tailoring, so the export can re-score with the latest scorer.
writeFileSync(`${OUT}/original.json`, JSON.stringify({ sections, allowed }));
const outFile = `${OUT}/candidates.jsonl`;
const done = new Set(existsSync(outFile) ? readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).listingId) : []);
const postings = readFileSync(POSTINGS, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  .filter(p => p.description && p.description.length >= 600 && !done.has(p.listingId));
const todo = postings.slice(0, Math.max(0, LIMIT - done.size));
console.log(`Model ${llmConfig().provider}:${llmConfig().model}. ${done.size} postings done, ${todo.length} to go, ${N} versions each, keeping scores ≥ ${MIN}.`);

let kept = 0; const t0 = Date.now();
let stopping = false; process.on('SIGINT', () => { if (stopping) process.exit(1); stopping = true; console.log('\nFinishing this posting, then stopping. Press Ctrl+C again to stop now.'); });
for (const [i, p] of todo.entries()) {
  if (stopping) break;
  const job = { title: p.title, company: p.company, description: p.description, skills: p.skills || [] };
  const versions = [];
  for (let k = 0; k < N; k++) {
    const r = await tailorResumeToMatch(sections, job, { bank, styleExamples, temperature: TEMP, recordPrompts: true });
    if (!r.report.model) { console.error(`\nThe model stopped answering: ${r.report.aiSkipped}`); stopping = true; break; }
    const s = atsScore(r.sections, job, { original: sections, allowed });
    versions.push({ score: s.score, parts: s.parts, issues: s.issues, sections: r.sections, sectionOrder: r.sectionOrder, report: r.report });
  }
  if (!versions.length) break;
  versions.sort((a, b) => b.score - a.score);
  const best = versions[0];
  if (best.score >= MIN) kept++;
  appendFileSync(outFile, JSON.stringify({
    listingId: p.listingId, family: p.family, job: { title: p.title, company: p.company, description: p.description, skills: p.skills || [] },
    scores: versions.map(v => v.score), best, kept: best.score >= MIN, at: new Date().toISOString(),
  }) + '\n');
  const mins = (Date.now() - t0) / 60000; const left = (todo.length - i - 1) * mins / (i + 1);
  console.log(`${done.size + i + 1}. ${p.title} @ ${p.company}: ${versions.map(v => v.score).join(' / ')} → best ${best.score}${best.score >= MIN ? ' kept' : ''}  (${kept} kept, about ${Math.round(left)} min left)`);
}
await close();
console.log(`\nDone for now: ${kept} new postings scored ${MIN}+. Next: npm run ml:rewriter:export -- --style bon`);
