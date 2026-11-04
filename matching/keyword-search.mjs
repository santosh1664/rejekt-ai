/**
 * matching/keyword-search.mjs
 *
 * Keyword search layered on top of the personalized recommendation feed.
 * Modeled on the behavior observed in Tsenta's feed search (see
 * docs/keyword-search.md for the evidence and the design notes):
 *
 *   - `include` terms are OR-ed: a job passes when it matches ANY term.
 *   - `exclude` terms hide a job when it matches ANY of them.
 *   - `scope` decides WHERE terms match:
 *       title             (default) literal title match + semantic title
 *                          match via the canonical-role taxonomy, so
 *                          "GenAI engineer" also finds AI/ML Engineer jobs
 *       title_description  title, plus full-text over the description
 *                          and the job's extracted skills (for niche tools
 *                          like LangChain that rarely appear in titles)
 *       description        description/skills only
 *   - A title-scope search widens the candidate pool to every job, not only
 *     the role families nearest the user's profile (recommend.mjs skips its
 *     role-family narrowing when a keyword is active).
 *   - Keyword-matched jobs get a relevance boost on top of the profile
 *     match score; responses mark these scores as `scoreRebased` so they
 *     are never compared to unkeyworded scores.
 *
 * Everything here except buildKeywordSql() is pure (no DB access) so it can
 * be unit tested without a database — see scripts/test-keyword-search.mjs.
 */
import { normalizeRoleInput } from '../lib/profile-normalize.mjs';
import { normalizeTitle } from '../lib/normalize.mjs';
import { normalizeSkillName } from '../lib/skills.mjs';
import { CANONICAL_ROLES, ROLE_ADJACENCY, isGenericCanonicalRole } from '../lib/role-taxonomy.mjs';

export const SEARCH_SCOPES = ['title', 'title_description', 'description'];
export const DEFAULT_SCOPE = 'title';
const MAX_TERMS = 20;
const MAX_TERM_LENGTH = 80;

// Adjacent canonical roles at or above this weight count as a semantic title
// match (lib/role-taxonomy.mjs: VERY_CLOSE=0.92, CLOSE=0.78). CLOSE is too
// loose for search — BACKEND_ENGINEER would pull in every FULL_STACK and
// generic SOFTWARE_ENGINEER posting — so only VERY_CLOSE pairs expand.
const SEMANTIC_ADJACENCY_MIN = 0.9;

// Gaps in classifyRole() for search-style phrasing ("GenAI engineer",
// "Java developer") that users type but job titles classify differently.
// Rewrites run before the role classifier; explicit role hints are used
// when the classifier still returns nothing specific.
const TERM_REWRITES = [
  [/\b(gen\s*ai|generative\s+ai|llm|agentic(\s+ai)?)\b/g, 'ai'],
  [/\bdeveloper\b/g, 'engineer'],
  [/\bdev\b/g, 'engineer'],
  [/\bml\b/g, 'machine learning'],
];
const ROLE_HINTS = [
  [/\b(java|python|node(\.?js)?|golang|go|\.net|dotnet|c#|ruby|rails|spring( boot)?)\b/, 'BACKEND_ENGINEER'],
  [/\b(react|angular|vue|ui)\b/, 'FRONTEND_ENGINEER'],
  [/\b(ios|android|mobile|react native|flutter)\b/, 'MOBILE_ENGINEER'],
  [/\b(ai|machine learning)\b/, 'AI_ENGINEER'],
];

/**
 * Accepts an array of terms or a single "a|b|c" string. Trims, collapses
 * whitespace, drops empties and case-insensitive duplicates, caps count and
 * length so a request can't build an unbounded query.
 * @returns {string[]}
 */
export function parseTerms(input) {
  if (input == null) return [];
  const raw = Array.isArray(input) ? input.flatMap(v => String(v).split('|')) : String(input).split('|');
  const seen = new Set();
  const terms = [];
  for (const value of raw) {
    const term = value.replace(/\s+/g, ' ').trim().slice(0, MAX_TERM_LENGTH);
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= MAX_TERMS) break;
  }
  return terms;
}

/**
 * @returns {{ include: string[], exclude: string[], scope: string, active: boolean, errors: string[] }}
 */
export function normalizeKeywordSearch({ include, exclude, scope } = {}) {
  const errors = [];
  let normalizedScope = scope ? String(scope).toLowerCase() : DEFAULT_SCOPE;
  if (!SEARCH_SCOPES.includes(normalizedScope)) {
    errors.push(`scope must be one of ${SEARCH_SCOPES.join('/')}`);
    normalizedScope = DEFAULT_SCOPE;
  }
  const inc = parseTerms(include);
  const exc = parseTerms(exclude);
  return { include: inc, exclude: exc, scope: normalizedScope, active: inc.length > 0 || exc.length > 0, errors };
}

/** Lowercased, punctuation-stripped form used for literal title comparison on both sides. */
export function normalizeForMatch(text) {
  return normalizeTitle(text);
}

/**
 * Semantic title expansion: maps a search term onto canonical roles from
 * lib/role-taxonomy.mjs. Generic roles (SOFTWARE_ENGINEER) never expand —
 * they'd match an entire family, which is what a literal title match on
 * "software engineer" is for.
 * @returns {Array<{ canonicalRole: string, weight: number }>}
 */
export function expandTitleTerm(term) {
  let text = String(term).toLowerCase();
  for (const [re, replacement] of TERM_REWRITES) text = text.replace(re, replacement);
  if (!/\b(engineer|scientist|analyst|architect|sdet|devops)\b/.test(text)) text = `${text} engineer`;

  let base = normalizeRoleInput(text).canonicalRole;
  if (!CANONICAL_ROLES[base] || isGenericCanonicalRole(base)) {
    base = ROLE_HINTS.find(([re]) => re.test(text))?.[1] ?? null;
  }
  if (!base || !CANONICAL_ROLES[base] || isGenericCanonicalRole(base)) return [];

  const expanded = [{ canonicalRole: base, weight: 1 }];
  for (const [other, weight] of Object.entries(ROLE_ADJACENCY[base] || {})) {
    if (weight >= SEMANTIC_ADJACENCY_MIN && !isGenericCanonicalRole(other)) expanded.push({ canonicalRole: other, weight });
  }
  return expanded;
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, ch => `\\${ch}`);
}

