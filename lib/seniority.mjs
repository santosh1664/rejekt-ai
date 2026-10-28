/**
 * Deterministic seniority/career-level classifier.
 *
 * Replaces the old `career_level` field, which nothing in the current
 * pipeline populates anymore (see lib/normalize.mjs's history). This is
 * rule-based on purpose — no ML call, no external dependency — so it's
 * cheap enough to run on every new/changed job and safe to re-run in bulk
 * during a backfill.
 *
 * Canonical values (matches the CHECK constraint added for jobs.seniority_level):
 *   INTERN | ENTRY | JUNIOR | MID | SENIOR | STAFF | PRINCIPAL | LEAD |
 *   MANAGER | DIRECTOR | EXECUTIVE | UNKNOWN
 *
 * Strategy — two signal tiers, title first:
 *   1. STRONG title signals (explicit level words: "Senior", "Staff",
 *      "Principal", "Manager", "Director", etc.) — these win outright.
 *   2. WEAK signals used only when no strong title signal fires: numbered
 *      levels ("Engineer II"), minimum years-of-experience thresholds, and
 *      explicit phrases in the description ("entry level", "direct
 *      reports"). Years-of-experience evidence, when present, is preferred
 *      over a bare numbered-level suffix — a concrete "7+ years required"
 *      is more reliable than an arbitrary internal leveling number.
 *
 * If nothing matches, the result is UNKNOWN with null confidence — this
 * classifier never guesses without a concrete regex match ("do not invent
 * a level when evidence is weak").
 */

const CLASSIFIER_VERSION = 'seniority-rules-v1';

// ── Title-based STRONG signals (checked in this priority order) ────────────
// Order matters: more specific/senior titles are checked before broader ones
// so e.g. "Engineering Manager" doesn't fall through to a generic pattern.
const STRONG_TITLE_RULES = [
  { level: 'INTERN',    re: /\bintern(ship)?\b/i },
  { level: 'EXECUTIVE', re: /\b(vp|vice president|chief\s+\w+\s+officer|\bc[a-z]o\b|head of)\b/i },
  { level: 'DIRECTOR',  re: /\bdirector\b/i },
  { level: 'PRINCIPAL', re: /\bprincipal\b/i },
  { level: 'STAFF',     re: /\bstaff\b(?!ing)/i },
  {
    // "Engineering Manager", "Manager, Software Engineering", "Team Manager"
    // — but not functional ICs like "Product Manager"/"Program Manager"/
    // "Account Manager" who don't manage people.
    level: 'MANAGER',
    re: /\bmanager\b/i,
    exclude: /\b(product|program|project|account|community|customer\s+success|partner|vendor|category|brand|marketing|office)\s+manager\b/i,
  },
  { level: 'LEAD',      re: /\blead\b/i },
  { level: 'SENIOR',    re: /\b(senior|sr\.?)\b/i },
  { level: 'JUNIOR',    re: /\b(junior|jr\.?)\b/i },
  { level: 'ENTRY',     re: /\bentry[- ]level\b|\bnew\s+grad(uate)?s?\b|\bearly[- ]in[- ]career\b/i },
];

// Numbered levels ("Software Engineer II") — weak signal, only used as a
// fallback when nothing above matched. Roughly: I/1 = entry-ish, II = mid,
// III = senior-ish, IV+ = staff-ish. Anchored to end-of-title to avoid
// matching stray letters.
const NUMBERED_LEVEL_RULES = [
  { level: 'ENTRY',     re: /\b(I|1)\s*$/ },
  { level: 'MID',       re: /\bII\s*$/ },
  { level: 'SENIOR',    re: /\bIII\s*$/ },
  { level: 'STAFF',     re: /\b(IV|V)\s*$/ },
];

// Explicit level language in the description body, used when title gives
// no signal at all.
const DESCRIPTION_ENTRY_RE = /\bentry[- ]level\b|\bno prior experience\b|\bnew\s+grad(uate)?s?\b|\brecent\s+graduates?\b|\b0[- ]1\s*years?\b/i;
const DESCRIPTION_MANAGEMENT_RE = /\b\d+\+?\s*direct reports?\b|\bmanages?\s+a\s+team\s+of\b|\bpeople[- ]management\s+(experience|responsibilit)/i;

