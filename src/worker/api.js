/**
 * HTTP API. Everything is JSON, stateless, and CORS-open: the data is public,
 * the paywall is depth-of-history plus real-time Telegram delivery, not DRM.
 */

import { getStats, listEvents, getEvent, getEntitlement } from '../pipeline/store.js';
import {
  PLANS,
  createInvoice,
  invoiceStatus,
  paymentInstructions,
} from './payments.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'cache-control': 'no-store',
};

/** @param {unknown} data @param {number} [status] */
export function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS });
}

/** @param {string} message @param {number} [status] */
export function fail(message, status = 400) {
  return json({ error: message, status }, status);
}

/** @param {Request} request @param {object} env */
function isAdmin(request, env) {
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return Boolean(env.ADMIN_TOKEN) && token === env.ADMIN_TOKEN;
}

/**
 * Free callers see the recent window only; a valid licence key unlocks the
 * archive. This is the whole product wedge in one function.
 *
 * @param {Request} request
 * @param {object} env
 */
async function resolveHistoryWindow(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key') || request.headers.get('x-api-key') || '';
  const wantsHistory = url.searchParams.get('history') === 'all';
  const freeDays = Number(env.FREE_WINDOW_DAYS || 7);

  let entitlement = null;
  if (key) entitlement = await getEntitlement(env.DB, key.trim());

  if (wantsHistory && !entitlement?.valid) {
    return { error: fail('history=all requires a valid licence key', 402) };
  }
  const since = url.searchParams.get('since');
  if (since && Date.parse(since) < Date.now() - freeDays * 86400000 && !entitlement?.valid) {
    return { error: fail(`free tier is limited to the last ${freeDays} days`, 402) };
  }
  return { entitlement, freeDays, wantsHistory };
}

/** @param {Request} request @param {object} env */
export async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/api/v1';

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: JSON_HEADERS });

  // --- meta ---------------------------------------------------------------
  if (path === '/api/v1' || path === '/api/v1/health') {
    return json({
      ok: true,
      service: 'listing-alpha',
      version: '0.1.0',
      time: new Date().toISOString(),
      sources: ['binance', 'upbit', 'coinbase', 'okx', 'bybit', 'mexc', 'kucoin', 'gate'],
      endpoints: [
        'GET /api/v1/events?limit=50&kind=LISTING&source=binance',
        'GET /api/v1/events?history=all&key=LA-XXXXX-XXXXX-XXXXX',
        'GET /api/v1/events/:id',
        'GET /api/v1/stats?days=7',
        'GET /api/v1/pricing',
        'POST /api/v1/checkout {"plan":"month"}',
        'GET /api/v1/invoice/:id',
      ],
    });
  }

  if (path === '/api/v1/pricing') {
    return json({
      plans: Object.values(PLANS).map((plan) => ({
        id: plan.id,
        label: plan.label,
        price_usdt: plan.priceUsdt,
        days: plan.days,
        includes: ['instant telegram alerts', 'full event archive', 'api key', 'listing reaction stats'],
      })),
      network: 'USDT TRC20',
    });
  }

  // --- events -------------------------------------------------------------
  if (path === '/api/v1/events') {
    const gate = await resolveHistoryWindow(request, env);
    if (gate.error) return gate.error;
    const limit = Number(url.searchParams.get('limit') || 50);
    const events = await listEvents(env.DB, {
      limit,
      since: url.searchParams.get('since') || undefined,
      kind: url.searchParams.get('kind') || undefined,
      source: url.searchParams.get('source') || undefined,
      q: url.searchParams.get('q') || undefined,
      cursor: url.searchParams.get('cursor') || undefined,
    });
    return json({
      count: events.length,
      tier: gate.entitlement?.valid ? 'paid' : 'free',
      window_days: gate.wantsHistory && gate.entitlement?.valid ? 'all' : gate.freeDays,
      next_cursor: events.length ? events[events.length - 1].announced_at : null,
      events,
    });
  }

  const eventMatch = path.match(/^\/api\/v1\/events\/([A-Za-z0-9_-]{4,40})$/);
  if (eventMatch) {
    const event = await getEvent(env.DB, eventMatch[1]);
    return event ? json(event) : fail('event not found', 404);
  }

  if (path === '/api/v1/stats') {
    const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 7, 1), 90);
    return json(await getStats(env.DB, days));
  }

  // --- payments -----------------------------------------------------------
  if (path === '/api/v1/checkout' && request.method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch { /* empty body is fine */ }
    const plan = String(body.plan || 'month');
    try {
      const invoice = await createInvoice(env.DB, env, {
        plan,
        telegramChat: body.telegram_chat,
        contact: body.contact,
      });
      return json(paymentInstructions(invoice, env), 201);
    } catch (error) {
      return fail(error.message, 400);
    }
  }

  const invoiceMatch = path.match(/^\/api\/v1\/invoice\/(inv_[a-z0-9]{6,20})$/);
  if (invoiceMatch) {
    const status = await invoiceStatus(env.DB, invoiceMatch[1]);
    return status ? json(status) : fail('invoice not found', 404);
  }

  const licenseMatch = path.match(/^\/api\/v1\/entitlement\/(LA-[A-Z0-9-]{8,40})$/);
  if (licenseMatch) {
    const entitlement = await getEntitlement(env.DB, licenseMatch[1]);
    if (!entitlement) return fail('unknown licence', 404);
    return json({ valid: entitlement.valid, plan: entitlement.plan, expires: entitlement.expires_at });
  }

  // --- admin --------------------------------------------------------------
  if (path === '/api/v1/admin/poll' && request.method === 'POST') {
    if (!isAdmin(request, env)) return fail('unauthorized', 401);
    const { pollCycle } = await import('./loop.js');
    return json({ ok: true, ...(await pollCycle(env)) });
  }

  if (path === '/api/v1/admin/flush' && request.method === 'POST') {
    if (!isAdmin(request, env)) return fail('unauthorized', 401);
    const { flushFreeTier } = await import('./loop.js');
    return json({ ok: true, ...(await flushFreeTier(env)) });
  }

  if (path === '/api/v1/export') {
    if (!isAdmin(request, env)) return fail('unauthorized', 401);
    const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 400, 1), 2000);
    const events = await listEvents(env.DB, { limit: 200, since: new Date(Date.now() - days * 86400000).toISOString() });
    // Page through the archive by cursor so the site build sees everything.
    const all = [...events];
    let cursor = events.length ? events[events.length - 1].announced_at : null;
    while (cursor && all.length < 20000) {
      const page = await listEvents(env.DB, { limit: 200, cursor, since: new Date(Date.now() - days * 86400000).toISOString() });
      if (!page.length) break;
      all.push(...page);
      cursor = page[page.length - 1].announced_at;
      if (page.length < 200) break;
    }
    return json({ generated_at: new Date().toISOString(), days, count: all.length, events: all });
  }

  return fail(`no route for ${request.method} ${url.pathname}`, 404);
}
