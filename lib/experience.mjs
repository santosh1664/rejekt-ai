/**
 * Deterministic experience-requirement extraction.
 *
 * Supports: "3-5 years", "5+ years", "at least 2 years", "minimum of seven
 * years", and distinguishes REQUIRED vs PREFERRED phrasing where the text
 * supports it. Avoids company-history false positives ("founded 10 years
 * ago", "20 years in business") via a tight exclude window around each
 * candidate match, the same approach used in lib/skill-extract.mjs.
 */
export const EXPERIENCE_EXTRACTOR_VERSION = 'experience-v1';

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};
const NUM = `(?:\\d+(?:\\.\\d+)?|${Object.keys(NUMBER_WORDS).join('|')})`;

function toNumber(raw) {
  const lower = raw.toLowerCase();
  return NUMBER_WORDS[lower] !== undefined ? NUMBER_WORDS[lower] : Number(raw);
}

// Company-history / product-age language that happens to contain "N years"
// but has nothing to do with an experience requirement.
const HISTORY_EXCLUDE = [
  'in business', 'years in business', 'founded', 'years old', 'year old',
  'years of operation', 'years of history', 'in operation', 'since 19', 'since 20',
  'years of experience serving', 'years of innovation', 'years of success',
  "company's history", 'years of growth', 'combined experience of our team',
];

const REQUIRED_SECTION_RE = /\b(requirements?|required qualifications?|minimum qualifications?|basic qualifications?|must[- ]haves?|what you.?ll need|what you bring|you have)\s*:/gi;
const PREFERRED_SECTION_RE = /\b(preferred qualifications?|nice[- ]to[- ]haves?|bonus points?|desirable|pluses?|preferred skills?|great to have)\s*:/gi;
const PREFERRED_WINDOW_RE = /\b(preferred|nice to have|a plus|bonus|ideally)\b/i;
const WINDOW_CHARS = 60;
const EXCLUDE_WINDOW_CHARS = 40;
const EVIDENCE_CHARS = 70;

function buildSectionMap(text) {
  const marks = [];
  for (const [regex, tag] of [[REQUIRED_SECTION_RE, 'REQUIRED'], [PREFERRED_SECTION_RE, 'PREFERRED']]) {
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(text))) marks.push({ index: m.index, tag });
  }
  marks.sort((a, b) => a.index - b.index);
  return marks;
}

function sectionTagAt(marks, index) {
  let tag = null;
  for (const mark of marks) {
    if (mark.index > index) break;
    tag = mark.tag;
  }
  return tag;
}

function isHistoryFalsePositive(text, index, matchLength) {
  const start = Math.max(0, index - EXCLUDE_WINDOW_CHARS);
  const end = Math.min(text.length, index + matchLength + EXCLUDE_WINDOW_CHARS);
  const window = text.slice(start, end).toLowerCase();
  return HISTORY_EXCLUDE.some(phrase => window.includes(phrase));
}

function excerpt(text, index, matchLength) {
  const start = Math.max(0, index - EVIDENCE_CHARS);
  const end = Math.min(text.length, index + matchLength + EVIDENCE_CHARS);
  let s = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) s = '…' + s;
  if (end < text.length) s += '…';
  return s;
}

const PATTERNS = [
  // "3-5 years", "3 to 5 years"
  { re: new RegExp(`(${NUM})\\s*(?:-|–|to)\\s*(${NUM})\\+?\\s*years?`, 'gi'), kind: 'range' },
  // "5+ years"
  { re: new RegExp(`(${NUM})\\+\\s*years?`, 'gi'), kind: 'plus' },
  // "at least 2 years", "at least two years"
  { re: new RegExp(`at least\\s+(${NUM})\\s*years?`, 'gi'), kind: 'min' },
  // "minimum of seven years", "a minimum of 5 years"
  { re: new RegExp(`minimum(?: of)?\\s+(${NUM})\\s*years?`, 'gi'), kind: 'min' },
  // Bare "2 years [of] experience" / "2 years preferred" — no range/plus/
  // prefix. Lowest-confidence pattern since it's the least distinctive;
  // the history-exclude window is what keeps it from matching "20 years
  // in business".
  { re: new RegExp(`(${NUM})\\s*years?\\s*(?:of\\s+)?(?:experience|preferred|required)`, 'gi'), kind: 'min' },
];

export function classifyExperience(description = '', title = '') {
  const text = `${title}\n${String(description)}`;
  const sectionMarks = buildSectionMap(text);
  const candidates = [];

  for (const { re, kind } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const index = m.index;
      const matchLength = m[0].length;
      if (isHistoryFalsePositive(text, index, matchLength)) continue;

      let min, max;
      if (kind === 'range') { min = toNumber(m[1]); max = toNumber(m[2]); }
      else if (kind === 'plus') { min = toNumber(m[1]); max = null; }
      else { min = toNumber(m[1]); max = null; }
      if (min == null || Number.isNaN(min) || (max != null && max < min)) continue;
      // min_exp_years/max_exp_years are SMALLINT — "1.5 years" is a real
      // phrasing (found via a live-corpus backfill failure) but the column
      // has no fractional precision; round rather than reject it.
      min = Math.round(min);
      if (max != null) max = Math.round(max);

      const sectionTag = sectionTagAt(sectionMarks, index);
      const windowStart = Math.max(0, index - WINDOW_CHARS);
      const windowEnd = Math.min(text.length, index + matchLength + WINDOW_CHARS);
      const windowText = text.slice(windowStart, windowEnd);
      const requirementType = sectionTag || (PREFERRED_WINDOW_RE.test(windowText) ? 'PREFERRED' : 'REQUIRED');
      const confidence = sectionTag ? 0.9 : 0.7;

      candidates.push({ index, min, max, requirementType, confidence, evidence: excerpt(text, index, matchLength) });
    }
  }

  if (candidates.length === 0) {
    return { min: null, max: null, requirementType: 'UNKNOWN', confidence: null, evidence: null, extractorVersion: EXPERIENCE_EXTRACTOR_VERSION };
  }

  // Prefer a REQUIRED-section match, then the first survivor in document order.
  candidates.sort((a, b) => (a.requirementType === 'REQUIRED' ? -1 : 0) - (b.requirementType === 'REQUIRED' ? -1 : 0) || a.index - b.index);
  const best = candidates[0];
  return {
    min: best.min,
    max: best.max,
    requirementType: best.requirementType,
    confidence: best.confidence,
    evidence: best.evidence,
    extractorVersion: EXPERIENCE_EXTRACTOR_VERSION,
  };
}
