/**
 * lib/role-classifier.mjs — role-v2
 *
 * Deterministic title-based classifier producing a fine-grained canonical
 * role + specialization within lib/role-taxonomy.mjs's controlled set.
 *
 * Design notes (spec Steps 4-8):
 * - Title-only, no description matching (spec Step 4: "do not classify by
 *   description alone unless title is ambiguous" — the corpus audit showed
 *   title text alone is sufficient for the vast majority of real titles;
 *   description parsing would add real complexity for marginal gain here).
 * - Ordered rule list, most-specific phrase first (spec Step 6) — a single
 *   FLAT list across all canonical roles, not gated by the job's own
 *   role_family. Reason: the pre-existing role_family classifier
 *   (lib/fingerprint.mjs's classifyCategory) has real, verified miscategorizations
 *   (e.g. "Software Engineer, Machine Learning" lands in role_family=
 *   SOFTWARE_ENGINEERING, not DATA_SCIENCE, because classifyCategory's
 *   software_engineering pattern matches bare "machine learning" before the
 *   data_science pattern's stricter "machine learning engineer" phrase can).
 *   A flat list lets `canonicalRole` classify by real title evidence
 *   regardless of which (possibly wrong) family the job already landed in —
 *   matching.role-score.mjs never trusts a mismatched family from this,
 *   since it always uses the job's own role_family column for family-level
 *   comparisons (see role-score.mjs's `familyOf`); canonical_role only
 *   drives the finer EXACT/adjacency tiers.
 * - Confidence bands (spec Step 8): explicit unambiguous phrase = high
 *   (0.9); compound/acronym inferred = medium-high (0.75); generic title
 *   requiring a supporting specialization keyword = medium (0.55); no
 *   pattern matched at all = low (0.3), and the canonical role falls back
 *   to the job's own role_family rather than guessing finer.
 */
import { CANONICAL_ROLES } from './role-taxonomy.mjs';
import { SOFTWARE_CONTEXT_RE, PHYSICAL_CONTEXT_RE } from './fingerprint.mjs';

export const CLASSIFIER_VERSION = 'role-v2.3'; // v2.3 (role-consistency repair phase, spec Steps 5-7): v2.2 added reconcileFamily() — this module's RULES list is deliberately family-agnostic (see header comment), which let a high-confidence title match for one family's canonical role get persisted alongside an unrelated, already-assigned role_family; high-confidence title evidence now corrects role_family, lower-confidence evidence falls back to family-level. v2.3 found (via the live corpus audit) that QA_ENGINEER and EMBEDDED_ENGINEER's bare-phrase rules were themselves miscalibrated at override-confidence with no hardware/software context check — split each into a qualified (0.85) and ambiguous (0.5, below override) tier reusing lib/fingerprint.mjs's own SOFTWARE_CONTEXT_RE/PHYSICAL_CONTEXT_RE, so a confidence-based family correction can't force real manufacturing/electrical jobs into SOFTWARE_ENGINEERING.

