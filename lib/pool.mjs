/**
 * lib/pool.mjs
 *
 * Lightweight concurrent worker pool — no external deps.
 *
 * Usage:
 *   const limiter = createPool(30);  // max 30 in-flight at once
 *   await limiter(() => fetchCompany(portal));
 *
 * Or for batch dispatch:
 *   await runAll(companies, (c) => fetchCompany(c), { concurrency: 30 });
 */

/**
 * Create a concurrency-limited executor.
 * Returns a function that schedules tasks to run with at most `limit` running at once.
 *
 * @param {number} limit — max concurrent promises
 * @returns {(taskFn: () => Promise<any>) => Promise<any>}
 */
export function createPool(limit) {
  let active = 0;
  const queue = [];

  function run() {
    if (active >= limit || queue.length === 0) return;
    active++;
    const { taskFn, resolve, reject } = queue.shift();
    taskFn()
      .then(resolve)
      .catch(reject)
      .finally(() => {
        active--;
        run(); // pick up next queued task
      });
  }

  return function schedule(taskFn) {
    return new Promise((resolve, reject) => {
      queue.push({ taskFn, resolve, reject });
      run();
    });
  };
}

/**
 * Run all items through fn() with bounded concurrency.
 * Collects results in order (same as Promise.all semantics).
 * Errors are caught per-item and stored as { error } objects — won't abort the batch.
 *
 * @param {T[]}              items
 * @param {(item: T) => Promise<R>} fn
 * @param {{ concurrency?: number, onDone?: (result, index) => void }} opts
 * @returns {Promise<(R | { error: Error })[]>}
 */
export async function runAll(items, fn, { concurrency = 20, onDone } = {}) {
  const schedule = createPool(concurrency);
  const results  = new Array(items.length);

  await Promise.all(
    items.map((item, i) =>
      schedule(async () => {
        try {
          results[i] = await fn(item);
        } catch (err) {
          results[i] = { error: err };
        }
        onDone?.(results[i], i);
      })
    )
  );

  return results;
}

/**
 * ATS-specific default concurrency limits.
 * These are conservative defaults; override via env vars.
 *
 * Lowered 2026-09-15 after migrating DATABASE_URL from Neon to AWS RDS: the
 * old Neon-tuned values (greenhouse 60, etc.) reliably crashed full scans
 * against the new RDS instance with "timeout exceeded when trying to
 * connect" after ~5-7 minutes of sustained load — reproduced twice. These
 * values (8/5/5/5/5/5) completed a full 1,481-company scan cleanly (0
 * errors), just slower (~21 min vs ~5 min against Neon). If the RDS
 * instance is later resized/confirmed to handle more, these can go back up.
 */
export const ATS_CONCURRENCY = {
  greenhouse:      parseInt(process.env.WORKERS_GREENHOUSE     || '8'),
  ashby:           parseInt(process.env.WORKERS_ASHBY          || '5'),
  lever:           parseInt(process.env.WORKERS_LEVER          || '5'),
  workday:         parseInt(process.env.WORKERS_WORKDAY         || '5'),
  bamboohr:        parseInt(process.env.WORKERS_BAMBOOHR        || '5'),
  workable:        parseInt(process.env.WORKERS_WORKABLE        || '5'),
  smartrecruiters: parseInt(process.env.WORKERS_SMARTRECRUITERS || '5'),
  recruitee:       parseInt(process.env.WORKERS_RECRUITEE       || '5'),
  breezy:          parseInt(process.env.WORKERS_BREEZY          || '5'),
  pinpoint:        parseInt(process.env.WORKERS_PINPOINT        || '5'),
  rippling:        parseInt(process.env.WORKERS_RIPPLING        || '3'), // list + per-job detail calls
  teamtailor:      parseInt(process.env.WORKERS_TEAMTAILOR      || '5'),
  oraclecloud:     parseInt(process.env.WORKERS_ORACLECLOUD     || '2'), // big paginated tenants
};
