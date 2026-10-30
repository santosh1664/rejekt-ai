/**
 * Resume and cover-letter rendering.
 *
 * The resume is one column, real text, standard headings and no tables or
 * images, which is what ATS parsers read reliably. renderResumePDF() prints
 * that HTML with a headless browser (playwright-core, using installed Chrome
 * or CHROME_PATH); without one, callers serve the HTML and the browser's
 * "Save as PDF" does the rest.
 */
import { withDefaults, forEditing } from './resume-profiles.mjs';
import { normalizeLayout, resolveOrder, FONTS } from './resume-layout.mjs';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtMonth(ym) {
  const m = String(ym || '').match(/^(\d{4})(?:-(\d{2}))?$/);
  if (!m) return ym || '';
  return m[2] ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : m[1];
}
const range = (a, b, current) => [fmtMonth(a), current ? 'Present' : fmtMonth(b)].filter(Boolean).join(' – ');
const link = u => (u ? String(u).replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '') : '');

/**
 * renderResumeHTML(sections, opts)
 *   sectionOrder  the order tailoring chose for a job (used unless the user set their own)
 *   layout        the profile's layout (lib/resume-layout.mjs): template, font, size,
 *                 alignment, fit to one page, hidden/ordered sections, header links
 *   editable      marks every field contenteditable with data-path="experience.0.bullets.2"
 *                 and adds the edit controls the Resume tab drives (public/app)
 */
