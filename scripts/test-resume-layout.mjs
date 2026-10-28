/**
 * Resume layout and the Resume tab's preview/editor API (docs/profile.md, "Resume layout").
 *
 *   node scripts/test-resume-layout.mjs
 *   DATABASE_URL=postgres://postgres@localhost:5432/jobs_test node scripts/test-resume-layout.mjs --db
 */
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { normalizeLayout, resolveOrder } from '../lib/resume-layout.mjs';
import { renderResumeHTML, renderResumePDF, closeBrowser } from '../lib/resume-render.mjs';
import { extractResumeSections } from '../lib/resume-extract.mjs';
import { diffResumes } from '../lib/resume-diff.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}
const sections = extractResumeSections(readFileSync(`${ROOT}fixtures/resumes/sample-a.txt`, 'utf8'));
sections.custom = [{ title: 'Awards', body: 'Hackathon winner, 2024' }];

// Layout normalization
const L = normalizeLayout({ template: 'nope', font: 'Comic Sans', size: 99, align: 'justify', onePage: true, hidden: ['projects', 'bogus'], hiddenLinks: ['phone', 'x'], order: ['skills', 'custom:0', 'evil'] });
check('layout: unknown values fall back, size is clamped, lists are filtered', L.template === 'classic' && L.font === 'Arial' && L.size === 12 && L.align === 'justify' && L.onePage
  && L.hidden.join() === 'projects' && L.hiddenLinks.join() === 'phone' && L.order.join() === 'skills,custom:0', L);
check('order: the user\'s order wins, missing sections follow, hidden ones are left out',
  resolveOrder(sections, { order: ['skills', 'custom:0'], hidden: ['projects'] }).join() === 'skills,custom:0,summary,experience,education,certifications');
check('order: without a user order, the order tailoring chose is used', resolveOrder(sections, {}, ['summary', 'skills', 'experience', 'projects', 'education', 'certifications', 'custom'])[1] === 'skills');

// Rendering
const html = renderResumeHTML(sections, { layout: { template: 'compact', font: 'Georgia', size: 11, hidden: ['projects'], hiddenLinks: ['phone'], linksAsLabels: true, order: ['custom:0'] } });
check('header: centered by default, left when chosen', normalizeLayout({}).header === 'center' && renderResumeHTML(sections).includes('header { text-align: center; }') && renderResumeHTML(sections, { layout: { header: 'left' } }).includes('header { text-align: left; }'));
check('render: font and size applied', html.includes('Georgia, serif') && html.includes('--fs: 11pt'));
check('render: hidden section and hidden header link left out', !/<h2>Projects<\/h2>/.test(html) && !html.includes('555-0142'));
check('render: links shown as labels, still clickable', />LinkedIn<\/a>/.test(html) && html.includes('href="https://linkedin.com/in/alexrivera"'));
check('render: custom section placed first after the header', html.indexOf('Awards') < html.indexOf('>Summary<'));
const ed = renderResumeHTML({ ...sections, experience: [...sections.experience, { company: '', title: '', bullets: [''] }] }, { editable: true });
check('editor: every field carries its path, blank new entries stay', ed.includes('data-path="experience.0.bullets.1"') && ed.includes('data-path="experience.2.title"') && ed.includes('contenteditable="plaintext-only"'));
check('editor: controls to add and delete bullets and entries', ed.includes('data-act="add-bullet" data-key="experience.0"') && ed.includes('data-act="del-bullet"') && ed.includes('data-act="add-entry" data-key="projects"'));
check('editor: no fit-to-one-page script while editing', !renderResumeHTML(sections, { editable: true, layout: { onePage: true } }).includes('fitSize'));

// What changed (lib/resume-diff.mjs)
const tailored = structuredClone(sections);
const e0 = tailored.experience[0];
const origFirst = e0.bullets[0];
e0.bullets = [e0.bullets[1], e0.bullets[0].replace(/\.$/, ', feeding Kafka events to downstream services.'), 'Wrote Terraform modules for AWS infrastructure.'];
tailored.summary = sections.summary + ' Ships Kafka pipelines.';
tailored.skills[0].items = [...tailored.skills[0].items, 'Terraform'];
const d = diffResumes(sections, tailored);
check('changes: a reordered bullet counts as kept, a reworded one keeps its original, a new one is marked new',
  d.changes['experience.0.bullets.1']?.type === 'edited' && d.changes['experience.0.bullets.1'].original === origFirst && d.changes['experience.0.bullets.2']?.type === 'added' && !d.changes['experience.0.bullets.0'], d.changes);
