'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { fetchCursorBillingEvents } = require('../../src/shared/providers/cursor/billingUsage');

const day = 86_400_000;
const end = Date.UTC(2026, 10, 20);
const range = { start: end - 32 * day, end, signal: new AbortController().signal };
const item = (id, time) => ({
  billingItemId: id, product: 'cursor', chargeCategory: 'usage', eventTime: new Date(time).toISOString(),
  displayExtras: { model: 'composer' }, usage: { 'prompt-text-tokens': '9' }, totalTokens: '9'
});
const page = (data, hasMore = false, nextCursor) => Response.json({ data, pagination: { hasMore, nextCursor } });

test('personal billing queries complete every page and adjacent 31-day windows newest first', async () => {
  const boundary = end - 31 * day;
  const opaque = 'a+/=?%';
  const responses = [
    page([item('boundary', boundary)], true, opaque),
    page([item('latest', end - 1)]),
    page([item('oldest', range.start)])
  ];
  const calls = [];
  const events = await fetchCursorBillingEvents(async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, 'https://cursor.com/api/dashboard/v2/query-billing-items');
    assert.equal(options.method || 'GET', 'GET');
    assert.equal(options.signal, range.signal);
    const query = parsed.searchParams;
    assert.equal(query.get('scope'), 'user');
    assert.equal(query.get('product'), 'cursor');
    assert.equal(query.get('pageSize'), '100');
    calls.push([Date.parse(query.get('startTime')), Date.parse(query.get('endTime')), query.get('cursor')]);
    return responses.shift();
  }, range);
  assert.deepEqual(calls, [[boundary, end, null], [boundary, end, opaque], [range.start, boundary, null]]);
  assert.deepEqual(events.map(x => [x.usageEventId, x.tokenUsage.inputTokens]), [['latest', 9], ['boundary', 9], ['oldest', 9]]);
});

test('an empty recent billing window still requests older history', async () => {
  const replies = [page([]), page([item('older', range.start)])];
  const rows = await fetchCursorBillingEvents(async () => replies.shift(), range);
  assert.deepEqual(rows.map(e => e.usageEventId), ['older']);
});

test('invalid personal billing responses and incomplete pagination fail the import', async () => {
  const current = item('one', end - 1);
  for (const [replies, error] of [
    [[new Response(null, { status: 403 })], /403/],
    [[Response.json({})], /page/],
    [[page([{}])], /item/],
    [[page([current], true)], /continuation/],
    [[page([], true, 'more')], /continuation/],
    [[page([current], false, 'more')], /continuation/],
    [[page([current], true, 'more'), page([item('next', end - 2)], true, 'more')], /continuation/],
    [[page([current], true, 'more'), page([current])], /Duplicate/],
    [[page([item('outside', end)])], /range/]
  ]) {
    await assert.rejects(fetchCursorBillingEvents(async () => replies.shift(), range), error);
  }
});
