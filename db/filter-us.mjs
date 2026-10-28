/**
 * db/filter-us.mjs
 *
 * One-time cleanup: recompute improved location text for existing Greenhouse
 * rows (the provider used to store generic labels like "Distributed" instead
 * of the real office location — see providers/greenhouse.mjs), classify every
 * job by region, and delete postings that are confidently out of coverage.
 *
 * Coverage comes from lib/geo.mjs (US + Canada + EU + Australia by default,
 * or whatever JOB_REGIONS is set to). In-coverage regions and UNKNOWN are
 * kept; only confidently out-of-coverage rows are deleted.
 *
 * Usage:
 *   node --env-file=.env.local db/filter-us.mjs [--dry-run]
 */
import { query, closePool } from '../lib/db.mjs';
import { classifyJobCountry, isRegionInCoverage, ALLOWED_REGIONS } from '../lib/geo.mjs';

const dryRun = process.argv.includes('--dry-run');

// Mirrors providers/greenhouse.mjs's pickLocation() — used to backfill
// location text for rows fetched before that fix existed.
const GENERIC_LOCATION_LABELS = new Set([
  'distributed', 'hybrid', 'remote', 'flexible', 'in-office', 'various',
  'multiple locations', 'anywhere',
]);

function pickGreenhouseLocation(raw) {
  const meta = Array.isArray(raw.metadata)
    ? raw.metadata.find(m => /location/i.test(m?.name || '') && m?.value)
    : null;
  if (meta) {
    const v = Array.isArray(meta.value) ? meta.value.join('; ') : meta.value;
    if (v) return String(v);
  }

  const primary = (raw.location?.name || '').trim();
  if (primary && !GENERIC_LOCATION_LABELS.has(primary.toLowerCase())) return primary;

  if (Array.isArray(raw.offices) && raw.offices.length > 0) {
    const names = raw.offices.map(o => o?.name).filter(Boolean);
    if (names.length > 0) return names.join('; ');
  }

  return primary;
}

async function main() {
  const { rows } = await query(`SELECT id, ats, location, raw FROM jobs WHERE active = TRUE`);
  console.error(`Loaded ${rows.length} active jobs.\n`);

  let locationFixes = 0;
  const buckets = { US: [], CA: [], EU: [], AU: [], OTHER: [], UNKNOWN: [] };
  const dropSamples = new Map(); // location text -> count, for reporting

  for (const row of rows) {
    let location = row.location;

    if (row.ats === 'greenhouse') {
      const better = pickGreenhouseLocation(row.raw || {});
      if (better && better !== row.location) {
        location = better;
        locationFixes++;
        if (!dryRun) {
          await query(`UPDATE jobs SET location = $1 WHERE id = $2`, [better, row.id]);
        }
      }
    }

    const region = classifyJobCountry({ ats: row.ats, location, raw: row.raw });
    (buckets[region] || (buckets[region] = [])).push(row.id);

    if (!isRegionInCoverage(region)) {
      dropSamples.set(location, (dropSamples.get(location) || 0) + 1);
    }
  }

  const toDelete = Object.entries(buckets)
    .filter(([region]) => !isRegionInCoverage(region))
    .flatMap(([, ids]) => ids);

  console.error(`Backfilled location text for ${locationFixes} Greenhouse rows.\n`);
  console.error(`Coverage: ${[...ALLOWED_REGIONS].join(', ')} (+ UNKNOWN kept)\n`);
  console.error('── Classification ──────────────────────────────');
  for (const r of ['US', 'CA', 'EU', 'AU', 'OTHER', 'UNKNOWN']) {
    const kept = isRegionInCoverage(r) ? 'kept' : 'DROP';
    console.error(`  ${r.padEnd(8)}: ${String((buckets[r] || []).length).padStart(6)}  (${kept})`);
  }
  console.error('');

  const topDrop = [...dropSamples.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  console.error('── Top out-of-coverage locations being removed ──');
  for (const [loc, n] of topDrop) console.error(`  ${String(n).padStart(4)}  ${loc}`);
  console.error('');

  if (dryRun) {
    console.error(`[DRY RUN] Would delete ${toDelete.length} out-of-coverage jobs. No changes made.`);
  } else if (toDelete.length > 0) {
    const { rowCount } = await query(`DELETE FROM jobs WHERE id = ANY($1::bigint[])`, [toDelete]);
    console.error(`Deleted ${rowCount} out-of-coverage jobs.`);
  }

  await closePool();
}

main();
