/**
 * Deterministic canonical normalization for provider jobs.
 * Raw provider data remains in job.raw and is never replaced by these values.
 */
import { classifyRole } from './role-classifier.mjs';
import { validateRoleClassification } from './role-taxonomy.mjs';

export const CATEGORY_TO_ROLE_FAMILY = {
  data_science: 'DATA_SCIENCE',
  it_operations: 'DEVOPS_SRE',
  product_management: 'PRODUCT',
  design: 'DESIGN',
  software_engineering: 'SOFTWARE_ENGINEERING',
  consulting: 'CONSULTING',
  sales: 'SALES',
  marketing: 'MARKETING',
  finance: 'FINANCE',
  legal: 'LEGAL',
  human_resources: 'HUMAN_RESOURCES',
  operations: 'OPERATIONS',
  research: 'RESEARCH',
  healthcare: 'HEALTHCARE',
  education: 'EDUCATION',
  mechanical_engineering: 'MECHANICAL_ENGINEERING',
  electrical_engineering: 'ELECTRICAL_ENGINEERING',
  civil_engineering: 'CIVIL_ENGINEERING',
  chemical_engineering: 'CHEMICAL_ENGINEERING',
  industrial_engineering: 'INDUSTRIAL_ENGINEERING',
};

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"');
}

