'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { cursorBillingItemToEvent } = require('../../src/shared/providers/cursor/billingItems');

const item = {
  billingItemId: 'a069ec76-4a79-482f-8703-34cdad98f2bf',
  eventTime: '2026-11-18T09:25:12.500Z',
  product: 'cursor', chargeCategory: 'usage', usageType: 'included',
  principal: { type: 'user', id: 'user_private' },
  displayExtras: { model: 'composer-2.5', userEmail: 'private@example.test', displayLabel: 'Private' },
  usage: {
    'prompt-text-tokens': '30', 'cached-prompt-text-tokens': '15', 'cache-write-text-tokens': '4',
    'completion-text-tokens': '7', requests: '1'
  },
  hasTokenMeters: true, totalTokens: '56', pricing: { currency: 'USD', contracted: '0.0312500000' }
};

test('personal billing items retain real event identity, separate token meters and fractional US cents', () => {
  assert.deepEqual(cursorBillingItemToEvent(item), {
    usageEventId: item.billingItemId, timestamp: Date.parse(item.eventTime), model: 'composer-2.5',
    tokenUsage: { inputTokens: 30, cacheReadTokens: 15, cacheWriteTokens: 4, outputTokens: 7 },
    chargedCents: 3.125
  });
});

test('only Cursor usage items enter token history', () => {
  for (const overrides of [{ product: 'grok-bot' }, { product: 'grok-api' }, { chargeCategory: 'credit' }, { chargeCategory: 'adjustment' }]) {
    assert.equal(cursorBillingItemToEvent({ ...item, ...overrides }), null);
  }
});

test('an unlabelled model keeps its actual tokens and distinguishes zero cost from missing pricing', () => {
  const unlabelled = { ...item, displayExtras: {}, usage: { 'prompt-text-tokens': '25' }, totalTokens: '25' };
  const free = cursorBillingItemToEvent({ ...unlabelled, pricing: { currency: 'USD', contracted: '0.0000000000' } });
  assert.equal(free.model, 'unknown');
  assert.deepEqual(free.tokenUsage, { inputTokens: 25 });
  assert.equal(free.chargedCents, 0);
  for (const pricing of [undefined, { currency: 'EUR', contracted: '1' }, { currency: 'USD', contracted: '-0.1' }]) {
    assert.equal(Object.hasOwn(cursorBillingItemToEvent({ ...unlabelled, pricing }), 'chargedCents'), false);
  }
});

test('invalid quantities or an incomplete token breakdown fail the import', () => {
  assert.throws(() => cursorBillingItemToEvent({ ...item, usage: { 'prompt-text-tokens': '1.5' } }), /token count/);
  assert.throws(() => cursorBillingItemToEvent({ ...item, usage: { 'new-token-meter': '56' } }), /does not match/);
  assert.throws(() => cursorBillingItemToEvent({ ...item, billingItemId: '' }), /identity/);
  assert.throws(() => cursorBillingItemToEvent({ ...item, eventTime: 'invalid' }), /identity/);
});
