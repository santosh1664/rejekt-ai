/**
 * lib/fingerprint.mjs
 * SHA-256 based job fingerprinting — zero AI tokens.
 *
 * Two fingerprints per job:
 *   fingerprint  = hash(company + normalizedTitle)  → same-company dedup
 *   title_fp     = hash(normalizedTitle only)        → cross-listing detection
 */
import { createHash } from 'crypto';
import { CATEGORY_TO_ROLE_FAMILY } from './normalize.mjs';

const STOP_WORDS = new Set([
  'a','an','and','at','for','in','of','on','the','to','with',
  'senior','sr','junior','jr','lead','staff','principal','associate',
  'remote','hybrid','onsite','on-site',
  'i','ii','iii','iv','new','grad','graduate',
  'us','usa','united','states',
]);

export function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP_WORDS.has(w))
    .sort()
    .join(' ');
}

function sha16(str) {
  return createHash('sha256').update(str, 'utf-8').digest('hex').slice(0, 16);
}

/** Description-only content fingerprint used to detect enrichment changes. */
export function computeDescriptionHash(description = '') {
  return sha16(String(description).replace(/\s+/g, ' ').trim());
}

/** Raw source content fingerprint used to skip unchanged source records. */
export function computeContentHash(job, description = '') {
  return sha16([
    job.title || '',
    job.company || '',
    job.location || '',
    description,
  ].map(value => String(value).replace(/\s+/g, ' ').trim()).join('|'));
}

/** Company-scoped fingerprint (same-company same-role dedup) */
export function computeFingerprint(job) {
  return sha16(`${job.company.toLowerCase()}|${normalizeTitle(job.title)}`);
}

/** Title-only fingerprint (cross-company cross-listing detection) */
export function computeTitleFingerprint(job) {
  return sha16(normalizeTitle(job.title));
}

// role-family-v2 (this phase): a handful of words are ambiguous ACROSS
// disciplines — "quality", "test", "automation", "systems", "reliability",
// "embedded" — and the pre-v2 classifier resolved every one of them toward
// software_engineering unconditionally (either directly in its own pattern,
// or via the trailing bare "engineer" catch-all once nothing more specific
// matched). Verified live against the corpus (this phase's audit): 1,442
// jobs in SOFTWARE_ENGINEERING/DATA_SCIENCE/DEVOPS_SRE contain a clear
// non-software engineering-discipline word (mechanical, electrical,
// manufacturing, aerospace, nuclear, RF, calibration, supplier quality,
// ...). These helpers resolve the ambiguous words using nearby title
// context instead of bucketing them all one way — never a blind keyword
// blacklist (spec Step 9's explicit caution).
// Exported (role-consistency repair phase) so lib/role-classifier.mjs can
// apply the SAME hardware/software disambiguation to its own bare-term
// rules (QA_ENGINEER, EMBEDDED_ENGINEER) instead of a second, less careful
// copy — see that file's use for why: its RULES list previously gave full
// override-confidence to bare "quality engineer"/"embedded" with no
// context check at all, which would have forced genuinely non-software
// jobs into SOFTWARE_ENGINEERING once high-confidence matches started
// correcting role_family.
export const SOFTWARE_CONTEXT_RE = /\b(software|platform|cloud|application|app|backend|back.end|frontend|front.end|distributed|api|web|devops|it |saas)\b/;
export const PHYSICAL_CONTEXT_RE = /\b(mechanical|electrical|manufacturing|supplier|industrial|civil|structural|process|chemical|nuclear|aerospace|hardware|rf |controls|plc|scada|hvac|automotive|medical device|pharma|gmp|iso\s?\d|capa|six sigma|metrology|calibration|avionics|propulsion|robotics mechanical|field service|production line)\b/;

/** Software-QA evidence — explicit and narrow, checked before anything ambiguous. */
const SOFTWARE_QA_RE = /\b(qa automation|test automation|automation test engineer|automation testing|sdet|software test engineer|software qa|selenium|playwright|cypress|api testing|qa engineer|quality assurance engineer)\b/;

