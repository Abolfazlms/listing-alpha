/**
 * Telegram command surface — the checkout and support desk.
 *
 * Deliberately command-only (no inline keyboards): it is testable without a
 * browser, it survives clients that render keyboards badly, and the whole
 * funnel is four commands. A menu can be added later; a broken payment flow
 * cannot be recovered from.
 *
 *   /start     what this is + how to buy
 *   /pricing   plans
 *   /buy N     create an invoice   (N = month | quarter | lifetime)
 *   /status    state of your latest invoice / licence
 *   /help
 */

import { PLANS, createInvoice, paymentInstructions } from './payments.js';
import { getEntitlement, latestInvoiceForChat } from '../pipeline/store.js';
import { escapeHtml, sendMessage as defaultSend } from './notify.js';

const DEFAULT_PLAN = 'month';

/**
 * Parse a message into { command, args }. Tolerates "/buy@MyBot month".
 * @param {string} text
 * @returns {{command: string, args: string[]}}
 */
export function parseCommand(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('/')) return { command: '', args: [] };
  const parts = trimmed.split(/\s+/);
  const command = parts[0].slice(1).split('@')[0].toLowerCase();
  return { command, args: parts.slice(1) };
}

/** @param {string} [selected] */
export function formatPricing(selected) {
  const rows = Object.values(PLANS).map((plan) => {
    const duration = plan.days ? `${plan.days} days` : 'lifetime';
    const marker = plan.id === selected ? ' ←' : '';
    return `/buy ${plan.id} — <b>${plan.priceUsdt} USDT</b> · ${duration}${marker}`;
  });
  return [
    '<b>Listing Alpha — paid tier</b>',
    'Instant alerts, full archive, API key. Paid once in USDT (TRC20); no card, no account.',
    '',
    ...rows,
    '',
    'Prices are fixed in USDT. The invoice amount is unique to you and is the payment reference.',
  ].join('\n');
}

/**
 * @param {object} env
 * @param {{command: string, args: string[]}} parsed
 * @param {number|string} chatId
 * @param {{send?: typeof defaultSend}} [deps]
 * @returns {Promise<string>} the reply text (also sent)
 */
export async function respond(env, parsed, chatId, deps = {}) {
  const send = deps.send || defaultSend;
  const token = env.TELEGRAM_BOT_TOKEN;
  const reply = (text) => (token ? send(token, chatId, text).then(() => text) : Promise.resolve(text));

  switch (parsed.command) {
    case 'start':
      return reply(
        [
          '<b>Listing Alpha</b>',
          'We watch exchange announcement feeds and publish: what was listed, how fast we saw it, and what price did afterwards.',
          '',
          '/pricing — plans',
          '/buy month — create an invoice',
          '/status — your licence or pending payment',
          '',
          `Free channel: ${env.FREE_CHANNEL || 'not configured'}`,
        ].join('\n')
      );

    case 'pricing':
    case 'plans':
      return reply(formatPricing(parsed.args[0]));

    case 'buy':
    case 'subscribe': {
      const planId = (parsed.args[0] || DEFAULT_PLAN).toLowerCase();
      if (!PLANS[planId]) {
        return reply(`Unknown plan "<code>${escapeHtml(planId)}</code>".\n\nOptions: ${Object.keys(PLANS).join(', ')}`);
      }
      if (!env.MERCHANT_TRON_ADDRESS) {
        return reply('Payments are not configured yet. Ask in the free channel.');
      }
      const invoice = await createInvoice(env.DB, env, { plan: planId, telegramChat: String(chatId) });
      const info = paymentInstructions(invoice, env);
      return reply(
        [
          `<b>Invoice ${escapeHtml(info.invoice_id)}</b>`,
          `Plan: ${escapeHtml(invoice.plan)} · ${PLANS[planId].priceUsdt} USDT (TRC20)`,
          '',
          `Send exactly <code>${escapeHtml(info.amount)}</code> USDT to:`,
          `<code>${escapeHtml(info.address)}</code>`,
          '',
          'The micro-amount (e.g. 0.004217) is your payment reference — do not round it.',
          `Expires: ${escapeHtml(String(info.expires_at).replace('T', ' ').slice(0, 16))} UTC`,
          '',
          'Access is granted automatically once the transfer confirms (usually under a minute).',
          '/status — check',
        ].join('\n')
      );
    }

    case 'status':
    case 'license':
    case 'licence': {
      const invoice = await latestInvoiceForChat(env.DB, String(chatId));
      if (!invoice) {
        return reply('No invoice found for this chat.\n\n/buy month — create one');
      }
      if (invoice.status === 'paid') {
        const entitlement = await getEntitlement(env.DB, invoice.license_key);
        return reply(
          [
            '✅ <b>Paid</b>',
            `Plan: ${escapeHtml(invoice.plan)}`,
            `Licence: <code>${escapeHtml(invoice.license_key)}</code>`,
            entitlement?.expires_at ? `Valid until: ${escapeHtml(entitlement.expires_at.slice(0, 10))}` : 'Valid: lifetime',
            env.INVITE_LINK ? `Private channel: ${escapeHtml(env.INVITE_LINK)}` : '',
          ]
            .filter(Boolean)
            .join('\n')
        );
      }
      const minutesLeft = Math.round((Date.parse(invoice.expires_at) - Date.now()) / 60000);
      return reply(
        [
          `⏳ <b>${escapeHtml(invoice.status)}</b>`,
          `Invoice: <code>${escapeHtml(invoice.id)}</code>`,
          `Amount: <code>${escapeHtml(invoice.amount)}</code> USDT (TRC20)`,
          `To: <code>${escapeHtml(invoice.address)}</code>`,
          minutesLeft > 0 ? `Expires in ${minutesLeft} min` : 'Expired — /buy a new one',
        ].join('\n')
      );
    }

    case 'help':
    default:
      return reply(['Commands:', '/pricing', '/buy month', '/status', '/help'].join('\n'));
  }
}

/**
 * Handle one Telegram update. Always resolves: Telegram retries aggressively on
 * non-2xx responses, and a retry storm on a bad update is worse than a dropped one.
 *
 * @param {object} update
 * @param {object} env
 * @param {{send?: typeof defaultSend}} [deps]
 */
export async function handleUpdate(update, env, deps = {}) {
  const message = update?.message || update?.edited_message;
  if (!message?.text || !message.chat?.id) return { handled: false };
  const parsed = parseCommand(message.text);
  if (!parsed.command) return { handled: false };

  try {
    await respond(env, parsed, message.chat.id, deps);
    return { handled: true, command: parsed.command };
  } catch (error) {
    console.error(`bot failed for /${parsed.command}: ${error.message}`);
    return { handled: false, error: error.message };
  }
}

/**
 * Register the webhook with Telegram. Run once after each deploy.
 * @param {object} env
 */
export async function registerWebhook(env) {
  const base = (env.PUBLIC_SITE || '').replace(/\/$/, '');
  if (!base) throw new Error('PUBLIC_SITE is not set');
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not set');

  const body = {
    url: `${base}/api/v1/telegram/webhook`,
    allowed_updates: ['message', 'edited_message'],
    drop_pending_updates: true,
  };
  if (env.TELEGRAM_WEBHOOK_SECRET) body.secret_token = env.TELEGRAM_WEBHOOK_SECRET;

  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload.ok === false) throw new Error(`setWebhook failed: ${JSON.stringify(payload).slice(0, 200)}`);
  return payload.result;
}
