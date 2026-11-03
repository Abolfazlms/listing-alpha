#!/usr/bin/env node
/**
 * Probe every exchange endpoint and report what actually answers *from this
 * network*. Undocumented exchange APIs move; this is the tool that tells you
 * which adapter to repair, instead of discovering it from an empty dashboard.
 *
 *   npm run check:sources
 *   npm run check:sources -- --json
 *
 * Exit code is 0 even when sources fail (this is a diagnostic, not a gate).
 */

import { SOURCES, fetchSource } from '../src/pipeline/sources.js';

const asJson = process.argv.includes('--json');
const timeoutMs = 12000;

const rows = [];
for (const source of SOURCES) {
  const started = Date.now();
  const result = await fetchSource(source, { timeoutMs });
  rows.push({
    source: source.key,
    ok: result.ok,
    items: result.items.length,
    ms: Date.now() - started,
    endpoint: result.endpoint || (source.endpoints[0] || ''),
    error: result.ok ? '' : String(result.error || '').split(' | ')[0].slice(0, 110),
  });
}

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log('\nSOURCE PROBE — which announcement feeds answer from this network');
  console.log('='.repeat(96));
  for (const row of rows) {
    const status = row.ok ? 'OK  ' : 'FAIL';
    console.log(
      `${status}  ${row.source.padEnd(10)} ${String(row.items).padStart(3)} items  ${String(row.ms).padStart(5)}ms  ${row.error || row.endpoint.slice(0, 70)}`
    );
  }
  const healthy = rows.filter((r) => r.ok).length;
  console.log('-'.repeat(96));
  console.log(`${healthy}/${rows.length} sources healthy`);
  if (healthy === 0) {
    console.log('None reachable. Inside Iran several venues are DNS-blocked — Cloudflare Workers are not.');
  }
}
