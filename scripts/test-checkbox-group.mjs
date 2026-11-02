// Ashby gives each box of one question its own name (GCP, AWS, AZURE): they must be read as one group, and only
// options the resume mentions get ticked. No mention at all: the question goes back to the person.
import assert from 'node:assert/strict';
import http from 'node:http';
import { getBrowser, closeBrowser } from '../lib/resume-render.mjs';
import { fillApplication } from '../autoapply/form-fill.mjs';
import { buildAnswerBook } from '../autoapply/answers.mjs';
const FORM = `<!doctype html><body><form onsubmit="event.preventDefault(); location.href='/thanks';">
 <div class="ashby-application-form-field-entry"><label class="_required_x" for="n">Name</label><input id="n" name="_systemfield_name" required></div>
 <div class="ashby-application-form-field-entry"><label class="_required_x" for="e">Email</label><input id="e" type="email" name="_systemfield_email" required></div>
 <div class="ashby-application-form-field-entry"><label class="_required_x">What cloud services are you experienced building in?</label>
  <label><input type="checkbox" name="GCP"> GCP</label><label><input type="checkbox" name="AWS"> AWS</label><label><input type="checkbox" name="AZURE"> AZURE</label></div>
 <button type="submit">Submit Application</button></form></body>`;
const srv = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(req.url === '/thanks' ? '<h1>Thank you for applying</h1>' : FORM); }).listen(0);
const url = `http://127.0.0.1:${srv.address().port}/`;
const b = await getBrowser(); if (!b) { console.log('skipped: no browser'); srv.close(); process.exit(0); }
const run = async sections => { const page = await b.newPage(); try { return await fillApplication(page, url, buildAnswerBook(sections), { resume: null }, { submit: true, llmContext: { job: {}, resumeSections: sections } }); } finally { await page.close(); } };
const personal = { fullName: 'Test Person', email: 'a@example.com' };
let r = await run({ personal, skills: [{ group: 'c', items: ['AWS', 'Python'] }], experience: [{ company: 'X', title: 'Eng', bullets: ['Ran GCP workloads'] }] });
assert.equal(r.outcome, 'SUBMITTED'); assert.equal(r.filled.find(f => /cloud/i.test(f.label)).value, 'GCP, AWS');
r = await run({ personal, skills: [{ group: 'c', items: ['Python'] }] });
assert.equal(r.outcome, 'NEEDS_YOU'); assert.match(r.missing[0].label, /cloud services/);
await closeBrowser(); srv.close(); console.log('ok');