function matchStrongTitle(normalizedTitle) {
  for (const rule of STRONG_TITLE_RULES) {
    if (rule.exclude && rule.exclude.test(normalizedTitle)) continue;
    if (rule.re.test(normalizedTitle)) {
      return { level: rule.level, evidence: `title matched /${rule.re.source}/` };
    }
  }
  return null;
}

function matchNumberedLevel(rawTitle) {
  for (const rule of NUMBERED_LEVEL_RULES) {
    if (rule.re.test(rawTitle)) {
      return { level: rule.level, evidence: `numbered title suffix matched /${rule.re.source}/` };
    }
  }
  return null;
}

/**
 * Years-of-experience → level, used only as a fallback for generic titles.
 * Conservative thresholds — capped at SENIOR (STAFF/PRINCIPAL/MANAGER+ are
 * title-driven distinctions, not purely years-based, so we don't infer them
 * from years alone).
 */
function matchExperienceYears(minExpYears) {
  if (minExpYears == null || Number.isNaN(minExpYears)) return null;
  if (minExpYears >= 6) return { level: 'SENIOR', evidence: `min_exp_years=${minExpYears} >= 6` };
  if (minExpYears >= 3) return { level: 'MID', evidence: `min_exp_years=${minExpYears} in [3,6)` };
  if (minExpYears >= 1) return { level: 'JUNIOR', evidence: `min_exp_years=${minExpYears} in [1,3)` };
  return { level: 'ENTRY', evidence: `min_exp_years=${minExpYears} < 1` };
}

/**
 * Classify a job's seniority level.
 *
 * @param {object} job — normalized-ish job shape: { title }
 * @param {string} [description] — cleaned description text (lib/normalize.mjs's descriptionClean)
 * @param {number|null} [minExpYears] — already-extracted min years requirement (lib/normalize.mjs's extractStructuredFields)
 * @returns {{ level: string, confidence: number|null, evidence: string|null, classifierVersion: string }}
 */
export function classifySeniority(job, description = '', minExpYears = null) {
  const title = String(job?.title || '');
  const text  = String(description || '');

  // 1) Strong title signal wins outright.
  const strong = matchStrongTitle(title);
  if (strong) {
    return { level: strong.level, confidence: 0.9, evidence: strong.evidence, classifierVersion: CLASSIFIER_VERSION };
  }

  // 2) No strong title signal — prefer concrete years-of-experience evidence
  //    over a bare numbered-level suffix when both are available.
  const expGuess = matchExperienceYears(minExpYears);
  if (expGuess) {
    return { level: expGuess.level, confidence: 0.6, evidence: expGuess.evidence, classifierVersion: CLASSIFIER_VERSION };
  }

  const numbered = matchNumberedLevel(title);
  if (numbered) {
    return { level: numbered.level, confidence: 0.5, evidence: numbered.evidence, classifierVersion: CLASSIFIER_VERSION };
  }

  // 3) Explicit phrases in the description body.
  if (DESCRIPTION_ENTRY_RE.test(text)) {
    return { level: 'ENTRY', confidence: 0.55, evidence: 'description matched entry-level phrasing', classifierVersion: CLASSIFIER_VERSION };
  }
  if (DESCRIPTION_MANAGEMENT_RE.test(text)) {
    return { level: 'MANAGER', confidence: 0.55, evidence: 'description matched people-management phrasing', classifierVersion: CLASSIFIER_VERSION };
  }

  // 4) No concrete evidence — do not guess.
  return { level: 'UNKNOWN', confidence: null, evidence: null, classifierVersion: CLASSIFIER_VERSION };
}

export const SENIORITY_LEVELS = [
  'INTERN', 'ENTRY', 'JUNIOR', 'MID', 'SENIOR', 'STAFF', 'PRINCIPAL',
  'LEAD', 'MANAGER', 'DIRECTOR', 'EXECUTIVE', 'UNKNOWN',
];

export { CLASSIFIER_VERSION as SENIORITY_CLASSIFIER_VERSION };