check('changes: summary and added skills are listed', d.changes.summary?.type === 'edited' && d.counts.skillsAdded === 1 && d.list.some(x => x.type === 'skill' && x.text === 'Terraform'), d.counts);
const ch = renderResumeHTML(tailored, { changes: d });
check('changes page: highlights with the original text, a summary bar, and nothing of it in print', ch.includes(`data-orig="${origFirst.replace(/&/g, '&amp;')}"`) && ch.includes('What changed for this job') && /@media print \{ \.chg-bar/.test(ch));
check('changes page: the normal resume has no highlights', !renderResumeHTML(tailored).includes('mark class="chg'));

// Fit to one page, printed
const long = structuredClone(sections);
long.experience = Array.from({ length: 4 }, (_, i) => ({ ...sections.experience[0], company: `Company ${i}`, bullets: Array(5).fill('Built and ran services in Java and Spring Boot for payments, with Kafka events and PostgreSQL storage.') }));
const pdfFit = await renderResumePDF(renderResumeHTML(long, { layout: { onePage: true } }));
const pdfNo = await renderResumePDF(renderResumeHTML(long, { layout: { onePage: false } }));
if (pdfFit && pdfNo) {
  const pages = b => (b.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  check('PDF: "Fit to one page" shrinks a long resume onto one page', pages(pdfFit) === 1 && pages(pdfNo) >= 2, [pages(pdfFit), pages(pdfNo)]);
} else console.log('SKIP  PDF checks: no headless browser');

if (process.argv.includes('--db')) await dbTests();
await closeBrowser();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);

async function dbTests() {
  const url = process.env.DATABASE_URL || '';
  if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) { console.log('SKIP  --db: DATABASE_URL must point at localhost'); failures++; return; }
  const { query, closePool } = await import('../lib/db.mjs');
  const USER = '00000000-0000-4000-8000-0000000071a0';
  const PORT = 3996; const base = `http://localhost:${PORT}`;
  const server = spawn(process.execPath, ['api/server.mjs', '--port', String(PORT)], { cwd: ROOT, env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    await query(`DELETE FROM resume_profiles WHERE user_id = $1`, [USER]);
    for (let i = 0; i < 60; i++) { try { await fetch(`${base}/health`); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
    const call = async (method, path, body) => { const r = await fetch(base + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, type: r.headers.get('content-type'), text: await r.text() }; };
    let r = await call('POST', `/users/${USER}/resume-profiles`, { name: 'Default', sections });
    const id = JSON.parse(r.text).id;
    check('API: a new profile has the default layout', JSON.parse(r.text).layout?.template === 'classic', JSON.parse(r.text).layout);
    r = await call('PATCH', `/users/${USER}/resume-profiles/${id}`, { layout: { template: 'compact', hidden: ['projects'] } });
    r = await call('PATCH', `/users/${USER}/resume-profiles/${id}`, { layout: { size: 11 } });
    const prof = JSON.parse(r.text);
    check('API: layout changes are saved and merged', prof.layout.template === 'compact' && prof.layout.hidden.join() === 'projects' && prof.layout.size === 11, prof.layout);
    r = await call('GET', `/users/${USER}/resume-profiles/${id}/resume`);
    check('API: the resume page uses the saved layout', r.status === 200 && /text\/html/.test(r.type) && r.text.includes('font-variant: small-caps') && !/<h2>Projects<\/h2>/.test(r.text));
    r = await call('POST', `/users/${USER}/resume-profiles/${id}/render`, { edit: true, sections: { experience: [{ company: 'Draft Co', title: '', bullets: ['', 'Draft bullet'] }] } });
    check('API: preview of unsaved edits, without saving them', r.text.includes('Draft Co') && r.text.includes('data-path="experience.0.bullets.0"')
      && !(await call('GET', `/users/${USER}/resume-profiles/${id}`)).text.includes('Draft Co'));
    // The uploaded file, kept for download
    const pdfBytes = Buffer.from('%PDF-1.4\n% test resume file\n%%EOF\n');
    let up = await fetch(`${base}/users/${USER}/resume-profiles/${id}/original`, { method: 'PUT', headers: { 'content-type': 'application/pdf', 'x-filename': encodeURIComponent('Résumé Final.pdf') }, body: pdfBytes });
    check('upload: the file itself is kept', up.status === 200 && (await up.json()).bytes === pdfBytes.length);
    up = await fetch(`${base}/users/${USER}/resume-profiles/${id}/original`, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: Buffer.from('x') });
    check('upload: other file types are refused', up.status === 415);
    const dl = await fetch(`${base}/users/${USER}/resume-profiles/${id}/original`);
    const got = Buffer.from(await dl.arrayBuffer());
    check('download: the same bytes, type and name come back', dl.status === 200 && got.equals(pdfBytes) && dl.headers.get('content-type') === 'application/pdf'
      && /attachment/.test(dl.headers.get('content-disposition')) && dl.headers.get('content-disposition').includes(encodeURIComponent('Résumé Final.pdf')), dl.headers.get('content-disposition'));
    check('download: ?inline=1 opens it in the browser', /^inline/.test((await fetch(`${base}/users/${USER}/resume-profiles/${id}/original?inline=1`)).headers.get('content-disposition')));
    check('profile: says which file is kept', JSON.parse((await call('GET', `/users/${USER}/resume-profiles/${id}`)).text).originalFile?.name === 'Résumé Final.pdf');
    r = await call('GET', `/users/${USER}/resume-profiles/${id}/resume?format=pdf`);
    check('API: download as PDF', r.status === 200 && (/application\/pdf/.test(r.type) || /text\/html/.test(r.type)), r.type);
  } finally {
    server.kill();
    await query(`DELETE FROM resume_profiles WHERE user_id = $1`, [USER]);
    const { rows: left } = await query(`SELECT COUNT(*)::int AS n FROM resume_files WHERE user_id = $1`, [USER]);
    check('deleting a profile deletes its file', left[0].n === 0);
    await closePool();
  }
}