/** "quality engineer"/"quality" ambiguity — software QA already handled above; this resolves the rest. */
function classifyQualityAmbiguity(t) {
  if (!/\bquality\b/.test(t)) return null;
  // "quality system(s)" on its own is a standard manufacturing/regulatory
  // term (ISO 9001 "quality management system", GMP quality systems) —
  // strong enough signal on its own, no other physical-context word needed.
  if (/\bquality system/.test(t)) return 'industrial_engineering';
  if (PHYSICAL_CONTEXT_RE.test(t)) return 'industrial_engineering';
  if (SOFTWARE_CONTEXT_RE.test(t)) return 'software_engineering';
  return null; // bare "Quality Engineer"/"Quality Manager" with no context — ambiguous, don't guess
}

/** "test engineer"/"test" ambiguity — software test evidence already handled above; this resolves the rest. */
function classifyTestAmbiguity(t) {
  if (!/\btest\b/.test(t)) return null;
  if (PHYSICAL_CONTEXT_RE.test(t) || /\b(electrical|rf |flight|validation|systems|avionics|manufacturing|field|hardware|mechanical)\s+test|\btest\s+(engineer)\b.*\b(electrical|rf|hardware|mechanical|avionics|flight)\b/.test(t)) return 'industrial_engineering';
  return null; // bare "Test Engineer" with no context — ambiguous, don't guess
}

/** "automation engineer"/"automation" ambiguity (spec Step 8). */
function classifyAutomationAmbiguity(t) {
  if (!/\bautomation\b/.test(t)) return null;
  if (/\b(industrial|plc|scada|controls|factory|manufacturing|robotic process|process automation)\b/.test(t)) return 'industrial_engineering';
  if (/\b(qa|test|software|devops|deployment|ci\/cd|build)\b/.test(t)) return 'software_engineering'; // narrower than SOFTWARE_CONTEXT_RE — "cloud"/"platform" alone shouldn't force this
  return null; // bare "Automation Engineer" — ambiguous, don't guess
}

/** "systems engineer"/"embedded"/"reliability engineer" — each genuinely cross-discipline. */
function classifySystemsEmbeddedReliability(t) {
  if (/\bsystems engineer\b/.test(t)) {
    if (SOFTWARE_CONTEXT_RE.test(t)) return 'software_engineering';
    if (PHYSICAL_CONTEXT_RE.test(t)) return null; // let the discipline-specific patterns below claim it
    return null; // bare "Systems Engineer" — ambiguous, don't guess
  }
  if (/\bembedded\b|\bfirmware\b/.test(t)) {
    if (/\bembedded software\b|\bfirmware engineer\b|\bembedded systems engineer\b.*\bsoftware\b/.test(t)) return 'software_engineering';
    if (PHYSICAL_CONTEXT_RE.test(t)) return null; // e.g. "embedded electrical" — let electrical_engineering claim it
    return 'software_engineering'; // bare "Embedded Engineer"/"Firmware Engineer" with no hardware qualifier — embedded-systems/firmware software is the dominant real-world usage for these bare titles
  }
  if (/\breliability engineer\b/.test(t) && !/\bsite reliability\b/.test(t)) {
    if (SOFTWARE_CONTEXT_RE.test(t) || /\bsre\b/.test(t)) return 'it_operations';
    if (PHYSICAL_CONTEXT_RE.test(t)) return 'industrial_engineering';
    return null; // bare "Reliability Engineer" — ambiguous (common in both SRE and manufacturing), don't guess
  }
  return null;
}

/**
 * Broad category from title keywords — matches Tsenta's roleFamily enum.
 *
 * Values (order matters — first match wins):
 *   data_science | it_operations | product_management | design
 *   software_engineering | consulting | sales | marketing | finance
 *   legal | human_resources | operations | research | healthcare
 *   education | mechanical_engineering | electrical_engineering
 *   civil_engineering | chemical_engineering | industrial_engineering
 *   → other
 *
 * role-family-v2: the old bare "engineer"/"developer" catch-all (anything
 * left unmatched after every specific pattern → software_engineering) is
 * REMOVED. An ambiguous title ("Engineer II", "Senior Engineer", "Technical
 * Engineer") now falls through to 'other' — a false-positive family
 * assignment is more damaging than an honest UNKNOWN (spec Step 13).
 */
