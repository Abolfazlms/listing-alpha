/**
 * Exchange announcement adapters.
 *
 * Design note: most exchanges do not publish a stable, documented announcement
 * API. Endpoints rot, get renamed, or start returning HTML behind a WAF. So
 * instead of hard-coding one fragile schema per exchange, each source declares
 * an ordered list of candidate endpoints and we use the first one that yields
 * usable items. A generic collector walks the JSON and recognises items by
 * field shape (a title plus a timestamp), which survives most schema changes.
 *
 * Run `npm run check:sources` to see which endpoints answer from your network.
 * Note: some exchanges are DNS-blocked inside Iran; Cloudflare Workers are not
 * behind that boundary, which is exactly why the poller lives there.
 */

import { fetchJson, fetchText, retry } from '../lib/http.js';
import { normalizeEvent, dedupeEvents } from './normalize.js';

const TITLE_KEYS = ['title', 'name', 'subject', 'headline', 'articleTitle', 'annTitle', 'announcementTitle'];
const TIME_KEYS = [
  'timestamp', 'publishTime', 'publishAt', 'publish_time', 'releaseDate', 'announcementAt',
  'createdAt', 'created_at', 'cTime', 'createTime', 'pTime', 'date', 'published_at',
  'updatedAt', 'announceTime', 'releaseTime',
];
const ID_KEYS = ['id', 'articleId', 'annId', 'code', 'slug', 'uuid', 'noticeId', 'businessId', 'articleCode'];
const URL_KEYS = ['url', 'link', 'webUrl', 'href', 'announceUrl', 'wikiUrl', 'announcementUrl', 'detailUrl'];

const LISTING_HINT =
  /\b(list|listing|delist|perpetual|futures|pair|market|launch|support|spot|margin)\b/i;

/** @param {any} node @param {string[]} keys */
function pick(node, keys) {
  for (const key of keys) {
    const value = node?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

/**
 * Walk an arbitrary JSON payload and collect objects that look like an
 * announcement: { title, one timestamp field, optional id/url }.
 * @param {any} payload
 * @param {number} [maxDepth]
 * @returns {{title: string, timestamp: string|number|undefined, externalId?: string, url?: string}[]}
 */
export function collectItems(payload, maxDepth = 8) {
  const items = [];
  const seen = new Set();

  const visit = (node, depth) => {
    if (depth > maxDepth || node == null) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;

    const title = pick(node, TITLE_KEYS);
    if (title && title.length >= 8) {
      let timestamp;
      for (const key of TIME_KEYS) {
        if (node[key] != null) { timestamp = node[key]; break; }
      }
      if (timestamp !== undefined) {
        const externalId = pick(node, ID_KEYS);
        const url = pick(node, URL_KEYS);
        const key = `${externalId || url || title}|${timestamp}`;
        if (!seen.has(key)) {
          seen.add(key);
          items.push({ title, timestamp, externalId, url });
        }
      }
      // Do not recurse into a recognised item: its children are noise
      // (translations, attachments, tags).
      return;
    }
    for (const value of Object.values(node)) visit(value, depth + 1);
  };

  visit(payload, 0);
  return items;
}

/**
 * Last-resort HTML adapter. Announcement pages are server rendered on most
 * exchanges, and headline anchors are stable even when everything else is not.
 * Timestamps are unknown here, so events get `announced_at = now` and a
 * latency of 0 — good enough to alert on, not good enough to backfill.
 * @param {string} html
 * @param {string} baseUrl
 */
export function collectFromHtml(html, baseUrl) {
  const items = [];
  const anchor = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]{15,220}?)<\/a>/gi;
  let match;
  let guard = 0;
  while ((match = anchor.exec(html)) !== null && guard++ < 5000) {
    const href = match[1];
    const text = match[2]
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length < 15 || !LISTING_HINT.test(text)) continue;
    let url = href;
    try {
      url = new URL(href, baseUrl).toString();
    } catch { /* keep raw href */ }
    items.push({ title: text, timestamp: Date.now(), externalId: null, url });
  }
  // De-duplicate identical headlines rendered in multiple slots.
  const unique = new Map();
  for (const item of items) unique.set(item.title.toLowerCase(), item);
  return [...unique.values()];
}

