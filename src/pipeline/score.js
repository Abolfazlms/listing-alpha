/**
 * Signal scoring.
 *
 * The paying customer is not buying "a list of announcements" — they can get
 * that free from a dozen Telegram channels. They are buying a *ranked* stream:
 * which of today's 40 headlines actually moved price, and how fast we saw it.
 * Score is intentionally explainable: every point has a named reason, because
 * a number without a reason is indistinguishable from noise.
 */

import { KIND } from './normalize.js';

export const SOURCE_WEIGHTS = Object.freeze({
  binance: 1.0,
  upbit: 0.95,
  coinbase: 0.9,
  bybit: 0.8,
  okx: 0.78,
  kucoin: 0.65,
  mexc: 0.62,
  gate: 0.6,
});

export const KIND_WEIGHTS = Object.freeze({
  [KIND.LISTING]: 1.0,
  [KIND.PERP]: 0.72,
  [KIND.DELISTING]: 0.62,
  [KIND.QUOTE]: 0.45,
  [KIND.OTHER]: 0.18,
});

/** How good is a detection latency, in seconds? 1 = perfect. */
export function latencyQuality(latencySec) {
  if (!Number.isFinite(latencySec) || latencySec < 0) return 0.5;
  if (latencySec <= 120) return 1;
  if (latencySec <= 600) return 0.85;
  if (latencySec <= 1800) return 0.65;
  if (latencySec <= 7200) return 0.4;
  return 0.15;
}

/**
 * @param {object} event normalised event
 * @param {{isNewSymbol?: boolean, sourceWeight?: number}} [ctx]
 * @returns {{score: number, tier: string, reasons: string[]}}
 */
export function scoreEvent(event, ctx = {}) {
  const sourceWeight = ctx.sourceWeight ?? SOURCE_WEIGHTS[event.source] ?? 0.5;
  const kindWeight = KIND_WEIGHTS[event.kind] ?? 0.2;
  const novelty = ctx.isNewSymbol === false ? 0 : 1;
  const latency = latencyQuality(event.latency_sec);

  const raw = 0.45 * sourceWeight + 0.3 * kindWeight + 0.15 * novelty + 0.1 * latency;
  const score = Math.max(0, Math.min(100, Math.round(raw * 100)));

  const reasons = [];
  if (sourceWeight >= 0.9) reasons.push('top-tier exchange');
  else if (sourceWeight >= 0.75) reasons.push('major exchange');
  if (event.kind === KIND.LISTING) reasons.push('spot listing');
  if (event.kind === KIND.PERP) reasons.push('derivatives listing');
  if (event.kind === KIND.DELISTING) reasons.push('delisting risk');
  if (novelty === 1) reasons.push('first time seen');
  if (latency >= 0.85) reasons.push('fast detection');

  return { score, tier: tierOf(score), reasons };
}

/** @param {number} score */
export function tierOf(score) {
  if (score >= 80) return 'A';
  if (score >= 65) return 'B';
  if (score >= 50) return 'C';
  return 'D';
}

/**
 * Attach scores to a batch. `seenSymbols` is a Set of symbols we already knew
 * about before this batch, used for the novelty component.
 *
 * @param {object[]} events
 * @param {Set<string>} seenSymbols
 */
export function scoreAll(events, seenSymbols = new Set()) {
  return events.map((event) => {
    const isNewSymbol = event.symbol ? !seenSymbols.has(event.symbol) : false;
    const { score, tier, reasons } = scoreEvent(event, { isNewSymbol });
    return { ...event, score, meta: { ...(event.meta || {}), tier }, reasons };
  });
}
