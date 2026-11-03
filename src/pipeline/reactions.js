/**
 * Price-reaction statistics.
 *
 * This is the part customers actually pay for over time. A headline like
 * "Binance Will List X" is free information; "listings on Binance returned a
 * median +38% within 24h and +11% after seven days" is a product, and nobody
 * sells it because nobody keeps the timestamps aligned with prices.
 *
 * Method (deliberately conservative):
 *   entry  = open of the first hourly candle at/after the announcement time
 *   h1/h24 = close of the candle containing announcement + 1h / + 24h
 *   d7     = close at +168h
 *   peak   = highest high within the 7-day window (best case, not a forecast)
 *
 * Candle times are UTC and hourly, so entry can lag the announcement by up to
 * an hour. That bias is disclosed in the report rather than hidden: publishing a
 * flattering number is how this kind of product loses trust permanently.
 */

/** @typedef {{t: number, o: number, h: number, l: number, c: number}} Candle */

const HOUR_MS = 3600 * 1000;

/**
 * Normalise Binance klines: [[openTime, open, high, low, close, volume, ...]]
 * @param {any[]} rows
 * @returns {Candle[]}
 */
export function fromBinanceKlines(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => ({
      t: Number(row[0]),
      o: Number(row[1]),
      h: Number(row[2]),
      l: Number(row[3]),
      c: Number(row[4]),
    }))
    .filter((c) => Number.isFinite(c.t) && c.o > 0 && c.c > 0)
    .sort((a, b) => a.t - b.t);
}

/**
 * Normalise Bybit klines: [[start, open, high, low, close, volume, turnover]]
 * @param {any[]} rows
 * @returns {Candle[]}
 */
export function fromBybitKlines(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => ({
      t: Number(row[0]),
      o: Number(row[1]),
      h: Number(row[2]),
      l: Number(row[3]),
      c: Number(row[4]),
    }))
    .filter((c) => Number.isFinite(c.t) && c.o > 0 && c.c > 0)
    .sort((a, b) => a.t - b.t);
}

/**
 * @param {Candle[]} candles
 * @param {number} targetMs
 * @returns {Candle|null} the last candle whose open time is <= targetMs
 */
function candleAt(candles, targetMs) {
  let found = null;
  for (const candle of candles) {
    if (candle.t <= targetMs) found = candle;
    else break;
  }
  return found;
}

/**
 * Compute reaction returns from a candle series.
 *
 * @param {Candle[]} candles ascending by time
 * @param {number} announcedMs
 * @param {{horizons?: number[]}} [opts] horizons in hours
 * @returns {{
 *   entry: number,
 *   entryAt: number,
 *   returns: Record<string, number|null>,
 *   peak: number|null,
 *   drawdown: number|null,
 *   coverageHours: number
 * }|null}
 */
export function computeReaction(candles, announcedMs, opts = {}) {
  const horizons = opts.horizons ?? [1, 24, 168];
  if (!Array.isArray(candles) || candles.length === 0) return null;

  const entryIndex = candles.findIndex((candle) => candle.t >= announcedMs);
  const startIndex = entryIndex === -1 ? -1 : entryIndex;
  if (startIndex === -1) return null;

  const entryCandle = candles[startIndex];
  const entry = entryCandle.o;
  if (!(entry > 0)) return null;

  const returns = {};
  for (const hours of horizons) {
    const target = announcedMs + hours * HOUR_MS;
    const candle = candleAt(candles, target);
    // Refuse to report a horizon the data does not actually cover.
    returns[`h${hours}`] =
      candle && candle.t >= announcedMs + 0.5 * hours * HOUR_MS
        ? round((candle.c / entry - 1) * 100)
        : null;
  }

  const windowEnd = announcedMs + 7 * 24 * HOUR_MS;
  const window = candles.filter((candle) => candle.t >= announcedMs && candle.t <= windowEnd);
  const peak = window.length ? round((Math.max(...window.map((c) => c.h)) / entry - 1) * 100) : null;
  const drawdown = window.length ? round((Math.min(...window.map((c) => c.l)) / entry - 1) * 100) : null;

  return {
    entry: round(entry),
    entryAt: entryCandle.t,
    returns,
    peak,
    drawdown,
    coverageHours: Math.round((candles[candles.length - 1].t - entryCandle.t) / HOUR_MS),
  };
}

const round = (value) => Math.round(value * 100) / 100;

/**
 * Fetch hourly candles for a symbol from public spot APIs.
 * Binance first; Bybit as fallback for assets Binance does not list.
 * Returns [] instead of throwing: a missing price series must never break the
 * report build.
 *
 * @param {string} base e.g. "NOVA"
 * @param {{fromMs: number, toMs: number, timeoutMs?: number}} opts
 * @returns {Promise<{candles: Candle[], venue: string}>}
 */
export async function fetchCandles(base, opts) {
  const symbol = `${String(base).toUpperCase()}USDT`;
  const { fromMs, toMs, timeoutMs = 12000 } = opts;

  const attempt = async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    const payload = await attempt(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&startTime=${fromMs}&endTime=${toMs}&limit=200`
    );
    const candles = fromBinanceKlines(payload);
    if (candles.length) return { candles, venue: 'binance' };
  } catch { /* fall through */ }

  try {
    const payload = await attempt(
      `https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=60&start=${fromMs}&end=${toMs}&limit=200`
    );
    const candles = fromBybitKlines(payload?.result?.list);
    if (candles.length) return { candles, venue: 'bybit' };
  } catch { /* fall through */ }

  return { candles: [], venue: 'none' };
}

/**
 * Enrich listing events with reaction stats, bounded by `limit` to keep API
 * usage polite and the build fast.
 *
 * @param {object[]} events
 * @param {{limit?: number, now?: number, fetcher?: typeof fetchCandles}} [opts]
 * @returns {Promise<Record<string, object>>} keyed by event id
 */
export async function enrichEvents(events, opts = {}) {
  const limit = opts.limit ?? 40;
  const now = opts.now ?? Date.now();
  const fetcher = opts.fetcher ?? fetchCandles;
  const out = {};

  const candidates = events
    .filter((event) => event.kind === 'LISTING' && event.base && event.announced_at)
    // Only events old enough to have a 24h window, newest first.
    .filter((event) => Date.parse(event.announced_at) < now - 24 * HOUR_MS)
    .sort((a, b) => String(b.announced_at).localeCompare(String(a.announced_at)))
    .slice(0, limit);

  for (const event of candidates) {
    const announcedMs = Date.parse(event.announced_at);
    if (!Number.isFinite(announcedMs)) continue;
    try {
      const { candles, venue } = await fetcher(event.base, {
        fromMs: announcedMs - 2 * HOUR_MS,
        toMs: Math.min(announcedMs + 7 * 24 * HOUR_MS, now),
      });
      const reaction = computeReaction(candles, announcedMs);
      if (reaction) out[event.id] = { ...reaction, venue, symbol: `${event.base}USDT` };
    } catch { /* skip this event */ }
    // Stay under public rate limits.
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return out;
}