export const SOURCES = [
  {
    key: 'binance',
    name: 'Binance',
    weight: 1.0,
    kind: 'json',
    endpoints: [
      'https://www.binance.com/bapi/composite/v1/public/cms/article/catalog/list/query?type=1&pageNo=1&pageSize=20&catalogId=48',
      'https://www.binance.com/bapi/apex/v1/public/apex/cms/article/list/query?type=1&pageNo=1&pageSize=20&catalogId=161',
    ],
  },
  {
    key: 'upbit',
    name: 'Upbit',
    weight: 0.95,
    kind: 'json',
    endpoints: [
      'https://api-manager.upbit.com/api/v1/announcements?os=web&page=1&per_page=20&category=trade',
      'https://api-manager.upbit.com/api/v1/announcements?os=web&page=1&per_page=20',
    ],
  },
  {
    key: 'coinbase',
    name: 'Coinbase',
    weight: 0.9,
    kind: 'json',
    endpoints: [
      'https://www.coinbase.com/api/v3/announcements?limit=20',
      'https://api.coinbase.com/v2/assets/search?filter=all&limit=50',
    ],
  },
  {
    key: 'okx',
    name: 'OKX',
    weight: 0.78,
    kind: 'json',
    endpoints: [
      'https://www.okx.com/api/v5/support/announcements?annType=announcements-new-listings&page=1',
      'https://www.okx.com/api/v5/support/announcements?page=1',
    ],
  },
  {
    key: 'bybit',
    name: 'Bybit',
    weight: 0.8,
    kind: 'json',
    endpoints: [
      'https://api.bybit.com/v5/announcements/index?locale=en-US&type=new_crypto&page=1&limit=20',
      'https://api.bybit.com/v5/announcements/index?locale=en-US&page=1&limit=20',
    ],
  },
  {
    key: 'mexc',
    name: 'MEXC',
    weight: 0.62,
    kind: 'json',
    endpoints: [
      'https://www.mexc.com/support/api/v1/article/list?page=1&pageSize=20&type=1',
    ],
  },
  {
    key: 'kucoin',
    name: 'KuCoin',
    weight: 0.65,
    kind: 'html',
    endpoints: ['https://www.kucoin.com/news/categories/listing'],
  },
  {
    key: 'gate',
    name: 'Gate',
    weight: 0.6,
    kind: 'html',
    endpoints: ['https://www.gate.com/announcements'],
  },
];

export const sourcesById = Object.fromEntries(SOURCES.map((s) => [s.key, s]));

/**
 * Fetch and parse one source. Tries each candidate endpoint until one yields
 * at least one announcement.
 *
 * @param {typeof SOURCES[number]} source
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{source: string, ok: boolean, endpoint?: string, items: object[], error?: string}>}
 */
export async function fetchSource(source, opts = {}) {
  const errors = [];
  for (const endpoint of source.endpoints) {
    try {
      let items;
      if (source.kind === 'html') {
        const html = await retry(() => fetchText(endpoint, { timeoutMs: opts.timeoutMs ?? 12000 }), { attempts: 2 });
        items = collectFromHtml(html, endpoint);
      } else {
        const payload = await retry(() => fetchJson(endpoint, { timeoutMs: opts.timeoutMs ?? 12000 }), { attempts: 2 });
        items = collectItems(payload);
      }
      if (items.length > 0) return { source: source.key, ok: true, endpoint, items };
      errors.push(`${endpoint} -> 0 items`);
    } catch (error) {
      errors.push(`${endpoint} -> ${error.message}`);
    }
  }
  return { source: source.key, ok: false, items: [], error: errors.join(' | ') };
}

/**
 * Poll every enabled source, normalise, dedupe. Never throws: a dead exchange
 * must not take the whole cycle down.
 *
 * @param {{now?: number, sources?: typeof SOURCES, maxAgeDays?: number}} [opts]
 * @returns {Promise<{events: object[], report: object[]}>}
 */
export async function pollAll(opts = {}) {
  const now = opts.now ?? Date.now();
  const sources = opts.sources ?? SOURCES;
  const report = [];
  const events = [];

  // Sequential-ish (limit 3) to stay friendly to exchange rate limits.
  const results = [];
  const queue = [...sources];
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length) {
      const source = queue.shift();
      const result = await fetchSource(source, { timeoutMs: opts.timeoutMs });
      results.push(result);
    }
  });
  await Promise.all(workers);

  for (const result of results) {
    const source = sourcesById[result.source] || sources.find((s) => s.key === result.source);
    if (!result.ok) {
      report.push({ source: result.source, ok: false, items: 0, events: 0, error: result.error });
      continue;
    }
    const normalised = result.items
      .map((item) => normalizeEvent(item, source, { now, maxAgeDays: opts.maxAgeDays ?? 120 }))
      .filter(Boolean);
    events.push(...normalised);
    report.push({ source: result.source, ok: true, items: result.items.length, events: normalised.length });
  }

  return { events: dedupeEvents(events), report };
}
