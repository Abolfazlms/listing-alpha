/**
 * USDT (TRC20) invoicing.
 *
 * Why build this instead of using Stripe / Lemon Squeezy / Polar:
 *  - every card processor and most merchant-of-record providers geoblock Iran,
 *    so a global product with an Iranian operator cannot onboard to any of them;
 *  - the audience is crypto-native, so "send USDT" is a *lower* friction
 *    checkout than a card form, not a higher one;
 *  - there is no intermediary to freeze the balance.
 *
 * The matching trick: every invoice gets a globally unique micro-amount
 * (e.g. 29.004217 USDT instead of 29.000000). A plain on-chain transfer with no
 * memo is then unambiguous, and no private key or custodial service is needed
 * to detect it — we only read public chain data. Uniqueness is enforced by a
 * partial unique index in SQLite, so two open invoices can never collide.
 *
 * Trade-off to be explicit about: exact-amount matching means the buyer must
 * send the exact figure, which is a real cause of support tickets. The invoice
 * page therefore shows a one-tap "copy amount" and a QR that encodes a
 * TRC20 transfer request, and unmatched transfers are surfaced in the ops log.
 */

import { getInvoice, insertEntitlement, markInvoicePaid, pendingInvoices, recordTxid, expireInvoices, txidAlreadyCredited, openInvoiceAmountExists } from '../pipeline/store.js';
import { sendMessage } from './notify.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MICRO = 1_000_000;

export const PLANS = Object.freeze({
  month: { id: 'month', label: 'Monthly', priceUsdt: 29, days: 30 },
  quarter: { id: 'quarter', label: 'Quarterly', priceUsdt: 69, days: 90 },
  lifetime: { id: 'lifetime', label: 'Lifetime', priceUsdt: 249, days: null },
});

