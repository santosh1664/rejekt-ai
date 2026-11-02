import assert from 'node:assert/strict';
import { writeCoverLetter, checkLetter } from '../lib/cover-letter.mjs';
const sections = { personal: { fullName: 'Ada Lovelace' }, summary: 'Engineer.', experience: [{ title: 'Engineer', company: 'Acme', bullets: ['Cut latency by 40% on 12 services.'] }], skills: [] };
const job = { title: 'Backend Engineer', company: 'Globex', description: 'Build APIs.' };
const body = w => Array.from({ length: w }, (_, i) => (i === 3 ? 'Globex' : 'word')).join(' ');
const reply = letter => async () => ({ json: { letter }, provider: 'test', model: 'm' });

let r = await writeCoverLetter(sections, job, { complete: reply(`${body(180)} I cut latency by 40% on 12 services.`) });
assert.equal(r.source, 'model'); assert.match(r.letter, /Sincerely,\nAda Lovelace$/);
r = await writeCoverLetter(sections, job, { complete: reply(`${body(180)} I cut latency by 90%.`), template: 'Hi {company}, {title}.' });
assert.equal(r.source, 'template'); assert.equal(r.letter, 'Hi Globex, Backend Engineer.'); assert.match(r.rejected, /invents 90%/);
r = await writeCoverLetter(sections, job, { complete: reply(`${body(180)} [Your Name]`) });
assert.equal(r.source, 'none'); assert.match(r.rejected, /placeholder/);
r = await writeCoverLetter(sections, job, { complete: async () => { throw new Error('Ollama isn\'t running'); } });
assert.equal(r.source, 'none');
assert.match(checkLetter('too short', '', job), /words/);
console.log('ok');
