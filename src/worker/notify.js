/**
 * Telegram delivery.
 *
 * Why Telegram: the audience already lives there, the Bot API is free and
 * unmetered, and it survives the payment problem — buyers who pay in USDT are
 * the same people who keep a Telegram window open all day.
 *
 * The paywall mechanic is latency, not concealment: the free channel gets the
 * same headline later. That keeps the product honest and still sells.
 */

import { KIND, tierLabel } from './format.js';

const API = 'https://api.telegram.org/bot';

/** Escape for parse_mode=HTML. */
export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const KIND_ICON = {
  [KIND.LISTING]: '🟢',
  [KIND.DELISTING]: '🔴',
  [KIND.PERP]: '🟣',
  [KIND.QUOTE]: '🔵',
  [KIND.OTHER]: '⚪️',
};

/**
 * @param {object} event
 * @param {{freeTier?: boolean}} [opts]
 */
export function formatAlert(event, opts = {}) {
  const tier = event.meta?.tier || 'C';
  const icon = KIND_ICON[event.kind] || '⚪️';
  const symbol = event.symbol ? escapeHtml(event.symbol) : '—';
  const latency = Number.isFinite(event.latency_sec)
    ? `${event.latency_sec}s after announcement`
    : 'detection latency unknown';
  const reasons = (event.reasons || []).slice(0, 3).map(escapeHtml).join(' · ');

  const lines = [
    `${icon} <b>${escapeHtml(tierLabel(tier))}</b> · ${escapeHtml(event.source)} · ${escapeHtml(event.kind)}`,
    `<b>${symbol}</b> · score ${event.score ?? 0}`,
    escapeHtml(event.title),
    `<i>${escapeHtml(latency)}</i>${reasons ? `\n${reasons}` : ''}`,
  ];

  if (opts.freeTier) {
    lines.push('', '<i>Delayed feed. Instant alerts + full history: /pricing</i>');
  }
  if (event.url) lines.push(`<a href="${escapeHtml(event.url)}">source</a>`);
  return lines.join('\n');
}

/**
 * @param {string} token
 * @param {string|number} chatId
 * @param {string} text
 * @param {{disablePreview?: boolean}} [opts]
 */
export async function sendMessage(token, chatId, text, opts = {}) {
  const res = await fetch(`${API}${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: opts.disablePreview ?? true,
    }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload.ok === false) {
    throw new Error(`telegram sendMessage failed: ${res.status} ${JSON.stringify(payload).slice(0, 200)}`);
  }
  return payload.result;
}

/**
 * Push a batch to a channel, oldest first so the reading order is right.
 * Returns the ids that were actually delivered.
 *
 * @param {object} env
 * @param {object[]} events
 * @param {{freeTier?: boolean}} [opts]
 */
export async function broadcast(env, events, opts = {}) {
  const chatId = opts.freeTier ? env.FREE_CHANNEL : env.PAID_CHANNEL;
  if (!env.TELEGRAM_BOT_TOKEN || !chatId) return [];
  const delivered = [];
  for (const event of events) {
    try {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, formatAlert(event, opts));
      delivered.push(event.id);
      // Stay well under Telegram's ~20 messages/minute per-chat guidance.
      await new Promise((r) => setTimeout(r, 1200));
    } catch (error) {
      console.error(`alert failed for ${event.id}: ${error.message}`);
    }
  }
  return delivered;
}
