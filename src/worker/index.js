/**
 * Worker entrypoint.
 *
 *   fetch()      -> JSON API (see api.js) + admin triggers
 *   scheduled()  -> the business loop (see loop.js):
 *                     every 5 min  : poll exchanges, score, alert paid tier, settle USDT invoices
 *                     every 10 min : release the delayed free-tier feed
 *
 * Why the loop lives here and not in GitHub Actions: Actions may not be used as
 * the runtime of a commercial service (see docs/LEGAL.md). Actions builds,
 * tests and deploys this file; execution happens on Workers cron triggers,
 * which is both compliant and immune to the "scheduled workflows disabled after
 * 60 days of inactivity" behaviour.
 */

import { handleApi, json } from './api.js';
import { pollCycle, flushFreeTier } from './loop.js';

const LANDING = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Listing Alpha API</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:46rem;margin:3rem auto;padding:0 1rem;color:#111}
code{background:#f3f4f6;padding:.15rem .35rem;border-radius:4px}pre{background:#0b1020;color:#d7e0ff;padding:1rem;overflow:auto;border-radius:8px}</style>
</head><body>
<h1>Listing Alpha</h1>
<p>Exchange listing intelligence: which new listings matter, how fast we saw them, and what happens next.</p>
<pre>GET /api/v1/events?limit=20
GET /api/v1/stats?days=7
GET /api/v1/pricing</pre>
<p><a href="/api/v1/health">health</a> · <a href="/api/v1">api index</a></p>
</body></html>`;

export default {
  /**
   * @param {Request} request
   * @param {object} env
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env);
      } catch (error) {
        console.error('api error', error);
        return json({ error: 'internal error', detail: String(error?.message || error) }, 500);
      }
    }
    if (url.pathname === '/') {
      return new Response(LANDING, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    return new Response('Not found', { status: 404 });
  },

  /**
   * @param {ScheduledController} controller
   * @param {object} env
   * @param {ExecutionContext} ctx
   */
  async scheduled(controller, env, ctx) {
    const started = Date.now();
    const cron = controller?.cron || '*/5 * * * *';
    try {
      const result = cron.startsWith('*/10') ? await flushFreeTier(env) : await pollCycle(env);
      console.log(JSON.stringify({ cron, ms: Date.now() - started, ...result }));
    } catch (error) {
      // Never rethrow: the failure is already logged, and a throwing scheduled
      // handler makes every cron run look broken rather than degraded.
      console.error(JSON.stringify({ cron, error: String(error?.message || error) }));
    }
  },
};
