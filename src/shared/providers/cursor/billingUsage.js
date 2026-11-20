// @ts-check
'use strict';

const { cursorBillingItemToEvent } = require('./billingItems');
const { readUsageJson } = require('./webUsageResponse');

const MAX_WINDOW_MS = 31 * 86_400_000;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ROWS = 250_000;

/**
 * @param {typeof fetch} fetchWeb
 * @param {{start:number, end:number, signal:AbortSignal}} range
 */
async function fetchCursorBillingEvents(fetchWeb, { start, end, signal }) {
  /** @type {NonNullable<ReturnType<typeof cursorBillingItemToEvent>>[]} */
  const events = [];
  const ids = new Set();
  let bytes = 0;
  let rows = 0;
  for (let until = end; until > start;) {
    const from = Math.max(start, until - MAX_WINDOW_MS);
    const url = new URL('https://cursor.com/api/dashboard/v2/query-billing-items');
    url.search = new URLSearchParams({
      scope: 'user', product: 'cursor', startTime: new Date(from).toISOString(),
      endTime: new Date(until).toISOString(), pageSize: '100'
    }).toString();
    const cursors = new Set();
    for (;;) {
      const response = await fetchWeb(url.href, { signal });
      if (!response.ok) throw new Error(`Cursor billing usage HTTP ${response.status} for ${url.searchParams.get('startTime')} to ${url.searchParams.get('endTime')}`);
      const page = await readUsageJson(response, MAX_BYTES - bytes);
      bytes += page.bytes;
      const { data, pagination } = page.json || {};
      if (!Array.isArray(data) || typeof pagination?.hasMore !== 'boolean') {
        throw new Error('Invalid Cursor billing usage page');
      }
      rows += data.length;
      if (rows > MAX_ROWS) throw new Error('Cursor billing usage exceeds the supported event count');
      for (const item of data) {
        if (typeof item?.product !== 'string' || typeof item.chargeCategory !== 'string') {
          throw new Error('Invalid Cursor billing usage item');
        }
        const event = cursorBillingItemToEvent(item);
        if (!event) continue;
        if (event.timestamp < from || event.timestamp >= until) throw new Error('Cursor billing event outside its requested range');
        if (ids.has(event.usageEventId)) throw new Error('Duplicate Cursor billing item');
        ids.add(event.usageEventId);
        events.push(event);
      }
      const next = pagination.nextCursor;
      if (!pagination.hasMore) {
        if (next) throw new Error('Unexpected Cursor billing continuation');
        break;
      }
      if (!data.length || typeof next !== 'string' || !next.trim() || cursors.has(next)) {
        throw new Error('Invalid Cursor billing continuation');
      }
      cursors.add(next);
      url.searchParams.set('cursor', next);
    }
    until = from;
  }
  return events.sort((a, b) => b.timestamp - a.timestamp);
}

module.exports = { fetchCursorBillingEvents };
