import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SOURCES, collectItems } from '../src/pipeline/sources.js';
import { normalizeEvent, dedupeEvents } from '../src/pipeline/normalize.js';
import { scoreAll } from '../src/pipeline/score.js';
import { summarize } from '../src/lib/stats.js';
import { loadFixture, FIXTURE_NOW } from '../fixtures/index.js';

/** Build a snapshot in memory from the recorded payloads. */
function buildSnapshot() {
  const events = [];
  for (const source of SOURCES) {
    let payload;
    try {
      payload = loadFixture(source.key);
    } catch {
      continue;
    }
    for (const item of collectItems(payload)) {
      const event = normalizeEvent(item, source, { now: FIXTURE_NOW });
      if (event) events.push(event);
    }
  }
  return { generated_at: new Date(FIXTURE_NOW).toISOString(), events: scoreAll(dedupeEvents(events), new Set()) };
}

test('site generator produces a crawlable, self-consistent build', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'listing-alpha-site-'));
  try {
    const snapshotPath = join(workDir, 'snapshot.json');
    const outDir = join(workDir, 'dist');
    const snapshot = buildSnapshot();
    writeFileSync(snapshotPath, JSON.stringify(snapshot));

    // stdio: 'inherit' keeps this working under sandboxed environments that
    // forbid capturing a child process's piped output.
    execFileSync(
      process.execPath,
      ['scripts/build-site.mjs', '--input', snapshotPath, '--out', outDir, '--site', 'https://example.test'],
      { stdio: 'inherit' }
    );

    for (const file of ['index.html', 'stats.html', 'pricing.html', 'sitemap.xml', 'robots.txt', 'rss.xml', '404.html', 'style.css']) {
      assert.ok(existsSync(join(outDir, file)), `missing ${file}`);
    }

    const index = readFileSync(join(outDir, 'index.html'), 'utf8');
    assert.ok(index.includes('NOVA/USDT'), 'index should show a tracked symbol');
    assert.ok(index.includes('Binance'), 'index should name a venue');
    assert.ok(index.includes('rel="canonical"'), 'canonical link required for SEO');
    assert.ok(index.includes('application/ld+json'), 'structured data required');

    const eventFile = snapshot.events.find((event) => event.symbol === 'NOVA/USDT');
    assert.ok(eventFile, 'fixture should produce at least one NOVA event');
    const eventPage = readFileSync(join(outDir, 'events', `${eventFile.id}.html`), 'utf8');
    assert.ok(eventPage.includes('Why it scored'), 'event page should explain its score');
    assert.ok(eventPage.includes('https://example.test/events/'), 'event page should use the configured site origin');

    const sitemap = readFileSync(join(outDir, 'sitemap.xml'), 'utf8');
    assert.ok(sitemap.includes('https://example.test/events/'));
    assert.ok(sitemap.includes('/pricing.html'));

    const rss = readFileSync(join(outDir, 'rss.xml'), 'utf8');
    assert.ok(rss.includes('<item>'));
    assert.ok(rss.includes('pubDate'));

    const robots = readFileSync(join(outDir, 'robots.txt'), 'utf8');
    assert.ok(robots.includes('Sitemap: https://example.test/sitemap.xml'));

    assert.ok(existsSync(join(outDir, 'exchanges', 'binance.html')), 'per-venue page missing');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('summarize agrees with the events it was given', () => {
  const snapshot = buildSnapshot();
  const summary = summarize(snapshot.events);
  assert.equal(summary.total, snapshot.events.length);
  assert.equal(
    Object.values(summary.byKind).reduce((a, b) => a + b, 0),
    snapshot.events.length
  );
  assert.equal(
    summary.bySource.reduce((a, b) => a + b.count, 0),
    snapshot.events.length
  );
  assert.ok(summary.avgLatency >= 0);
});

test('titles are escaped, never injected as markup', () => {
  const snapshot = {
    generated_at: new Date(FIXTURE_NOW).toISOString(),
    events: [
      {
        id: 'inj0001',
        source: 'binance',
        kind: 'LISTING',
        symbol: 'XSS/USDT',
        title: '<script>alert(1)</script> Binance Will List XSS',
        url: 'javascript:alert(1)',
        announced_at: '2026-11-02T01:00:00.000Z',
        first_seen_at: '2026-11-02T01:01:00.000Z',
        latency_sec: 60,
        score: 90,
        reasons: ['test'],
        meta: { tier: 'A' },
      },
    ],
  };
  const workDir = mkdtempSync(join(tmpdir(), 'listing-alpha-xss-'));
  try {
    const snapshotPath = join(workDir, 'snapshot.json');
    const outDir = join(workDir, 'dist');
    writeFileSync(snapshotPath, JSON.stringify(snapshot));
    execFileSync(process.execPath, ['scripts/build-site.mjs', '--input', snapshotPath, '--out', outDir], { stdio: 'inherit' });

    const html = readFileSync(join(outDir, 'events', 'inj0001.html'), 'utf8');
    assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag must not survive');
    assert.ok(html.includes('&lt;script&gt;'), 'title must be escaped');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
