import test from 'node:test';
import assert from 'node:assert/strict';

import {
  uniqueAmountUnits,
  formatUnits,
  parseUnits,
  randomCode,
  licenseKey,
  invoiceId,
  matchTransfer,
  PLANS,
} from '../src/worker/payments.js';

const NOW = Date.parse('2026-11-02T02:10:00Z');

const invoice = (overrides = {}) => ({
  id: 'inv_test',
  status: 'pending',
  plan: 'month',
  amount_units: 29_004_217,
  amount: '29.004217',
  address: 'TMerchantAddress',
  created_at: new Date(NOW - 60_000).toISOString(),
  expires_at: new Date(NOW + 7_200_000).toISOString(),
  ...overrides,
});

const transfer = (overrides = {}) => ({
  txid: 'txid-1',
  to: 'TMerchantAddress',
  units: 29_004_217,
  timestampMs: NOW,
  ...overrides,
});

test('invoice amounts are unique-friendly and anchored to the plan price', () => {
  for (const plan of Object.values(PLANS)) {
    const base = plan.priceUsdt * 1_000_000;
    for (let i = 0; i < 200; i++) {
      const units = uniqueAmountUnits(plan.priceUsdt);
      assert.ok(units > base, 'must exceed the round price');
      assert.ok(units <= base + 9_099, 'suffix stays within 4 digits');
      assert.ok(Number.isInteger(units));
    }
  }
});

test('amount formatting round-trips at micro precision', () => {
  assert.equal(formatUnits(29_004_217), '29.004217');
  assert.equal(parseUnits('29.004217'), 29_004_217);
  assert.equal(parseUnits(formatUnits(249_000_123)), 249_000_123);
  assert.equal(formatUnits(1), '0.000001');
});

test('codes are unambiguous and long enough to be unguessable', () => {
  const code = randomCode(12);
  assert.equal(code.length, 12);
  assert.match(code, /^[A-HJ-NP-Z2-9]+$/, 'no 0/O/1/I ambiguity');
  const seen = new Set(Array.from({ length: 500 }, () => randomCode(10)));
  assert.equal(seen.size, 500, 'no collisions in 500 draws');
  assert.match(invoiceId(), /^inv_[a-z2-9]{10}$/);
  assert.match(licenseKey(), /^LA-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
});

test('exact transfer settles the invoice', () => {
  assert.deepEqual(matchTransfer(invoice(), transfer(), { now: NOW }), { ok: true, reason: 'matched' });
});

test('off-by-one micro is refused — the amount *is* the reference', () => {
  const result = matchTransfer(invoice(), transfer({ units: 29_004_218 }), { now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'amount-mismatch');
});

test('transfers to another address are ignored', () => {
  assert.equal(matchTransfer(invoice(), transfer({ to: 'TSomeoneElse' }), { now: NOW }).reason, 'wrong-address');
});

test('a replayed txid can never settle a second invoice', () => {
  assert.equal(matchTransfer(invoice(), transfer(), { now: NOW, credited: true }).reason, 'txid-already-credited');
});

test('stale transfers and expired invoices are refused', () => {
  const early = matchTransfer(invoice(), transfer({ timestampMs: NOW - 600_000 }), { now: NOW });
  assert.equal(early.reason, 'transfer-before-invoice');

  const lateInvoice = invoice({ expires_at: new Date(NOW - 7 * 3600_000).toISOString() });
  assert.equal(matchTransfer(lateInvoice, transfer(), { now: NOW }).reason, 'transfer-too-late');

  const expiredNow = matchTransfer(invoice(), transfer(), { now: NOW + 24 * 3600_000 });
  assert.equal(expiredNow.reason, 'invoice-expired');
});

test('already-paid invoices are not settled twice', () => {
  assert.equal(matchTransfer(invoice({ status: 'paid' }), transfer(), { now: NOW }).reason, 'invoice-paid');
});

test('a transfer inside the grace window still settles after expiry', () => {
  const expired = invoice({ expires_at: new Date(NOW - 60_000).toISOString() });
  const result = matchTransfer(expired, transfer({ timestampMs: NOW - 30_000 }), { now: NOW });
  assert.equal(result.ok, true);
});
