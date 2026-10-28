/**
 * Deterministic salary extraction and period normalization.
 *
 * Preserves the employer-stated value and period as-is (salary_min_raw /
 * salary_max_raw / salary_period) — hourly is never silently rewritten into
 * an annual number in that field. annualizeSalary() computes a SEPARATE
 * derived view for filtering/sorting; callers decide whether to also store
 * that.
 */
export const SALARY_EXTRACTOR_VERSION = 'salary-v4';

export const SALARY_PERIODS = ['HOUR', 'DAY', 'WEEK', 'MONTH', 'YEAR'];

const PERIOD_WORDS = {
  HOUR: /\b(?:per\s+hour|\/\s*hour|\/\s*hr|hourly|an hour)\b/i,
  DAY: /\b(?:per\s+day|\/\s*day|daily|a day)\b/i,
  WEEK: /\b(?:per\s+week|\/\s*week|\/\s*wk|weekly|a week)\b/i,
  MONTH: /\b(?:per\s+month|\/\s*month|\/\s*mo\b|monthly|a month)\b/i,
  YEAR: /\b(?:per\s+year|\/\s*year|\/\s*yr\b|annually|annual|per annum|a year|yearly)\b/i,
};

const ANNUAL_HOURS = 2080; // 40h * 52wk — standard full-time convention
const PERIOD_TO_ANNUAL_FACTOR = { HOUR: ANNUAL_HOURS, DAY: 260, WEEK: 52, MONTH: 12, YEAR: 1 };

const EVIDENCE_CHARS = 60;
function excerpt(text, index, matchLength) {
  const start = Math.max(0, index - EVIDENCE_CHARS);
  const end = Math.min(text.length, index + matchLength + EVIDENCE_CHARS);
  let s = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) s = '…' + s;
  if (end < text.length) s += '…';
  return s;
}

function parseAmount(raw) {
  const cleaned = raw.replace(/,/g, '');
  const kMatch = /^(\d+(?:\.\d+)?)k$/i.exec(cleaned);
  // salary_min_raw/salary_max_raw are INTEGER columns — an hourly rate like
  // "$37.63/hour" is a real, valid amount but has cents; round rather than
  // reject it (found via a live-corpus backfill failure, not a synthetic case).
  if (kMatch) return Math.round(Number(kMatch[1]) * 1000);
  return Math.round(Number(cleaned));
}

// $120,000-$150,000, $120k-$150k, $60-$75, $120,000 (single value)
const RANGE_RE = /\$\s*([\d,]+(?:\.\d+)?k?)(?:\s*(?:-|–|to)\s*\$?\s*([\d,]+(?:\.\d+)?k?))?/gi;

// Benefits/perk figures ("$5,250 tuition reimbursement per year", "$4000/yr
// travel stipend") match the same $-amount-plus-period shape as a real
// salary and were found, via live-corpus quality sampling, being read as
// compensation. None of these phrasings describe pay for the work itself.
const BENEFITS_CONTEXT_RE = /\b(tuition|reimbursement|stipend|discount|allowance|401\(?k\)?|match(?:ing)?|hsa|fsa|relocation|sign-on bonus|referral bonus|gym|wellness|childcare|commuter)\b/i;
// An itemized perks list can string together several unrelated dollar
// figures with no per-item keyword to exclude on ("$350/mo AI Tools
// $150/mo Team lunch $500/one time Home office") — found immediately
// after fixing the single-keyword case above, in the same job posting.
// Anything after one of these section intros, until a strong
// SALARY_CONTEXT_RE mention appears, is treated as a perks list rather
// than compensation.
const BENEFITS_SECTION_RE = /\b(perks and benefits|benefits include|some of the (?:highlights|perks)|what we offer|our benefits package|additional perks|compensation and benefits)\b/gi;
const BENEFITS_SECTION_LOOKBACK_CHARS = 400;
// Real salary mentions are usually introduced with one of these — used to
// prefer a well-contextualized match over a bare "$X" figure when both
// exist in the same description.
const SALARY_CONTEXT_RE = /\b(salary|compensation|base pay|pay range|OTE|on-target earnings|annual salary|hourly rate|wage)\b/i;
const BENEFITS_WINDOW_CHARS = 60;

