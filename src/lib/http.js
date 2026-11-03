/**
 * Minimal fetch helpers. Zero dependencies so the same file runs in the
 * Cloudflare Workers runtime, in Node 20+, and in Deno.
 */

export class HttpError extends Error {
  constructor(status, url, body = '') {
    super(`HTTP ${status} for ${url}${body ? ` :: ${body.slice(0, 160)}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

const DEFAULT_UA =
  'ListingAlphaBot/0.1 (+https://github.com/listing-alpha; announcement monitor)';

/**
 * @param {string} url
 * @param {{headers?: Record<string,string>, timeoutMs?: number, method?: string, body?: string}} [opts]
 * @returns {Promise<string>}
 */
export async function fetchText(url, opts = {}) {
  const { headers = {}, timeoutMs = 12000, method = 'GET', body } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      body,
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': DEFAULT_UA,
        accept: 'application/json, text/html;q=0.9, */*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        ...headers,
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new HttpError(res.status, url, text);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} url
 * @param {object} [opts]
 * @returns {Promise<any>}
 */
export async function fetchJson(url, opts = {}) {
  const text = await fetchText(url, opts);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON from ${url}, got: ${text.slice(0, 120)}`);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run an async mapper with bounded concurrency. Used to poll many exchanges
 * without opening dozens of sockets at once (Workers limits subrequests).
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Retry an async operation with exponential backoff. Exchange endpoints are
 * flaky and rate limited; a single 429 must not blank out a polling cycle.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{attempts?: number, baseMs?: number, onError?: (e: Error, attempt: number) => void}} [opts]
 * @returns {Promise<T>}
 */
export async function retry(fn, opts = {}) {
  const { attempts = 3, baseMs = 400, onError } = opts;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      onError?.(error, attempt);
      if (attempt < attempts) await sleep(baseMs * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}
