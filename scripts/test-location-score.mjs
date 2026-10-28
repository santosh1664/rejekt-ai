import { scoreLocation } from '../matching/location-score.mjs';

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

const noPrefs = { preferredStates: [], preferredCities: [], preferredWorkplaceTypes: [] };
const noLoc = { currentCity: null, currentState: null, currentCountry: null };

check('preferred city match scores 100',
  scoreLocation(noLoc, { ...noPrefs, preferredCities: ['Austin'] }, { workplace: 'ONSITE', locations: [{ city: 'Austin', stateCode: 'TX', countryCode: 'US', isRemoteRestriction: false, region: null }] }).score === 100);
check('preferred state match scores 90',
  scoreLocation(noLoc, { ...noPrefs, preferredStates: ['TX'] }, { workplace: 'ONSITE', locations: [{ city: 'Dallas', stateCode: 'TX', countryCode: 'US', isRemoteRestriction: false, region: null }] }).score === 90);
check('remote with no restriction scores high',
  scoreLocation(noLoc, noPrefs, { workplace: 'REMOTE', locations: [] }).score >= 90);
check('remote restricted to user\'s own country scores 100',
  scoreLocation({ ...noLoc, currentCountry: 'US' }, noPrefs, { workplace: 'REMOTE', locations: [{ city: null, stateCode: null, countryCode: 'US', isRemoteRestriction: true, region: null }] }).score === 100);
check('unknown location data -> neutral score',
  scoreLocation(noLoc, noPrefs, { workplace: 'ONSITE', locations: [] }).score === 50);

console.log(`\n${failures === 0 ? 'All checks passed' : failures + ' check(s) FAILED'}`);
if (failures > 0) process.exit(1);
