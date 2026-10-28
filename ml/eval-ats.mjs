/**
 * Compare resume rewriters by ATS score on postings none of them trained on
 * (docs/resume-model.md).
 *
 *   npm run ml:rewriter:eval-ats -- --user <your user id>
 *   npm run ml:rewriter:eval-ats -- --resume resume.pdf --models qwen2.5:7b-instruct,jd-rewriter --limit 20
 *
 * Postings come from data/imports/tsenta/postings.jsonl, minus every posting
 * used for best-of-N training data (ml/data/bon/candidates.jsonl). Each model
 * tailors the same resume for the same postings exactly as the app does, and
 * the ATS scorer (lib/ats-score.mjs) grades the result.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tailorResumeToMatch } from '../lib/resume-match.mjs';
import { atsScore } from '../lib/ats-score.mjs';
import { buildBank } from '../lib/bullet-bank.mjs';
import { extractResumeSections } from '../lib/resume-extract.mjs';

const args = process.argv.slice(2);
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const root = new URL('..', import.meta.url).pathname;
const models = val('--models', 'qwen2.5:7b-instruct,jd-rewriter').split(',').map(s => s.trim()).filter(Boolean);
// "jd-rewriter" = Ollama model; "openrouter:google/gemma-4-31b-it:free" or "huggingface:Qwen/..." = hosted
const modelEnv = m => {
  const [, prov, name] = m.match(/^(openrouter|huggingface):(.+)$/) || [];
  return prov ? { ...process.env, LLM_PROVIDER: prov, [prov === 'openrouter' ? 'OPENROUTER_MODEL' : 'HF_MODEL']: name } : { ...process.env, LLM_PROVIDER: 'ollama', OLLAMA_MODEL: m };
};
const LIMIT = +val('--limit', 20);

let sections; let bank; let styleExamples = null; let close = async () => {};
if (val('--resume')) {
  const file = val('--resume'); const buf = readFileSync(file); const require = createRequire(import.meta.url);
  const text = /\.pdf$/i.test(file) ? (await new (require('pdf-parse').PDFParse)({ data: buf }).getText()).text : buf.toString('utf8');
  sections = extractResumeSections(text); bank = buildBank([sections]);
} else if (val('--user')) {
  const { getDefaultResumeProfile } = await import('../lib/resume-profiles.mjs');
  const { loadBulletBank, loadStyleExamples } = await import('../lib/rewrites.mjs');
  ({ closePool: close } = await import('../lib/db.mjs'));
  sections = (await getDefaultResumeProfile(val('--user')))?.sections;
  if (!sections?.experience?.length) { console.error('Your default resume profile is empty.'); process.exit(1); }
  bank = await loadBulletBank(val('--user')).catch(() => buildBank([sections]));
  styleExamples = await loadStyleExamples(val('--user'), sections).catch(() => null);
} else { console.error('Pass --user <id> or --resume <file>.'); process.exit(1); }

const used = new Set();
const cand = root + 'ml/data/bon/candidates.jsonl';
if (existsSync(cand)) for (const l of readFileSync(cand, 'utf8').split('\n')) if (l.trim()) used.add(JSON.parse(l).listingId);
const postings = readFileSync(val('--postings', root + 'data/imports/tsenta/postings.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  .filter(p => p.description?.length >= 600 && !used.has(p.listingId)).slice(-LIMIT);   // from the end: the generator works from the start
if (!postings.length) { console.error('No unused postings left to test on. Pull more postings, or lower --limit on the generator.'); process.exit(1); }
const allowed = [...bank.roles, ...bank.projects].flatMap(x => x.bullets).join(' ');
console.log(`Scoring ${models.join(' vs ')} on ${postings.length} postings no model trained on.\n`);

const results = Object.fromEntries(models.map(m => [m, []]));
for (const [i, p] of postings.entries()) {
  const job = { title: p.title, company: p.company, description: p.description, skills: p.skills || [] };
  const row = [];
  for (const m of models) {
    const r = await tailorResumeToMatch(sections, job, { bank, styleExamples, llm: { env: modelEnv(m) } });
    if (!r.report.model) { console.error(`${m}: ${r.report.aiSkipped}`); process.exit(1); }
    const s = atsScore(r.sections, job, { original: sections, allowed });
    results[m].push(s); row.push(`${m} ${s.score}`);
  }
  console.log(`${i + 1}. ${p.title} @ ${p.company}: ${row.join('  ')}`);
}
await close();
const avg = a => (a.reduce((x, y) => x + y, 0) / Math.max(1, a.length));
console.log('\nmodel                      average  9+     parts (coverage/evidence/placement/integrity/writing)');
for (const m of models) {
  const r = results[m]; const p = k => avg(r.map(x => x.parts[k])).toFixed(2);
  console.log(`${m.padEnd(26)} ${avg(r.map(x => x.score)).toFixed(2).padEnd(8)} ${String(Math.round(100 * r.filter(x => x.score >= 9).length / r.length)).padStart(3)}%   ${p('coverage')} / ${p('evidence')} / ${p('placement')} / ${p('integrity')} / ${p('writing')}`);
}
