/**
 * lib/logos.mjs: company and university logos for job cards and the profile, found and cached on the server.
 *   company: name → website (Clearbit's free name lookup) → that site's icon (DuckDuckGo, then Google's icon service)
 *   school:  the Wikipedia article's seal or logo, else the school's website icon
 * Only the company or school NAME leaves the server, never who asked. A wrong logo is worse than a letter, so a name
 * that doesn't clearly match gets no logo and the app shows the initial instead. Misses are cached for a week.
 *
 *   const logo = await getLogo('company', 'Citigroup')   // { contentType, image } | null
 */
import { query } from './db.mjs';

const UA = { 'User-Agent': 'rejekt-ai/1.0 (support@rejekt.ai)' };
const HIT_DAYS = 90, MISS_DAYS = 7, MAX_PARALLEL = 4;
const SUFFIX = /\b(inc|llc|ltd|corp(oration)?|co|company|technolog(y|ies)|group|holdings|plc|gmbh|limited|the)\b\.?/g;

let ready;
const ensure = () => ready ||= query(`CREATE TABLE IF NOT EXISTS logo_cache (
  kind TEXT NOT NULL, key TEXT NOT NULL, domain TEXT, content_type TEXT, image BYTEA, fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (kind, key))`);

export const keyOf = name => String(name || '').toLowerCase().replace(/['’]/g, '').replace(/&/g, ' and ').replace(SUFFIX, ' ').replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 120);

export function sniff(buf) {
  const h = buf.subarray(0, 12);
  if (h[0] === 0x89 && h[1] === 0x50) return 'image/png';
  if (h[0] === 0xff && h[1] === 0xd8) return 'image/jpeg';
  if (h[0] === 0x47 && h[1] === 0x49) return 'image/gif';
  if (h.toString('latin1', 0, 4) === 'RIFF') return 'image/webp';
  if (/^\s*(<\?xml|<svg)/i.test(buf.subarray(0, 100).toString('utf8'))) return 'image/svg+xml';
  return buf.length > 100 && h[0] === 0 && h[2] === 1 ? 'image/x-icon' : null;
}

const get = async (url, { json = false } = {}) => {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(7000), redirect: 'follow' }).catch(() => null);
  if (!r?.ok) return null;
  return json ? r.json().catch(() => null) : Buffer.from(await r.arrayBuffer());
};
async function image(url, minBytes = 500) {
  const buf = await get(url);
  const type = buf && buf.length >= minBytes && buf.length < 2_000_000 ? sniff(buf) : null;
  return type ? { contentType: type, image: buf } : null;
}

/** "Citigroup" → "citigroup.com", only when the suggestion's name clearly is the same company */
export async function findDomain(name) {
  const want = keyOf(name); if (!want) return null;
  const list = await get(`https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(name)}`, { json: true });
  const hit = (Array.isArray(list) ? list : []).find(c => { const got = keyOf(c.name); return got && (got === want || got.startsWith(want + ' ') || want.startsWith(got + ' ')); });
  return hit?.domain || null;
}
const iconFor = async domain =>
  (await image(`https://icons.duckduckgo.com/ip3/${domain}.ico`)) ||
  (await image(`https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://${domain}&size=128`));

const LOGOISH = /seal|logo|crest|emblem|arms|shield|coat|wordmark|insignia|badge/i;
const SCHOOLISH = /universit|college|institut|school|academy|polytechnic/i;
async function schoolLogo(name) {
  // "Vellore Institute of Technology University" is the article "Vellore Institute of Technology": retry without a trailing "University"
  let title = null;
  for (const q of [name, name.replace(/\s+university$/i, '')]) {
    const t = (await get(`https://en.wikipedia.org/w/api.php?action=opensearch&limit=1&format=json&search=${encodeURIComponent(q)}`, { json: true }))?.[1]?.[0];
    if (t && (keyOf(t).includes(keyOf(q)) || keyOf(q).includes(keyOf(t)))) { title = t; break; }
  }
  if (title) {
    const s = await get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`, { json: true });
    const src = s?.thumbnail?.source;
    if (src && SCHOOLISH.test(`${s.description || ''} ${s.title}`) && LOGOISH.test(decodeURIComponent(src.split('/').pop()))) {
      const img = await image(src, 300); if (img) return img;
    }
  }
  const domain = await findDomain(name);
  return domain ? iconFor(domain) : null;
}

let running = 0; const waiting = [];
const slot = async () => { if (running >= MAX_PARALLEL) await new Promise(r => waiting.push(r)); running++; };
const free = () => { running--; waiting.shift()?.(); };
const inflight = new Map();

export async function getLogo(kind, name) {
  const key = keyOf(name); if (!key || !['company', 'school'].includes(kind)) return null;
  await ensure();
  const { rows: [c] } = await query(`SELECT content_type, image, fetched_at FROM logo_cache WHERE kind = $1 AND key = $2`, [kind, key]);
  const ageDays = c ? (Date.now() - new Date(c.fetched_at)) / 864e5 : Infinity;
  if (c && ageDays < (c.image ? HIT_DAYS : MISS_DAYS)) return c.image ? { contentType: c.content_type, image: c.image } : null;

  const id = `${kind}:${key}`;
  if (!inflight.has(id)) inflight.set(id, (async () => {
    await slot();
    try {
      const found = kind === 'school' ? await schoolLogo(name) : await (async () => { const d = await findDomain(name); return d ? iconFor(d) : null; })();
      await query(`INSERT INTO logo_cache (kind, key, content_type, image, fetched_at) VALUES ($1, $2, $3, $4, NOW())
                   ON CONFLICT (kind, key) DO UPDATE SET content_type = $3, image = $4, fetched_at = NOW()`, [kind, key, found?.contentType || null, found?.image || null]);
      return found;
    } finally { free(); inflight.delete(id); }
  })());
  return inflight.get(id);
}
