/**
 * Deterministic education-requirement extraction.
 *
 * Canonical levels: NONE, HIGH_SCHOOL, ASSOCIATE, BACHELORS, MASTERS,
 * DOCTORATE, UNKNOWN. Distinguishes REQUIRED vs PREFERRED and detects
 * "or equivalent experience" phrasing. Never assumes a degree when none is
 * stated — absence of a match returns UNKNOWN, not NONE.
 */
export const EDUCATION_EXTRACTOR_VERSION = 'education-v1';

export const EDUCATION_LEVELS = ['NONE', 'HIGH_SCHOOL', 'ASSOCIATE', 'BACHELORS', 'MASTERS', 'DOCTORATE', 'UNKNOWN'];

const LEVEL_PATTERNS = [
  { level: 'DOCTORATE', re: /\b(ph\.?d\.?|doctorate|doctoral degree)\b/i },
  { level: 'MASTERS', re: /\b(master'?s?( degree)?|\bmba\b|m\.s\.|m\.a\.)\b/i },
  { level: 'BACHELORS', re: /\b(bachelor'?s?( degree)?|\bb\.?s\.?\b|\bb\.?a\.?\b|undergraduate degree|4[- ]year degree)\b/i },
  { level: 'ASSOCIATE', re: /\b(associate'?s?( degree)?|\ba\.?a\.?\b|2[- ]year degree)\b/i },
  { level: 'HIGH_SCHOOL', re: /\b(high school diploma|ged\b|high school degree)\b/i },
];

const EQUIVALENT_EXPERIENCE_RE = /\bor equivalent (?:work )?experience\b|\bor equivalent combination of education and experience\b|\bin lieu of a degree\b|\bequivalent practical experience\b/i;
const PREFERRED_RE = /\bpreferred\b|\bnice to have\b|\ba plus\b|\bideally\b|\bbonus\b/i;
const REQUIRED_RE = /\brequired\b|\bmust have\b|\bminimum qualification\b|\bmandatory\b/i;

const WINDOW_CHARS = 90;
const EVIDENCE_CHARS = 80;
const LEVEL_RANK = { DOCTORATE: 5, MASTERS: 4, BACHELORS: 3, ASSOCIATE: 2, HIGH_SCHOOL: 1 };

function excerpt(text, index, matchLength) {
  const start = Math.max(0, index - EVIDENCE_CHARS);
  const end = Math.min(text.length, index + matchLength + EVIDENCE_CHARS);
  let s = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) s = '…' + s;
  if (end < text.length) s += '…';
  return s;
}

export function classifyEducation(description = '') {
  const text = String(description);
  const candidates = [];

  for (const { level, re } of LEVEL_PATTERNS) {
    const globalRe = new RegExp(re.source, 'gi');
    let m;
    while ((m = globalRe.exec(text))) {
      const index = m.index;
      const matchLength = m[0].length;
      const windowStart = Math.max(0, index - WINDOW_CHARS);
      const windowEnd = Math.min(text.length, index + matchLength + WINDOW_CHARS);
      const window = text.slice(windowStart, windowEnd);

      const equivalentExperienceAccepted = EQUIVALENT_EXPERIENCE_RE.test(window);
      const preferred = PREFERRED_RE.test(window);
      const required = REQUIRED_RE.test(window);
      // Default to REQUIRED when a degree is named without explicit
      // "preferred" language — most postings that name a degree do require
      // it — but never invent a level that wasn't named at all.
      const requirement = preferred && !required ? 'PREFERRED' : 'REQUIRED';

      candidates.push({
        level, index, requirement, equivalentExperienceAccepted,
        confidence: preferred || required ? 0.85 : 0.65,
        evidence: excerpt(text, index, matchLength),
      });
    }
  }

  if (candidates.length === 0) {
    return { level: 'UNKNOWN', requirement: 'UNKNOWN', equivalentExperienceAccepted: false, confidence: null, evidence: null, extractorVersion: EDUCATION_EXTRACTOR_VERSION };
  }

  // "Master's or PhD preferred" / "Bachelor's or Master's" — take the
  // highest-ranked level mentioned; REQUIRED wins over PREFERRED if both
  // appear (a posting requiring a Bachelor's while preferring a Master's
  // should report the Bachelor's as the binding requirement).
  candidates.sort((a, b) =>
    (a.requirement === 'REQUIRED' ? -1 : 0) - (b.requirement === 'REQUIRED' ? -1 : 0)
    || LEVEL_RANK[b.level] - LEVEL_RANK[a.level]
  );
  const best = candidates[0];
  return {
    level: best.level,
    requirement: best.requirement,
    equivalentExperienceAccepted: best.equivalentExperienceAccepted,
    confidence: best.confidence,
    evidence: best.evidence,
    extractorVersion: EDUCATION_EXTRACTOR_VERSION,
  };
}
