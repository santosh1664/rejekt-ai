/**
 * Sponsorship, citizenship, and security-clearance extraction.
 *
 * Kept in one module because the three concepts sit close together in real
 * job text and share a lot of surrounding legal/eligibility language, but
 * they are deliberately NOT conflated in the output — sponsorship,
 * citizenship, and clearance are independent eligibility facts (spec Step
 * 5's explicit rule).
 */
export const SPONSORSHIP_EXTRACTOR_VERSION = 'sponsorship-v3';
export const CITIZENSHIP_EXTRACTOR_VERSION = 'citizenship-v1';
export const CLEARANCE_EXTRACTOR_VERSION = 'clearance-v1';

const EVIDENCE_CHARS = 80;
function excerpt(text, index, matchLength) {
  const start = Math.max(0, index - EVIDENCE_CHARS);
  const end = Math.min(text.length, index + matchLength + EVIDENCE_CHARS);
  let s = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) s = '…' + s;
  if (end < text.length) s += '…';
  return s;
}

// ── Sponsorship ──────────────────────────────────────────────────────────
// Critical rule (spec Step 4): absence of sponsorship language must stay
// UNKNOWN, never NO_SPONSORSHIP — most job postings simply don't mention
// sponsorship policy at all, and silence is not a policy.
// "no <word>* visa sponsorship" allows an inserted word ("work", "future")
// between "no" and "visa" — found via live-corpus quality sampling: "No
// work visa sponsorship is available" fell through this pattern's original
// stricter form to SPONSORS_RE's "sponsorship is available" instead.
// "without sponsorship" alone is deliberately scoped to visa/work-permit
// context (not left bare) — an unrelated "without sponsorship for an
// export license" (ITAR/export-control context, nothing to do with
// employment visas) was otherwise misread as NO_SPONSORSHIP.
const NO_SPONSORSHIP_RE = /\b(we do not|does not|do not|won'?t|will not|unable to|cannot)\s+(?:currently\s+)?(?:provide|offer|sponsor)\b[^.]{0,40}\bvisas?\b|\bno\s+(?:\w+\s+){0,2}?(?:visa\s+)?sponsorship\b|\bwithout\s+(?:current or future\s+)?(?:visa|work permit)\s+sponsorship\b|\bnot sponsor(?:ing)?\b[^.]{0,30}\bvisas?\b|\b(?:visa|work permit)(?:\/work permit)? sponsorship (?:is )?not (?:available|provided|offered)\b|\bsponsorship (?:is )?not (?:available|provided|offered)\b/i;
// Negative lookbehind rejects "no ... sponsorship is/are available" so a
// negated sentence (checked above) never also matches here — this pattern
// only fires on an un-negated, affirmative statement.
const SPONSORS_RE = /(?<!no\s)(?<!not\s)\bsponsorship (?:is )?available\b|\bwill sponsor\b|\bsponsors? (?:h-?1b|visas?)\b|\bh-?1b sponsorship available\b|\bprovides? (?:visa )?sponsorship\b|\boffers? (?:visa )?sponsorship\b/i;
const MAY_SPONSOR_RE = /\bmay sponsor\b|\bcould sponsor\b|\bsponsorship (?:may be|is) possible\b|\bopt candidates? (?:are )?considered\b|\bcase[- ]by[- ]case sponsorship\b/i;

export function classifySponsorship(description = '') {
  const text = String(description);
  for (const [re, status] of [[NO_SPONSORSHIP_RE, 'NO_SPONSORSHIP'], [SPONSORS_RE, 'SPONSORS'], [MAY_SPONSOR_RE, 'MAY_SPONSOR']]) {
    const m = re.exec(text);
    if (m) {
      return { status, confidence: 0.85, evidence: excerpt(text, m.index, m[0].length), extractorVersion: SPONSORSHIP_EXTRACTOR_VERSION };
    }
  }
  return { status: 'UNKNOWN', confidence: null, evidence: null, extractorVersion: SPONSORSHIP_EXTRACTOR_VERSION };
}

// ── Citizenship ──────────────────────────────────────────────────────────
// Deliberately distinct from sponsorship/work-authorization/clearance.
// "must be authorized to work in the U.S." is NOT a citizenship requirement
// on its own — only explicit citizen/citizenship language sets this.
const CITIZENSHIP_RE = /\b(u\.?s\.?|united states)\s+citizens?\s+only\b|\bmust be a\s+(?:u\.?s\.?|united states)\s+citizen\b|\bcitizenship (?:is )?required\b|\brequires? (?:u\.?s\.?|united states)?\s*citizenship\b/i;
const ITAR_RE = /\bITAR\b|\bEAR\b[^.]{0,20}\bexport control\b|\bexport[- ]controlled\b/i;

export function classifyCitizenship(description = '') {
  const text = String(description);
  const citizenMatch = CITIZENSHIP_RE.exec(text);
  const itarMatch = ITAR_RE.exec(text);
  if (!citizenMatch && !itarMatch) {
    return { required: null, itarRelated: false, confidence: null, evidence: null, extractorVersion: CITIZENSHIP_EXTRACTOR_VERSION };
  }
  const primary = citizenMatch || itarMatch;
  return {
    // ITAR alone (without explicit citizen language) still strongly implies
    // a US-person requirement in practice, but we mark it via itarRelated
    // rather than asserting citizenship_required outright when the text
    // itself never said "citizen".
    required: citizenMatch ? 'US' : null,
    itarRelated: !!itarMatch,
    confidence: citizenMatch ? 0.9 : 0.7,
    evidence: excerpt(text, primary.index, primary[0].length),
    extractorVersion: CITIZENSHIP_EXTRACTOR_VERSION,
  };
}

// ── Security clearance ───────────────────────────────────────────────────
// "Do not mark every defense-related posting as clearance-required" — only
// explicit clearance-level language sets anything beyond the NONE default.
const CLEARANCE_TYPE_PATTERNS = [
  { type: 'TS_SCI', re: /\bTS\/?SCI\b|\btop secret\s*\/\s*sci\b/i },
  { type: 'TOP_SECRET', re: /\btop secret\b/i },
  { type: 'SECRET', re: /\bsecret clearance\b|\bactive secret\b|\ba secret\b clearance/i },
  { type: 'PUBLIC_TRUST', re: /\bpublic trust\b/i },
];
const REQUIRED_NOW_RE = /\bactive\b|\bcurrent(?:ly)?\s+hold/i;
const ELIGIBLE_RE = /\beligible to obtain\b|\bable to obtain\b|\bcapable of obtaining\b|\bmust be able to obtain\b/i;
const PREFERRED_RE = /\bpreferred\b|\ba plus\b|\bnice to have\b|\bdesirable\b/i;

export function classifyClearance(description = '') {
  const text = String(description);
  let best = null;
  for (const { type, re } of CLEARANCE_TYPE_PATTERNS) {
    const m = re.exec(text);
    if (m && (!best || m.index < best.index)) best = { type, index: m.index, matchLength: m[0].length };
  }
  if (!best) {
    return { type: 'NONE', requirement: 'NONE', confidence: 0.6, evidence: null, extractorVersion: CLEARANCE_EXTRACTOR_VERSION };
  }
  const windowStart = Math.max(0, best.index - 60);
  const windowEnd = Math.min(text.length, best.index + best.matchLength + 60);
  const window = text.slice(windowStart, windowEnd);
  const requirement = PREFERRED_RE.test(window) ? 'PREFERRED'
    : ELIGIBLE_RE.test(window) ? 'ELIGIBLE_TO_OBTAIN'
    : REQUIRED_NOW_RE.test(window) ? 'REQUIRED_NOW'
    // A named clearance level with no explicit now/eligible/preferred
    // qualifier is still a real signal it's needed at some point — treat
    // as required rather than inventing an "eligible" qualifier that
    // wasn't stated.
    : 'REQUIRED_NOW';
  return {
    type: best.type,
    requirement,
    confidence: 0.85,
    evidence: excerpt(text, best.index, best.matchLength),
    extractorVersion: CLEARANCE_EXTRACTOR_VERSION,
  };
}
