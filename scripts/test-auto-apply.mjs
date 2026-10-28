/**
 * scripts/test-auto-apply.mjs — application storage, resume tailoring and
 * auto-apply (docs/auto-apply.md).
 *
 *   node scripts/test-auto-apply.mjs           pure checks (answers, tailoring)
 *   DATABASE_URL=postgres://…@localhost/jobs_test node scripts/test-auto-apply.mjs --db
 *                                              + storage, API, and the full auto-apply
 *                                                flow against local copies of
 *                                                Greenhouse / Lever / Ashby-style forms
 *
 * The browser part needs playwright-core and Chrome (or CHROME_PATH); it's
 * skipped with a note when neither is available.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { classifyQuestion, chooseOption, resolveAnswer, buildAnswerBook, findSavedAnswer } from '../autoapply/answers.mjs';
import { tailorResume, tailorResumeWithAI, checkRewrite, resumeEvidence } from '../lib/resume-tailor.mjs';
import { llmStatus } from '../lib/llm.mjs';
import { extractResumeSections } from '../lib/resume-extract.mjs';
import { renderResumeHTML, renderCoverLetter } from '../lib/resume-render.mjs';

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 600) : ''}`); }
}

// ─── Questions from real forms (scanned read-only on 2026-10-23) ─────────────
const REAL = [
  ['First Name *', 'firstName'], ['Last Name *', 'lastName'], ['Email *', 'email'], ['Phone *', 'phone'],
  ['Country *', 'country'], ['Location (City) *', 'location'], ['LinkedIn Profile *', 'linkedin'],
  ['Are you legally authorized to work in the United States for LaunchDarkly? *', 'authorizedToWork'],
  ['Do you now, or will you in the future, require sponsorship for employment to work legally in the United States? (Note: This includes visa statuses such as H-1B) *', 'needsSponsorship'],
  ['Where is your permanent (City, State) work location? *', 'location'],
  ['How would you describe your gender identity? (mark all that apply)', 'gender'],
  ['How would you describe your racial/ethnic background? (mark all that apply)', 'ethnicity'],
  ['Do you identify as transgender?', null],
  ['Are you a veteran or active member of the United States Armed Forces?', 'veteran'],
  ['Are you Hispanic/Latino?', 'hispanic'], ['Veteran Status', 'veteran'], ['Gender', 'gender'],
  ['Full name *', 'fullName'], ['Current location', 'location'], ['Current company', 'currentCompany'],
  ['LinkedIn URL', 'linkedin'], ['GitHub URL', 'github'], ['Portfolio URL', 'website'], ['Twitter URL', null],
  ['What are your compensation expectations?', 'salaryExpectation'],
  ['If this position is located in Denver, CO as Hybrid, are you willing to relocate to Denver?', 'canRelocate'],
  ['How did you hear about us?', 'referralSource'],
  ['Are you authorized to work lawfully in the United States for Ibotta?', 'authorizedToWork'],
  ['What kinds of SDK libraries have you built or maintained? *', null],
  ['Were you referred to this role by a current employee?', null],
];
for (const [label, want] of REAL) {
  const got = classifyQuestion(label, {});
  check(`classify "${label.slice(0, 60)}" → ${want}`, got === want, got);
}
check('file labelled "Attach (resume)" is the resume', classifyQuestion('Attach (resume)', { type: 'file' }) === 'resumeFile');
check('file labelled "Attach (cover_letter)" is the cover letter', classifyQuestion('Attach (cover_letter)', { type: 'file' }) === 'coverLetterFile');
check('Lever "Resume/CV ✱ ATTACH RESUME/CV" is the resume', classifyQuestion('Resume/CV ✱ ATTACH RESUME/CV', { type: 'file' }) === 'resumeFile');

const opt = l => l.map(x => ({ label: x, value: x }));
check('Yes/No from a boolean', chooseOption(opt(['Yes', 'No']), true)?.label === 'Yes' && chooseOption(opt(['Yes', 'No']), false)?.label === 'No');
check('"No" never picks "Not sure"', chooseOption(opt(['Not sure', 'No', 'Yes']), false)?.label === 'No');
check('"Prefer not to say" picks the decline option', chooseOption(opt(['Male', 'Female', 'Decline To Self Identify']), 'Prefer not to say')?.label === 'Decline To Self Identify');
check('veteran: "Not a protected veteran" maps to Ashby wording',
  chooseOption(opt(['I identify as one or more of the classifications of protected veteran listed above', 'I am not a protected veteran', 'I decline to self-identify']), 'Not a protected veteran')?.label === 'I am not a protected veteran');
check('race: Asian matches "Asian (Not Hispanic or Latino)"', chooseOption(opt(['White (Not Hispanic or Latino)', 'Asian (Not Hispanic or Latino)']), 'Asian')?.label.startsWith('Asian'));

// ─── Answer book ─────────────────────────────────────────────────────────────
const resumeText = readFileSync(new URL('../fixtures/resumes/sample-a.txt', import.meta.url), 'utf8');
const sections = extractResumeSections(resumeText);
sections.applicationDefaults = {
  authorizedToWork: true, needsSponsorship: true, workPermit: 'F-1 OPT', workPermitStatus: 'Valid', canRelocate: true,
  over18: true, salaryExpectation: '120000', gender: 'Prefer not to say', ethnicity: 'Asian', veteran: 'Not a protected veteran',
  disability: 'Prefer not to say', referralSource: 'Company website',
};
sections.personal.country = 'United States';
const book = buildAnswerBook(sections, { company: 'Testco', title: 'Data Engineer' });
check('answer book splits the name', book.firstName === 'Alex' && book.lastName === 'Rivera', [book.firstName, book.lastName]);
check('sponsorship radio answers Yes', resolveAnswer({ label: 'Will you require sponsorship?', type: 'radio', group: true, options: opt(['Yes', 'No']) }, book).value?.option.label === 'Yes');
check('Hispanic question answers No for an Asian profile', resolveAnswer({ label: 'Are you Hispanic/Latino?', tag: 'select', options: opt(['Yes', 'No', 'Decline to self identify']) }, book).value?.option.label === 'No');
check('consent checkbox stays unticked unless allowed',
  resolveAnswer({ label: 'I agree to the privacy policy *', type: 'checkbox' }, book).value === null
  && resolveAnswer({ label: 'I agree to the privacy policy *', type: 'checkbox' }, book, { acceptConsent: true }).value === true);
check('an unknown required question has no answer', resolveAnswer({ label: 'Why Testco?', tag: 'textarea', type: 'textarea' }, book).value === null);
const book2 = buildAnswerBook({ ...sections, savedAnswers: [{ question: 'Why do you want to work at Testco?', answer: 'Because of the data platform.' }] });
check('a saved answer is reused for the same question', findSavedAnswer(book2, 'Why do you want to work at Testco? *') === 'Because of the data platform.');
check('a saved answer is not reused for a different question', findSavedAnswer(book2, 'What is your notice period?') === null);

// ─── Tailoring ───────────────────────────────────────────────────────────────
const posting = { title: 'Data Engineer', description: readFileSync(new URL('../fixtures/postings/data-engineer.txt', import.meta.url), 'utf8') };
const t = tailorResume(sections, posting);
const count = s => s.experience.map(e => e.bullets.length).join(',');
check('tailoring keeps every bullet', count(t.sections) === count(sections), [count(sections), count(t.sections)]);
check('tailoring keeps titles, companies and dates', JSON.stringify(t.sections.experience.map(e => [e.title, e.company, e.startDate, e.endDate])) === JSON.stringify(sections.experience.map(e => [e.title, e.company, e.startDate, e.endDate])));
check('tailoring keeps the same bullets (only order changes)', t.sections.experience.every((e, i) => [...e.bullets].sort().join('|') === [...sections.experience[i].bullets].sort().join('|')));
const { shown } = resumeEvidence(sections);
check('tailoring adds only skills the resume shows', t.report.addedToSkills.every(s => shown.has(s.toLowerCase())), t.report.addedToSkills);
check('gaps are reported, not inserted', t.report.missingRequired.length > 0 && !JSON.stringify(t.sections.skills).includes(t.report.missingRequired[0]), t.report.missingRequired);
check('skills section moves to the top of a tailored resume', t.sectionOrder[1] === 'skills');
check("mode 'off' changes nothing", JSON.stringify(tailorResume(sections, posting, { mode: 'off' }).sections.experience) === JSON.stringify(sections.experience));

check('rewrite check rejects a new skill', /adds skills/.test(checkRewrite('Built REST APIs in Java', 'Built REST APIs in Java and Databricks', shown) || ''));
check('rewrite check rejects a new number', /adds numbers/.test(checkRewrite('Cut processing steps', 'Cut processing steps by 40%', shown) || ''));
check('rewrite check rejects JD filler', /filler/.test(checkRewrite('Built Java services for a bank.', 'Built Java services for a bank, applying builder mindset.', shown) || ''));
check('rewrite check keeps filler the original had', checkRewrite('Passionate about Java services.', 'Passionate about building Java services.', shown) === null);
check('rewrite check accepts a rewording', checkRewrite('Designed secure REST APIs with JWT auth serving 50K+ daily requests.', 'Built secure, JWT-authenticated REST APIs serving 50K+ daily requests.', shown) === null);

const firstRole = t.sections.experience[0];
// A stand-in for Ollama's HTTP API (/api/tags, /api/chat). Its "model"
// rewrites every bullet ("Built" → "Delivered") and, for the first role,
// tacks a skill the resume doesn't have onto the first bullet.
const seenPrompts = [];
const fakeOllama = createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const send = o => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.url === '/api/tags') return send({ models: [{ name: 'test-model:latest' }] });
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const prompt = body.messages.at(-1).content; seenPrompts.push({ system: body.messages[0].content, prompt, format: body.format });
  const bullets = JSON.parse(prompt.slice(prompt.lastIndexOf('Bullets:') + 8).trim());
  const isFirstRole = prompt.includes(`Role: ${firstRole.title} at ${firstRole.company}`);
  const out = bullets.map((b, i) => (isFirstRole && i === 0 ? `${b} using Databricks` : b.replace(/^\w+/, 'Delivered')));
  send({ message: { role: 'assistant', content: JSON.stringify({ bullets: out }) } });
});
await new Promise(r => fakeOllama.listen(0, '127.0.0.1', r));
const llmEnv = { OLLAMA_URL: `http://127.0.0.1:${fakeOllama.address().port}`, OLLAMA_MODEL: 'test-model' };
const status = await llmStatus({ env: llmEnv });
check('local model status sees the pulled model', status.ok && status.provider === 'ollama', status);
check('local model status explains a missing model', /ollama pull/.test((await llmStatus({ env: { ...llmEnv, OLLAMA_MODEL: 'other' } })).reason || ''));
const ai = await tailorResumeWithAI(sections, posting, { llm: { env: llmEnv } });
check('local model rewrite runs and says which model', ai.report.mode === 'ai' && ai.report.model === 'ollama:test-model', ai.report);
check('local model gets the job description and the bullets, one block at a time', seenPrompts.length >= sections.experience.length && seenPrompts.every(p => p.format === 'json' && p.prompt.includes('Posting:')), seenPrompts.length);
check('local model rewrite: a bullet that adds a skill is put back', ai.sections.experience[0].bullets[0] === firstRole.bullets[0] && ai.report.revertedBullets.some(r => /Databricks/i.test(r.reason)), ai.report.revertedBullets);
check('local model rewrite: allowed rewordings are kept', ai.report.rewrittenBullets > 0 && JSON.stringify(ai.sections).includes('Delivered'));
check('local model rewrite: bullet count, titles and dates are unchanged', count(ai.sections) === count(sections)
  && JSON.stringify(ai.sections.experience.map(e => [e.title, e.company, e.startDate, e.endDate])) === JSON.stringify(sections.experience.map(e => [e.title, e.company, e.startDate, e.endDate])));
fakeOllama.close();
const down = await tailorResumeWithAI(sections, posting, { llm: { env: { OLLAMA_URL: 'http://127.0.0.1:9', OLLAMA_MODEL: 'test-model' } } });
check('with no model running, AI mode falls back to reordering and says why', down.report.mode === 'honest' && /Ollama/.test(down.report.aiSkipped || ''), down.report.aiSkipped);
const wrongCount = await tailorResumeWithAI(sections, posting, { complete: async () => ({ json: { bullets: ['only one'] }, provider: 'x', model: 'y' }) });
check('a reply with the wrong number of bullets is ignored', count(wrongCount.sections) === count(sections) && wrongCount.report.revertedBullets.some(r => /number of bullets/.test(r.reason)));

const html = renderResumeHTML(t.sections, { sectionOrder: t.sectionOrder });
check('resume renders name, roles and bullets', html.includes('Alex Rivera') && html.includes(firstRole.title) && html.includes('<li>'));
check('rendered resume keeps the tailored section order', html.indexOf('>Skills<') < html.indexOf('>Experience<'));
check('cover letter fills {company} and {title}', renderCoverLetter('Dear {company}, re: {title}', { company: 'Testco', title: 'Data Engineer' }) === 'Dear Testco, re: Data Engineer');

// ─── Database, API and browser flow ──────────────────────────────────────────
if (process.argv.includes('--db')) await dbTests();

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);

async function dbTests() {
  const url = process.env.DATABASE_URL || '';
  if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) { console.log('SKIP db: DATABASE_URL must point at localhost'); return; }
  process.env.AUTO_APPLY_ALLOW_LOCAL = '1';
  process.env.OLLAMA_URL = 'http://127.0.0.1:9';   // no model in the flow tests: tailoring falls back without rewriting
  const { query, closePool } = await import('../lib/db.mjs');
  const { createResumeProfile, updateResumeProfile, getResumeProfile } = await import('../lib/resume-profiles.mjs');
  const { trackApplication, updateApplication, getApplication } = await import('../lib/applications.mjs');
  const engine = await import('../autoapply/engine.mjs');
  const { getBrowser, closeBrowser } = await import('../lib/resume-render.mjs');

  const USER = '00000000-0000-4000-8000-0000000a0a01';
  const MARK = 'aatest';
  const cleanup = async () => {
    await query(`DELETE FROM applications WHERE user_id = $1`, [USER]);
    await query(`DELETE FROM auto_apply_runs WHERE user_id = $1`, [USER]);
    await query(`DELETE FROM auto_apply_lanes WHERE user_id = $1`, [USER]);
    await query(`DELETE FROM auto_apply_settings WHERE user_id = $1`, [USER]);
    await query(`DELETE FROM resume_profiles WHERE user_id = $1`, [USER]);
    await query(`DELETE FROM user_job_interactions WHERE user_id = $1`, [USER]);
    await query(`DELETE FROM user_profiles WHERE user_id = $1`, [USER]);
    await query(`DELETE FROM jobs WHERE ats = $1 OR url LIKE 'http://127.0.0.1:%/aatest/%'`, [MARK]);
  };

  // Local ATS-style boards.
  const submissions = {};
  const page = name => readFileSync(new URL(`../fixtures/forms/${name}.html`, import.meta.url), 'utf8');
  const board = createServer(async (req, res) => {
    const path = req.url.split('?')[0];
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('latin1');
    const send = (code, html) => { res.writeHead(code, { 'content-type': 'text/html' }); res.end(html); };
    if (req.method === 'GET' && path.startsWith('/aatest/')) return send(200, page(path.split('/')[2]));
    if (req.method === 'POST' && path.endsWith('/submit')) {
      submissions[path.split('/')[1]] = body;
      if (path.startsWith('/lever')) { res.writeHead(303, { location: '/lever/thanks' }); return res.end(); }
      return send(200, '<h1>Thank you for applying!</h1>');
    }
    if (path === '/lever/thanks') return send(200, '<h3>Application submitted!</h3>');
    send(404, 'not found');
  });
  await new Promise(r => board.listen(0, '127.0.0.1', r));
  const boardUrl = `http://127.0.0.1:${board.address().port}`;

  await cleanup();
  const jobIds = {};
  const DESC = posting.description;
  for (const [i, [name, title]] of [['greenhouse-style', 'Data Engineer'], ['lever-style', 'Data Engineer II'], ['ashby-style', 'Backend Data Engineer'], ['captcha', 'Platform Data Engineer'], ['workday', 'Data Engineer III']].entries()) {
    const jurl = name === 'workday' ? 'https://testco.wd5.myworkdayjobs.com/en-US/careers/job/x_R-1' : `${boardUrl}/aatest/${name}?job=${i}`;
    const { rows } = await query(
      `INSERT INTO jobs (url, title, normalized_title, company, ats, role_family, canonical_role, description_clean,
                         workplace_type, employment_type, status, active, fingerprint, discovered, location)
       VALUES ($1,$2,lower($2),$3,$4,'DATA_SCIENCE','DATA_ENGINEER',$5,'REMOTE','FULL_TIME','READY',TRUE,$6,NOW(),'Remote') RETURNING id`,
      [jurl, title, `AA Co ${i}`, MARK, DESC, `aatest${String(i).padStart(10, '0')}`]);
    jobIds[name] = String(rows[0].id);
  }

  // Resume profile → matching profile.
  const rp = await createResumeProfile(USER, { name: 'Data Engineer' });
  await updateResumeProfile(USER, rp.id, { sections, coverLetter: 'Dear {company} team,\nI am applying for {title}.', resumeText: resumeText, resumeFilename: 'sample-a.txt' });
  await query(`INSERT INTO user_target_roles (user_profile_id, canonical_role, role_family, priority)
               SELECT id, 'DATA_ENGINEER', 'DATA_SCIENCE', 1 FROM user_profiles WHERE user_id = $1`, [USER]);
  await query(`UPDATE user_profiles SET current_country = 'US' WHERE user_id = $1`, [USER]);

  try {
    // Storage
    const tr = await trackApplication(USER, Number(jobIds['workday']), 'SAVED');
    let app = await getApplication(USER, tr.id);
    check('tracking a job stores a snapshot with the description', app.snapshot?.title === 'Data Engineer III' && app.snapshot.description.includes('Kafka'), app.snapshot);
    await updateApplication(USER, tr.id, { status: 'APPLIED' });
    await query(`UPDATE jobs SET description_clean = 'rewritten by a later scan' WHERE id = $1`, [jobIds['workday']]);
    await query(`DELETE FROM jobs WHERE id = $1`, [jobIds['workday']]);
    app = await getApplication(USER, tr.id);
    check('an applied job keeps its title, company and description after the job is removed',
      app.job?.title === 'Data Engineer III' && app.job.company === 'AA Co 4' && app.job.removed === true && app.snapshot.description.includes('Kafka'), app.job);
    check('status history records SAVED → APPLIED', app.events.map(e => `${e.from}>${e.to}`).join(',') === 'null>SAVED,SAVED>APPLIED', app.events);

    // Settings and lanes
    let s = await engine.getSettings(USER);
    check('auto-apply is off until turned on', s.enabled === false && s.exists === false);
    s = await engine.saveSettings(USER, { enabled: true, dailyCap: 10, perCompanyCap30d: 2 });
    check('settings save', s.enabled && s.dailyCap === 10 && s.perCompanyCap30d === 2);
    const lane = await engine.saveLane(USER, null, { name: 'Data roles', resumeProfileId: rp.id, minScore: 40, search: '', reviewBeforeSubmit: true });
    check('a lane is created with review before submit on', lane?.id && lane.reviewBeforeSubmit && lane.resumeProfileName === 'Data Engineer', lane);

    const preview = await engine.planRun(USER, { dryRun: true });
    const picked = preview.lanes[0].picked.map(p => p.jobId).sort();
    check('preview picks the fillable jobs and writes nothing',
      ['greenhouse-style', 'lever-style', 'ashby-style', 'captcha'].every(n => picked.includes(jobIds[n]))
      && (await query(`SELECT COUNT(*)::int AS n FROM applications WHERE user_id = $1 AND source = 'auto'`, [USER])).rows[0].n === 0, preview.lanes[0]);

    const browser = await getBrowser();
    if (!browser) { console.log('SKIP browser flow: no Chrome / playwright-core available'); return; }

    const run1 = await engine.runForUser(USER, {});
    check('run queues and prepares 4 applications', run1.plan.queued === 4 && run1.prepared === 4, run1);
    const stateOf = async name => (await query(`SELECT id, apply_state, apply_detail, status, tailored_resume IS NOT NULL AS t FROM applications WHERE user_id = $1 AND job_id = $2`, [USER, jobIds[name]])).rows[0];
    const gh = await stateOf('greenhouse-style'); const lv = await stateOf('lever-style'); const ab = await stateOf('ashby-style'); const cp = await stateOf('captcha');
    check('every application gets a tailored resume', [gh, lv, ab, cp].every(a => a.t));
    check('Greenhouse-style: stops on the unknown required question', gh.apply_state === 'NEEDS_YOU' && gh.apply_detail.missing.some(m => /SDK libraries/.test(m.label)), gh.apply_detail);
    check('Greenhouse-style: dropdowns, typeahead and uploads were filled',
      ['authorizedToWork', 'needsSponsorship', 'location', 'resumeFile', 'coverLetterFile', 'gender', 'veteran'].every(k => gh.apply_detail.filled.some(f => f.key === k)), gh.apply_detail.filled);
    check('Lever-style: filled and waiting for review', lv.apply_state === 'NEEDS_REVIEW' && lv.apply_detail.filled.some(f => f.key === 'over18'), lv.apply_detail);
    check('Ashby-style: Yes/No buttons answered, waiting for review', ab.apply_state === 'NEEDS_REVIEW'
      && ab.apply_detail.filled.some(f => f.key === 'authorizedToWork' && f.value === 'Yes') && ab.apply_detail.filled.some(f => f.key === 'needsSponsorship' && f.value === 'Yes'), ab.apply_detail);
    check('a visible CAPTCHA hands the application to the person', cp.apply_state === 'NEEDS_YOU' && /reCAPTCHA/.test(cp.apply_detail.reason), cp.apply_detail);
    check('nothing was sent while review is on', Object.keys(submissions).length === 0, Object.keys(submissions));

    // The person answers and approves.
    const ans = await engine.answerApplication(USER, String(gh.id), { answers: { 'What kinds of SDK libraries have you built or maintained?': 'Java and Python client SDKs for internal REST APIs.' }, remember: true });
    check('answering stores the answer and queues it', ans.ok && ans.answered === 1);
    check('the answer is saved to the resume profile for next time', (await getResumeProfile(USER, rp.id)).sections.savedAnswers.some(a => /SDK libraries/.test(a.question)));
    await engine.answerApplication(USER, String(lv.id), { answers: {}, approve: true });
    await engine.answerApplication(USER, String(ab.id), { answers: {}, approve: true });

    await engine.runForUser(USER, {});
    const gh2 = await stateOf('greenhouse-style'); const lv2 = await stateOf('lever-style'); const ab2 = await stateOf('ashby-style');
    check('approved applications are sent', gh2.apply_state === 'SUBMITTED' && lv2.apply_state === 'SUBMITTED' && ab2.apply_state === 'SUBMITTED', [gh2.apply_state, gh2.apply_detail?.reason, lv2.apply_state, lv2.apply_detail?.reason, ab2.apply_state, ab2.apply_detail?.reason]);
    check('sent applications move to Applied in the tracker', [gh2, lv2, ab2].every(a => a.status === 'APPLIED'));
    const g = submissions.greenhouse || '';
    check('Greenhouse-style submission carries name, answers and the tailored PDF',
      /name="first_name"\r\n\r\nAlex/.test(g) && /name="question_2"\r\n\r\nYes/.test(g) && /name="question_3"\r\n\r\nYes/.test(g)
      && /name="location"\r\n\r\nDallas/.test(g) && /filename="Alex_Rivera_Resume\.pdf"/.test(g) && /application\/pdf/.test(g) && /SDK libraries|client SDKs/.test(g), g.slice(0, 400));
    const l = submissions.lever || '';
    check('Lever-style submission carries full name, sponsorship and 18+',
      /name="name"\r\n\r\nAlex Rivera/.test(l) && /name="cards\[q1\]\[field0\]"\r\n\r\nYes/.test(l) && /name="cards\[q2\]\[field0\]"\r\n\r\nYes/.test(l) && /filename="Alex_Rivera_Resume\.pdf"/.test(l), l.slice(0, 300));
    const a = JSON.parse(submissions.ashby || '{}');
    check('Ashby-style submission carries buttons, salary, EEO and resume',
      a.auth === 'yes' && a.spons === 'yes' && a.comp === '120000' && a.gender === 'Decline' && a.veteran === '2' && /Resume\.pdf$/.test(a.resume || ''), a);

    const detail = await getApplication(USER, String(gh.id));
    check('the application keeps the tailored resume, letter and history',
      detail.tailoredResume?.report && detail.coverLetter.includes('AA Co 0') && detail.events.some(e => e.to === 'SUBMITTED') && detail.submittedAt, detail.events);

    const s2 = await engine.saveSettings(USER, { dailyCap: 4 });
    const p2 = await engine.planRun(USER, { dryRun: true });
    check('the daily cap counts today\'s auto applications', s2.dailyCap === 4 && p2.capLeft === 0, p2);

    // API
    const PORT = 3995;
    const srv = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let srvLog = ''; srv.stderr.on('data', d => { srvLog += d; }); srv.stdout.on('data', d => { srvLog += d; });
    try {
      const base = `http://localhost:${PORT}/v1`;
      for (let i = 0; i < 60; i++) { try { await fetch(`${base}/health`); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
      const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
      let c = await call('GET', `/users/${USER}/auto-apply`);
      check('GET auto-apply returns settings, lanes and counts', c.body.enabled && c.body.lanes.length === 1 && c.body.counts.SUBMITTED === 3 && c.body.counts.NEEDS_YOU === 1, c.body.counts);
      c = await call('POST', `/users/${USER}/auto-apply/lanes`, { name: 'Backend', minScore: 75, workplaceTypes: ['REMOTE', 'bogus'] });
      check('POST lane validates input', c.status === 201 && c.body.workplaceTypes.join() === 'REMOTE' && c.body.minScore === 75, c.body);
      c = await call('PATCH', `/users/${USER}/auto-apply/lanes/${c.body.id}`, { enabled: false });
      check('PATCH lane', c.status === 200 && c.body.enabled === false);
      c = await call('DELETE', `/users/${USER}/auto-apply/lanes/${c.body.id}`);
      check('DELETE lane', c.body.deleted === true);
      c = await call('POST', `/users/${USER}/auto-apply/preview`);
      check('POST preview is a dry run', c.status === 200 && Array.isArray(c.body.lanes));
      c = await call('GET', `/users/${USER}/applications/${gh.id}`);
      check('GET application returns snapshot, events and tailored resume', c.body.snapshot?.description && c.body.events.length >= 3 && c.body.tailoredResume?.sections, Object.keys(c.body));
      const r = await fetch(`${base}/users/${USER}/applications/${gh.id}/resume`);
      const rh = await r.text();
      check('GET …/resume renders the tailored resume', r.status === 200 && rh.includes('Alex Rivera') && rh.indexOf('>Skills<') < rh.indexOf('>Experience<'));
      const rp2 = await fetch(`${base}/users/${USER}/applications/${gh.id}/resume?format=pdf`);
      check('GET …/resume?format=pdf returns a PDF', rp2.status === 200 && rp2.headers.get('content-type') === 'application/pdf', [rp2.status, rp2.status === 200 ? '' : await rp2.text(), srvLog.slice(-400)]);
      const manual = await call('POST', `/users/${USER}/applications`, { jobId: jobIds['lever-style'] });
      c = await call('POST', `/users/${USER}/applications/${manual.body.id}/tailor`, { mode: 'honest' });
      check('POST …/tailor tailors a manually tracked job', c.status === 200 && c.body.report.mode === 'honest' && c.body.application.hasTailoredResume, c.body);
      c = await call('POST', `/users/${USER}/applications/${cp.id}/skip`);
      check('POST …/skip archives it', c.body.applyState === 'SKIPPED' && c.body.status === 'ARCHIVED', c.body);
    } finally { srv.kill('SIGKILL'); }
  } finally {
    await closeBrowser();
    board.close();
    await cleanup();
    await closePool();
  }
}
