'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { runCursorLogin } = require('../../src/shared/providers/cursor/auth');
const { syncCursorWebUsage } = require('../../src/shared/providers/cursor/webUsage');
const { createCursorUsageEventIndex } = require('../../src/shared/providers/cursor/usageEvents');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-cursor-web-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const accountId = 'user_web';
  const cacheDir = path.join(home, 'cache');
  const hash = createHash('sha256').update(accountId).digest('hex');
  const file = path.join(cacheDir, 'web', `usage.account-${hash}.json`);
  const row = { timestamp: String(Date.now()), model: 'default', conversationId: 'session',
    usageEventId: 'usage-1', tokenUsage: { inputTokens: 100, outputTokens: 10, totalCents: 3 } };
  const options = { home, cacheDir, accountId };
  const pages = [];
  const dashboard = (respond, identity = () => accountId) => async (url, init) => {
    assert.equal(new URL(url).origin, 'https://cursor.com');
    if (new URL(url).pathname === '/api/auth/me') return Response.json({ sub: identity() });
    assert.equal(new URL(url).pathname, '/api/dashboard/get-filtered-usage-events');
    assert.deepEqual(init.headers, { 'Content-Type': 'application/json' });
    const body = JSON.parse(init.body);
    pages.push(body);
    return respond(body);
  };
  const page = rows => Response.json({ totalUsageEventsCount: rows.length, usageEventsDisplay: rows });
  return { home, cacheDir, file, row, options, dashboard, page, pages };
}

test('web dashboard pages and corrected events feed the Cursor cache/index without additional billing rows', async t => {
  const { file, row, cacheDir, options, dashboard, page, pages } = fixture(t);
  const older = { ...row, timestamp: String(Number(row.timestamp) - 7200000), usageEventId: undefined };
  const cold = dashboard(body => Response.json({
    totalUsageEventsCount: 3, usageEventsDisplay: body.page === 1 ? [row] : [older, older]
  }));
  assert.equal(await syncCursorWebUsage(cold, options), options.accountId);
  assert.deepEqual(pages.map(p => p.page), [1, 2]);
  assert.equal(pages[0].startDate, '0');
  assert.equal(pages[1].endDate, pages[0].endDate);
  const corrected = { ...row, tokenUsage: { inputTokens: 124, outputTokens: 0, totalCents: 5 } };
  const warm = dashboard(() => page([corrected]));
  await syncCursorWebUsage(warm, options);
  assert.equal(pages.at(-1).startDate, String(Number(row.timestamp) - 3600000));
  const after = fs.readFileSync(file, 'utf8');
  const rows = JSON.parse(after).usageEventsDisplay;
  assert.equal(rows.length, 3);
  assert.equal(rows.filter(r => r.usageEventId === row.usageEventId).length, 1);
  assert.equal(rows[0].tokenUsage.totalCents, 5);
  assert.deepEqual(createCursorUsageEventIndex({ cacheDir })().sessionsAt(Number(row.timestamp), 124), ['session']);
  await syncCursorWebUsage(warm, options);
  assert.equal(fs.readFileSync(file, 'utf8'), after);
});

test('native and browser logins for one user share exactly one cache and preserve earlier events', async t => {
  const { home, cacheDir, file, row, options, dashboard, page } = fixture(t);
  const sync = () => syncCursorWebUsage(dashboard(() => page([row])), options);
  await sync();
  await runCursorLogin('user_web::opaque-test', { home });
  const native = path.join(cacheDir, 'usage.json');
  const earlier = { ...row, usageEventId: 'earlier', timestamp: String(Number(row.timestamp) - 10000000) };
  fs.writeFileSync(native, JSON.stringify({ _tokscale: { version: 1, accountId: options.accountId }, usageEventsDisplay: [row, earlier] }));
  await sync();
  assert.equal(fs.existsSync(file), false);
  const content = JSON.parse(fs.readFileSync(native, 'utf8'));
  assert.deepEqual(content.usageEventsDisplay, [row, earlier]);
  assert.equal(content._tokscale.accountId, options.accountId);
  await sync();
  assert.equal(fs.existsSync(file), false);
  assert.equal(JSON.parse(fs.readFileSync(native, 'utf8')).totalUsageEventsCount, 2);
});