function norm(title) {
  return String(title || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Hardware/manufacturing/aerospace test-and-quality titles that must NOT be
// swept into QA_ENGINEER/QA_AUTOMATION_ENGINEER/SDET just because they
// contain "test" or "quality" (spec Step 7's collision concern, confirmed
// live in the corpus: "Supplier Quality Engineer", "Electrical Test
// Engineer", "Flight Test Engineer", "Hardware Test Engineer" all currently
// sit in role_family=SOFTWARE_ENGINEERING due to a pre-existing, out-of-
// scope role_family classifier bug — see docs/role-taxonomy.md).
const HARDWARE_TEST_EXCLUSION_RE = /\b(electrical|hardware|mechanical|manufacturing|supplier|flight|rf|avionics|field|firmware|thermal|structural|production)\s+(test|quality)\b|\b(test|quality)\s+(electrical|hardware|mechanical|manufacturing|supplier|flight|rf|avionics|field|production)\b/;

const SPECIALIZATION_PATTERNS = {
  JAVA: /\bjava\b(?!script)/, PYTHON: /\bpython\b/, NODE: /\bnode(\.?js)?\b/, DOTNET: /\b(\.net|dotnet|c#)\b/, GO: /\bgolang\b/, RUBY: /\bruby\b/,
  REACT: /\breact\b/, ANGULAR: /\bangular\b/, VUE: /\bvue\b/,
  IOS: /\bios\b/, ANDROID: /\bandroid\b/, REACT_NATIVE: /\breact native\b/,
  AWS: /\baws\b/, AZURE: /\bazure\b/, GCP: /\bgcp\b|\bgoogle cloud\b/, SPARK: /\bspark\b/, STREAMING: /\bstreaming\b|\bkafka\b/, WAREHOUSE: /\bwarehouse\b/, DATABRICKS: /\bdatabricks\b/,
  LLM: /\bllm\b|\blarge language model/, NLP: /\bnlp\b|\bnatural language/, COMPUTER_VISION: /\bcomputer vision\b/, RECOMMENDATION_SYSTEMS: /\brecommendation (system|engine)/, MLOPS: /\bmlops\b/,
};

function detectSpecialization(canonicalRole, title) {
  const candidates = CANONICAL_ROLES[canonicalRole]?.specializations || [];
  for (const spec of candidates) {
    if (SPECIALIZATION_PATTERNS[spec]?.test(title)) return spec;
  }
  return null;
}

// Ordered, most-specific-first (spec Step 6). Each rule: canonicalRole,
// test(title)->bool, confidence, evidence label.
const RULES = [
  // ── Tier 1: unambiguous compound phrases / acronyms ──────────────────
  { role: 'SITE_RELIABILITY_ENGINEER', test: t => /\bsite reliability engineer\b|\bsre\b/.test(t), confidence: 0.9, evidence: 'explicit "site reliability engineer"/"SRE"' },
  { role: 'SITE_RELIABILITY_ENGINEER', test: t => /\bplatform reliability engineer\b/.test(t), confidence: 0.75, evidence: 'compound "platform reliability engineer"' },
  { role: 'SDET', test: t => /\bsdet\b/.test(t), confidence: 0.9, evidence: 'explicit acronym "SDET"' },
  { role: 'QA_AUTOMATION_ENGINEER', test: t => !HARDWARE_TEST_EXCLUSION_RE.test(t) && /\bqa automation\b|\btest automation engineer\b|\bautomation test engineer\b|\bautomation engineer\b.*\b(qa|test|quality)\b/.test(t), confidence: 0.9, evidence: 'explicit "QA/test automation engineer"' },
  { role: 'MLOPS_ENGINEER', test: t => /\bmlops\b/.test(t), confidence: 0.9, evidence: 'explicit "MLOps"' },
  { role: 'ML_PLATFORM_ENGINEER', test: t => /\bml platform engineer\b|\bmachine learning platform engineer\b/.test(t), confidence: 0.9, evidence: 'explicit "ML platform engineer"' },
  { role: 'DATA_PLATFORM_ENGINEER', test: t => /\bdata platform engineer\b/.test(t), confidence: 0.9, evidence: 'explicit "data platform engineer"' },
  { role: 'ML_ENGINEER', test: t => /\bmachine learning engineer\b|\bml engineer\b/.test(t), confidence: 0.9, evidence: 'explicit "machine learning/ML engineer"' },
  // Non-contiguous order ("Software Engineer, Machine Learning") still counts
  // as strong evidence per the spec's own example — just at a lower band
  // since the phrase isn't the exact canonical ordering.
  { role: 'ML_ENGINEER', test: t => /\bmachine learning\b/.test(t) && /\bengineer\b/.test(t), confidence: 0.75, evidence: '"machine learning" and "engineer" both present, non-contiguous' },
  { role: 'ML_ENGINEER', test: t => (/\bnlp\b|\bnatural language processing\b/.test(t)) && /\bengineer\b/.test(t), confidence: 0.85, evidence: 'explicit "NLP engineer" (NLP is a specialization of ML_ENGINEER in this taxonomy)' },
  { role: 'ANALYTICS_ENGINEER', test: t => /\banalytics engineer\b/.test(t), confidence: 0.9, evidence: 'explicit "analytics engineer"' },
  { role: 'ETL_ENGINEER', test: t => /\betl engineer\b/.test(t), confidence: 0.9, evidence: 'explicit "ETL engineer"' },
  { role: 'DATA_ENGINEER', test: t => /\bdata engineer\b/.test(t), confidence: 0.9, evidence: 'explicit "data engineer"' },
  { role: 'DATA_SCIENTIST', test: t => /\bdata scientist\b/.test(t), confidence: 0.9, evidence: 'explicit "data scientist"' },
  { role: 'DATA_ANALYST', test: t => /\bdata analyst\b/.test(t), confidence: 0.9, evidence: 'explicit "data analyst"' },
  { role: 'RESEARCH_SCIENTIST', test: t => /\bresearch scientist\b|\bapplied scientist\b/.test(t), confidence: 0.9, evidence: 'explicit "research/applied scientist"' },
  { role: 'FULL_STACK_ENGINEER', test: t => /\bfull[\s-]?stack\b/.test(t), confidence: 0.9, evidence: 'explicit "full stack"' },
  { role: 'BACKEND_ENGINEER', test: t => /\bbackend\b|\bback[\s-]end\b|\bserver[\s-]side\b/.test(t), confidence: 0.9, evidence: 'explicit "backend"/"server-side"' },
  { role: 'FRONTEND_ENGINEER', test: t => /\bfrontend\b|\bfront[\s-]end\b|\bui engineer\b/.test(t), confidence: 0.9, evidence: 'explicit "frontend"/"UI engineer"' },
  { role: 'MOBILE_ENGINEER', test: t => /\bmobile engineer\b|\bmobile developer\b|\bios engineer\b|\bandroid engineer\b/.test(t), confidence: 0.9, evidence: 'explicit "mobile/iOS/Android engineer"' },
  // Split into two confidence tiers (role-consistency repair phase, spec
  // Step 7): bare "embedded"/"firmware" alone used to be 0.85 unconditionally
  // — above reconcileFamily's family-override threshold — which would have
  // forced genuinely electrical/hardware "Embedded Hardware Engineer"-type
  // jobs into SOFTWARE_ENGINEERING. Mirrors classifyCategory()'s own existing
  // embedded/firmware disambiguation (lib/fingerprint.mjs): a competing
  // PHYSICAL_CONTEXT_RE word drops this below the override threshold instead
  // of winning unconditionally.
  { role: 'EMBEDDED_ENGINEER', test: t => (/\bembedded\b|\bfirmware\b/.test(t)) && !PHYSICAL_CONTEXT_RE.test(t), confidence: 0.85, evidence: 'explicit "embedded"/"firmware", no competing hardware-discipline context' },
  { role: 'EMBEDDED_ENGINEER', test: t => (/\bembedded\b|\bfirmware\b/.test(t)) && PHYSICAL_CONTEXT_RE.test(t), confidence: 0.5, evidence: 'explicit "embedded"/"firmware", but a hardware-discipline word is also present — ambiguous' },
  { role: 'GAME_ENGINEER', test: t => /\bgame (engineer|developer)\b/.test(t), confidence: 0.85, evidence: 'explicit "game engineer/developer"' },
  { role: 'SOFTWARE_ARCHITECT', test: t => /\bsoftware architect\b|\bsolutions? architect\b.*\bsoftware\b/.test(t), confidence: 0.85, evidence: 'explicit "software architect"' },
  { role: 'CLOUD_SECURITY_ENGINEER', test: t => /\bcloud security\b/.test(t), confidence: 0.9, evidence: 'explicit "cloud security"' },
  { role: 'APPLICATION_SECURITY_ENGINEER', test: t => /\bapplication security\b|\bappsec\b|\bproduct security\b/.test(t), confidence: 0.9, evidence: 'explicit "application/product security"' },
  { role: 'SECURITY_ENGINEER', test: t => /\bsecurity engineer\b|\bdevsecops\b/.test(t), confidence: 0.85, evidence: 'explicit "security engineer"/"DevSecOps"' },
  { role: 'SECURITY_ENGINEER', test: t => /\bsecurity\b/.test(t) && /\bengineer\b/.test(t), confidence: 0.7, evidence: '"security" and "engineer" both present, non-contiguous' },
  { role: 'RELEASE_ENGINEER', test: t => /\brelease engineer\b|\bbuild engineer\b/.test(t), confidence: 0.85, evidence: 'explicit "release/build engineer"' },
  { role: 'DEVOPS_ENGINEER', test: t => /\bdevops engineer\b|\bdevops\b/.test(t), confidence: 0.85, evidence: 'explicit "DevOps"' },
  { role: 'CLOUD_ENGINEER', test: t => /\bcloud engineer\b/.test(t), confidence: 0.85, evidence: 'explicit "cloud engineer"' },
  { role: 'NETWORK_ENGINEER', test: t => /\bnetwork engineer\b/.test(t), confidence: 0.85, evidence: 'explicit "network engineer"' },
  { role: 'INFRASTRUCTURE_ENGINEER', test: t => /\binfrastructure engineer\b/.test(t), confidence: 0.85, evidence: 'explicit "infrastructure engineer"' },
  // PLATFORM_ENGINEER guarded against "platform product manager"/"program manager" collision (spec Step 7).
  { role: 'PLATFORM_ENGINEER', test: t => /\bplatform engineer\b/.test(t) && !/\bproduct (manager|owner)\b|\bprogram manager\b/.test(t), confidence: 0.85, evidence: 'explicit "platform engineer"' },
  // ── Tier 2: QA/test — guarded against the hardware/manufacturing collision ──
  // Split into two confidence tiers (role-consistency repair phase, spec
  // Step 7): "qa engineer" bare is independently confirmed software by
  // classifyCategory()'s own Tier-0 SOFTWARE_QA_RE, so it stays high
  // confidence unconditionally. "quality engineer"/"test engineer"/
  // "testing engineer" bare, with NEITHER a hardware exclusion word NOR
  // software context, is genuinely ambiguous (these are common, real
  // manufacturing-QA titles too) — classifyCategory()'s own ambiguity
  // resolvers deliberately decline to guess on exactly this bare case
  // (see lib/fingerprint.mjs's classifyQualityAmbiguity/
  // classifyTestAmbiguity), so this rule must not get override-confidence
  // for it either, or a confidence-based family correction would force
  // real non-software jobs into SOFTWARE_ENGINEERING.
  { role: 'QA_ENGINEER', test: t => !HARDWARE_TEST_EXCLUSION_RE.test(t) && (/\bqa engineer\b/.test(t) || ((/\bquality engineer\b|\btest engineer\b|\btesting engineer\b/.test(t)) && SOFTWARE_CONTEXT_RE.test(t))), confidence: 0.85, evidence: 'explicit "QA engineer" (independently software), or "quality/test/testing engineer" with software context' },
  { role: 'QA_ENGINEER', test: t => !HARDWARE_TEST_EXCLUSION_RE.test(t) && /\bquality engineer\b|\btest engineer\b|\btesting engineer\b/.test(t), confidence: 0.5, evidence: 'bare "quality/test/testing engineer" — no hardware exclusion but no software context either, genuinely ambiguous' },
  // AI_ENGINEER after QA/data-specific tiers so "AI" doesn't shadow more specific phrases, but before the generic software-engineer catch-all.
  { role: 'AI_ENGINEER', test: t => /\bai engineer\b|\bartificial intelligence engineer\b/.test(t), confidence: 0.85, evidence: 'explicit "AI engineer"' },
  // ── Tier 3: generic software-engineer catch-all (spec Step 5). Bare
  // "engineer" is deliberately NOT included here — role-family-v2's audit
  // found this exact class of bug in lib/fingerprint.mjs's classifyCategory
  // (a bare "engineer" catch-all swallowing every discipline), and this
  // classifier had the identical latent bug: once role_family started
  // correctly reporting MECHANICAL_ENGINEERING etc. (instead of always
  // SOFTWARE_ENGINEERING), a bare-title job like "Mechanical Engineer"
  // would still get canonicalRole=SOFTWARE_ENGINEER from this rule,
  // matching bare "engineer" regardless of context. The bare-"engineer"
  // case is now handled below, gated on the job's own role_family already
  // being software-adjacent.
  { role: 'SOFTWARE_ENGINEER', test: t => /\bsoftware engineer\b|\bsoftware developer\b|\bdeveloper\b|\bprogrammer\b/.test(t), confidence: 0.55, evidence: 'generic "software engineer"/"developer"/"programmer" — no specific pattern matched' },
];

const SOFTWARE_ADJACENT_FAMILIES = new Set(['SOFTWARE_ENGINEERING', 'DATA_SCIENCE', 'DEVOPS_SRE']);

// Below this, title evidence for a specific canonicalRole isn't strong
// enough to override an already-assigned role_family — matches this
// ruleset's own confidence bands (0.9/0.85 explicit phrase, 0.75 compound/
// inferred, 0.55 generic-with-support, 0.3 no match) and spec Step 7's own
// worked example contrast (0.98 vs 0.55 -> family is wrong; a weaker signal
// doesn't get the same benefit of the doubt).
const FAMILY_OVERRIDE_CONFIDENCE = 0.75;

/**
 * Reconciles a candidate canonicalRole against the job's already-assigned
 * role_family (spec Steps 5-7, role-consistency repair phase). This
 * module's RULES list is deliberately family-agnostic (see header
 * comment) — title evidence for canonicalRole can disagree with whatever
 * SEPARATE classifier (lib/fingerprint.mjs's classifyCategory()) already
 * assigned role_family. Never persists an invalid combination silently:
 *   - High-confidence evidence (>=FAMILY_OVERRIDE_CONFIDENCE) for a KNOWN
 *     canonical role wins — role_family is corrected to that role's one
 *     taxonomy-declared family.
 *   - Lower-confidence evidence does not get to override family (spec
 *     Step 6): falls back to the job's own role_family (generic/
 *     not-deepened), never a confident-looking but invalid pair.
 * @returns {{ roleFamily: string|null, canonicalRole: string|null, corrected: boolean, fellBack: boolean }}
 */
function reconcileFamily(roleFamily, canonicalRole, confidence) {
  const entry = CANONICAL_ROLES[canonicalRole];
  if (!entry || entry.family === roleFamily) return { roleFamily, canonicalRole, corrected: false, fellBack: false };
  if (confidence >= FAMILY_OVERRIDE_CONFIDENCE) {
    return { roleFamily: entry.family, canonicalRole, corrected: true, fellBack: false };
  }
  const fallbackRole = roleFamily === 'OTHER' ? null : roleFamily;
  return { roleFamily, canonicalRole: fallbackRole, corrected: false, fellBack: true };
}

/**
 * @param {{ title: string, roleFamily: string|null, skills?: string[] }} input
 * @returns {{ roleFamily: string|null, canonicalRole: string|null, roleSpecialization: string|null, confidence: number, evidence: string, classifierVersion: string }}
 */
export function classifyRole({ title, roleFamily, skills = [] }) {
  const t = norm(title);

  for (const rule of RULES) {
    if (rule.test(t)) {
      const resolved = reconcileFamily(roleFamily, rule.role, rule.confidence);
      const specialization = resolved.canonicalRole === rule.role
        ? (detectSpecialization(rule.role, t) || detectSpecializationFromSkills(rule.role, skills))
        : null;
      const evidence = resolved.corrected
        ? `${rule.evidence} (role_family corrected ${roleFamily} -> ${resolved.roleFamily} — taxonomy invariant for ${rule.role})`
        : resolved.fellBack
          ? `${rule.evidence}, but canonicalRole ${rule.role} is invalid for role_family ${roleFamily} at confidence ${rule.confidence} — fell back to family-level rather than persist an invalid combination`
          : rule.evidence;
      return { roleFamily: resolved.roleFamily, canonicalRole: resolved.canonicalRole, roleSpecialization: specialization, confidence: rule.confidence, evidence, classifierVersion: CLASSIFIER_VERSION };
    }
  }

  // Bare "engineer" (e.g. "Engineer II", "Staff Engineer") only counts as
  // generic-software evidence when the job's own role_family is already
  // software-adjacent — otherwise it's exactly as ambiguous here as it is
  // in lib/fingerprint.mjs's classifyCategory(), and forcing SOFTWARE_ENGINEER
  // onto a MECHANICAL_ENGINEERING/other-family job would silently
  // reintroduce the same bug this phase's role_family fix just removed.
  // SOFTWARE_ENGINEER's own taxonomy family is SOFTWARE_ENGINEERING only,
  // so this still needs reconcileFamily — a bare "Engineer" title within
  // an already-DATA_SCIENCE/DEVOPS_SRE role_family falls back to that
  // family generically (confidence 0.55 is below the override threshold)
  // rather than overwriting it with SOFTWARE_ENGINEER.
  if (/\bengineer\b/.test(t) && SOFTWARE_ADJACENT_FAMILIES.has(roleFamily)) {
    const resolved = reconcileFamily(roleFamily, 'SOFTWARE_ENGINEER', 0.55);
    const evidence = resolved.fellBack
      ? 'generic "engineer" within an already software-adjacent role_family, but not SOFTWARE_ENGINEERING itself — fell back to family-level'
      : 'generic "engineer" within an already software-adjacent role_family';
    return { roleFamily: resolved.roleFamily, canonicalRole: resolved.canonicalRole, roleSpecialization: null, confidence: 0.55, evidence, classifierVersion: CLASSIFIER_VERSION };
  }

  // Nothing matched — fall back to the job's own (broader) role_family
  // rather than guessing finer (spec Step 5/8). Matches today's behavior,
  // including lib/normalize.mjs's existing rule that role_family='OTHER'
  // means canonical_role=null, not the literal string 'OTHER'.
  const fallbackRole = roleFamily === 'OTHER' ? null : roleFamily;
  return { roleFamily, canonicalRole: fallbackRole, roleSpecialization: null, confidence: 0.3, evidence: 'no title pattern matched — falling back to role_family', classifierVersion: CLASSIFIER_VERSION };
}

// Skills fallback (spec Step 4, item 5: "selected high-confidence skills
// only as fallback evidence") — only consulted when the title itself gave
// no specialization signal, and only for the small set of specializations
// where a matched required/preferred skill is unambiguous evidence.
function detectSpecializationFromSkills(canonicalRole, skills) {
  const candidates = CANONICAL_ROLES[canonicalRole]?.specializations || [];
  if (!candidates.length || !skills.length) return null;
  const lowerSkills = skills.map(s => String(s).toLowerCase());
  for (const spec of candidates) {
    if (SPECIALIZATION_PATTERNS[spec]?.test(lowerSkills.join(' '))) return spec;
  }
  return null;
}