export function classifyCategory(title) {
  const t = title.toLowerCase();

  // ── Tier 0: explicit, unambiguous software-QA evidence ──────────────────
  if (SOFTWARE_QA_RE.test(t)) return 'software_engineering';

  // ── Tier 1: Data / ML / Analytics ────────────────────────────────────────
  // role-consistency repair phase (spec Step 3 root cause): "ml engineer",
  // bare "machine learning", "ai engineer", "llm", "nlp", "deep learning",
  // "artificial intelligence", "computer vision" used to live ONLY in the
  // later software_engineering tier below — so "Senior ML Engineer" landed
  // role_family=SOFTWARE_ENGINEERING while lib/role-classifier.mjs's
  // (family-agnostic) canonical-role classifier correctly assigned
  // canonicalRole=ML_ENGINEER, whose taxonomy family is DATA_SCIENCE —
  // a mismatch reproducing on every new job with this title shape, not
  // just historical data. Moved here, matching the taxonomy's own
  // ML_ENGINEER/AI_ENGINEER -> DATA_SCIENCE mapping (lib/role-taxonomy.mjs).
  // Only "machine learning engineer" (the spelled-out phrase) was here
  // before; the rest are new to this tier, removed from the
  // software_engineering tier below.
  if (/\b(data scientist|data engineer|analytics engineer|analytics|etl|data warehouse|dbt|spark|hadoop|bi |business intel|business intelligence|data analyst|ml ops|mlops|machine learning engineer|ml engineer|ai engineer|machine learning|deep learning|artificial intelligence|llm|nlp|computer vision|data science|applied scientist)\b/.test(t)) return 'data_science';

  // ── Product Management — checked BEFORE IT Operations. it_operations's
  // bare "security" swept in genuinely non-technical titles like "Director
  // of Product Management (Agentic Data Security)" and "VP of Growth -
  // Space, Defense & National Security" (found in this phase's spot-check)
  // — product_management's own patterns are narrow/unambiguous enough to
  // safely claim these first, the same precedence-bug class as everything
  // else fixed in this phase. ──────────────────────────────────────────────
  if (/\b(product manager|product management|program manager|scrum master|agile coach|technical program manager|tpm|product owner)\b/.test(t)) return 'product_management';

  // ── Tier 2: IT Operations (DevOps + Security + Networking) ──────────────
  // "data center" alone is guarded against the construction-role collision
  // ("Civil Engineer - Data Center" builds one; doesn't operate it) — found
  // in this phase's audit alongside the quality/test/automation/systems
  // ambiguities above. A civil/mechanical/electrical discipline word
  // anywhere in the title means the physical-engineering checks near the
  // end of this function should get first claim instead.
  const hasDataCenter = /\bdata center\b/.test(t) && !/\b(civil|mechanical|electrical|structural|construction|grading|utility)\b/.test(t);
  if (hasDataCenter || /\b(devops|site reliability|platform engineer|infrastructure|cloud engineer|cloud architect|kubernetes|k8s|terraform|ci\/cd|devsecops|build engineer|release engineer|security|appsec|pen test|pentest|penetration|soc analyst|siem|vulnerability|cybersec|cyber security|information security|infosec|threat|iam engineer|zero trust|network engineer|network admin|sysadmin|systems admin|it support|it administrator|helpdesk|help desk|noc )\b/.test(t)) return 'it_operations';

  // ── Ambiguous-word resolution (spec Steps 6-9) — checked before both the
  // generic software patterns and the discipline-specific ones, so neither
  // side can shadow a well-evidenced context guard for the other. ─────────
  const qualityCall = classifyQualityAmbiguity(t);
  if (qualityCall) return qualityCall;
  const testCall = classifyTestAmbiguity(t);
  if (testCall) return testCall;
  const automationCall = classifyAutomationAmbiguity(t);
  if (automationCall) return automationCall;
  const sysCall = classifySystemsEmbeddedReliability(t);
  if (sysCall) return sysCall;

  // ── Design ────────────────────────────────────────────────────────────────
  if (/\b(designer|ux |ui |user experience|user interface|figma|visual design|brand designer|graphic design|creative director|illustrator|motion design|web design)\b/.test(t)) return 'design';

  // ── Software Engineering (unambiguous specific titles only — the
  // ambiguous ones above are already resolved by this point) ────────────────
  // ml/ai/llm/nlp/deep-learning/computer-vision terms moved to Tier 1 above
  // (role-consistency repair phase) — they belong to DATA_SCIENCE per the
  // taxonomy, not here.
  if (/\b(software engineer|software developer|software architect|coder|fullstack|full.stack|full stack|backend|front.?end|mobile engineer|ios engineer|android engineer|web engineer|api engineer|game developer|game engineer|computer scientist)\b/.test(t)) return 'software_engineering';
  // Bare "programmer" is guarded against CNC/machinist context ("CNC
  // Programmer" is a manufacturing/machining title, found in this phase's
  // spot-check) — real software usage never pairs "programmer" with CNC.
  if (/\bprogrammer\b/.test(t) && !/\bcnc\b/.test(t)) return 'software_engineering';

  // ── Consulting ────────────────────────────────────────────────────────────
  if (/\b(consultant|consulting|advisor|advisory|management consulting|it consulting|solutions architect|implementation specialist|engagement manager)\b/.test(t)) return 'consulting';

  // ── Sales ─────────────────────────────────────────────────────────────────
  if (/\b(account executive|account manager|sales rep|sales development|sdr|bdr|business development|sales engineer|solution engineer|presales|pre-sales|channel partner|inside sales|outbound|revenue|customer success)\b/.test(t)) return 'sales';

  // ── Marketing ────────────────────────────────────────────────────────────
  if (/\b(marketing|content strateg|copywriter|seo |sem |growth hacker|demand generation|campaign manager|brand manager|social media|email marketing|product marketing|performance marketing|communications|public relations|pr manager)\b/.test(t)) return 'marketing';

  // ── Finance ───────────────────────────────────────────────────────────────
  if (/\b(finance|accountant|accounting|controller|cfo|fp&a|financial analyst|financial planning|treasury|tax|audit|bookkeeper|payroll|billing|revenue ops|rev ops)\b/.test(t)) return 'finance';

  // ── Legal ─────────────────────────────────────────────────────────────────
  if (/\b(legal|attorney|lawyer|counsel|paralegal|compliance|regulatory|contracts|litigation|corporate law|ip counsel)\b/.test(t)) return 'legal';

  // ── Human Resources ───────────────────────────────────────────────────────
  if (/\b(recruiter|recruiting|talent acquisition|hr |human resources|people ops|compensation|benefits|hrbp|hr business partner|onboarding|learning.*development|l&d|workforce)\b/.test(t)) return 'human_resources';

  // ── Operations ────────────────────────────────────────────────────────────
  if (/\b(operations|ops manager|biz ops|supply chain|logistics|procurement|vendor|office manager|executive assistant|administrative|project coordinator|business analyst|strategy|general manager|chief of staff)\b/.test(t)) return 'operations';

  // ── Research ─────────────────────────────────────────────────────────────
  if (/\b(researcher|research scientist|research engineer|computational biologist|bioinformatic|physicist|r&d )\b/.test(t)) return 'research';

  // ── Healthcare ────────────────────────────────────────────────────────────
  if (/\b(nurse|physician|doctor|surgeon|pharmacist|therapist|counselor|psychologist|psychiatrist|medical|clinical|dental|dentist|optometrist|radiology|phlebotomist|emt|paramedic|health coach|care coordinator|patient|hospital|icu|er |rn |lpn |cna |bsn |md |dds )\b/.test(t)) return 'healthcare';

  // ── Education ─────────────────────────────────────────────────────────────
  if (/\b(teacher|professor|instructor|tutor|curriculum|academic|librarian|school|education|teaching|faculty|lecturer|coach|trainer|learning)\b/.test(t)) return 'education';

  // ── Engineering disciplines (checked before any generic fallback — a
  // discipline-specific title must never fall through to software) ─────────
  // Expanded vs. the prior version with real corpus terms found during this
  // phase's audit (nuclear, aerospace, RF/avionics, propulsion, structural/
  // stress-analysis, FPGA, signal integrity/processing, mechanisms).
  if (/\b(mechanical engineer|hvac engineer|robotics engineer|robotics mechanical|mechatronics|manufacturing engineer|process engineer|tooling engineer|thermal engineer|mechanisms engineer|propulsion engineer|stress analysis engineer)\b/.test(t)) return 'mechanical_engineering';
  if (/\b(electrical engineer|electronics engineer|power engineer|circuit|embedded systems engineer|pcb|eec|signal processing|rf engineer|fpga engineer|signal integrity engineer|avionics engineer|wireless.*engineer)\b/.test(t)) return 'electrical_engineering';
  if (/\b(civil engineer|structural engineer|geotechnical|environmental engineer|transportation engineer|surveyor|urban planner|construction manager)\b/.test(t)) return 'civil_engineering';
  if (/\b(chemical engineer|materials scientist|biochemical|polymer|petrochemical|refinery|nuclear engineer|nuclear licensing)\b/.test(t)) return 'chemical_engineering';
  if (/\b(industrial engineer|supply chain engineer|operations engineer|lean|six sigma|manufacturing|production|assembly|warehouse|forklift|logistics engineer|controls engineer|plc engineer|cnc)\b/.test(t)) return 'industrial_engineering';

  // ── Technician / Skilled Trades (catch-all for non-engineer trades) ────────
  if (/\b(technician|mechanic|electrician|plumber|hvac tech|carpenter|welder|machinist|fabricator|maintenance|field service|installation tech|service tech|repair tech|network tech|av tech|lab tech|quality inspector|operator)\b/.test(t)) return 'industrial_engineering';

  return 'other';
}