test('incomplete pages, failed authentication and account changes keep the previous snapshot', async t => {
  const { file, row, options, dashboard, page } = fixture(t);
  await syncCursorWebUsage(dashboard(() => page([row])), options);
  const before = fs.readFileSync(file);
  await assert.rejects(syncCursorWebUsage(dashboard(() => Response.json({ totalUsageEventsCount: 9, usageEventsDisplay: [] })), options), /incomplete/);
  await assert.rejects(syncCursorWebUsage(dashboard(() => new Response(null, { status: 401 })), options), /401/);
  let reads = 0;
  const switched = dashboard(() => page([row]), () => ++reads === 1 ? options.accountId : 'user_other');
  await assert.rejects(syncCursorWebUsage(switched, options), /account changed/);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('an authoritative overlap replaces anonymous counter corrections and voided usage', async t => {
  const { file, row, options, dashboard, page } = fixture(t);
  const anonymous = { ...row, usageEventId: undefined };
  const voided = { ...row, usageEventId: 'voided' };
  await syncCursorWebUsage(dashboard(() => page([anonymous, voided])), options);
  const corrected = { ...anonymous, tokenUsage: { inputTokens: 90, outputTokens: 5, totalCents: 2 } };
  await syncCursorWebUsage(dashboard(() => page([corrected])), options);
  const result = JSON.parse(fs.readFileSync(file, 'utf8')).usageEventsDisplay;
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].tokenUsage, corrected.tokenUsage);
});

test('an orphaned but owned native file is adopted once; archived usage and other accounts stay untouched', async t => {
  const { cacheDir, file, row, options, dashboard, page } = fixture(t);
  const archive = path.join(cacheDir, 'archive', 'preserved');
  fs.mkdirSync(archive, { recursive: true });
  const native = path.join(cacheDir, 'usage.json');
  const unrelated = path.join(cacheDir, 'usage.other.json');
  const older = { ...row, timestamp: String(Number(row.timestamp) - 7200000), usageEventId: 'earlier' };
  const oldCache = JSON.stringify({ _tokscale: { accountId: options.accountId, version: 1 }, usageEventsDisplay: [row, older] });
  fs.writeFileSync(native, oldCache);
  fs.writeFileSync(path.join(archive, 'usage.json'), oldCache);
  const otherCache = JSON.stringify({ _tokscale: { accountId: 'user_other', version: 1 }, usageEventsDisplay: [row] });
  fs.writeFileSync(unrelated, otherCache);
  await syncCursorWebUsage(dashboard(() => page([row])), options);
  assert.equal(fs.existsSync(native), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).usageEventsDisplay, [row, older]);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), otherCache);
  assert.equal(fs.readFileSync(path.join(archive, 'usage.json'), 'utf8'), oldCache);
  fs.writeFileSync(path.join(cacheDir, 'usage.csv'), 'Date,Model,Total Tokens\n');
  await assert.rejects(syncCursorWebUsage(dashboard(() => page([row])), options), /unverified legacy usage cache/);
  assert.equal(fs.readFileSync(path.join(cacheDir, 'usage.csv'), 'utf8'), 'Date,Model,Total Tokens\n');
});

function personalBillingFixture(t) {
  const { file, options } = fixture(t);
  const end = Date.parse('2026-11-19T12:00:00Z');
  const clock = t.mock.method(Date, 'now', () => end);
  const calls = [];
  const ranges = [];
  const sync = (ledger, identity = () => options.accountId) => syncCursorWebUsage(async (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://cursor.com');
    calls.push(url.pathname);
    if (url.pathname === '/api/auth/me') {
      const account = identity();
      return Response.json(typeof account === 'string' ? { sub: account } : account);
    }
    if (url.pathname === '/api/dashboard/get-filtered-usage-events') {
      assert.equal(JSON.parse(init.body).page, 1);
      return Response.json({});
    }
    assert.equal(url.pathname, '/api/dashboard/v2/query-billing-items');
    assert.equal(init.method || 'GET', 'GET');
    assert.equal(url.searchParams.get('scope'), 'user');
    assert.equal(url.searchParams.get('product'), 'cursor');
    const range = {
      from: Date.parse(url.searchParams.get('startTime')), until: Date.parse(url.searchParams.get('endTime')),
      cursor: url.searchParams.get('cursor')
    };
    ranges.push(range);
    return Response.json(ledger(range));
  }, { ...options, allTimeSince: '2026-09-01' });
  return { file, clock, calls, ranges, sync, end, accountId: options.accountId };
}

function billingItem(id, date, tokens) {
  return {
    billingItemId: id, eventTime: date, product: 'cursor', chargeCategory: 'usage',
    displayExtras: { model: 'composer-2.5' }, usage: { 'prompt-text-tokens': String(tokens) }, totalTokens: String(tokens)
  };
}