export function renderResumeHTML(sections, { sectionOrder = null, title = null, layout = null, editable = false, changes = null } = {}) {
  const s = editable ? forEditing(sections) : withDefaults(sections);
  const p = s.personal;
  const L = normalizeLayout(layout || {});
  const ed = editable;
  // A field: plain text, or a contenteditable span carrying its path in edit mode.
  const f = (path, value, ph = '', tag = 'span', cls = '') => ed
    ? `<${tag} class="f${cls ? ` ${cls}` : ''}" data-path="${path}" data-ph="${esc(ph)}" contenteditable="plaintext-only" spellcheck="true">${esc(value)}</${tag}>`
    : (value ? `<${tag}${cls ? ` class="${cls}"` : ''}>${esc(value)}</${tag}>` : '');
  const dateText = (ym, cur) => (cur ? 'Present' : fmtMonth(ym));
  const dates = (base, e, withCurrent = true) => ed
    ? `<span class="dates">${f(`${base}.startDate`, fmtMonth(e.startDate), 'Start')} – ${f(`${base}.endDate`, withCurrent ? dateText(e.endDate, e.current) : fmtMonth(e.endDate), withCurrent ? 'Present' : 'End')}</span>`
    : esc(range(e.startDate, e.endDate, withCurrent && e.current));
  // "What changed" view (lib/resume-diff.mjs): reworded and new text is marked; clicking shows the original.
  const C = !editable && changes ? changes.changes || {} : null;
  const mark = (path, html) => {
    const c = C?.[path]; if (!c) return html;
    const label = c.type === 'edited' ? 'Reworded for this job' : 'Added for this job';
    return `<mark class="chg ${c.type}" tabindex="0" data-kind="${label}"${c.original ? ` data-orig="${esc(c.original)}"` : ''}>${html}</mark>`;
  };
  const ctl = (act, key, label, cls = 'ed-btn') => (ed ? `<button type="button" class="${cls}" data-act="${act}" data-key="${key}" aria-label="${esc(label)}" title="${esc(label)}">${act.startsWith('del') ? '×' : esc(label)}</button>` : '');
  const bullets = (base, list) => {
    if (!list?.length && !ed) return '';
    return `<ul${ed ? ` data-list="${base}.bullets"` : ''}>${(list || []).map((b, i) => ed
      ? `<li data-index="${i}"><span class="grip" draggable="true" title="Drag to reorder" aria-hidden="true">⋮⋮</span>${f(`${base}.bullets.${i}`, b, 'Describe what you did and the result')}${ctl('del-bullet', `${base}.bullets.${i}`, 'Delete bullet', 'ed-x')}</li>`
      : `<li>${mark(`${base}.bullets.${i}`, esc(b))}</li>`).join('')}</ul>${ctl('add-bullet', base, '+ Add bullet', 'ed-add')}`;
  };
  const heading = (key, label) => `<h2${ed ? ` data-section="${key}"` : ''}>${esc(label)}</h2>`;
  const compact = L.template === 'compact';

  const blocks = {
    summary: () => (s.summary || ed) ? `<section>${heading('summary', 'Summary')}${ed ? f('summary', s.summary, 'A short professional summary', 'p', 'para') : `<p class="para">${mark('summary', esc(s.summary))}</p>`}</section>` : '',
    experience: () => (s.experience.length || ed) ? `<section>${heading('experience', 'Experience')}${s.experience.map((e, i) => {
      const b = `experience.${i}`;
      const where = ed ? `${f(`${b}.company`, e.company, 'Company')}<span class="sep">, </span>${f(`${b}.location`, e.location, 'Location', 'span', 'loc')}` : esc([e.company, e.location].filter(Boolean).join(', '));
      const head = compact
        ? `<div class="row"><b>${ed ? f(`${b}.company`, e.company, 'Company') : esc(e.company)}</b><span>${dates(b, e)}</span></div>
           <div class="row sub"><i>${ed ? f(`${b}.title`, e.title, 'Job title') : esc(e.title)}</i><span>${ed ? f(`${b}.location`, e.location, 'Location') : esc(e.location || '')}</span></div>`
        : `<div class="row"><b>${ed ? f(`${b}.title`, e.title, 'Job title') : esc(e.title)}</b><span>${dates(b, e)}</span></div>
           <div class="row sub"><span>${where}</span></div>`;
      return `<div class="entry split">${ctl('del-entry', b, 'Delete role', 'ed-x entry-x')}${head}${bullets(b, e.bullets)}</div>`;
    }).join('')}${ctl('add-entry', 'experience', '+ Add role', 'ed-add')}</section>` : '',
    projects: () => (s.projects.length || ed) ? `<section>${heading('projects', 'Projects')}${s.projects.map((pr, i) => {
      const b = `projects.${i}`;
      const tech = ed ? ` <span class="tech">| ${f(`${b}.technologies`, (pr.technologies || []).join(', '), 'Technologies, comma separated')}</span>` : (pr.technologies?.length ? ` <span class="tech">| ${esc(pr.technologies.join(', '))}</span>` : '');
      const url = ed ? `<div class="sub">${f(`${b}.url`, pr.url, 'Link')}</div>` : (pr.url ? `<div class="sub"><a href="${esc(/^https?:/.test(pr.url) ? pr.url : `https://${pr.url}`)}">${esc(link(pr.url))}</a></div>` : '');
      return `<div class="entry split">${ctl('del-entry', b, 'Delete project', 'ed-x entry-x')}<div class="row"><b>${ed ? f(`${b}.name`, pr.name, 'Project name') : esc(pr.name)}${tech}</b><span>${(pr.startDate || pr.endDate || ed) ? dates(b, pr, false) : ''}</span></div>${url}${bullets(b, pr.bullets)}</div>`;
    }).join('')}${ctl('add-entry', 'projects', '+ Add project', 'ed-add')}</section>` : '',
    education: () => (s.education.length || ed) ? `<section>${heading('education', 'Education')}${s.education.map((e, i) => {
      const b = `education.${i}`;
      const degree = ed ? `${f(`${b}.degree`, e.degree, 'Degree')} in ${f(`${b}.field`, e.field, 'Field of study')}` : esc([e.degree, e.field].filter(Boolean).join(' in '));
      const school = ed ? f(`${b}.school`, e.school, 'School') : esc(e.school);
      const gpa = ed ? ` · GPA ${f(`${b}.gpa`, e.gpa, 'GPA')}` : (e.gpa ? ` · GPA ${esc(e.gpa)}` : '');
      return `<div class="entry">${ctl('del-entry', b, 'Delete education', 'ed-x entry-x')}${compact
        ? `<div class="row"><b>${school}</b><span>${dates(b, e, false)}</span></div><div class="row sub"><i>${degree}</i><span>${gpa.replace(/^ · /, '')}</span></div>`
        : `<div class="row"><b>${degree}</b><span>${dates(b, e, false)}</span></div><div class="sub">${school}${gpa}</div>`}</div>`;
    }).join('')}${ctl('add-entry', 'education', '+ Add education', 'ed-add')}</section>` : '',
    skills: () => (s.skills.some(g => g.items.length) || ed) ? `<section>${heading('skills', 'Skills')}${s.skills.map((g, i) => (g.items.length || ed)
      ? `<p class="skills">${ctl('del-entry', `skills.${i}`, 'Delete skill group', 'ed-x entry-x')}<b>${ed ? f(`skills.${i}.group`, g.group, 'Group') : esc(g.group || 'Skills')}:</b> ${ed ? f(`skills.${i}.items`, g.items.join(', '), 'Skills, comma separated') : g.items.map((x, j) => mark(`skills.${i}.items.${j}`, esc(x))).join(', ')}</p>` : '').join('')}${ctl('add-entry', 'skills', '+ Add skill group', 'ed-add')}</section>` : '',
    certifications: () => (s.certifications.length || ed) ? `<section>${heading('certifications', 'Certifications')}<ul class="plain">${s.certifications.map((c, i) => ed
      ? `<li>${ctl('del-entry', `certifications.${i}`, 'Delete certification', 'ed-x')}${f(`certifications.${i}.name`, c.name, 'Certification')} — ${f(`certifications.${i}.issuer`, c.issuer, 'Issuer')} (${f(`certifications.${i}.date`, fmtMonth(c.date), 'Date')})</li>`
      : `<li>${esc([c.name, c.issuer].filter(Boolean).join(' — '))}${c.date ? ` (${esc(fmtMonth(c.date))})` : ''}</li>`).join('')}</ul>${ctl('add-entry', 'certifications', '+ Add certification', 'ed-add')}</section>` : '',
  };
  const custom = i => {
    const c = s.custom[i]; if (!c) return '';
    return `<section>${ed ? `<h2 data-section="custom:${i}">${f(`custom.${i}.title`, c.title, 'Section title')}</h2>` : `<h2>${esc(c.title)}</h2>`}${ed ? f(`custom.${i}.body`, c.body, 'Write this section', 'p', 'para multiline') : `<p>${esc(c.body).replace(/\n/g, '<br>')}</p>`}</section>`;
  };
  const order = resolveOrder(s, L, sectionOrder);

  // Header: name, headline, contact links (the ones not hidden).
  const url = u => (/^https?:\/\//.test(u) ? u : `https://${u}`);
  const contactItems = [
    ['city', p.city, 'City'], ['state', p.state, 'State'], ['country', p.country, 'Country'],
    ['email', p.email, 'Email', `mailto:${p.email}`, 'Email'], ['phone', p.phone, 'Phone', `tel:${String(p.phone || '').replace(/[^\d+]/g, '')}`, 'Phone'],
    ['linkedin', p.linkedin, 'linkedin.com/in/you', url(p.linkedin || ''), 'LinkedIn'], ['github', p.github, 'github.com/you', url(p.github || ''), 'GitHub'],
    ['website', p.portfolio, 'yourwebsite.com', url(p.portfolio || ''), 'Website'],
  ];
  const pathOf = k => `personal.${k === 'website' ? 'portfolio' : k}`;
  let contact;
  if (ed) {
    contact = contactItems.map(([k, v, ph]) => `<span class="ci${L.hiddenLinks.includes(k) ? ' hidden-link' : ''}">${f(pathOf(k), v, ph)}</span>`).join('<span class="sep"> | </span>');
  } else {
    const shown = contactItems.filter(([k, v]) => v && !L.hiddenLinks.includes(k));
    // City, state and country read as one place.
    const place = shown.filter(([k]) => ['city', 'state', 'country'].includes(k)).map(([, v]) => esc(v)).join(', ');
    const rest = shown.filter(([k]) => !['city', 'state', 'country'].includes(k)).map(([k, v, , href, label]) =>
      `<a href="${esc(href)}">${esc(L.linksAsLabels && !['email', 'phone'].includes(k) ? label : (['email', 'phone'].includes(k) ? v : link(v)))}</a>`);
    contact = [place, ...rest].filter(Boolean).join('<span class="sep"> | </span>');
  }

  const font = FONTS[L.font];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title || `${p.fullName || 'Resume'}`)}</title>
