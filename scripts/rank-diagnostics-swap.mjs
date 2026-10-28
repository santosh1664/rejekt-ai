/**
 * scripts/rank-diagnostics-swap.mjs
 *
 * Post-classification ranking calibration phase — Step 17. Compares two
 * dumps (before/after an experiment) and reports, per profile and overall,
 * how many BAD/BORDERLINE jobs left the top-10 and how many GOOD/EXCELLENT
 * jobs entered it — the primary metric for this phase (Step 16), since
 * ordering-only improvements (P@5/NDCG) were already exhausted in prior
 * phases.
 *
 * Usage: node scripts/rank-diagnostics-swap.mjs <before.json> <after.json>
 */
import { readFileSync } from 'fs';

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) { console.error('Usage: node scripts/rank-diagnostics-swap.mjs <before.json> <after.json>'); process.exit(1); }

const before = JSON.parse(readFileSync(beforePath, 'utf8'));
const after = JSON.parse(readFileSync(afterPath, 'utf8'));

function top10ByProfile(data) {
  const map = {};
  for (const j of data.jobs.filter(j => j.rank <= 10)) (map[j.profileId] ||= new Set()).add(j.jobId);
  return map;
}
function labelsByJobId(data) {
  const map = {};
  for (const j of data.jobs) map[`${j.profileId}:${j.jobId}`] = j.label;
  return map;
}

const beforeTop10 = top10ByProfile(before);
const afterTop10 = top10ByProfile(after);
const labels = labelsByJobId(after); // labels are static, same in both dumps

let totals = { badRemoved: 0, borderlineRemoved: 0, goodAdded: 0, excellentAdded: 0, badAdded: 0, borderlineAdded: 0, goodRemoved: 0, excellentRemoved: 0 };

console.log('=== Top-10 membership swap, per profile ===\n');
for (const profileId of Object.keys(beforeTop10)) {
  const b = beforeTop10[profileId] || new Set();
  const a = afterTop10[profileId] || new Set();
  const removed = [...b].filter(id => !a.has(id));
  const added = [...a].filter(id => !b.has(id));

  const counts = { badRemoved: 0, borderlineRemoved: 0, goodAdded: 0, excellentAdded: 0, badAdded: 0, borderlineAdded: 0, goodRemoved: 0, excellentRemoved: 0 };
  for (const id of removed) {
    const label = labels[`${profileId}:${id}`];
    if (label === 'BAD') counts.badRemoved++;
    else if (label === 'BORDERLINE') counts.borderlineRemoved++;
    else if (label === 'GOOD') counts.goodRemoved++;
    else if (label === 'EXCELLENT') counts.excellentRemoved++;
  }
  for (const id of added) {
    const label = labels[`${profileId}:${id}`];
    if (label === 'BAD') counts.badAdded++;
    else if (label === 'BORDERLINE') counts.borderlineAdded++;
    else if (label === 'GOOD') counts.goodAdded++;
    else if (label === 'EXCELLENT') counts.excellentAdded++;
  }
  for (const k of Object.keys(totals)) totals[k] += counts[k];

  if (removed.length || added.length) {
    console.log(`${profileId}: BAD removed=${counts.badRemoved} BORDERLINE removed=${counts.borderlineRemoved} GOOD removed=${counts.goodRemoved} EXCELLENT removed=${counts.excellentRemoved} | BAD added=${counts.badAdded} BORDERLINE added=${counts.borderlineAdded} GOOD added=${counts.goodAdded} EXCELLENT added=${counts.excellentAdded}`);
  } else {
    console.log(`${profileId}: no membership change`);
  }
}

console.log('\n=== TOTAL ===');
console.log(`BAD removed: ${totals.badRemoved}`);
console.log(`BORDERLINE removed: ${totals.borderlineRemoved}`);
console.log(`GOOD removed: ${totals.goodRemoved}`);
console.log(`EXCELLENT removed: ${totals.excellentRemoved}`);
console.log(`BAD added: ${totals.badAdded}`);
console.log(`BORDERLINE added: ${totals.borderlineAdded}`);
console.log(`GOOD added: ${totals.goodAdded}`);
console.log(`EXCELLENT added: ${totals.excellentAdded}`);