/**
 * Builds the SQL predicates for a normalized keyword search, pushing
 * parameters onto `params` (the caller's positional-parameter array).
 * Expects the jobs table aliased as `alias` (default `j`).
 *
 * @returns {{ conditions: string[], semanticRoles: Map<string, {term: string, weight: number}> }}
 */
export function buildKeywordSql(ks, params, alias = 'j') {
  const conditions = [];
  const semanticRoles = new Map();
  if (!ks?.active) return { conditions, semanticRoles };

  const titleLiteral = terms => {
    params.push(terms.map(t => `%${escapeLike(normalizeForMatch(t))}%`));
    const literal = `$${params.length}::text[]`;
    params.push(terms.map(t => `%${escapeLike(t)}%`));
    const raw = `$${params.length}::text[]`;
    // normalized_title catches "Sr. SWE" vs "senior software engineer";
    // raw title catches terms normalizeTitle would mangle (C++, .NET).
    return `(${alias}.normalized_title LIKE ANY(${literal}) OR ${alias}.title ILIKE ANY(${raw}))`;
  };
  const fullText = terms => {
    // the words next to each other, in order: "software engineer" no longer matches a lab manager whose posting says "software" and "engineer" apart
    const parts = terms.map(t => { params.push(t); return `phraseto_tsquery('english', $${params.length})`; });
    return `(${parts.join(' || ')})`;
  };
  const skillMatch = terms => {
    params.push([...new Set(terms.map(normalizeSkillName))]);
    return `EXISTS (SELECT 1 FROM job_skills ks_js JOIN skills ks_s ON ks_s.id = ks_js.skill_id
                     WHERE ks_js.job_id = ${alias}.id AND ks_s.normalized_name = ANY($${params.length}::text[]))`;
  };
  // Description weight only: search_vector stores description_clean at
  // weight C (db/schema.sql). The plain @@ lets the GIN index prune first.
  const descriptionOnly = terms => {
    const tsq = fullText(terms);
    return `(${alias}.search_vector @@ ${tsq} AND ts_filter(${alias}.search_vector, '{c}') @@ ${tsq})`;
  };

  if (ks.include.length) {
    const clauses = [];
    if (ks.scope === 'title' || ks.scope === 'title_description') {
      clauses.push(titleLiteral(ks.include));
      for (const term of ks.include) {
        for (const { canonicalRole, weight } of expandTitleTerm(term)) {
          const prev = semanticRoles.get(canonicalRole);
          if (!prev || prev.weight < weight) semanticRoles.set(canonicalRole, { term, weight });
        }
      }
      if (semanticRoles.size) {
        params.push([...semanticRoles.keys()]);
        clauses.push(`${alias}.canonical_role = ANY($${params.length}::text[])`);
      }
    }
    if (ks.scope === 'title_description') {
      clauses.push(`${alias}.search_vector @@ ${fullText(ks.include)}`);
      clauses.push(skillMatch(ks.include));
    }
    if (ks.scope === 'description') {
      clauses.push(descriptionOnly(ks.include));
      clauses.push(skillMatch(ks.include));
    }
    conditions.push(`(${clauses.join(' OR ')})`);
  }

  if (ks.exclude.length) {
    // Excludes are literal and title-only, whatever the scope (as Tsenta does): "senior" sits in almost
    // every description ("work with senior engineers"), so checking descriptions hid most good jobs.
    conditions.push(`NOT ${titleLiteral(ks.exclude)}`);
  }

  return { conditions, semanticRoles };
}

