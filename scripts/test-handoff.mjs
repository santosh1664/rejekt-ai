// "Finish it here": the form is filled and left open; a person ticks a stand-in check and clicks Submit, and we only
// watch for the confirmation (we never touch the check or the Submit button). The form shows a fake check box.
import assert from 'node:assert/strict';
import http from 'node:http';
import { getBrowser, closeBrowser } from '../lib/resume-render.mjs';
import { fillApplication } from '../autoapply/form-fill.mjs';
import { buildAnswerBook } from '../autoapply/answers.mjs';
const FORM = `<!doctype html><body><form id="f"><label for="e">Email *</label><input id="e" type="email" name="email" required>
 <label><input id="human" type="checkbox"> I am human</label><button id="go" type="submit">Submit application</button></form>
 <script>document.getElementById('f').addEventListener('submit', e => { e.preventDefault(); if (document.getElementById('human').checked) location.href = '/thanks'; });</script></body>`;
const srv = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(req.url === '/thanks' ? '<h1>Thank you for applying</h1>' : FORM); }).listen(0);
const url = `http://127.0.0.1:${srv.address().port}/`;
const b = await getBrowser(); if (!b) { console.log('skipped: no browser'); srv.close(); process.exit(0); }
const book = buildAnswerBook({ personal: { fullName: 'Test Person', email: 'a@example.com' } });
let page = await b.newPage();
const run = fillApplication(page, url, book, { resume: null }, { handoff: true });
await new Promise(r => setTimeout(r, 4000));
assert.equal(page.url(), url, 'nothing is sent until the person clicks Submit');
assert.equal(await page.inputValue('#e'), 'a@example.com', 'the form was filled');
await page.check('#human'); await page.click('#go');          // the person
let r = await run; assert.equal(r.outcome, 'SUBMITTED', JSON.stringify(r)); await page.close();
page = await b.newPage();
const closed = fillApplication(page, url, book, { resume: null }, { handoff: true });
await new Promise(r => setTimeout(r, 3000)); await page.close();
r = await closed; assert.equal(r.outcome, 'NEEDS_YOU'); assert.match(r.reason, /closed/);
await closeBrowser(); srv.close(); console.log('ok');
