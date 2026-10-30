/**
 * Wrap a slow async fn(key, ...args) so callers always get an answer from memory once one exists.
 * Younger than `ttl`: served as is. Older (up to `maxAge`): served immediately AND refreshed in the
 * background, so nobody waits on the database. A failed refresh keeps the old value. Only the very
 * first call per key (nothing cached yet) waits for fn, and it throws if fn throws.
 */
export function cached(fn, { ttl, maxAge, max = 200 }) {
  const store = new Map(); // key → { at, value, pending }
  const refresh = (key, args) => {
    const e = store.get(key) || {};
    if (e.pending) return e.pending;
    const pending = fn(key, ...args).then(
      value => { store.delete(key); store.set(key, { at: Date.now(), value }); if (store.size > max) store.delete(store.keys().next().value); return value; },
      err => {
        const cur = store.get(key);
        if (cur?.value !== undefined) { cur.pending = null; console.error(`[stale-cache] refresh failed, keeping cached result: ${err.message}`); return cur.value; }
        store.delete(key);
        throw err;
      });
    store.set(key, { ...e, pending });
    return pending;
  };
  return (key, ...args) => {
    const e = store.get(key);
    if (e?.value !== undefined && Date.now() - e.at < maxAge) {
      if (Date.now() - e.at >= ttl) refresh(key, args).catch(() => {});
      return Promise.resolve(e.value);
    }
    return refresh(key, args);
  };
}

if (process.argv[1]?.endsWith('stale-cache.mjs')) {
  const assert = (await import('node:assert')).strict;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  let calls = 0, fail = false;
  const c = cached(async k => { calls++; await wait(10); if (fail) throw new Error('timeout'); return k + calls; }, { ttl: 20, maxAge: 1000 });
  assert.equal(await c('a'), 'a1');
  assert.equal(await c('a'), 'a1'); assert.equal(calls, 1);   // fresh: no second call
  await wait(30);
  assert.equal(await c('a'), 'a1');                           // expired: answered from memory at once…
  await wait(30); assert.equal(await c('a'), 'a2');           // …and the background refresh landed
  fail = true; await wait(30);
  assert.equal(await c('a'), 'a2'); await wait(30);           // refresh fails: old value kept
  assert.equal(await c('a'), 'a2');
  await assert.rejects(c('never-worked'));                    // nothing cached yet + fn fails → error
  console.log('stale-cache ok');
}