/** Warnings worth surfacing to the caller about how a search will behave. */
export function keywordSearchWarnings(ks) {
  return [];   // hidden words are title-only now, so the "hides too much" warning no longer applies
}

/**
 * Classifies HOW a job that passed the SQL filter matched, for the score
 * boost and the explanation shown to the user.
 * @returns {{ type: 'TITLE'|'SEMANTIC_TITLE'|'DESCRIPTION'|null, term: string|null, strength: number }}
 */
export function classifyKeywordMatch(job, ks, semanticRoles) {
  if (!ks?.include?.length) return { type: null, term: null, strength: 0 };
  const title = normalizeForMatch(job.title || '');
  const rawTitle = String(job.title || '').toLowerCase();
  for (const term of ks.include) {
    const needle = normalizeForMatch(term);
    if (ks.scope !== 'description' && ((needle && title.includes(needle)) || rawTitle.includes(term.toLowerCase()))) {
      return { type: 'TITLE', term, strength: 1 };
    }
  }
  const semantic = semanticRoles?.get(job.canonicalRole);
  if (semantic && ks.scope !== 'description') {
    return { type: 'SEMANTIC_TITLE', term: semantic.term, strength: 0.85 * semantic.weight };
  }
  return { type: 'DESCRIPTION', term: null, strength: 0.4 };
}

// Share of the remaining headroom (100 - score) a full-strength title match
// recovers. 0.35 lifts a 60 to 74 and an 80 to 87 — enough to put explicit
// search intent on top without letting a weak profile fit look strong.
const KEYWORD_BOOST = 0.35;

/**
 * Rebases a profile match score for a keyword-matched job.
 *
 * The role cap in final-score.mjs exists to stop a job far from the user's
 * TARGET roles from scoring well — but a title keyword is the user saying
 * "this role is what I want right now", so for a title/semantic-title match
 * the role cap is lifted. The experience cap is NOT lifted: searching
 * "engineering manager" doesn't make a 3-year profile a fit for a role
 * needing 10.
 */
export function rebaseScore(scoreResult, keywordMatch) {
  if (!keywordMatch?.type) return scoreResult.matchScore;
  const titleIntent = keywordMatch.type === 'TITLE' || keywordMatch.type === 'SEMANTIC_TITLE';
  const experienceCap = scoreResult.components.experience <= 20 ? 55 : scoreResult.components.experience <= 40 ? 75 : 100;
  const base = titleIntent ? Math.min(scoreResult.rawScore, experienceCap) : scoreResult.matchScore;
  const boosted = Math.round(base + (100 - base) * KEYWORD_BOOST * keywordMatch.strength);
  return Math.min(Math.max(boosted, scoreResult.matchScore), titleIntent ? experienceCap : 100);
}

export function describeKeywordMatch(keywordMatch) {
  if (keywordMatch.type === 'TITLE') return `Title matches your search "${keywordMatch.term}".`;
  if (keywordMatch.type === 'SEMANTIC_TITLE') return `Role is closely related to your search "${keywordMatch.term}".`;
  if (keywordMatch.type === 'DESCRIPTION') return 'Description or skills match your search.';
  return null;
}

/** Human-readable one-liner, e.g. for a coverage/"what am I looking at" line. */
export function summarizeKeywordSearch(ks) {
  if (!ks?.active) return null;
  const parts = [];
  if (ks.include.length) parts.push(`must match: "${ks.include.join('|')}"`);
  if (ks.exclude.length) parts.push(`hides: "${ks.exclude.join('|')}"`);
  return `Keyword search (${ks.scope}) — ${parts.join('; ')}`;
}
