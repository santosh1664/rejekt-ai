/**
 * Wrap a slow async fn(key, ...args) so callers always get an answer from memory once one exists.
 * Younger than `ttl`: served as is. Older (up to `maxAge`): served immediately AND refreshed in the
 * background, so nobody waits on the database. A failed refresh keeps the old value. Only the very
 * first call per key (nothing cached yet) waits for fn, and it throws if fn throws.
 */
// Optional shared layer: with REDIS_URL set and a `name`, every web instance reuses one another's results
// (and they survive a restart). Redis down or unset → plain per-process memory, never an error.
import { createHash } from 'node:crypto';
let redis;
async function shared() {
  if (redis !== undefined) return redis;
  if (!process.env.REDIS_URL) return (redis = null);
  const { createClient } = await import('redis');
  redis = createClient({ url: process.env.REDIS_URL, disableOfflineQueue: true, socket: { reconnectStrategy: n => Math.min(n * 500, 10_000) } });
  redis.on('error', e => console.error(`[redis] ${e.message}`));
  await Promise.race([redis.connect(), new Promise(r => setTimeout(r, 1000))]).catch(() => {}); // later calls reuse the client; it keeps retrying in the background
  return redis;
}
const rkey = (name, key) => `sc:${name}:${createHash('sha1').update(String(key)).digest('hex')}`;

export function cached(fn, { ttl, maxAge, max = 200, name }) {
  const withShared = !name ? fn : async (key, ...a) => {
    const r = await shared().catch(() => null);
    try { const hit = r?.isReady && JSON.parse(await r.get(rkey(name, key))); if (hit && Date.now() - hit.at < ttl) return hit.value; } catch {}
    const value = await fn(key, ...a);
    try { if (r?.isReady) await r.set(rkey(name, key), JSON.stringify({ at: Date.now(), value }), { EX: Math.ceil(maxAge / 1000) }); } catch {}
    return value;
  };
  const store = new Map(); // key → { at, value, pending }
  const refresh = (key, args) => {
    const e = store.get(key) || {};
    if (e.pending) return e.pending;
    const pending = withShared(key, ...args).then(
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
