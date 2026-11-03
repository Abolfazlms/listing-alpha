#!/usr/bin/env node
/**
 * Adds price-reaction statistics to a snapshot.
 *
 *   node scripts/enrich-reactions.mjs --input data/snapshot.json \
 *        --out data/reactions.json --limit 40
 *
 * Needs network access to a public spot API. Run it from GitHub Actions or from
 * a machine where the exchange API is reachable — from inside Iran these hosts
 * are often DNS-blocked, which is why this is a build step and not a runtime one.
 *
 * Failure policy: every individual event is allowed to fail. A missing price
 * series degrades the report, it never blocks publication.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { enrichEvents } from '../src/pipeline/reactions.js';

const args = parseArgs(process.argv.slice(2));
const inputPath = args.input || 'data/snapshot.json';
const outPath = args.out || 'data/reactions.json';
const limit = Number(args.limit || 40);

if (!existsSync(inputPath)) {
  console.error(`No snapshot at ${inputPath}. Run: npm run export`);
  process.exit(1);
}

const snapshot = JSON.parse(readFileSync(inputPath, 'utf8'));
const events = snapshot.events || [];

console.log(`enriching up to ${limit} listing events with price reactions…`);
const reactions = await enrichEvents(events, { limit });

const values = Object.values(reactions);
const h24 = values.map((r) => r.returns?.h24).filter((v) => typeof v === 'number').sort((a, b) => a - b);
const median = h24.length ? h24[Math.floor(h24.length / 2)] : null;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  JSON.stringify({ generated_at: new Date().toISOString(), count: values.length, median_h24: median, reactions }, null, 2)
);

console.log(`wrote ${outPath}: ${values.length}/${events.length} events enriched`);
console.log(`  venues: ${[...new Set(values.map((r) => r.venue))].join(', ') || 'none'}`);
if (median !== null) console.log(`  median 24h reaction: ${median > 0 ? '+' : ''}${median}%`);
if (values.length === 0) {
  console.log('  nothing enriched — usually means no network, or these assets are not on a spot API yet');
}

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
