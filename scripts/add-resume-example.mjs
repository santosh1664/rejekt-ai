/**
 * Add one of your own tailoring examples: your original resume and the
 * version you tailored for a posting (docs/resume-model.md).
 *
 *   npm run resume:example -- --user <id> --original base.pdf --tailored tailored.pdf [--jd posting.txt] [--title "Software Engineer, AI"] [--company Acme]
 *
 * Files can be PDF, Word or plain text. The pair becomes a gold training
 * example (when the posting is given), a style example for the model, and
 * its bullets go into your bullet bank.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { addManualExample } from '../lib/rewrites.mjs';
import { closePool } from '../lib/db.mjs';

const args = process.argv.slice(2);
const val = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const require = createRequire(import.meta.url);

async function readText(file) {
  const buf = readFileSync(file);
  if (/\.pdf$/i.test(file)) { const { PDFParse } = require('pdf-parse'); return (await new PDFParse({ data: buf }).getText()).text; }
  if (/\.docx?$/i.test(file)) return (await require('mammoth').extractRawText({ buffer: buf })).value;
  return buf.toString('utf8');
}

const user = val('--user'); const original = val('--original'); const tailored = val('--tailored');
if (!user || !original || !tailored) { console.error('Usage: --user <id> --original <file> --tailored <file> [--jd <file>] [--title ..] [--company ..]'); process.exit(1); }
const r = await addManualExample(user, {
  original: await readText(original), tailored: await readText(tailored),
  jobDescription: val('--jd') ? readFileSync(val('--jd'), 'utf8') : '', jobTitle: val('--title') || '', company: val('--company') || '',
});
if (r.error) { console.error(r.error); process.exitCode = 1; }
else console.log(`Saved example ${r.id}: ${r.bullets.original} bullets → ${r.bullets.tailored}.${r.hasPosting ? '' : ' No posting given, so it is used for style and the bullet bank but not for training.'}`);
await closePool();
