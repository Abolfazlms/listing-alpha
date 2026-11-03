import test from 'node:test';
import assert from 'node:assert/strict';

import { collectItems, collectFromHtml, SOURCES, sourcesById } from '../src/pipeline/sources.js';
import { loadFixture, fixtureKeys } from '../fixtures/index.js';

test('the generic collector understands every recorded venue schema', () => {
  const expected = {
    binance: 3,
    upbit: 2,
    bybit: 2,
    okx: 2,
    coinbase: 2,
    mexc: 2,
  };

  for (const [key, count] of Object.entries(expected)) {
    const items = collectItems(loadFixture(key));
    assert.equal(items.length, count, `${key} should yield ${count} items`);
    for (const item of items) {
      assert.ok(item.title.length >= 8, `${key}: title too short`);
      assert.ok(item.timestamp !== undefined, `${key}: missing timestamp`);
    }
  }
});

test('collector does not duplicate the same article across nested catalogs', () => {
  const payload = {
    data: {
      catalogs: [
        { articles: [{ id: 1, title: 'Binance Will List Alpha (ALPHA)', releaseDate: 1793583000000 }] },
        { articles: [{ id: 1, title: 'Binance Will List Alpha (ALPHA)', releaseDate: 1793583000000 }] },
      ],
    },
  };
  assert.equal(collectItems(payload).length, 1);
});

test('every fixture maps onto one of the declared sources', () => {
  for (const key of fixtureKeys()) {
    assert.ok(sourcesById[key], `fixture ${key} has no matching source definition`);
  }
});

test('html fallback keeps announcement links and drops navigation chrome', () => {
  const html = `
    <nav><a href="/">Home</a><a href="/login">Log in</a></nav>
    <ul>
      <li><a href="/news/1">KuCoin Will List Nova Protocol (NOVA) for spot trading</a></li>
      <li><a href="/news/2">Scheduled maintenance notice for the API</a></li>
      <li><a href="/news/3">KuCoin Will Delist OLDTOK trading pairs</a></li>
    </ul>`;
  const items = collectFromHtml(html, 'https://www.kucoin.com/news/categories/listing');
  assert.equal(items.length, 2);
  assert.equal(items[0].url, 'https://www.kucoin.com/news/1');
  assert.ok(items.some((item) => item.title.includes('Will List')));
  assert.ok(!items.some((item) => item.title.includes('maintenance')));
});

test('source definitions are well formed', () => {
  const keys = new Set();
  for (const source of SOURCES) {
    assert.ok(source.key && !keys.has(source.key), 'unique key');
    keys.add(source.key);
    assert.ok(Array.isArray(source.endpoints) && source.endpoints.length > 0, `${source.key}: endpoints`);
    assert.ok(['json', 'html'].includes(source.kind), `${source.key}: kind`);
    assert.ok(source.weight > 0 && source.weight <= 1, `${source.key}: weight`);
  }
});
