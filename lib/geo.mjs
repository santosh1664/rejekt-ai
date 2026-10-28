/**
 * lib/geo.mjs
 *
 * Best-effort region classification of a job posting, used to decide which
 * postings the scanner keeps.
 *
 * Location data is free text from a dozen different ATSs with no shared
 * schema, so this is heuristic, not authoritative. Where an ATS exposes a
 * structured country field (Ashby, SmartRecruiters) we use that directly —
 * it's exact. Everywhere else we pattern-match the location string.
 *
 * Returns one of:
 *   'US'      — a US location (or a multi-region listing that includes the US)
 *   'CA'      — Canada
 *   'EU'      — a European Union member state
 *   'AU'      — Australia
 *   'OTHER'   — confidently somewhere else (UK, India, LATAM, Asia, …)
 *   'UNKNOWN' — no usable signal either way (e.g. "Hybrid", bare "Remote")
 *
 * Coverage: ALLOWED_REGIONS decides which regions the scanner stores. The
 * default is US + Canada + EU + Australia, overridable with the JOB_REGIONS
 * env var (comma-separated, e.g. JOB_REGIONS="US,CA"). A job is kept when its
 * region is allowed OR UNKNOWN — we'd rather keep an unclassifiable posting
 * than silently drop a real in-coverage job over a quirky location string.
 * Only a confidently out-of-coverage region ('OTHER', or an allowed-list that
 * excludes it) is dropped.
 *
 * Note on the EU: this is the 27 member states only. The UK, Norway,
 * Switzerland and Iceland are European but NOT EU members, so they fall under
 * 'OTHER'. Add them to a region set here if you want them covered.
 */

const US_STATE_ABBR = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
]);

const US_STATE_NAMES = new Set([
  'alabama','alaska','arizona','arkansas','california','colorado','connecticut',
  'delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa',
  'kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan',
  'minnesota','mississippi','missouri','montana','nebraska','nevada',
  'new hampshire','new jersey','new mexico','new york','north carolina',
  'north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island',
  'south carolina','south dakota','tennessee','texas','utah','vermont',
  'virginia','washington','west virginia','wisconsin','wyoming',
]);

// Common tech-hub US cities that appear bare, with no state/country attached.
const US_CITIES = new Set([
  'san francisco','san francisco bay area','new york','new york city','seattle',
  'austin','chicago','boston','los angeles','denver','atlanta','miami','dallas',
  'houston','philadelphia','san jose','oakland','mountain view','palo alto',
  'menlo park','redwood city','sunnyvale','cupertino','santa clara','sacramento',
  'nashville','raleigh','durham','pittsburgh','minneapolis','detroit','charlotte',
  'salt lake city','las vegas','san diego','portland','phoenix','washington',
  'washington dc','washington, dc','washington d.c.','silicon valley',
  'foster city','santa monica','irvine','bellevue','fort worth','jersey city',
  'brooklyn','arlington','columbus, ohio','sf bay area','st. louis','st louis',
]);

// ── In-coverage regions (besides the US) ────────────────────────────────────

// Canada — country name plus provinces/territories. No US state or city shares
// these names, except "ontario" (also a city in California) and "quebec";
// classifying those as Canada is the long-standing, accepted behaviour.
const CA_COUNTRIES = new Set([
  'canada','british columbia','alberta','manitoba','saskatchewan','nova scotia',
  'new brunswick','newfoundland','prince edward island','yukon',
  'northwest territories','nunavut','ontario','quebec',
]);
const CA_CITIES = new Set([
  'toronto','vancouver','montreal','montréal','ottawa','calgary','edmonton',
  'winnipeg','mississauga','brampton','hamilton','waterloo','kitchener',
  'halifax','victoria','quebec city','québec city','gatineau','burnaby',
]);

// Australia.
const AU_COUNTRIES = new Set(['australia']);
const AU_CITIES = new Set([
  'sydney','melbourne','brisbane','perth','adelaide','canberra','gold coast',
  'newcastle','wollongong','hobart','darwin',
]);

