/**
 * Normalisation layer: turns whatever shape an exchange announcement feed
 * returns into one canonical event record.
 *
 * Everything here is pure and synchronous so it can be unit tested offline
 * and reused by the Worker, the site builder and the report builder.
 */

export const KIND = Object.freeze({
  LISTING: 'LISTING',
  DELISTING: 'DELISTING',
  PERP: 'PERP',
  QUOTE: 'QUOTE',
  OTHER: 'OTHER',
});

const QUOTES = ['USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD', 'BTC', 'ETH', 'BNB', 'TRY', 'EUR', 'BRL'];
const QUOTE_RE = new RegExp(`\\b(${QUOTES.join('|')})\\b`, 'i');

/**
 * 64-bit-ish FNV-1a. Sync, dependency free, stable across runtimes.
 * Collision risk is irrelevant for our scale and we only need determinism.
 * @param {string} input
 * @returns {string} 16 hex chars
 */
export function hash64(input) {
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b);
  }
  h1 ^= h1 >>> 13;
  h2 ^= h2 >>> 11;
  return ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0'));
}

/**
 * @param {...string} parts
 */
export function stableId(...parts) {
  return hash64(parts.filter(Boolean).join('|'));
}

/**
 * Classify an announcement title. Order matters: a delisting headline often
 * contains the word "list", and a futures headline often says "launch".
 * @param {string} title
 * @returns {string} one of KIND
 */
export function classifyKind(title) {
  const t = String(title || '');
  if (/\b(delist|will remove|removal|removing|suspend|offboard)\w*/i.test(t)) return KIND.DELISTING;
  if (/\b(perpetual|perps?|futures|contract|margin|options?)\b/i.test(t)) return KIND.PERP;
  if (/\b(will list|to list|new listing|now listed|list(ing)?s?\b|add(s|ed)? support|gets? listed|goes? live|now available|begins trading|trading begins|now live|starts trading)\b/i.test(t)) {
    return KIND.LISTING;
  }
  if (/\b(trading pairs?|new pairs?|adds? .{0,20}pairs?|markets?)\b/i.test(t)) return KIND.QUOTE;
  return KIND.OTHER;
}

/**
 * Pull the traded ticker out of a headline.
 * Handles: "Will List XYZ (XYZ)", "XYZ/USDT Perpetual", "Adds XYZ-USD Pair".
 * @param {string} title
 * @returns {{base: string|null, quote: string, symbol: string|null}}
 */
export function parseSymbol(title) {
  const t = String(title || '');

  // 1) Parenthesised ticker, the most reliable convention.
  const paren = t.match(/\(([A-Z0-9]{2,12})\)/);
  if (paren) {
    const base = paren[1].toUpperCase();
    const quote = (t.match(new RegExp(`([A-Z0-9]{2,12})\\s*[\\/\\-]\\s*(${QUOTES.join('|')})`, 'i'))?.[2] || 'USDT').toUpperCase();
    return { base, quote, symbol: `${base}/${quote}` };
  }

  // 2) Explicit pair: XYZ/USDT, XYZ-USDT, XYZUSDT.
  const pair = t.match(/\b([A-Z0-9]{2,12})\s*[\/\-]\s*(USDT|USDC|FDUSD|BUSD|TUSD|BTC|ETH|BNB|TRY|EUR|BRL)\b/i);
  if (pair) {
    const base = pair[1].toUpperCase();
    const quote = pair[2].toUpperCase();
    return { base, quote, symbol: `${base}/${quote}` };
  }

  const glued = t.match(/\b([A-Z0-9]{2,10})(USDT|USDC|FDUSD|BUSD|TUSD)\b/);
  if (glued) {
    const base = glued[1].toUpperCase();
    const quote = glued[2].toUpperCase();
    return { base, quote, symbol: `${base}/${quote}` };
  }

  // 3) Bare ticker: "OKX will delist OLDTOK spot trading pairs". Only accept
  // all-caps tokens so ordinary capitalised words cannot masquerade as tickers,
  // and blacklist the vocabulary that headlines are built from.
  const bare = t.match(/\b([A-Z]{3,10})\b/g) || [];
  for (const token of bare) {
    if (NOT_TICKERS.has(token)) continue;
    return { base: token, quote: 'USDT', symbol: `${token}/USDT` };
  }

  return { base: null, quote: null, symbol: null };
}

