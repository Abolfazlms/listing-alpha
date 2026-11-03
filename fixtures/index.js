/**
 * Fixture loader. Feeds are recorded as realistic payloads; timestamps are
 * pinned relative to FIXTURE_NOW so tests are deterministic and never depend
 * on the wall clock.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const FIXTURE_NOW = Date.parse('2026-11-02T02:10:00Z');

const DIR = dirname(fileURLToPath(import.meta.url));

/** @param {string} key @returns {any} */
export function loadFixture(key) {
  return JSON.parse(readFileSync(join(DIR, `${key}.json`), 'utf8'));
}

/** @returns {string[]} */
export function fixtureKeys() {
  return readdirSync(DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.replace(/\.json$/, ''))
    .sort();
}