// European Union — the 27 member states (with a couple of local-language and
// short aliases).
const EU_COUNTRIES = new Set([
  'austria','belgium','bulgaria','croatia','cyprus','czech republic','czechia',
  'denmark','estonia','finland','france','germany','greece','hungary','ireland',
  'italy','italia','latvia','lithuania','luxembourg','malta','netherlands',
  'the netherlands','poland','portugal','romania','slovakia','slovenia','spain',
  'sweden','deutschland','österreich','espana','españa',
]);
const EU_CITIES = new Set([
  // Ireland
  'dublin','cork','galway',
  // Netherlands
  'amsterdam','rotterdam','the hague','utrecht','eindhoven',
  // France
  'paris','lyon','toulouse','marseille','lille','bordeaux','nantes',
  // Germany
  'berlin','munich','münchen','frankfurt','hamburg','cologne','köln',
  'stuttgart','düsseldorf','dusseldorf','leipzig','nuremberg','nürnberg',
  // Spain
  'barcelona','madrid','valencia','seville','málaga','malaga','bilbao',
  // Italy
  'milan','milano','rome','roma','turin','torino','bologna','naples','napoli',
  // Poland
  'warsaw','warszawa','krakow','kraków','wroclaw','wrocław','gdansk','gdańsk','poznan','poznań',
  // Czechia
  'prague','praha','brno',
  // Portugal
  'lisbon','lisboa','porto',
  // Sweden
  'stockholm','gothenburg','göteborg','malmö','malmo',
  // Denmark
  'copenhagen','københavn','aarhus',
  // Finland
  'helsinki','espoo','tampere',
  // Austria
  'vienna','wien','graz','linz',
  // Belgium
  'brussels','antwerp','ghent','leuven',
  // Greece
  'athens','thessaloniki',
  // Romania
  'bucharest','cluj-napoca','cluj','timisoara','timișoara','iasi','iași',
  // Hungary
  'budapest',
  // Slovenia / Slovakia / Baltics / others
  'ljubljana','bratislava','tallinn','riga','vilnius','luxembourg city',
  'sofia','zagreb','valletta','nicosia',
]);

// Everything else confidently outside coverage — countries.
const OTHER_COUNTRIES = new Set([
  'india','china','japan','brazil','mexico','argentina','singapore',
  'united kingdom','uk','great britain','england','scotland','wales',
  'northern ireland','norway','switzerland','iceland','new zealand',
  'israel','philippines','indonesia','malaysia','thailand','vietnam',
  'south korea','korea','taiwan','hong kong','egypt','nigeria','kenya',
  'south africa','uae','united arab emirates','colombia','chile','peru',
  'costa rica','ukraine','pakistan','bangladesh','sri lanka','morocco',
  'turkey','türkiye','saudi arabia','qatar','kuwait','serbia','cambodia',
  'uruguay','bosnia','montenegro','albania','moldova','armenia','azerbaijan',
  'kazakhstan','kyrgyzstan','uzbekistan','mongolia','nepal','jordan','lebanon',
  'iraq','iran','oman','bahrain','yemen','tunisia','algeria',
  'dominican republic','guatemala','honduras','el salvador','nicaragua',
  'panama','bolivia','ecuador','paraguay','venezuela','latam',
]);

// Everything else confidently outside coverage — cities.
const OTHER_CITIES = new Set([
  'bengaluru','bangalore','gurugram','gurgaon','mumbai','delhi','new delhi',
  'hyderabad','pune','chennai','noida','tokyo','seoul','mexico city',
  'kuala lumpur','buenos aires','dubai','tel aviv','manila','taguig','cebu',
  'jakarta','bangkok','ho chi minh city','hong kong','shanghai','beijing',
  'taipei','zurich','zürich','geneva','oslo','bergen','reykjavik','reykjavík',
  'cairo','lagos','nairobi','johannesburg','rio de janeiro','sao paulo',
  'são paulo','cdmx','jerusalem','belgrade','auckland','wellington',
  'london','belfast','manchester','edinburgh','glasgow','leeds','birmingham',
  'bristol','cambridge','oxford','istanbul','ankara','kyiv','kiev','lahore',
  'karachi','colombo','casablanca','santiago','bogota','bogotá','lima',
]);

