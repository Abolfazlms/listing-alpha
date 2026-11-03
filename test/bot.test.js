import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCommand, formatPricing, respond } from '../src/worker/bot.js';

const env = { TELEGRAM_BOT_TOKEN: 'test-token', FREE_CHANNEL: '@free' };

function capture() {
  const sent = [];
  return {
    sent,
    send: async (token, chatId, text) => {
      sent.push({ token, chatId, text });
      return { message_id: sent.length };
    },
  };
}

test('parses commands, arguments and @botname suffixes', () => {
  assert.deepEqual(parseCommand('/buy month'), { command: 'buy', args: ['month'] });
  assert.deepEqual(parseCommand('/buy@ListingAlphaBot quarter'), { command: 'buy', args: ['quarter'] });
  assert.deepEqual(parseCommand('  /STATUS  '), { command: 'status', args: [] });
  assert.deepEqual(parseCommand('hello there'), { command: '', args: [] });
  assert.deepEqual(parseCommand(''), { command: '', args: [] });
});

test('pricing lists every plan with a copy-pasteable command', () => {
  const text = formatPricing('quarter');
  assert.ok(text.includes('/buy month'));
  assert.ok(text.includes('/buy quarter'));
  assert.ok(text.includes('/buy lifetime'));
  assert.ok(text.includes('29 USDT'));
  assert.ok(text.includes('249 USDT'));
  assert.ok(text.includes('←'), 'selected plan is marked');
});

test('/start explains the product and the commands', async () => {
  const { sent, send } = capture();
  await respond(env, parseCommand('/start'), 42, { send });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 42);
  assert.ok(sent[0].text.includes('Listing Alpha'));
  assert.ok(sent[0].text.includes('/buy month'));
});

test('/buy with an unknown plan refuses before touching the database', async () => {
  const { sent, send } = capture();
  await respond(env, parseCommand('/buy yacht'), 42, { send });
  assert.ok(sent[0].text.includes('Unknown plan'));
  assert.ok(sent[0].text.includes('month, quarter, lifetime'));
});

test('/buy without a configured wallet explains itself instead of throwing', async () => {
  const { sent, send } = capture();
  await respond({ ...env, MERCHANT_TRON_ADDRESS: '' }, parseCommand('/buy'), 42, { send });
  assert.ok(sent[0].text.includes('not configured'));
});

test('unknown commands answer with help rather than silence', async () => {
  const { sent, send } = capture();
  await respond(env, parseCommand('/nonsense'), 42, { send });
  assert.ok(sent[0].text.includes('/pricing'));
});

test('user-supplied text is escaped before it reaches HTML parse mode', async () => {
  const { sent, send } = capture();
  await respond(env, parseCommand('/buy <script>alert(1)</script>'), 7, { send });
  assert.ok(!sent[0].text.includes('<script>'));
  assert.ok(sent[0].text.includes('&lt;script&gt;'));
});
