/**
 * lib/http.mjs
 * Shared HTTP utilities — fetch with retry, timeout, 429 backoff.
 * Zero AI tokens.
 */

const DEFAULT_TIMEOUT_MS  = 15_000;
const DEFAULT_RETRY_COUNT = 2;
const RETRY_DELAY_MS      = 2_000;

export const INTER_REQUEST_DELAY_MS = 100; // polite delay between requests to same host

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch with automatic retry on network errors, 429, and 5xx.
 * `parse` extracts the return value from a successful `Response`.
 */
async function fetchWithRetry(url, opts, parse) {
  const {
    method    = 'GET',
    headers   = {},
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries   = DEFAULT_RETRY_COUNT,
  } = opts;

  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS * attempt);

    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method,
        headers: { Accept: 'application/json', ...headers },
        ...(body ? { body } : {}),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.status === 429) {
        // Only wait when a retry follows, and never longer than a minute: Workable answers Retry-After: 8213
        // (2.3 h), and sleeping that out held a scan worker until the company timeout.
        const wait = Math.min(parseInt(res.headers.get('Retry-After') || '10', 10), 60);
        lastErr = new Error(`HTTP 429 (Retry-After ${res.headers.get('Retry-After') ?? '?'}s)`);
        if (attempt < retries) await sleep(wait * 1_000);
        continue;
      }
      if (res.status >= 500) { lastErr = new Error(`HTTP ${res.status}`); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

      return await parse(res);

    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') { lastErr = new Error(`Timeout ${timeoutMs}ms`); continue; }
      if (err.cause || err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') { lastErr = err; continue; }
      throw err; // 4xx or parse error — don't retry
    }
  }

  throw lastErr || new Error('Request failed after retries');
}

/**
 * Fetch JSON with automatic retry on network errors, 429, and 5xx.
 */
export async function fetchJSON(url, opts = {}) {
  return fetchWithRetry(url, opts, (res) => res.json());
}

/**
 * Fetch raw text with automatic retry on network errors, 429, and 5xx.
 * Use for endpoints that return newline-delimited JSON (e.g. Common Crawl's CDX API),
 * which isn't valid input for `res.json()`.
 */
export async function fetchText(url, opts = {}) {
  return fetchWithRetry(url, opts, (res) => res.text());
}

/**
 * HEAD request — used for liveness checks. Returns HTTP status code.
 *
 * @param {string} url
 * @param {number|object} [optsOrTimeout]  — ms timeout OR { headers, timeoutMs }
 */
export async function headStatus(url, optsOrTimeout = 8_000) {
  const isNum     = typeof optsOrTimeout === 'number';
  const timeoutMs = isNum ? optsOrTimeout : (optsOrTimeout?.timeoutMs ?? 8_000);
  const headers   = isNum ? {} : (optsOrTimeout?.headers ?? {});

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'HEAD', headers, signal: controller.signal });
    clearTimeout(timer);
    return res.status;
  } catch {
    clearTimeout(timer);
    return 0; // network error
  }
}

export function normalizeLocation(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim();
}
