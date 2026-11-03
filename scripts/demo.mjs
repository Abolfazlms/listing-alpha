#!/usr/bin/env node
/**
 * Offline end-to-end smoke test.
 *
 * Runs the full detection path against recorded exchange payloads — no network,
 * no Cloudflare account, no database — and prints exactly what a paying
 * subscriber would have received. Also exercises the USDT invoice matcher.
 *
 *   npm run demo
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { SOURCES, collectItems } from '../src/pipeline/sources.js';
import { normalizeEvent, dedupeEvents } from '../src/pipeline/normalize.js';
import { scoreAll } from '../src/pipeline/score.js';
import { formatAlert } from '../src/worker/notify.js';
import { formatUnits, matchTransfer, uniqueAmountUnits } from '../src/worker/payments.js';
import { loadFixture, FIXTURE_NOW } from '../fixtures/index.js';

const now = FIXTURE_NOW;
const events = [];
const sourceReport = [];

for (const source of SOURCES) {
  let payload;
  try {
    payload = loadFixture(source.key);
  } catch {
    sourceReport.push({ source: source.key, items: 0, events: 0, note: 'no fixture' });
    continue;
  }
  const items = collectItems(payload);
  const normalised = items
    .map((item) => normalizeEvent(item, source, { now }))
    .filter(Boolean);
  events.push(...normalised);
  sourceReport.push({ source: source.key, items: items.length, events: normalised.length });
}

const unique = dedupeEvents(events);
const scored = scoreAll(unique, new Set()).sort((a, b) => b.score - a.score || a.announced_at.localeCompare(b.announced_at));

/* ---------------------------- detection table --------------------------- */

const padEnd = (value, width) => String(value).padEnd(width).slice(0, width);
const padStart = (value, width) => String(value).padStart(width).slice(0, width);

console.log('\nLISTING ALPHA — offline pipeline run');
console.log('='.repeat(100));
console.log(
  `${padEnd('TIER', 5)}${padStart('SCORE', 6)}  ${padEnd('SOURCE', 10)}${padEnd('KIND', 10)}${padEnd('SYMBOL', 12)}${padStart('LATENCY', 9)}  TITLE`
);
console.log('-'.repeat(100));

for (const event of scored) {
  const tier = event.meta?.tier ?? '-';
  console.log(
    `${padEnd(tier, 5)}${padStart(event.score, 6)}  ${padEnd(event.source, 10)}${padEnd(event.kind, 10)}${padEnd(event.symbol ?? '—', 12)}${padStart(`${event.latency_sec}s`, 9)}  ${String(event.title).slice(0, 46)}`
  );
}

console.log('-'.repeat(100));
console.log(`sources polled: ${sourceReport.filter((r) => r.items > 0).length}/${sourceReport.length}`);
console.log(`candidate items: ${events.length}   unique events: ${unique.length}`);

const byKind = {};
for (const event of unique) byKind[event.kind] = (byKind[event.kind] || 0) + 1;
console.log(`by kind: ${Object.entries(byKind).map(([k, v]) => `${k}=${v}`).join('  ')}`);

const avgLatency = Math.round(unique.reduce((sum, e) => sum + (e.latency_sec || 0), 0) / (unique.length || 1));
const highSignal = scored.filter((e) => e.score >= 80).length;
console.log(`avg detection latency: ${avgLatency}s   high-signal (A): ${highSignal}`);

/* ------------------------- what the customer sees ----------------------- */

const top = scored[0];
if (top) {
  console.log('\nPAID CHANNEL MESSAGE (instant)');
  console.log('='.repeat(100));
  console.log(formatAlert(top));
  console.log('\nFREE CHANNEL MESSAGE (delayed by PAYWALL_DELAY_SEC)');
  console.log('='.repeat(100));
  console.log(formatAlert(top, { freeTier: true }));
}

/* ---------------------------- payment smoke ----------------------------- */

const units = uniqueAmountUnits(29);
const invoice = {
  id: 'inv_demo000000',
  status: 'pending',
  plan: 'month',
  amount_units: units,
  amount: formatUnits(units),
  address: 'TDemoMerchantAddress000000000000',
  created_at: new Date(now - 60000).toISOString(),
  expires_at: new Date(now + 7200000).toISOString(),
};

const goodTransfer = {
  txid: 'demo-txid-001',
  to: invoice.address,
  units,
  timestampMs: now,
};

const wrongAmount = { ...goodTransfer, txid: 'demo-txid-002', units: units + 1 };
const replay = { ...goodTransfer };

console.log('\nUSDT SETTLEMENT MATCHER');
console.log('='.repeat(100));
console.log(`invoice amount ......... ${invoice.amount} USDT (${units} micro)`);
console.log(`exact transfer ......... ${matchTransfer(invoice, goodTransfer, { now }).reason}`);
console.log(`off-by-one micro ....... ${matchTransfer(invoice, wrongAmount, { now }).reason}`);
console.log(`replayed txid .......... ${matchTransfer(invoice, replay, { now, credited: true }).reason}`);

/* ------------------------------- artefact ------------------------------- */

mkdirSync('data', { recursive: true });
const out = {
  generated_at: new Date(now).toISOString(),
  source_report: sourceReport,
  events: scored,
};
writeFileSync('data/demo-events.json', JSON.stringify(out, null, 2));
console.log('\nwrote data/demo-events.json');