<style>
  @page { size: Letter; margin: 0.5in 0.6in; }
  :root { --fs: ${L.size}pt; --lh: 1.36; }
  html { background: ${ed ? '#fff' : '#fff'}; }
  body { font-family: ${font}; font-size: var(--fs); line-height: var(--lh); color: #111; margin: 0; }
  .page { box-sizing: border-box; width: 8.5in; min-height: 11in; margin: 0 auto; padding: 0.5in 0.6in; background: #fff; }
  @media print { .page { width: auto; min-height: 0; padding: 0; } }
  h1 { font-size: 1.75em; line-height: 1.15; margin: 0; }
  .headline { margin: 2px 0 3px; }
  .contact { font-size: 0.92em; color: #333; }
  .contact a { color: inherit; text-decoration: none; }
  h2 { font-size: 1.05em; text-transform: uppercase; letter-spacing: .04em; border-bottom: 1px solid #999; margin: 0.9em 0 0.35em; padding-bottom: 2px; }
  .entry { margin-bottom: 0.45em; break-inside: avoid; position: relative; }
  /* Long roles and projects flow onto the next page instead of leaving a gap; headings stay with their first lines. */
  .entry.split { break-inside: auto; }
  .entry > .row, .entry > .sub { break-after: avoid; }
  .entry li { break-inside: avoid; }
  .entry ul { orphans: 2; widows: 2; }
  h2 { break-after: avoid; }
  .row { display: flex; justify-content: space-between; gap: 12px; }
  .row > span:last-child { white-space: nowrap; }
  .sub { color: #333; }
  .tech { font-weight: normal; color: #333; }
  ul { margin: 2px 0 0; padding-left: 1.3em; }
  ul.plain { padding-left: 1.1em; }
  li { margin: 1px 0; }
  p { margin: 2px 0; }
  a { color: inherit; }
  .para, li, .skills { text-align: ${L.align}; }
  header { text-align: ${L.header}; }
  /* Compact: centered header, small-caps headings, company first */
  ${compact ? `h1 { font-size: 1.95em; font-variant: small-caps; letter-spacing: .02em; }
  h2 { text-transform: none; font-variant: small-caps; font-size: 1.15em; letter-spacing: .03em; border-bottom: 1px solid #222; }
  .row.sub { font-size: .97em; }
  :root { --lh: 1.28; }` : ''}
  ${ed ? `
  .f { outline: none; border-radius: 3px; }
  h1.f, div.f, p.f { display: block; }
  span.f:empty { display: inline-block; min-width: 7ch; }
  .f:hover { background: #eef3ff; }
  .f:focus { background: #e3ebff; box-shadow: 0 0 0 1px #6b84f5; }
  .f:empty::before { content: attr(data-ph); color: #9aa3b2; }
  .multiline { white-space: pre-wrap; }
  .hidden-link { opacity: .4; }
  .ed-x { border: 0; background: none; color: #c0392b; cursor: pointer; font-size: 14px; line-height: 1; padding: 0 4px; opacity: 0; }
  li:hover .ed-x, .entry:hover > .entry-x, .skills:hover .ed-x, li:focus-within .ed-x { opacity: 1; }
  .entry-x { position: absolute; left: -22px; top: 0; }
  .skills { position: relative; } .skills > .entry-x { left: -22px; }
  .ed-add { border: 0; background: none; color: #3451d1; cursor: pointer; font: 600 11px/1.6 system-ui, sans-serif; padding: 2px 0; }
  li { position: relative; }
  .grip { position: absolute; left: -2.1em; top: 0; cursor: grab; color: #9aa3b2; font-size: 10px; letter-spacing: -2px; user-select: none; opacity: 0; padding: 0 4px; }
  li:hover .grip { opacity: 1; }
  li.drag-over { box-shadow: 0 -2px 0 #6b84f5; }
  li.dragging { opacity: .4; }` : ''}
${C ? `
  mark.chg { color: inherit; border-radius: 2px; padding: 0 1px; cursor: pointer; }
  mark.chg.edited { background: #fff1b8; box-shadow: inset 0 -2px 0 #f0b000; }
  mark.chg.added { background: #d9f2e4; box-shadow: inset 0 -2px 0 #17845a; }
  body.plain mark.chg { background: none; box-shadow: none; cursor: auto; }
  mark.chg:focus { outline: 2px solid #2b45c9; outline-offset: 1px; }
  .chg-pop { position: absolute; z-index: 10; max-width: 440px; background: #fff; color: #111; border: 1px solid #c9d0de; border-radius: 10px; box-shadow: 0 10px 30px rgba(16,26,51,.18); padding: 10px 12px; font: 13px/1.5 system-ui, -apple-system, sans-serif; }
  .chg-pop small { display: block; color: #6b7590; font-weight: 600; margin-bottom: 4px; }
  .chg-pop .was { text-decoration: line-through; text-decoration-color: rgba(192,45,69,.6); color: #3a4560; }
  @media print { .chg-pop { display: none !important; } mark.chg { background: none !important; box-shadow: none !important; } }` : ''}
</style></head><body><div class="page"><div class="content" id="content">
<header>
${ed ? f('personal.fullName', p.fullName, 'Your name', 'h1') : `<h1>${esc(p.fullName)}</h1>`}
${ed ? f('personal.headline', p.headline, 'Headline (optional)', 'div', 'headline') : (p.headline ? `<div class="headline">${esc(p.headline)}</div>` : '')}
<div class="contact">${contact}</div>
</header>
${order.map(k => (k.startsWith('custom:') ? custom(Number(k.slice(7))) : blocks[k]?.() || '')).join('\n')}
</div></div>
${C ? `<script>
(function () {
  var pop = null;
  function close() { if (pop) { pop.remove(); pop = null; } }
  function open(m) {
    close();
    if (document.body.classList.contains('plain')) return;
    pop = document.createElement('div'); pop.className = 'chg-pop'; pop.setAttribute('role', 'dialog');
    var k = document.createElement('small'); k.textContent = m.dataset.kind; pop.appendChild(k);
    if (m.dataset.orig) {
      var l = document.createElement('small'); l.textContent = 'Your original:'; l.style.marginTop = '2px'; pop.appendChild(l);
      var w = document.createElement('div'); w.className = 'was'; w.textContent = m.dataset.orig; pop.appendChild(w);
    } else { var n = document.createElement('div'); n.textContent = 'Not in your original resume.'; pop.appendChild(n); }
    document.body.appendChild(pop);
    var r = m.getBoundingClientRect(), top = r.bottom + window.scrollY + 6, left = Math.min(r.left + window.scrollX, document.documentElement.clientWidth - pop.offsetWidth - 12);
    pop.style.top = top + 'px'; pop.style.left = Math.max(8, left) + 'px';
  }
  document.addEventListener('click', function (e) { var m = e.target.closest('mark.chg'); if (m) open(m); else if (!e.target.closest('.chg-pop')) close(); });
  document.addEventListener('keydown', function (e) { var m = e.target.closest && e.target.closest('mark.chg'); if (m && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(m); } if (e.key === 'Escape') close(); });
  document.addEventListener('mouseover', function (e) { var m = e.target.closest('mark.chg'); if (m && matchMedia('(hover: hover)').matches) open(m); });
})();
</script>` : ''}
${L.onePage && !ed ? `<script>
// Fit to one page: shrink the text a little at a time until it fits (not below 8.5pt).
(function () {
  var root = document.documentElement, el = document.getElementById('content');
  var limit = 10 * 96; // 11in page minus 0.5in top and bottom margins, in CSS pixels
  var size = ${L.size}, lh = parseFloat(getComputedStyle(root).getPropertyValue('--lh')) || 1.36;
  for (var i = 0; i < 40 && el.scrollHeight > limit; i++) {
    if (lh > 1.2) lh = Math.round((lh - 0.02) * 100) / 100; else if (size > 8.5) size = Math.round((size - 0.25) * 100) / 100; else break;
    root.style.setProperty('--fs', size + 'pt'); root.style.setProperty('--lh', lh);
  }
  root.dataset.fitSize = size;
})();
</script>` : ''}
</body></html>`;
}

/** Fill {company} and {title}; returns '' when there's no template. */
export function renderCoverLetter(template, job) {
  if (!template) return '';
  return String(template).replace(/\{company\}/gi, job.company || 'your team').replace(/\{title\}/gi, job.title || 'this role');
}

let browserPromise = null;
/** Shared headless browser, or null when playwright-core or Chrome isn't available. */
export async function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      let pw;
      try { pw = await import('playwright-core'); } catch { return null; }
      const tries = [
        process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : null,
        { channel: 'chrome' },
        { executablePath: '/opt/pw-browsers/chromium' },
      ].filter(Boolean);
      for (const opt of tries) {
        try {
          // Leave Ctrl+C / SIGTERM to the app: Playwright's own handlers close the
          // browser but keep a running web server alive.
          const b = await pw.chromium.launch({ headless: process.env.AUTO_APPLY_HEADFUL !== '1', handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, ...opt });
          // A browser that crashes or is closed is relaunched on the next call.
          b.on('disconnected', () => { if (browserPromise && launched === b) browserPromise = null; });
          launched = b;
          return b;
        } catch { /* next */ }
      }
      return null;
    })();
  }
  const b = await browserPromise;
  if (b && !b.isConnected()) { browserPromise = null; return getBrowser(); }
  return b;
}
let launched = null;

export async function closeBrowser() {
  if (!browserPromise) return;
  const b = await browserPromise; browserPromise = null;
  if (b) await b.close().catch(() => {});
}

/** Print resume HTML to a PDF Buffer, or null without a browser. */
export async function renderResumePDF(html, retry = true) {
  const browser = await getBrowser();
  if (!browser) return null;
  let page;
  try {
    page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    return await page.pdf({ format: 'Letter', printBackground: true, preferCSSPageSize: true });
  } catch (err) {
    if (retry && /closed|crash|disconnected/i.test(err.message)) { browserPromise = null; return renderResumePDF(html, false); }
    throw err;
  } finally { await page?.close().catch(() => {}); }
}
