/**
 * How a resume profile is laid out on the page (docs/profile.md, "Resume
 * layout"): template, font, size, alignment, fit to one page, which sections
 * show and in what order, and which contact links appear in the header.
 * Stored per profile in resume_profiles.layout; every rendered resume (the
 * profile preview, tailored resumes, auto-apply PDFs) uses it.
 */
export const TEMPLATES = ['classic', 'compact'];
export const FONTS = {
  Arial: 'Arial, Helvetica, sans-serif',
  Calibri: 'Calibri, Carlito, "Segoe UI", sans-serif',
  Helvetica: 'Helvetica, Arial, sans-serif',
  Garamond: 'Garamond, "EB Garamond", "Times New Roman", serif',
  Georgia: 'Georgia, serif',
  'Times New Roman': '"Times New Roman", Times, serif',
};
export const SECTION_LABELS = {
  summary: 'Summary', experience: 'Work experience', projects: 'Projects', education: 'Education',
  skills: 'Skills', certifications: 'Certifications',
};
export const HEADER_LINKS = ['city', 'state', 'country', 'email', 'phone', 'linkedin', 'github', 'website'];
export const DEFAULT_ORDER = ['summary', 'experience', 'projects', 'education', 'skills', 'certifications'];

export const DEFAULT_LAYOUT = Object.freeze({
  template: 'classic', font: 'Arial', size: 10.5, align: 'left', onePage: false,
  header: 'center',     // name and contact line: 'center' or 'left'
  order: null,          // null: the default order, or the one tailoring picks for the job
  hidden: [],           // section keys left off the page ("custom:0" for custom sections)
  hiddenLinks: ['country'],
  linksAsLabels: false, // "LinkedIn" instead of linkedin.com/in/…
});

/** Section keys this resume has, including its custom sections ("custom:0", …). */
export function sectionKeys(sections) {
  return [...DEFAULT_ORDER, ...(sections?.custom || []).map((_, i) => `custom:${i}`)];
}

const validKey = k => DEFAULT_ORDER.includes(k) || /^custom:\d{1,2}$/.test(k);

export function normalizeLayout(input = {}) {
  const l = input && typeof input === 'object' ? input : {};
  const size = Number(l.size);
  const list = (v, ok) => (Array.isArray(v) ? [...new Set(v.map(String).filter(ok))].slice(0, 30) : null);
  return {
    template: TEMPLATES.includes(l.template) ? l.template : DEFAULT_LAYOUT.template,
    font: Object.hasOwn(FONTS, l.font) ? l.font : DEFAULT_LAYOUT.font,
    size: Number.isFinite(size) ? Math.min(12, Math.max(8.5, Math.round(size * 2) / 2)) : DEFAULT_LAYOUT.size,
    align: l.align === 'justify' ? 'justify' : 'left',
    header: l.header === 'left' ? 'left' : 'center',
    onePage: l.onePage === true,
    order: list(l.order, validKey),
    hidden: list(l.hidden, validKey) || [],
    hiddenLinks: list(l.hiddenLinks, k => HEADER_LINKS.includes(k)) ?? [...DEFAULT_LAYOUT.hiddenLinks],
    linksAsLabels: l.linksAsLabels === true,
  };
}

/**
 * The order sections print in: the user's own order when they set one,
 * otherwise the order tailoring chose for the job, otherwise the default.
 * Custom sections the order doesn't mention go last; hidden ones are left out.
 */
export function resolveOrder(sections, layout, tailoredOrder = null) {
  const L = normalizeLayout(layout);
  const keys = sectionKeys(sections);
  const tailored = tailoredOrder ? tailoredOrder.flatMap(k => (k === 'custom' ? keys.filter(x => x.startsWith('custom:')) : [k])) : null;
  const base = L.order || tailored || keys;
  return [...base, ...keys].filter((k, i, a) => keys.includes(k) && a.indexOf(k) === i && !L.hidden.includes(k));
}