export function cleanDescription(value = '') {
  return decodeEntities(String(value))
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>|<\/div>|<\/li>|<\/h[1-6]>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizeTitle(title = '') {
  return String(title)
    .replace(/\bSr\.?\b/gi, 'Senior')
    .replace(/\bJr\.?\b/gi, 'Junior')
    .replace(/\bSWE\b/gi, 'Software Engineer')
    .replace(/\bSDE\b/gi, 'Software Development Engineer')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// description is optional and, when given, only matched against narrow,
// explicit phrasings ("this is a fully remote position") — never a bare
// "remote"/"hybrid" keyword, which shows up constantly in benefits
// boilerplate ("remote-friendly culture") unrelated to this role's actual
// workplace type (spec Step 8's explicit false-positive concern).
const DESCRIPTION_REMOTE_RE = /\b(this (?:is|role is|position is)|fully|100%|completely)\s+(?:a\s+)?remote\b|\bremote[- ]first\b|\bwork(?:ing)? (?:fully |entirely )?remote(?:ly)?\b/i;
const DESCRIPTION_HYBRID_RE = /\bhybrid (?:role|position|schedule|work environment)\b|\b\d+\s*days?\s*(?:a|per)\s*week\s*(?:in[- ]office|on[- ]?site)\b/i;
const DESCRIPTION_ONSITE_RE = /\bonsite (?:role|position|requirement)\b|\bmust work (?:on[- ]?site|in[- ]?person)\b|\brequires? (?:on[- ]?site|in[- ]?person) (?:presence|attendance)\b/i;

export function normalizeWorkplace(job, location = job.location || '', description = '') {
  const text = `${location} ${job.title || ''}`.toLowerCase();
  if (/\bremote\b|work from home|distributed/.test(text)) return 'REMOTE';
  if (/\bhybrid\b/.test(text)) return 'HYBRID';
  if (/\bflexible\b/.test(text)) return 'FLEXIBLE';
  if (description) {
    if (DESCRIPTION_REMOTE_RE.test(description)) return 'REMOTE';
    if (DESCRIPTION_HYBRID_RE.test(description)) return 'HYBRID';
    if (DESCRIPTION_ONSITE_RE.test(description)) return 'ONSITE';
  }
  if (location) return 'ONSITE';
  return 'UNKNOWN';
}

const US_STATES = new Map([
  ['alabama', 'AL'], ['alaska', 'AK'], ['arizona', 'AZ'], ['arkansas', 'AR'], ['california', 'CA'],
  ['colorado', 'CO'], ['connecticut', 'CT'], ['florida', 'FL'], ['georgia', 'GA'], ['illinois', 'IL'],
  ['massachusetts', 'MA'], ['michigan', 'MI'], ['minnesota', 'MN'], ['missouri', 'MO'], ['new jersey', 'NJ'],
  ['new york', 'NY'], ['north carolina', 'NC'], ['ohio', 'OH'], ['oregon', 'OR'], ['pennsylvania', 'PA'],
  ['texas', 'TX'], ['virginia', 'VA'], ['washington', 'WA'], ['wisconsin', 'WI'],
]);

export function parseLocation(location = '') {
  const value = String(location).replace(/\s+/g, ' ').trim();
  if (!value || /\b(remote|anywhere|distributed)\b/i.test(value)) {
    return { city: null, stateCode: null, countryCode: /\b(us|usa|united states)\b/i.test(value) ? 'US' : null };
  }
  const parts = value.split(/[,;|]/).map(part => part.trim()).filter(Boolean);
  const statePart = parts.find(part => /^[A-Z]{2}$/i.test(part) || US_STATES.has(part.toLowerCase()));
  const stateCode = statePart ? (US_STATES.get(statePart.toLowerCase()) || statePart.toUpperCase()) : null;
  const city = parts[0] && !/^(us|usa|united states)$/i.test(parts[0]) ? parts[0] : null;
  return { city, stateCode, countryCode: /\b(us|usa|united states)\b/i.test(value) || stateCode ? 'US' : null };
}

// Experience, salary, sponsorship, citizenship, and clearance used to be
// extracted here with single-pass regexes (no section awareness, no
// evidence, no versioning, no company-history exclusion for experience).
// That logic has moved to dedicated, versioned modules — lib/experience.mjs,
// lib/education.mjs, lib/work-eligibility.mjs, lib/salary-extract.mjs —
// called directly from scanner/worker.mjs and scripts/backfill-eligibility.mjs.
// This function's remaining job is employment type, source-metadata-first
// per spec (see normalizeJob's employmentTypeRaw parameter) with a
// description/title fallback.
const EMPLOYMENT_TYPE_RAW_MAP = {
  full_time: 'FULL_TIME', fulltime: 'FULL_TIME', 'full-time': 'FULL_TIME',
  part_time: 'PART_TIME', parttime: 'PART_TIME', 'part-time': 'PART_TIME',
  contract: 'CONTRACT', contractor: 'CONTRACT', temporary: 'TEMPORARY', temp: 'TEMPORARY',
  intern: 'INTERNSHIP', internship: 'INTERNSHIP', 'co-op': 'COOP', coop: 'COOP',
};

export function extractStructuredFields(text = '', title = '', employmentTypeRaw = null) {
  const value = `${title}\n${cleanDescription(text)}`;
  const fromSource = employmentTypeRaw ? EMPLOYMENT_TYPE_RAW_MAP[String(employmentTypeRaw).toLowerCase().replace(/\s+/g, '_')] : null;
  const employmentType = fromSource
    || (/co-?op\b/i.test(title) ? 'COOP'
      : /intern(ship)?/i.test(title) ? 'INTERNSHIP'
        : /contract|contractor/i.test(value) ? 'CONTRACT'
          : /part[- ]time/i.test(value) ? 'PART_TIME'
            : /temporary|temp role/i.test(value) ? 'TEMPORARY'
              : /full[- ]time|regular employee/i.test(value) ? 'FULL_TIME' : 'UNKNOWN');
  return { employmentType };
}

export function normalizeJob(job, category = 'other') {
  const description = job.raw?.description ?? job.raw?.descriptionHtml ??
    job.raw?.content ?? job.raw?.full_description ?? job.raw?.body ?? '';
  const employmentTypeRaw = job.raw?.employment_type ?? job.raw?.employmentType ?? job.raw?.commitment ?? null;
  const displayTitle = String(job.title || '').trim();
  const roleFamily = CATEGORY_TO_ROLE_FAMILY[category] || 'OTHER';
  const descriptionClean = cleanDescription(description);
  // Fine-grained canonical role + specialization (spec Step 26: classify at
  // ingestion/backfill time, never at recommendation-request time — this is
  // the ingestion path; scripts/backfill-roles.mjs handles the rest of the
  // corpus and re-classifies on a classifier-version bump). classifyRole()
  // may CORRECT roleFamily (role-consistency repair phase, spec Steps 5-7)
  // when high-confidence title evidence for canonicalRole disagrees with
  // the role_family classifier's own output — classified.roleFamily, not
  // the pre-correction local, is what gets persisted below.
  const classified = classifyRole({ title: displayTitle, roleFamily });

  // Validation gate (spec Step 5) — defense in depth beyond
  // classifyRole()'s own reconcileFamily(): never persist a known-invalid
  // combination silently. Should not fire given reconcileFamily already
  // resolves every case classifyRole can produce; a hit here means some
  // other code path changed shape and gets the same safe degrade (spec
  // Step 6) rather than writing bad data.
  let { canonicalRole, roleFamily: resolvedFamily, roleSpecialization } = classified;
  const validation = validateRoleClassification({ roleFamily: resolvedFamily, canonicalRole, roleSpecialization });
  if (!validation.valid) {
    console.error(`[normalize] invalid role classification for "${displayTitle}" — ${validation.errors.join('; ')} — falling back to family-level`);
    canonicalRole = resolvedFamily === 'OTHER' ? null : resolvedFamily;
    roleSpecialization = null;
  }

  return {
    displayTitle,
    normalizedTitle: normalizeTitle(displayTitle),
    canonicalRole,
    roleFamily: resolvedFamily,
    roleSpecialization,
    descriptionClean,
    workplaceType: normalizeWorkplace(job, job.location, descriptionClean),
    location: parseLocation(job.location),
    fields: extractStructuredFields(description, displayTitle, employmentTypeRaw),
  };
}
