// @ts-check
'use strict';

const TOKEN_METERS = {
  'prompt-text-tokens': 'inputTokens',
  'cached-prompt-text-tokens': 'cacheReadTokens',
  'cache-write-text-tokens': 'cacheWriteTokens',
  'completion-text-tokens': 'outputTokens'
};

/** @param {unknown} value */
function tokenCount(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error('Invalid Cursor billing token count');
  }
  return Number(value);
}

/**
 * @param {{product?:string, chargeCategory?:string, billingItemId?:string,
 *   eventTime?:string, displayExtras?:{model?:string}, usage?:Record<string,unknown>, totalTokens?:string,
 *   pricing?:{currency?:string,contracted?:string}}} item
 */
function cursorBillingItemToEvent(item) {
  if (item.product !== 'cursor' || item.chargeCategory !== 'usage') return null;
  const model = item.displayExtras?.model?.trim() || 'unknown';
  const timestamp = Date.parse(item.eventTime || '');
  if (!Number.isFinite(timestamp) || typeof item.billingItemId !== 'string' || !item.billingItemId.trim()) {
    throw new Error('Invalid Cursor billing item identity');
  }

  /** @type {Record<string, number>} */
  const tokenUsage = {};
  for (const [meter, field] of Object.entries(TOKEN_METERS)) {
    const value = item.usage?.[meter];
    if (value !== undefined) tokenUsage[field] = tokenCount(value);
  }
  if (item.totalTokens !== undefined) {
    const sum = Object.values(tokenUsage).reduce((total, count) => total + count, 0);
    if (tokenCount(item.totalTokens) !== sum) throw new Error('Cursor billing token breakdown does not match its total');
  }

  const pricing = item.pricing;
  const cents = pricing?.currency === 'USD' && typeof pricing.contracted === 'string' && /^\d+(?:\.\d+)?$/.test(pricing.contracted)
    ? Number(pricing.contracted) * 100 : NaN;
  return {
    usageEventId: item.billingItemId, timestamp, model, tokenUsage,
    ...(Number.isFinite(cents) ? { chargedCents: cents } : {})
  };
}

module.exports = { cursorBillingItemToEvent };
