/**
 * Score a rewriting model on held-out examples (docs/resume-model.md).
 *
 *   npm run ml:rewriter:eval                       uses OLLAMA_MODEL (or the default)
 *   OLLAMA_MODEL=jd-rewriter npm run ml:rewriter:eval
 *   npm run ml:rewriter:eval -- --data ml/data/rewriter/test.jsonl --limit 50
 *
 * For each example it sends the same prompt the app sends and measures:
 *   valid      the reply was JSON with the right number of bullets
 *   honest     share of bullets that pass the fact check: no new skill or number (honest style)
 *   postingWords  share of added words taken from the posting (match style)
 *   changed    share of bullets the model actually reworded
 *   skillGain  posting skills named in the output that the input didn't name
 *   closeness  word overlap with the reference rewrite (0–1)
 * Run it on the base model and on your fine-tuned one and compare.
 */
import { readFileSync } from 'node:fs';
import { completeJSON, llmConfig } from '../lib/llm.mjs';
import { checkRewrite } from '../lib/resume-tailor.mjs';
import { MATCH_SYSTEM, SUMMARY_SYSTEM } from '../lib/resume-match.mjs';
import { extractSkills } from '../lib/skill-extract.mjs';
import { similarity } from '../lib/rewriter-dataset.mjs';

const args = process.argv.slice(2);
const val = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const file = val('--data') || new URL('./data/rewriter/test.jsonl', import.meta.url).pathname;
const limit = +(val('--limit') || 100);
const skills = t => new Set(extractSkills(t || '').map(s => s.name));

const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).slice(0, limit);
if (!rows.length) { console.error(`No examples in ${file}. Run npm run ml:rewriter:export first.`); process.exit(1); }
const cfg = llmConfig();
console.log(`Scoring ${cfg.provider}:${cfg.model} on ${rows.length} examples from ${file}`);

const tot = { examples: 0, valid: 0, bullets: 0, honest: 0, changed: 0, skillGain: 0, closeness: 0 };
for (const [i, ex] of rows.entries()) {
  const [sys, user, ref] = ex.messages;
  if (sys.content.startsWith(SUMMARY_SYSTEM.slice(0, 40))) continue;   // summaries aren't scored here
  const input = JSON.parse(user.content.slice(user.content.lastIndexOf('Bullets:') + 8).trim());
  const reference = JSON.parse(ref.content).bullets;
  const postingSkills = skills(user.content.slice(0, user.content.lastIndexOf('Bullets:')));
  const shown = skills(input.join('\n'));
  tot.examples++;
  const match = sys.content.startsWith(MATCH_SYSTEM.slice(0, 40));
  let out; let added = [];
  try { const j = (await completeJSON({ system: sys.content, prompt: user.content })).json; out = j.bullets; added = Array.isArray(j.added) ? j.added : []; }
  catch (err) { console.log(`#${i + 1} error: ${err.message}`); continue; }
  if (match) {
    const posting = user.content.slice(0, user.content.lastIndexOf('Bullets:')).toLowerCase();
    const newWords = [...out, ...added].join(' ').toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}/g) || [];
    const inputWords = new Set(input.join(' ').toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}/g) || []);
    const fresh = newWords.filter(w => !inputWords.has(w));
    tot.jdWords = (tot.jdWords || 0) + fresh.filter(w => posting.includes(w)).length; tot.freshWords = (tot.freshWords || 0) + fresh.length;
    tot.added = (tot.added || 0) + added.length;
    tot.keptNumbers = (tot.keptNumbers || 0) + (Array.isArray(out) && out.length === input.length ? out.filter((b, j) => (input[j].match(/\d+/g) || []).every(n => String(b).includes(n))).length : 0);
  }
  if (!Array.isArray(out) || out.length !== input.length) { console.log(`#${i + 1} wrong bullet count`); continue; }
  tot.valid++;
  out.forEach((b, j) => {
    tot.bullets++;
    if (!checkRewrite(input[j], String(b), shown)) tot.honest++;
    if (String(b).trim() !== input[j]) tot.changed++;
    const before = skills(input[j]); tot.skillGain += [...skills(b)].filter(s => postingSkills.has(s) && !before.has(s)).length;
    tot.closeness += similarity(b, reference[j]);
  });
  process.stdout.write(`\r${i + 1}/${rows.length}`);
}
const pct = (a, b) => (b ? `${Math.round(100 * a / b)}%` : '–');
console.log(`\n
model       ${cfg.provider}:${cfg.model}
valid       ${pct(tot.valid, tot.examples)} of examples
honest      ${pct(tot.honest, tot.bullets)} of bullets pass the fact check
changed     ${pct(tot.changed, tot.bullets)} of bullets reworded
skillGain   ${(tot.skillGain / Math.max(1, tot.bullets)).toFixed(2)} posting skills surfaced per bullet
closeness   ${(tot.closeness / Math.max(1, tot.bullets)).toFixed(2)} to the reference rewrites${tot.freshWords != null ? `
postingWords ${pct(tot.jdWords, tot.freshWords)} of the words it added come from the posting (Tsenta: about 82%)
added       ${tot.added} new bullets
numbers     ${pct(tot.keptNumbers, tot.bullets)} of bullets keep their original numbers` : ''}`);
