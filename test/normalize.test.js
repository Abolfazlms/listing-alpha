import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyKind,
  parseSymbol,
  toEpochMs,
  normalizeEvent,
  dedupeEvents,
  stableId,
  KIND,
} from '../src/pipeline/normalize.js';

test('classifies delisting before listing (headline contains both words)', () => {
  assert.equal(classifyKind('Binance Will Delist OLD Token (OLDTOK)'), KIND.DELISTING);
  assert.equal(classifyKind('Binance Will List Nova Protocol (NOVA)'), KIND.LISTING);
  assert.equal(classifyKind('Binance Futures Will Launch NOVAUSDT Perpetual Contract'), KIND.PERP);
  assert.equal(classifyKind('Nova Protocol (NOVA) is now available on Coinbase'), KIND.LISTING);
  assert.equal(classifyKind('Bybit Will Add Spot Trading Pairs: NOVA/USDC'), KIND.QUOTE);
  assert.equal(classifyKind('Scheduled maintenance on the matching engine'), KIND.OTHER);
});

test('extracts the ticker from every headline shape we have seen', () => {
  assert.deepEqual(parseSymbol('Binance Will List Nova Protocol (NOVA)'), {
    base: 'NOVA', quote: 'USDT', symbol: 'NOVA/USDT',
  });
  assert.equal(parseSymbol('Bybit Lists NOVAUSDT Perpetual Contract').symbol, 'NOVA/USDT');
  assert.equal(parseSymbol('Bybit Will Add Spot Trading Pairs: NOVA/USDC').symbol, 'NOVA/USDC');
  assert.equal(parseSymbol('OKX will delist OLDTOK spot trading pairs').symbol, 'OLDTOK/USDT');
  assert.equal(parseSymbol('MEXC Will Delist OLDTOK and Remove the Trading Pair').symbol, 'OLDTOK/USDT');
  assert.equal(parseSymbol('Upbit will add NOVA (NOVA) to the KRW market').base, 'NOVA');
});

test('never mistakes a venue name or headline vocabulary for a ticker', () => {
  const venues = [
    'Binance will list something new today',
    'OKX announces a maintenance window',
    'Upbit will suspend deposits during the upgrade',
  ];
  for (const title of venues) {
    const parsed = parseSymbol(title);
    assert.equal(parsed.base, null, `should not invent a symbol from: ${title}`);
  }
});

test('parses timestamps as UTC even when the feed omits a zone', () => {
  const iso = Date.parse('2026-11-02T01:40:00Z');
  assert.equal(toEpochMs('2026-11-02T01:40:00Z'), iso);
  assert.equal(toEpochMs('2026-11-02T01:40:00'), iso, 'naive ISO must be read as UTC');
  assert.equal(toEpochMs('2026-11-02 01:40:00'), iso, 'space separated must be read as UTC');
  assert.equal(toEpochMs(1793583600), iso, 'epoch seconds');
  assert.equal(toEpochMs(1793583660000), iso + 60000, 'epoch millis');
  assert.equal(toEpochMs('not a date'), null);
});

test('stableId is deterministic and source scoped', () => {
  assert.equal(stableId('binance', 'abc'), stableId('binance', 'abc'));
  assert.notEqual(stableId('binance', 'abc'), stableId('okx', 'abc'));
  assert.match(stableId('binance', 'abc'), /^[0-9a-f]{16}$/);
});

test('normalizeEvent rejects stale and far-future items', () => {
  const now = Date.parse('2026-11-02T02:10:00Z');
  const source = { key: 'binance', name: 'Binance' };

  const fresh = normalizeEvent(
    { title: 'Binance Will List Nova Protocol (NOVA)', timestamp: now - 600000 },
    source,
    { now }
  );
  assert.equal(fresh.kind, KIND.LISTING);
  assert.equal(fresh.symbol, 'NOVA/USDT');
  assert.equal(fresh.latency_sec, 600);
  assert.equal(fresh.announced_at, '2026-11-02T02:00:00.000Z');

  const stale = normalizeEvent(
    { title: 'Binance Will List Something (OLD)', timestamp: now - 400 * 86400000 },
    source,
    { now }
  );
  assert.equal(stale, null);

  const future = normalizeEvent(
    { title: 'Binance Will List Something (FUT)', timestamp: now + 72 * 3600000 },
    source,
    { now }
  );
  assert.equal(future, null);

  const tooShort = normalizeEvent({ title: 'hi', timestamp: now }, source, { now });
  assert.equal(tooShort, null);
});

test('dedupeEvents collapses republished headlines from the same venue', () => {
  const base = {
    source: 'binance',
    kind: KIND.LISTING,
    title: 'Binance Will List Nova (NOVA)',
    announced_at: '2026-11-02T02:00:00.000Z',
  };
  const events = [{ ...base, id: 'a' }, { ...base, id: 'b' }];
  assert.equal(dedupeEvents(events).length, 1);
});