function withinBenefitsSection(text, index) {
  const lookbackStart = Math.max(0, index - BENEFITS_SECTION_LOOKBACK_CHARS);
  const between = text.slice(lookbackStart, index);
  BENEFITS_SECTION_RE.lastIndex = 0;
  let last = null;
  let m;
  while ((m = BENEFITS_SECTION_RE.exec(between))) last = m;
  if (!last) return false;
  // A salary-context word appearing AFTER the benefits header (but still
  // before our match) means the text moved on to talking about pay again.
  return !SALARY_CONTEXT_RE.test(between.slice(last.index));
}

function detectPeriod(windowText) {
  for (const period of SALARY_PERIODS) {
    if (PERIOD_WORDS[period].test(windowText)) return period;
  }
  return null;
}

export function parseSalary(description = '') {
  const text = String(description);
  RANGE_RE.lastIndex = 0;
  let m;
  const candidates = [];
  while ((m = RANGE_RE.exec(text))) {
    const index = m.index;
    const matchLength = m[0].length;
    const min = parseAmount(m[1]);
    const max = m[2] ? parseAmount(m[2]) : null;
    if (Number.isNaN(min) || min < 1) continue;
    // Guard against matching an unrelated dollar figure (a benefit cap, a
    // funding amount) rather than compensation — real salaries are almost
    // always four-to-seven figures.
    if (min < 8 && !/hour|hr/i.test(text.slice(index, index + matchLength + 20))) continue;
    // Upper bound: reject figures no real salary reaches (funding rounds,
    // valuations, revenue) — found via a live-corpus backfill failure where
    // a $220B figure was parsed as compensation. Comfortably covers any
    // real hourly/annual salary while staying well under INTEGER's range.
    if (min > 100_000_000 || (max != null && max > 100_000_000)) continue;
    if (max != null && max < min) continue; // impossible range — reject rather than guess which is which

    const benefitsWindow = text.slice(Math.max(0, index - BENEFITS_WINDOW_CHARS), Math.min(text.length, index + matchLength + BENEFITS_WINDOW_CHARS));
    if (BENEFITS_CONTEXT_RE.test(benefitsWindow)) continue;
    if (withinBenefitsSection(text, index)) continue;

    const periodWindow = text.slice(Math.max(0, index - 10), Math.min(text.length, index + matchLength + 30));
    const period = detectPeriod(periodWindow) || (min >= 1000 ? 'YEAR' : null);
    if (!period) continue; // no period signal and not clearly annual-scale — too ambiguous to trust

    candidates.push({
      min, max, period, index, matchLength,
      hasSalaryContext: SALARY_CONTEXT_RE.test(benefitsWindow),
      hasPeriodWord: !!detectPeriod(periodWindow),
    });
  }

  if (candidates.length === 0) {
    return { min: null, max: null, currency: null, period: null, confidence: null, evidence: null, extractorVersion: SALARY_EXTRACTOR_VERSION };
  }
  // Prefer a match with explicit salary-context wording over a bare figure.
  candidates.sort((a, b) => (b.hasSalaryContext - a.hasSalaryContext) || (a.index - b.index));
  const best = candidates[0];
  return {
    min: best.min, max: best.max, currency: 'USD', period: best.period,
    confidence: best.hasPeriodWord ? 0.85 : 0.6,
    evidence: excerpt(text, best.index, best.matchLength),
    extractorVersion: SALARY_EXTRACTOR_VERSION,
  };
}

/** Derived, non-authoritative annualized view — never overwrites the raw employer-stated value/period. */
export function annualizeSalary(min, max, period) {
  const factor = PERIOD_TO_ANNUAL_FACTOR[period];
  if (!factor) return { min: null, max: null };
  return {
    min: min != null ? Math.round(min * factor) : null,
    max: max != null ? Math.round(max * factor) : null,
  };
}
