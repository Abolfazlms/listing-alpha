/**
 * The business loop, extracted from the Worker entrypoint so it can be driven
 * by the cron trigger, by an admin HTTP call (CI smoke tests), or by tests.
 * Deliberately free of request/response objects.
 */

import {
  knownSymbols,
  insertEvents,
  pendingPaidEvents,
  markPaidNotified,
  dueFreeEvents,
  markFreeNotified,
  trackSymbols,
} from '../pipeline/store.js';
import { pollAll } from '../pipeline/sources.js';
import { scoreAll } from '../pipeline/score.js';
import { broadcast } from './notify.js';
import { reconcileInvoices } from './payments.js';

/**
 * Poll every venue, score, alert the paid tier, settle pending invoices.
 * @param {object} env
 * @returns {Promise<object>} a structured summary, logged and returned to admin callers
 */
export async function pollCycle(env) {
  const now = Date.now();
  const { events, report } = await pollAll({ now });
  const known = await knownSymbols(env.DB);
  const scored = scoreAll(events, known);

  const inserted = await insertEvents(env.DB, scored);
  await trackSymbols(env.DB, scored);

  // Anything still un-notified and above the bar is necessarily new, because
  // delivered rows are marked immediately after a successful send.
  let alerted = 0;
  if (env.TELEGRAM_BOT_TOKEN && env.PAID_CHANNEL) {
    const pending = await pendingPaidEvents(env.DB, 55, 8);
    const delivered = await broadcast(env, pending, { freeTier: false });
    await markPaidNotified(env.DB, delivered);
    alerted = delivered.length;
  }

  const settlements = await reconcileInvoices(env.DB, env);

  return {
    polled: report.filter((r) => r.ok).length,
    sourcesFailed: report.filter((r) => !r.ok).map((r) => r.source),
    found: events.length,
    inserted,
    alerted,
    paid: settlements.paid.length,
  };
}

/**
 * Release the delayed free-tier feed.
 * @param {object} env
 */
export async function flushFreeTier(env) {
  const delaySec = Number(env.PAYWALL_DELAY_SEC || 900);
  const due = await dueFreeEvents(env.DB, delaySec, 10);
  if (!due.length) return { flushed: 0 };

  if (!env.TELEGRAM_BOT_TOKEN || !env.FREE_CHANNEL) {
    // No free channel configured yet: drain the queue so it cannot grow
    // unbounded while the product is still being wired up.
    await markFreeNotified(env.DB, due.map((e) => e.id));
    return { flushed: 0, drained: due.length };
  }

  const delivered = await broadcast(env, due, { freeTier: true });
  await markFreeNotified(env.DB, delivered.length ? delivered : due.map((e) => e.id));
  return { flushed: delivered.length };
}
