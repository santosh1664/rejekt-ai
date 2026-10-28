/**
 * matching/location-score.mjs
 *
 * Soft location/workplace compatibility scoring. Hard geography violations
 * (disallowed country, remote-only user seeing an onsite-only job) are
 * matching/eligibility.mjs's job, not this module's — this only ranks
 * among jobs that already passed eligibility.
 */

function matchesAny(value, list) {
  return !!value && (list || []).some(v => String(v).toLowerCase() === String(value).toLowerCase());
}

/**
 * @param {{ currentCity: string|null, currentState: string|null, currentCountry: string|null }} userLocation
 * @param {{ preferredStates: string[], preferredCities: string[], preferredWorkplaceTypes: string[] }} userPreferences
 * @param {{ workplace: string, locations: Array<{city, stateCode, countryCode, isRemoteRestriction, region}> }} job
 */
export function scoreLocation(userLocation, userPreferences, job) {
  const locations = job.locations || [];
  const officeLocations = locations.filter(l => !l.isRemoteRestriction);
  const remoteRestrictions = locations.filter(l => l.isRemoteRestriction);

  if (job.workplace === 'REMOTE') {
    if (remoteRestrictions.length === 0) {
      return { score: 95, reason: 'Fully remote with no stated region restriction.' };
    }
    const userCountry = userLocation.currentCountry;
    const restrictedToUserCountry = userCountry && remoteRestrictions.some(l => l.countryCode === userCountry);
    if (restrictedToUserCountry) {
      return { score: 100, reason: `Fully remote, restricted to ${userCountry} — matches your location.` };
    }
    if (!userCountry) {
      return { score: 60, reason: 'Remote role has a region restriction; your location is unknown.' };
    }
    // A genuine country mismatch on a remote-restricted role is an
    // eligibility concern (handled there); reaching here with mismatched
    // data means eligibility already let it through (e.g. via allowed_countries) —
    // score it moderately rather than assuming it's wrong.
    return { score: 55, reason: `Remote role restricted to a region other than your own (${userCountry}).` };
  }

  if (officeLocations.length === 0) {
    return { score: 50, reason: 'No structured location data for this job.' };
  }

  for (const loc of officeLocations) {
    if (matchesAny(loc.city, userPreferences.preferredCities || [])) {
      return { score: 100, reason: `Matches your preferred city (${loc.city}).` };
    }
  }
  for (const loc of officeLocations) {
    if (matchesAny(loc.stateCode, userPreferences.preferredStates || [])) {
      return { score: 90, reason: `Matches your preferred state (${loc.stateCode}).` };
    }
  }
  if (job.workplace === 'HYBRID' && (userPreferences.preferredWorkplaceTypes || []).includes('HYBRID')) {
    return { score: 78, reason: 'Hybrid workplace matches your stated preference.' };
  }
  const userCountry = userLocation.currentCountry;
  if (userCountry && officeLocations.some(l => l.countryCode === userCountry)) {
    return { score: 72, reason: `Same country (${userCountry}) as your profile, but not your preferred city/state.` };
  }
  if (!userCountry) {
    return { score: 50, reason: 'Your location is unknown, so this cannot be compared.' };
  }
  return { score: 40, reason: 'Location does not match your preferences or current country.' };
}
