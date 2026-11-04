import assert from 'node:assert/strict';
import { cycleWindow, MONTHLY_CAP, MAX_DAILY_CAP, MAX_LANES } from '../autoapply/engine.mjs';
const d = x => x.toISOString().slice(0, 10);
assert.deepEqual([MONTHLY_CAP, MAX_DAILY_CAP, MAX_LANES], [1500, 50, 3]);
let w = cycleWindow('2026-10-19', new Date('2026-11-25')); assert.deepEqual([d(w.startsAt), d(w.resetsAt)], ['2026-11-19', '2026-12-19']);   // Nov 19 - Dec 19
w = cycleWindow('2026-10-19', new Date('2026-11-10')); assert.deepEqual([d(w.startsAt), d(w.resetsAt)], ['2026-10-19', '2026-11-19']);
w = cycleWindow('2026-01-31', new Date('2026-03-05')); assert.deepEqual([d(w.startsAt), d(w.resetsAt)], ['2026-02-28', '2026-03-31']);   // short months
console.log('ok');
