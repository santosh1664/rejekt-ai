// Greenhouse's emailed security code: after the first Submit the form shows eight boxes and keeps Submit disabled until
// the right code is typed. The code is read through opts.readCode (the applicant's inbox in the app).
import assert from 'node:assert/strict';
import http from 'node:http';
import { getBrowser, closeBrowser } from '../lib/resume-render.mjs';
import { fillApplication } from '../autoapply/form-fill.mjs';
import { buildAnswerBook } from '../autoapply/answers.mjs';
import { extractSecurityCode } from '../lib/gmail.mjs';
const CODE = 'Xt3kY9Pq';
const FORM = `<!doctype html><body><form id="f"><label for="e">Email *</label><input id="e" type="email" name="email" required>
 <div id="code" hidden><p>A verification code was sent to a@example.com. To submit your application, enter the 8-character code to confirm you're a human.</p><label>Security code</label>
 ${[0, 1, 2, 3, 4, 5, 6, 7].map(i => `<input id="security-input-${i}" maxlength="1">`).join('')}</div>
 <button id="go" type="submit">Submit application</button></form>
 <script>let sent = false; const f = document.getElementById('f');
 const typed = () => [...document.querySelectorAll('[id^=security-input]')].map(x => x.value).join('');
 f.addEventListener('submit', e => { e.preventDefault(); if (!sent) { sent = true; document.getElementById('code').hidden = false; return; }
   if (typed() === '${CODE}') location.href = '/thanks'; else document.getElementById('code').insertAdjacentHTML('beforeend', '<p role="alert">Wrong code</p>'); });</script></body>`;
const srv = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(req.url === '/thanks' ? '<h1>Thank you for applying</h1>' : FORM); }).listen(0);
const url = `http://127.0.0.1:${srv.address().port}/`;
const b = await getBrowser(); if (!b) { console.log('skipped: no browser'); srv.close(); process.exit(0); }
const run = async readCode => { const page = await b.newPage(); try { return await fillApplication(page, url, buildAnswerBook({ personal: { fullName: 'Test Person', email: 'a@example.com' } }), { resume: null }, { submit: true, readCode }); } finally { await page.close(); } };
let r = await run(async () => ({ code: CODE }));
assert.equal(r.outcome, 'SUBMITTED', JSON.stringify(r));
r = await run(async () => ({ reason: 'Link Gmail' }));
assert.equal(r.outcome, 'NEEDS_YOU'); assert.equal(r.reason, 'Link Gmail');
r = await run(async () => ({ code: 'WRONGCD1' }));
assert.notEqual(r.outcome, 'SUBMITTED');
assert.equal(extractSecurityCode('this code into the security code field on your application:\n\nXt3kY9Pq\n'), 'Xt3kY9Pq');
await closeBrowser(); srv.close(); console.log('ok');
