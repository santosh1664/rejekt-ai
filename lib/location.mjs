/**
 * Structured, multi-location parsing for the raw location string a
 * provider gives us. Supports multiple cities ("NYC / SF / Remote"),
 * state-only lists ("Georgia, Texas, Virginia"), country-only, and
 * "Remote - <region>" restriction phrasing. Never stores "Remote" as a
 * city — workplace_type=REMOTE carries that, this module only records
 * WHERE a remote role is restricted to, when the text says so.
 */
export const LOCATION_EXTRACTOR_VERSION = 'location-v2';

const US_STATES = new Map(Object.entries({
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO',
  montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH',
  oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  'district of columbia': 'DC', 'washington dc': 'DC', 'washington d.c.': 'DC',
}));
const US_STATE_CODES = new Set(US_STATES.values());

const COUNTRY_NAMES = new Map(Object.entries({
  'united states': 'US', usa: 'US', 'u.s.a.': 'US', 'u.s.': 'US',
  canada: 'CA', 'united kingdom': 'GB', uk: 'GB', 'u.k.': 'GB',
  germany: 'DE', france: 'FR', netherlands: 'NL', ireland: 'IE', spain: 'ES',
  italy: 'IT', portugal: 'PT', poland: 'PL', sweden: 'SE', switzerland: 'CH',
  india: 'IN', singapore: 'SG', australia: 'AU', mexico: 'MX', brazil: 'BR',
  japan: 'JP', israel: 'IL',
}));

const REMOTE_WORD_RE = /\b(remote|anywhere|distributed|wfh|work from home)\b/i;

function stripDiacriticPunctuation(s) {
  return s.replace(/\./g, '');
}

export function matchState(part) {
  const cleaned = stripDiacriticPunctuation(part).trim();
  const lower = cleaned.toLowerCase();
  if (US_STATES.has(lower)) return US_STATES.get(lower);
  const upper = cleaned.toUpperCase();
  if (US_STATE_CODES.has(upper)) return upper;
  return null;
}

export function matchCountry(part) {
  const clean = stripDiacriticPunctuation(part).trim().toLowerCase();
  return COUNTRY_NAMES.get(clean) || null;
}

/** Parses ONE location segment (no multi-location separators) into {city, stateCode, countryCode, isRemote, region}. */
function parseSegment(raw) {
  const value = raw.replace(/\s+/g, ' ').trim();
  if (!value) return null;

  if (REMOTE_WORD_RE.test(value)) {
    // "Remote - Illinois, USA", "Remote (US only)", "USA Remote", "Remote - Europe"
    const region = value.replace(REMOTE_WORD_RE, '').replace(/^[\s\-–—(]+|[\s\-–—)]+$/g, '').trim();
    if (!region) return { city: null, stateCode: null, countryCode: null, isRemote: true, region: null };
    const parts = region.split(/[,]/).map(p => p.trim()).filter(Boolean);
    let stateCode = null, countryCode = null;
    for (const part of parts) {
      stateCode = stateCode || matchState(part);
      countryCode = countryCode || matchCountry(part);
    }
    if (stateCode && !countryCode) countryCode = 'US';
    return { city: null, stateCode, countryCode, isRemote: true, region: countryCode || stateCode ? null : region };
  }

  const parts = value.split(/[,]/).map(p => p.trim()).filter(Boolean);
  if (parts.length === 1) {
    // A single bare token: could be a state, a country, or a city with no state given.
    const stateCode = matchState(parts[0]);
    if (stateCode) return { city: null, stateCode, countryCode: 'US', isRemote: false, region: null };
    const countryCode = matchCountry(parts[0]);
    if (countryCode) return { city: null, stateCode: null, countryCode, isRemote: false, region: null };
    return { city: parts[0], stateCode: null, countryCode: null, isRemote: false, region: null };
  }

  // Multi-part: "City, ST", "City, State, Country" — the flat
  // all-state-names case ("Georgia, Texas, Virginia") is already split
  // apart by the caller before this runs, so parts[0] here is always the
  // city, even when that city's name happens to also be a state's
  // ("New York, NY", "Washington, D.C.") — checking parts[0] against
  // matchState would wrongly null out exactly those two common cases.
  let stateCode = null, countryCode = null;
  for (const part of parts.slice(1)) {
    stateCode = stateCode || matchState(part);
    countryCode = countryCode || matchCountry(part);
  }
  if (stateCode && !countryCode) countryCode = 'US';
  return { city: parts[0], stateCode, countryCode, isRemote: false, region: null };
}

/**
 * Parses a raw location string into one or more structured locations.
 * Returns an array (usually length 1) — multi-location postings ("NYC /
 * SF / Remote", "Boston; New York; Remote") produce one entry per option.
 */
export function parseLocations(locationRaw = '') {
  const raw = String(locationRaw).replace(/\s+/g, ' ').trim();
  if (!raw) return [];

  // Unambiguous multi-location separators.
  let segments = raw.split(/\s*;\s*|\s+\/\s+|\s+\bor\b\s+/i).map(s => s.trim()).filter(Boolean);

  // A comma-separated list where EVERY part is itself a full US state name
  // ("Georgia, Texas, Virginia, Washington") is a list of alternative
  // states, not one "City, State" pair — split those apart too.
  segments = segments.flatMap(segment => {
    const parts = segment.split(',').map(p => p.trim()).filter(Boolean);
    // Require 3+ parts: a bare 2-part "X, Y" is overwhelmingly a "City,
    // State" pair, not two alternative states — and "Washington, DC" would
    // otherwise misfire here, since DC is both a real city and a valid
    // state-equivalent code.
    if (parts.length > 2 && parts.every(p => matchState(p))) return parts;
    return [segment];
  });

  const results = segments.map(parseSegment).filter(Boolean);
  // De-duplicate identical entries (multi-location strings sometimes repeat).
  const seen = new Set();
  return results.filter(loc => {
    const key = JSON.stringify(loc);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
