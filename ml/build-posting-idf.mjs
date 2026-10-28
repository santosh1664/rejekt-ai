/**
 * Word and phrase rarity across job postings, for the ATS scorer's posting
 * keywords (lib/ats-score.mjs postingTerms): a term that appears in most
 * postings ("experience", "data", "team") says little about one posting.
 *
 *   node ml/build-posting-idf.mjs [postings.jsonl ...]   → data/posting-idf.json
 *
 * Defaults to data/imports/tsenta/postings.jsonl and details.jsonl. Only counts
 * are stored, no posting text.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { termsOf } from '../lib/ats-score.mjs';
import { htmlToText } from '../lib/import-tsenta.mjs';

const root = new URL('..', import.meta.url).pathname;
const files = process.argv.slice(2).length ? process.argv.slice(2) : ['data/imports/tsenta/postings.jsonl', 'data/imports/tsenta/details.jsonl'].map(f => root + f);
const df = new Map(); let n = 0;
for (const f of files) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    const text = r.description || (r.job?.description ? htmlToText(r.job.description) : '');
    if (!text) continue;
    n++;
    for (const t of new Set(termsOf(text))) df.set(t, (df.get(t) || 0) + 1);
  }
}
const kept = Object.fromEntries([...df.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 40000));
writeFileSync(root + 'data/posting-idf.json', JSON.stringify({ postings: n, df: kept }));
console.log(`${n} postings, ${Object.keys(kept).length} terms → data/posting-idf.json`);
