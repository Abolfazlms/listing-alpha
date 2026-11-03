#!/usr/bin/env node
/**
 * Pull a full snapshot from the running Worker (admin endpoint) and write it to
 * data/snapshot.json. This is the bridge between the Worker (production data)
 * and GitHub Actions (build + publish), and it is the only reason the Actions
 * job needs a network credential.
 *
 *   API_BASE=https://xxx.workers.dev ADMIN_TOKEN=... npm run export
 */

import { mkdirSync, writeFileSync } from 'node:fs';

const apiBase = (process.env.API_BASE || '').replace(/\/$/, '');
const token = process.env.ADMIN_TOKEN || '';
const days = Number(process.env.SNAPSHOT_DAYS || 400);

if (!apiBase || !token) {
  console.error('Missing API_BASE or ADMIN_TOKEN.');
  console.error('Example: API_BASE=https://listing-alpha.example.workers.dev ADMIN_TOKEN=xxx npm run export');
  process.exit(1);
}

const url = `${apiBase}/api/v1/export?days=${days}`;

for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 401) {
      console.error('401 unauthorized: ADMIN_TOKEN does not match the Worker secret.');
      process.exit(2);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const payload = await res.json();
    if (!Array.isArray(payload.events)) throw new Error('response has no events array');

    mkdirSync('data', { recursive: true });
    writeFileSync('data/snapshot.json', JSON.stringify(payload, null, 2));
    console.log(`snapshot: ${payload.events.length} events, generated ${payload.generated_at} -> data/snapshot.json`);
    process.exit(0);
  } catch (error) {
    console.error(`attempt ${attempt} failed: ${error.message}`);
    if (attempt === 3) process.exit(1);
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
}
