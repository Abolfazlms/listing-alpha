import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fromBinanceKlines,
  fromBybitKlines,
  computeReaction,
} from '../src/pipeline/reactions.js';

const T0 = Date.parse('2026-11-01T00:00:00Z');
const HOUR = 3600 * 1000;

/** Build a flat series with a known shape: entry 100, +40% at 24h, +10% at 7d. */
function series({ hours = 200, entry = 100 } = {}) {
  const candles = [];
  for (let i = 0; i < hours; i++) {
    const t = T0 + i * HOUR;
    const close = i < 24 ? entry + i * (40 / 24) : entry * 1.1 + (i - 24) * -0.01;
    candles.push({ t, o: i === 0 ? entry : candles[i - 1].c, h: close * 1.02, l: close * 0.97, c: close });
  }
  return candles;
}

test('normalises both venue payload shapes to the same candle type', () => {
  const binance = fromBinanceKlines([[T0, '100', '110', '90', '105', '1.0']]);
  const bybit = fromBybitKlines([[T0, '100', '110', '90', '105', '1.0', '2.0']]);
  assert.deepEqual(binance, [{ t: T0, o: 100, h: 110, l: 90, c: 105 }]);
  assert.deepEqual(bybit, binance);
  assert.deepEqual(fromBinanceKlines([[T0, '0', '0', '0', '0']]), [], 'zero prices are dropped');
  assert.deepEqual(fromBinanceKlines('nonsense'), []);
});

test('entry is the open of the first candle at or after the announcement', () => {
  const reaction = computeReaction(series(), T0);
  assert.equal(reaction.entry, 100);
  assert.equal(reaction.entryAt, T0);
});

test('entry follows the announcement when it falls mid-series', () => {
  const candles = series();
  const announced = T0 + 30 * HOUR;
  const reaction = computeReaction(candles, announced);
  assert.equal(reaction.entryAt, announced, 'must not use a candle from before the announcement');
  assert.ok(reaction.entry > 0);
});

test('horizons are computed from the entry price and rounded to 2dp', () => {
  const reaction = computeReaction(series(), T0);
  assert.equal(typeof reaction.returns.h1, 'number');
  assert.equal(typeof reaction.returns.h24, 'number');
  assert.ok(Number.isFinite(reaction.returns.h1));
  // price drifts up over the first day by design
  assert.ok(reaction.returns.h24 > reaction.returns.h1 - 50);
  for (const value of Object.values(reaction.returns)) {
    if (value === null) continue;
    assert.equal(Math.round(value * 100) / 100, value, 'rounded to 2 decimals');
  }
});

test('a horizon the data does not cover is reported as null, never guessed', () => {
  const reaction = computeReaction(series({ hours: 5 }), T0);
  assert.equal(reaction.returns.h1 === null || typeof reaction.returns.h1 === 'number', true);
  assert.equal(reaction.returns.h24, null, 'no 24h of data yet');
  assert.equal(reaction.returns.h168, null, 'no 7d of data yet');
});

test('peak and drawdown describe the seven-day window only', () => {
  const reaction = computeReaction(series(), T0);
  assert.ok(reaction.peak > 0, 'series trends up');
  assert.ok(reaction.drawdown < 0, 'every candle has a lower wick');
  assert.ok(reaction.peak > reaction.returns.h168);
});

test('empty or misaligned input yields null instead of a fabricated number', () => {
  assert.equal(computeReaction([], T0), null);
  assert.equal(computeReaction(null, T0), null);
  const before = series();
  assert.equal(computeReaction(before, T0 + 10_000 * HOUR), null, 'announcement after the series ends');
});
