#!/usr/bin/env node
/**
 * Builds the sellable artefacts: a Markdown dataset report and a clean CSV.
 *
 * This is the "first dollar" product. It needs no runtime, no payments
 * integration and no support: it is produced from data we already collect,
 * priced low enough to be an impulse buy, and doubles as marketing for the
 * subscription.
 *
 *   node scripts/build-report.mjs --input data/snapshot.json --out data
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { summarize, formatLatency } from '../src/lib/stats.js';

const args = parseArgs(process.argv.slice(2));
const inputPath = args.input || 'data/snapshot.json';
const outDir = args.out || 'data';
const label = args.label || new Date().toISOString().slice(0, 10);

if (!existsSync(inputPath)) {
  console.error(`No snapshot at ${inputPath}. Run: npm run export`);
  process.exit(1);
}

const snapshot = JSON.parse(readFileSync(inputPath, 'utf8'));
const events = (snapshot.events || []).slice().sort((a, b) => String(b.announced_at).localeCompare(String(a.announced_at)));
const summary = summarize(events);
const highSignal = events.filter((e) => (e.score ?? 0) >= 80);
const listings = events.filter((e) => e.kind === 'LISTING');

mkdirSync(outDir, { recursive: true });

/* --------------------------------- CSV ---------------------------------- */

const header = ['announced_at', 'source', 'kind', 'symbol', 'score', 'tier', 'latency_sec', 'title', 'url'];
const csvEscape = (value) => {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const csv = [
  header.join(','),
  ...events.map((event) =>
    [
      event.announced_at,
      event.source,
      event.kind,
      event.symbol || '',
      event.score ?? 0,
      event.meta?.tier || '',
      event.latency_sec ?? '',
      event.title,
      event.url || '',
    ]
      .map(csvEscape)
      .join(',')
  ),
].join('\n');

writeFileSync(join(outDir, 'listings.csv'), csv);

/* -------------------------------- report -------------------------------- */

const top = [...events].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 25);

const report = `# Listing Alpha — Exchange Listing Report (${label})

**Coverage window:** ${String(events.at(-1)?.announced_at || '').slice(0, 10)} → ${String(events[0]?.announced_at || '').slice(0, 10)}
**Events:** ${summary.total} · **Spot listings:** ${listings.length} · **High-signal (A):** ${highSignal.length}
**Venues:** ${summary.bySource.length} · **Mean detection latency:** ${formatLatency(summary.avgLatency)}

---

## 1. What this dataset answers

Every row is an announcement observed on an exchange's own announcement feed, normalised to
a single schema and timestamped twice: when the venue published it, and when our poller saw
it. The gap between the two is *detection latency* — the only number that matters if you
trade listings, and the one no free channel publishes.

Because the same ticker usually gets announced by several venues within hours, this file lets
you answer questions that are otherwise guesswork:

- Which exchanges lead and which follow on the same token?
- How fast is the announcement feed itself, per venue?
- How often is a "listing" actually a perpetual or a quote-currency addition?

## 2. Venue coverage

| Venue | Events | Spot listings | Mean detection |
|---|---:|---:|---:|
${summary.bySource.map((s) => `| ${s.source} | ${s.count} | ${s.listings} | ${formatLatency(s.avgLatency)} |`).join('\n')}

## 3. Announcement mix

| Type | Count |
|---|---:|
${Object.entries(summary.byKind).map(([kind, count]) => `| ${kind} | ${count} |`).join('\n')}

## 4. Most frequently announced symbols

${summary.topSymbols.slice(0, 10).map((s, i) => `${i + 1}. **${s.symbol}** — ${s.count} announcements`).join('\n')}

## 5. Highest-signal events

| Tier | Score | Venue | Type | Symbol | Detected | Announcement |
|---|---:|---|---|---|---:|---|
${top.map((e) => `| ${e.meta?.tier || '-'} | ${e.score ?? 0} | ${e.source} | ${e.kind} | ${e.symbol || '—'} | ${formatLatency(e.latency_sec)} | ${String(e.title).replace(/\|/g, '\\|').slice(0, 90)} |`).join('\n')}

## 6. Method and honesty notes

- **Source:** public announcement pages and APIs of each exchange. Only published, already-public
  information is recorded; nothing is scraped from behind a login.
- **Detection latency** is measured against the venue's own published timestamp, so it includes
  the feed's own publication lag. It is a floor on how fast a human could ever react, not a claim
  that we are first.
- **Signal score** is a transparent weighted combination of venue tier, announcement type,
  symbol novelty and detection speed. It is a prioritisation aid, not a forecast. Nothing here
  predicts price.
- **Delistings and maintenance notices** are included because they carry risk, and are labelled
  as such.

## 7. Access

The live, un-delayed stream and the full archive are available via Telegram and the API.
See \`/pricing\` for terms. This report is generated automatically from the same pipeline, so
its numbers always match the live feed.
`;

writeFileSync(join(outDir, 'report.md'), report);

console.log(`report: ${events.length} events -> ${join(outDir, 'report.md')}, ${join(outDir, 'listings.csv')}`);
console.log(`  venues ${summary.bySource.length} · listings ${listings.length} · high-signal ${highSignal.length} · avg latency ${formatLatency(summary.avgLatency)}`);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; }
    else out[key] = true;
  }
  return out;
}