export const CATEGORY_CLASSIFIER_VERSION = 'role-family-v2.4'; // v2.4 (role-consistency repair phase): ml engineer/ai engineer/machine learning/deep learning/artificial intelligence/llm/nlp/computer vision moved from software_engineering to data_science, matching the taxonomy's ML_ENGINEER/AI_ENGINEER->DATA_SCIENCE mapping — root cause of the canonical_role/role_family mismatch class found in the prior ranking-calibration phase

/**
 * Auditable wrapper around classifyCategory() + CATEGORY_TO_ROLE_FAMILY
 * (spec Step 12) — classifyCategory() itself stays a plain string-returning
 * function (its existing call sites, e.g. lib/profile-normalize.mjs, expect
 * that and don't need the audit fields). Confidence is coarser than
 * lib/role-classifier.mjs's per-rule bands since classifyCategory() doesn't
 * expose which tier matched internally: 'other' means no pattern matched at
 * all (low confidence, genuinely unknown — never a forced guess, spec Step
 * 13); any other category means at least one explicit title pattern
 * matched (treated as reasonably high confidence).
 * @param {string} title
 */
export function classifyRoleFamilyWithConfidence(title) {
  const category = classifyCategory(title);
  const roleFamily = CATEGORY_TO_ROLE_FAMILY[category] || 'OTHER';
  const confidence = category === 'other' ? 0.3 : 0.8;
  const evidence = category === 'other'
    ? 'no title pattern matched — falling back to OTHER, not a forced guess'
    : `title matched the "${category}" classification pattern`;
  return { roleFamily, confidence, evidence, classifierVersion: CATEGORY_CLASSIFIER_VERSION };
}