/** @returns {string} n chars from an unambiguous base32 alphabet */
export function randomCode(length = 8) {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function invoiceId() {
  return `inv_${randomCode(10).toLowerCase()}`;
}

export function licenseKey() {
  return `LA-${randomCode(5)}-${randomCode(5)}-${randomCode(5)}`;
}

/**
 * Unique payable amount. Adds a 4-7 digit micro-suffix so the amount itself is
 * the payment reference.
 * @param {number} priceUsdt
 * @returns {number} micro-USDT units
 */
export function uniqueAmountUnits(priceUsdt) {
  const base = Math.round(priceUsdt * MICRO);
  const bytes = new Uint8Array(2);
  globalThis.crypto.getRandomValues(bytes);
  const suffix = ((bytes[0] << 8) | bytes[1]) % 9000 + 100; // 100..9099 micro
  return base + suffix;
}

/** 29004217 -> "29.004217" */
export function formatUnits(units) {
  return (units / MICRO).toFixed(6);
}

/** "29.004217" -> 29004217 */
export function parseUnits(amount) {
  return Math.round(Number(amount) * MICRO);
}

/**
 * Decide whether an on-chain transfer settles an invoice.
 * Pure so the money path is unit-testable without a chain.
 *
 * @param {object} invoice
 * @param {{txid: string, to: string, units: number, timestampMs: number}} transfer
 * @param {{now?: number, graceMs?: number, credited?: boolean}} [opts]
 * @returns {{ok: boolean, reason: string}}
 */
export function matchTransfer(invoice, transfer, opts = {}) {
  const now = opts.now ?? Date.now();
  const graceMs = opts.graceMs ?? 6 * 3600 * 1000;
  if (opts.credited) return { ok: false, reason: 'txid-already-credited' };
  if (invoice.status !== 'pending') return { ok: false, reason: `invoice-${invoice.status}` };
  if (String(transfer.to) !== String(invoice.address)) return { ok: false, reason: 'wrong-address' };
  if (Number(transfer.units) !== Number(invoice.amount_units)) return { ok: false, reason: 'amount-mismatch' };
  const createdMs = Date.parse(invoice.created_at);
  if (Number.isFinite(createdMs) && transfer.timestampMs < createdMs - 120000) {
    return { ok: false, reason: 'transfer-before-invoice' };
  }
  const expiresMs = Date.parse(invoice.expires_at);
  if (Number.isFinite(expiresMs) && transfer.timestampMs > expiresMs + graceMs) {
    return { ok: false, reason: 'transfer-too-late' };
  }
  if (Number.isFinite(expiresMs) && now > expiresMs + graceMs) {
    return { ok: false, reason: 'invoice-expired' };
  }
  return { ok: true, reason: 'matched' };
}

/**
 * Read confirmed USDT TRC20 transfers into an address.
 * TronGrid's public endpoint works without a key at a low rate limit; a key
 * only raises the ceiling.
 *
 * @param {{TRONGRID_BASE?: string, MERCHANT_TRON_ADDRESS: string, USDT_TRC20_CONTRACT?: string, TRONGRID_API_KEY?: string}} env
 * @param {{limit?: number, minTimestampMs?: number}} [opts]
 */
export async function fetchUsdtTransfers(env, opts = {}) {
  const base = env.TRONGRID_BASE || 'https://api.trongrid.io';
  const contract = env.USDT_TRC20_CONTRACT || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
  const params = new URLSearchParams({
    limit: String(opts.limit ?? 100),
    only_confirmed: 'true',
    contract_address: contract,
  });
  if (opts.minTimestampMs) params.set('min_timestamp', String(Math.floor(opts.minTimestampMs)));

  const url = `${base}/v1/accounts/${env.MERCHANT_TRON_ADDRESS}/transactions/trc20?${params}`;
  const headers = { accept: 'application/json' };
  if (env.TRONGRID_API_KEY) headers['TRON-PRO-API-KEY'] = env.TRONGRID_API_KEY;

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`trongrid ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const payload = await res.json();
  const rows = Array.isArray(payload?.data) ? payload.data : [];

  return rows
    .filter((row) => row.type === 'Transfer')
    .map((row) => ({
      txid: row.transaction_id,
      from: row.from,
      to: row.to,
      units: Number(row.value),
      timestampMs: Number(row.block_timestamp),
      symbol: row.token_info?.symbol || 'USDT',
    }));
}

/**
 * Create a new pending invoice. Retries on the (rare) amount collision that the
 * unique index catches.
 *
 * @param {D1Database} db
 * @param {object} env
 * @param {{plan: string, telegramChat?: string, contact?: string, ttlMinutes?: number}} input
 */
export async function createInvoice(db, env, input) {
  const plan = PLANS[input.plan];
  if (!plan) throw new Error(`unknown plan: ${input.plan}`);
  if (!env.MERCHANT_TRON_ADDRESS) throw new Error('MERCHANT_TRON_ADDRESS is not configured');

  const now = Date.now();
  const ttlMinutes = input.ttlMinutes ?? 120;

  for (let attempt = 0; attempt < 6; attempt++) {
    const units = uniqueAmountUnits(plan.priceUsdt);
    if (await openInvoiceAmountExists(db, units)) continue;

    const invoice = {
      id: invoiceId(),
      plan: plan.id,
      amount_units: units,
      amount: formatUnits(units),
      address: env.MERCHANT_TRON_ADDRESS,
      network: 'trc20',
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + ttlMinutes * 60000).toISOString(),
      license_key: licenseKey(),
      telegram_chat: input.telegramChat,
      contact: input.contact,
    };
    await insertInvoice(db, invoice);
    return invoice;
  }
  throw new Error('could not allocate a unique invoice amount, try again');
}

/** @param {object} invoice @param {object} env */
export function paymentInstructions(invoice, env) {
  const site = env.PUBLIC_SITE || '';
  return {
    invoice_id: invoice.id,
    plan: invoice.plan,
    network: invoice.network,
    address: invoice.address,
    amount: invoice.amount,
    amount_units: invoice.amount_units,
    expires_at: invoice.expires_at,
    status: invoice.status,
    copy_hint: `Send exactly ${invoice.amount} USDT (TRC20) to ${invoice.address}`,
    status_url: site ? `${site}/api/v1/invoice/${invoice.id}` : `/api/v1/invoice/${invoice.id}`,
  };
}

/**
 * Reconcile pending invoices against the chain. Run from the scheduled handler.
 *
 * @param {D1Database} db
 * @param {object} env
 * @returns {Promise<{paid: string[], expired: number, examined: number, unmatched: number}>}
 */
export async function reconcileInvoices(db, env) {
  const now = Date.now();
  await expireInvoices(db, new Date(now).toISOString());

  const invoices = await pendingInvoices(db);
  if (!invoices.length) return { paid: [], expired: 0, examined: 0, unmatched: 0 };
  if (!env.MERCHANT_TRON_ADDRESS) return { paid: [], expired: 0, examined: invoices.length, unmatched: 0 };

  const oldest = Math.min(...invoices.map((i) => Date.parse(i.created_at)).filter(Number.isFinite));
  const transfers = await fetchUsdtTransfers(env, { minTimestampMs: oldest - 300000 });

  const paid = [];
  let unmatched = 0;

  for (const invoice of invoices) {
    let settlement = null;
    for (const transfer of transfers) {
      const credited = await txidAlreadyCredited(db, transfer.txid);
      const result = matchTransfer(invoice, transfer, { now, credited });
      if (result.ok) { settlement = transfer; break; }
      if (result.reason === 'amount-mismatch' && transfer.units === Number(invoice.amount_units)) unmatched++;
    }
    if (!settlement) continue;

    const won = await markInvoicePaid(db, invoice.id, settlement.txid, new Date(now).toISOString());
    if (!won) continue; // another isolate settled it first

    await recordTxid(db, settlement.txid, invoice.id, settlement.units);
    const plan = PLANS[invoice.plan] || PLANS.month;
    const expiresAt = plan.days ? new Date(now + plan.days * 86400000).toISOString() : null;
    await insertEntitlement(db, {
      key: invoice.license_key,
      plan: plan.id,
      invoiceId: invoice.id,
      expiresAt,
      telegramChat: invoice.telegram_chat,
    });

    paid.push(invoice.id);
    await deliverAccess(env, invoice, plan).catch((error) => {
      console.error(`delivery failed for ${invoice.id}: ${error.message}`);
    });
  }

  return { paid, expired: 0, examined: invoices.length, unmatched };
}

/** Send licence + Telegram invite to the buyer. */
export async function deliverAccess(env, invoice, plan) {
  if (!env.TELEGRAM_BOT_TOKEN || !invoice.telegram_chat) return;
  const lines = [
    '✅ <b>Payment confirmed</b>',
    `Plan: ${plan.label}`,
    `Licence: <code>${invoice.license_key}</code>`,
  ];
  if (env.INVITE_LINK) lines.push(`Private channel: ${env.INVITE_LINK}`);
  if (env.PUBLIC_SITE) lines.push(`History API: ${env.PUBLIC_SITE}/api/v1/events?key=${invoice.license_key}&history=all`);
  await sendMessage(env.TELEGRAM_BOT_TOKEN, invoice.telegram_chat, lines.join('\n'));
}

/** @param {D1Database} db @param {string} id */
export async function invoiceStatus(db, id) {
  const invoice = await getInvoice(db, id);
  if (!invoice) return null;
  return {
    invoice_id: invoice.id,
    status: invoice.status,
    plan: invoice.plan,
    amount: invoice.amount,
    expires_at: invoice.expires_at,
    paid_at: invoice.paid_at,
    license_key: invoice.status === 'paid' ? invoice.license_key : null,
    invite_link: invoice.status === 'paid' ? '' : null,
  };
}