// Which region a non-US country/city name belongs to (for phrase matches).
function regionOfCountryPhrase(lower) {
  for (const p of CA_COUNTRIES) if (lower.includes(p)) return 'CA';
  for (const p of AU_COUNTRIES) if (lower.includes(p)) return 'AU';
  for (const p of EU_COUNTRIES) if (lower.includes(p)) return 'EU';
  for (const p of OTHER_COUNTRIES) if (lower.includes(p)) return 'OTHER';
  return null;
}
function regionOfCityPhrase(lower) {
  for (const p of CA_CITIES) if (lower.includes(p)) return 'CA';
  for (const p of AU_CITIES) if (lower.includes(p)) return 'AU';
  for (const p of EU_CITIES) if (lower.includes(p)) return 'EU';
  for (const p of OTHER_CITIES) if (lower.includes(p)) return 'OTHER';
  return null;
}

// Structured 2-letter country codes → region. Used for ATS country fields and
// for free-text ISO codes. 'ca' is deliberately excluded from FREE-TEXT token
// matching below (it collides with the California state abbreviation), but is
// safe here because a structured country code of CA is unambiguously Canada.
const CODE2_REGION = {
  ca: 'CA', au: 'AU',
  at: 'EU', be: 'EU', bg: 'EU', hr: 'EU', cy: 'EU', cz: 'EU', dk: 'EU',
  ee: 'EU', fi: 'EU', fr: 'EU', de: 'EU', gr: 'EU', hu: 'EU', ie: 'EU',
  it: 'EU', lv: 'EU', lt: 'EU', lu: 'EU', mt: 'EU', nl: 'EU', pl: 'EU',
  pt: 'EU', ro: 'EU', sk: 'EU', si: 'EU', es: 'EU', se: 'EU',
  uk: 'OTHER', gb: 'OTHER', in: 'OTHER', cn: 'OTHER', jp: 'OTHER', kr: 'OTHER',
  sg: 'OTHER', ph: 'OTHER', my: 'OTHER', id: 'OTHER', th: 'OTHER', vn: 'OTHER',
  il: 'OTHER', ae: 'OTHER', br: 'OTHER', mx: 'OTHER', ar: 'OTHER', co: 'OTHER',
  cl: 'OTHER', pe: 'OTHER', cr: 'OTHER', tw: 'OTHER', hk: 'OTHER', eg: 'OTHER',
  ng: 'OTHER', ke: 'OTHER', za: 'OTHER', ch: 'OTHER', no: 'OTHER', is: 'OTHER',
  nz: 'OTHER', tr: 'OTHER', ua: 'OTHER',
};

// Short city abbreviations that show up bare or in lists like "SF, NYC, SEA" —
// exact-token only (never substring: too easy to collide with random text).
const US_CITY_ABBR = new Set(['SF', 'NYC', 'CHI', 'SEA', 'ATL']);

const US_PHRASE_RE = /\b(united states|u\.s\.a\.?|u\.s\.|usa)\b/i;
const US_TOKEN_RE  = /(^|[\s,\-–—/(])US($|[\s,\-–—/.):])/; // uppercase-only "US" token
const WASHINGTON_DC_RE = /washington,?\s*d\.?c\.?/i;

// Regions the scanner keeps, from JOB_REGIONS (default US + CA + EU + AU).
const DEFAULT_REGIONS = ['US', 'CA', 'EU', 'AU'];
export const ALLOWED_REGIONS = new Set(
  (process.env.JOB_REGIONS
    ? process.env.JOB_REGIONS.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    : DEFAULT_REGIONS)
);

/** True when a job in this region should be stored. UNKNOWN is always kept. */
export function isRegionInCoverage(region) {
  return region === 'UNKNOWN' || ALLOWED_REGIONS.has(region);
}

/** True when a job should be stored (allowed region, or no confident signal). */
export function isJobInCoverage(job) {
  return isRegionInCoverage(classifyJobCountry(job));
}

function hasPhrase(lowerText, phrases) {
  for (const phrase of phrases) {
    if (lowerText.includes(phrase)) return true;
  }
  return false;
}

/**
 * Classify a free-text location string into a region.
 *
 * US signals win over everything (a multi-region listing that includes the US
 * is reachable by a US applicant). Among non-US matches, an in-coverage region
 * (CA/EU/AU) wins over OTHER, for the same reason — if the listing includes a
 * covered region, someone there could apply.
 *
 * Multi-word signals (state/country/city names) are matched as substrings of
 * the whole string. Short 2-3 letter tokens (state abbreviations, ISO country
 * codes, city abbreviations like "SF"/"NYC") are matched only as exact, whole,
 * comma/dash-delimited segments — substring-matching a 2-letter code against
 * free text is how you end up thinking "Finland" is Indiana.
 *
 * @param {string} text
 * @returns {'US'|'CA'|'EU'|'AU'|'OTHER'|'UNKNOWN'}
 */
