/**
 * Extracts skills from a job description using the taxonomy in
 * data/skills-taxonomy.json (see lib/skill-taxonomy.mjs for the compiled
 * matchers). Importance (REQUIRED/PREFERRED/MENTIONED) is classified from
 * bounded context around each match — a labeled section header when one
 * precedes the match, otherwise a local keyword window — never from
 * whether a requirement phrase appears anywhere in the whole description.
 */
import { loadTaxonomy, getTaxonomyVersion } from './skill-taxonomy.mjs';

const REQUIRED_SECTION_RE = /\b(requirements?|required qualifications?|minimum qualifications?|basic qualifications?|must[- ]haves?|must possess|what you.?ll need|what you bring|you have)\s*:/gi;
const PREFERRED_SECTION_RE = /\b(preferred qualifications?|nice[- ]to[- ]haves?|bonus points?|desirable|pluses?|preferred skills?|great to have)\s*:/gi;

const REQUIRED_WINDOW_RE = /\b(required|requirements?|minimum qualifications?|basic qualifications?|must have|must possess|you have|at least)\b/i;
const PREFERRED_WINDOW_RE = /\b(preferred|nice to have|bonus|desirable|\bplus\b|preferred qualifications?)\b/i;

const WINDOW_CHARS = 250;    // how far to look for require/prefer keywords when no section header precedes a match
const EVIDENCE_CHARS = 70;   // excerpt radius stored as evidence
// Deliberately tight: exclude phrases are meant to catch text directly
// abutting the match (R&D, C++, Go-to-market), not merely nearby — a wide
// window would also suppress a genuine, distinct mention of the same token
// elsewhere in the same sentence (e.g. "...R&D preferred. Experience with R
// and Python...").
const EXCLUDE_WINDOW_CHARS = 15;

const IMPORTANCE_RANK = { REQUIRED: 3, PREFERRED: 2, MENTIONED: 1 };

// All section-header occurrences in the text, in order, each tagging
// everything from its position until the next header.
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

function windowImportance(text, index, matchLength) {
  const start = Math.max(0, index - WINDOW_CHARS);
  const end = Math.min(text.length, index + matchLength + WINDOW_CHARS);
  const window = text.slice(start, end);
  if (REQUIRED_WINDOW_RE.test(window)) return 'REQUIRED';
  if (PREFERRED_WINDOW_RE.test(window)) return 'PREFERRED';
  return 'MENTIONED';
}

function extractEvidence(text, index, matchLength) {
  const start = Math.max(0, index - EVIDENCE_CHARS);
  const end = Math.min(text.length, index + matchLength + EVIDENCE_CHARS);
  let excerpt = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) excerpt = '…' + excerpt;
  if (end < text.length) excerpt += '…';
  return excerpt;
}

function excludedNear(text, index, matchLength, excludeList) {
  if (!excludeList.length) return false;
  const start = Math.max(0, index - EXCLUDE_WINDOW_CHARS);
  const end = Math.min(text.length, index + matchLength + EXCLUDE_WINDOW_CHARS);
  const window = text.slice(start, end).toLowerCase();
  return excludeList.some(phrase => window.includes(phrase.toLowerCase()));
}

// description_clean is not fully HTML-entity-decoded at the source (found
// during backfill spot-checking — "R&D" is stored as "R&amp;D", "&nbsp;"
// appears literally throughout), which silently broke punctuation-based
// exclude phrases like R's "R&D". Decoding the common entities here fixes
// exclude matching and incidentally makes evidence excerpts more readable.
const HTML_ENTITIES = { '&amp;': '&', '&nbsp;': ' ', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" };
function decodeHtmlEntities(text) {
  return text.replace(/&(?:amp|nbsp|lt|gt|quot|#39|apos);/g, m => HTML_ENTITIES[m]);
}

export function extractSkills(description = '') {
  const text = decodeHtmlEntities(String(description));
  if (!text.trim()) return [];

  const { matchers, skillByNormalizedName } = loadTaxonomy();
  const sectionMarks = buildSectionMap(text);
  const bestBySkill = new Map();

  for (const { regex, normalizedName } of matchers) {
    const skill = skillByNormalizedName.get(normalizedName);
    if (!skill) continue;
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(text))) {
      const index = m.index;
      const matchLength = m[0].length;
      if (excludedNear(text, index, matchLength, skill.exclude)) continue;

      const sectionTag = sectionTagAt(sectionMarks, index);
      const importance = sectionTag || windowImportance(text, index, matchLength);
      // A section header corroborates the mention is a deliberate
      // requirement/preference, not incidental text — small confidence bump.
      const confidence = sectionTag ? Math.min(0.95, skill.baseConfidence + 0.1) : skill.baseConfidence;

      const candidate = {
        name: skill.normalizedName,
        canonicalName: skill.canonicalName,
        category: skill.category,
        importance,
        confidence,
        evidence: extractEvidence(text, index, matchLength),
      };

      const existing = bestBySkill.get(skill.normalizedName);
      const better = !existing
        || IMPORTANCE_RANK[candidate.importance] > IMPORTANCE_RANK[existing.importance]
        || (IMPORTANCE_RANK[candidate.importance] === IMPORTANCE_RANK[existing.importance] && candidate.confidence > existing.confidence);
      if (better) bestBySkill.set(skill.normalizedName, candidate);
    }
  }

  return [...bestBySkill.values()];
}

export const skillExtractorVersion = getTaxonomyVersion();