test('empty legacy response imports personal billing pages across contiguous windows, then updates its overlap', async t => {
  const { sync, file, calls, ranges, end, accountId } = personalBillingFixture(t);
  const older = billingItem('old', '2026-09-03T12:00:00Z', 100);
  const recent = billingItem('recent', '2026-11-19T09:00:00Z', 20);
  const second = billingItem('second-page', '2026-11-19T10:00:00Z', 3);
  const done = data => ({ data, pagination: { hasMore: false } });
  await sync(({ from, until, cursor }) => {
    if (until === end) return cursor === 'page-2' ? done([second]) : { data: [recent], pagination: { hasMore: true, nextCursor: 'page-2' } };
    return done(from <= Date.parse(older.eventTime) && Date.parse(older.eventTime) < until ? [older] : []);
  });
  assert.deepEqual(calls.slice(0, 2), ['/api/auth/me', '/api/dashboard/get-filtered-usage-events']);
  assert.equal(calls.at(-1), '/api/auth/me');
  assert.deepEqual(ranges[1], { ...ranges[0], cursor: 'page-2' });
  const windows = ranges.filter(range => !range.cursor);
  assert.ok(windows.length > 1);
  assert.equal(windows[0].until, end);
  assert.equal(windows.at(-1).from, Date.parse('2026-09-01T00:00:00'));
  windows.forEach(({ from, until }, index) => {
    assert.ok(until > from && until - from <= 31 * 86_400_000);
    if (index) assert.equal(until, windows[index - 1].from);
  });
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const cold = read();
  assert.equal(cold.totalUsageEventsCount, 3);
  assert.equal(cold._tokscale.accountId, accountId);
  assert.deepEqual(cold.usageEventsDisplay.map(row => row.usageEventId).sort(), ['old', 'recent', 'second-page']);
  calls.length = 0;
  ranges.length = 0;
  const corrected = billingItem('recent', recent.eventTime, 28);
  await sync(() => done([corrected]));
  assert.deepEqual(calls, ['/api/auth/me', '/api/dashboard/v2/query-billing-items', '/api/auth/me']);
  assert.ok(ranges[0].from > Date.parse(older.eventTime));
  assert.ok(ranges[0].from <= Date.parse(recent.eventTime));
  assert.deepEqual(read().usageEventsDisplay.map(row => [row.usageEventId, row.tokenUsage.inputTokens]), [['recent', 28], ['old', 100]]);
});

test('only a complete personal billing ledger establishes empty history for the verified account', async t => {
  const { file, sync, ranges } = personalBillingFixture(t);
  await assert.rejects(sync(() => assert.fail('billing read before account check'), () => 'user_other'), /account changed/);
  assert.equal(fs.existsSync(file), false);
  await sync(() => ({ data: [], pagination: { hasMore: false } }));
  assert.ok(ranges.length > 1);
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(snapshot.usageEventsDisplay, []);
  assert.equal(snapshot.totalUsageEventsCount, 0);
  assert.ok(snapshot._tokscale.billing.through > snapshot._tokscale.billing.since);
});

test('unfinished billing pages and a changed account preserve the last cache and its coverage', async t => {
  const { file, sync, clock, end, accountId } = personalBillingFixture(t);
  const row = billingItem('recent', '2026-11-19T11:00:00Z', 5);
  await sync(({ until }) => ({ data: until === end ? [row] : [], pagination: { hasMore: false } }));
  const before = fs.readFileSync(file);
  clock.mock.mockImplementation(() => end + 86_400_000);
  await assert.rejects(sync(() => ({ data: [row], pagination: { hasMore: true } })), /continuation/);
  assert.deepEqual(fs.readFileSync(file), before);
  let reads = 0;
  await assert.rejects(sync(() => ({ data: [], pagination: { hasMore: false } }), () => ++reads === 1 ? accountId : 'user_other'), /account changed/);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('personal billing starts at the verified account creation date and preserves earlier cached events', async t => {
  const { file, sync, ranges, accountId } = personalBillingFixture(t);
  const created = '2026-11-16T09:10:11.234Z';
  const earlier = { usageEventId: 'prior', timestamp: Date.parse('2026-10-01T12:00:00Z'), model: 'prior', tokenUsage: { inputTokens: 20 } };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ _tokscale: { version: 1, accountId }, usageEventsDisplay: [earlier] }));
  await sync(() => ({ data: [], pagination: { hasMore: false } }), () => ({ sub: accountId, created_at: created }));
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].from, Date.parse(created));
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(snapshot._tokscale.billing.since, Date.parse(created));
  assert.deepEqual(snapshot.usageEventsDisplay, [earlier]);
});