export function classifyLocationText(text) {
  if (!text || typeof text !== 'string') return 'UNKNOWN';

  const lower = text.toLowerCase();

  // US — highest priority.
  if (US_PHRASE_RE.test(text)) return 'US';
  if (US_TOKEN_RE.test(text)) return 'US';
  if (WASHINGTON_DC_RE.test(text)) return 'US';

  let sawUS = hasPhrase(lower, US_STATE_NAMES) || hasPhrase(lower, US_CITIES);

  // Non-US phrase matches, tracked by region.
  const regions = new Set();
  const countryRegion = regionOfCountryPhrase(lower);
  if (countryRegion) regions.add(countryRegion);
  const cityRegion = regionOfCityPhrase(lower);
  if (cityRegion) regions.add(cityRegion);

  // Short tokens: US state/city abbreviations, and non-US ISO codes.
  const segments = text.split(/[,;•|/]| - /).map(s => s.trim()).filter(Boolean);
  for (const seg of segments) {
    if (seg.length === 2 && seg === seg.toUpperCase() && US_STATE_ABBR.has(seg)) sawUS = true;
    if (US_CITY_ABBR.has(seg.toUpperCase()) && seg === seg.toUpperCase()) sawUS = true;
    if (seg.length === 2 && seg === seg.toLowerCase() && seg !== 'ca' && CODE2_REGION[seg]) {
      regions.add(CODE2_REGION[seg]);
    }
  }

  if (sawUS) return 'US';                       // multi-region incl US ⇒ US
  if (regions.has('CA')) return 'CA';           // in-coverage regions win over OTHER
  if (regions.has('EU')) return 'EU';
  if (regions.has('AU')) return 'AU';
  if (regions.has('OTHER')) return 'OTHER';
  return 'UNKNOWN';
}

/** Map a country name (from a structured ATS field) to a region. */
function regionOfCountryName(name) {
  const c = String(name).trim().toLowerCase();
  if (['united states', 'usa', 'us', 'u.s.', 'u.s.a.', 'united states of america'].includes(c)) return 'US';
  if (CA_COUNTRIES.has(c)) return 'CA';
  if (AU_COUNTRIES.has(c)) return 'AU';
  if (EU_COUNTRIES.has(c)) return 'EU';
  return 'OTHER';
}

/** Map a structured 2-letter country code to a region. */
function regionOfCode2(code) {
  const c = String(code).trim().toLowerCase();
  if (c === 'us' || c === 'usa') return 'US';
  return CODE2_REGION[c] || 'OTHER';
}

/**
 * Classify a job using the most reliable signal available for its ATS,
 * falling back to free-text classification of `location`.
 *
 * @param {{ ats: string, location: string, raw: object, countryCode?: string }} job
 * @returns {'US'|'CA'|'EU'|'AU'|'OTHER'|'UNKNOWN'}
 */
export function classifyJobCountry(job) {
  const raw = job.raw || {};

  if (job.ats === 'ashby') {
    const countries = [
      raw.address?.postalAddress?.addressCountry,
      ...(Array.isArray(raw.secondaryLocations)
        ? raw.secondaryLocations.map(l => l?.address?.postalAddress?.addressCountry)
        : []),
    ].filter(Boolean);
    if (countries.length > 0) {
      const regions = countries.map(regionOfCountryName);
      // A multi-country listing counts as covered if any location is covered,
      // US first.
      if (regions.includes('US')) return 'US';
      const covered = regions.find(r => ALLOWED_REGIONS.has(r));
      return covered || regions[0];
    }
  }

  if (job.ats === 'smartrecruiters') {
    const code = raw.location?.country;
    if (code) return regionOfCode2(code);
  }

  // Providers that expose a structured country (recruitee, breezy,
  // oraclecloud) pass it through as job.countryCode — trust it over text.
  if (job.countryCode) return regionOfCode2(job.countryCode);

  return classifyLocationText(job.location);
}