/** Words that look like tickers but are not. Kept explicit for reviewability. */
const NOT_TICKERS = new Set([
  'THE', 'AND', 'FOR', 'WITH', 'WILL', 'FROM', 'ONTO', 'INTO', 'THIS', 'THAT',
  'LIST', 'LISTS', 'LISTED', 'LISTING', 'DELIST', 'DELISTS', 'DELISTING', 'REMOVE', 'REMOVES',
  'SPOT', 'PAIR', 'PAIRS', 'TRADE', 'TRADES', 'TRADING', 'MARKET', 'MARKETS', 'ADD', 'ADDS', 'ADDED',
  'NEW', 'NOW', 'LIVE', 'AVAILABLE', 'LAUNCH', 'LAUNCHES', 'STARTS', 'BEGINS', 'SUSPEND', 'SUSPENDED',
  'PERPETUAL', 'PERPETUALS', 'CONTRACT', 'CONTRACTS', 'FUTURES', 'MARGIN', 'OPTION', 'OPTIONS',
  'LEVERAGE', 'SETTLEMENT', 'ANNOUNCEMENT', 'ANNOUNCEMENTS', 'NOTICE', 'UPDATE', 'DETAIL', 'DETAILS',
  'DEPOSIT', 'DEPOSITS', 'WITHDRAWAL', 'WITHDRAWALS', 'WITHDRAW', 'NETWORK', 'NETWORKS', 'UPGRADE',
  'MAINTENANCE', 'SERVICE', 'SUPPORT', 'TRADING', 'API', 'KYC', 'FAQ', 'INFO', 'MORE', 'READ',
  'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER',
  'OCTOBER', 'NOVEMBER', 'DECEMBER', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY',
  'SATURDAY', 'SUNDAY', 'UTC', 'GMT',
  // Venue names: headlines start with the exchange, and the venue is never
  // the traded ticker. Without these, "OKX will delist X" resolves to OKX/USDT.
  'BINANCE', 'OKX', 'UPBIT', 'BYBIT', 'MEXC', 'KUCOIN', 'GATE', 'GATEIO', 'COINBASE',
  'BITGET', 'HTX', 'HUOBI', 'KRAKEN', 'BITSTAMP', 'BITHUMB', 'POLONIEX', 'GEMINI',
  'DERIBIT', 'CRYPTOCOM', 'LAUNCHPOOL', 'KICKSTARTER', 'USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD',
]);

/**
 * Parse the many timestamp shapes feeds use into epoch milliseconds.
 * Returns null when it cannot be parsed with confidence.
 * @param {unknown} value
 * @returns {number|null}
 */
export function toEpochMs(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{10,13}$/.test(trimmed)) return toEpochMs(Number(trimmed));
    // "2026-10-01 12:30:00" and "2026-10-01T12:30:00" carry no zone; exchange
    // feeds publish UTC. Parsing them as local time silently corrupts latency
    // by the host's UTC offset, so pin the zone explicitly.
    const naive = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/;
    const normalised = naive.test(trimmed) ? `${trimmed.replace(' ', 'T')}Z` : trimmed;
    const parsed = Date.parse(normalised);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

export const toIso = (ms) => new Date(ms).toISOString();

/**
 * @typedef {object} RawItem
 * @property {string} [externalId]
 * @property {string} [url]
 * @property {string} title
 * @property {number|string} [timestamp]
 */

/**
 * Build the canonical event row from a raw feed item.
 *
 * @param {RawItem} item
 * @param {{key: string, name: string, weight?: number}} source
 * @param {{now?: number, maxAgeDays?: number}} [opts]
 * @returns {object|null} null when the item is unusable
 */
export function normalizeEvent(item, source, opts = {}) {
  const now = opts.now ?? Date.now();
  const maxAgeDays = opts.maxAgeDays ?? 120;
  const title = String(item?.title || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (title.length < 8) return null;

  const announcedMs = toEpochMs(item.timestamp) ?? now;
  // Drop ancient items (feed pagination, pinned posts) and clock-skewed futures.
  if (announcedMs < now - maxAgeDays * 86400000) return null;
  if (announcedMs > now + 36 * 3600000) return null;

  const { base, quote, symbol } = parseSymbol(title);
  const kind = classifyKind(title);
  const externalId = item.externalId ? String(item.externalId) : item.url || title;
  const latencySec = Math.max(0, Math.round((now - announcedMs) / 1000));

  return {
    id: stableId(source.key, externalId),
    source: source.key,
    kind,
    symbol,
    base,
    quote,
    title,
    url: item.url ? String(item.url) : '',
    announced_at: toIso(announcedMs),
    first_seen_at: toIso(now),
    latency_sec: latencySec,
    score: 0,
    reasons: [],
    meta: { exchange: source.name },
  };
}

/**
 * Reject near-duplicates that survive id hashing: the same headline can be
 * republished under a new id (edited post, mirrored feed).
 * @param {object[]} events
 * @returns {object[]}
 */
export function dedupeEvents(events) {
  const seen = new Set();
  const out = [];
  for (const evt of events) {
    const fingerprint = `${evt.source}|${evt.title.toLowerCase()}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    out.push(evt);
  }
  return out;
}
