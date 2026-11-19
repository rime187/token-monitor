'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const overview = import('../../plugins/personal-quota/ui.mjs');
const now = Date.parse('2026-11-19T12:00:00Z');
const upcoming = '2026-11-20T12:00:00Z';

function account(provider, windows, extra = {}) {
  return { provider, status: 'ok', windows, ...extra };
}

test('keeps four slots and distinguishes absent, inaccessible and exhausted quotas', async () => {
  const { quotaOverview } = await overview;
  assert.deepEqual(quotaOverview([], now).map(({ id, value }) => [id, value]), [
    ['codex', '未连接'], ['antigravity', '未连接'], ['grok', '未连接'], ['deepseek', '未连接']
  ]);
  const stale = [{ kind: 'session', remainingPercent: 88 }];
  const rows = quotaOverview([
    account('codex', stale, { status: 'unauthorized' }),
    account('antigravity', stale, { status: 'sourceRateLimited' }),
    account('cursor', [{ label: 'Included usage', kind: 'weekly', remainingPercent: 0 }]),
    account('deepseek', [], { status: 'unavailable' })
  ], now);
  assert.deepEqual(rows.map(row => row.value), ['需要登录', '查询受限', '0%', '暂不可用']);
});

test('shows both Codex windows from one account and the limiting Antigravity model group', async () => {
  const { quotaOverview } = await overview;
  const [codex, antigravity] = quotaOverview([
    account('codex', [
      { kind: 'session', additional: true, remainingPercent: 3 },
      { kind: 'session', windowMinutes: 300, remainingPercent: 60, resetsAt: upcoming },
      { kind: 'weekly', remainingPercent: 22 }
    ], { sourceDetail: 'cli' }),
    account('codex', [{ kind: 'weekly', remainingPercent: 99 }], { sourceDetail: 'managed' }),
    account('antigravity', [
      { kind: 'weekly', label: 'Unknown group', remainingPercent: null },
      { kind: 'weekly', label: 'Gemini', remainingPercent: 84, resetsAt: upcoming },
      { kind: 'session', label: 'Claude / GPT', usedPercent: 85, resetsAt: '2026-11-18T12:00:00Z' }
    ])
  ], now);
  assert.match(codex.value, /5h 60%.*周 22%/);
  assert.match(codex.detail, /周 重置时间未知/);
  assert.equal(antigravity.value, '15%');
  assert.match(antigravity.detail, /Claude \/ GPT.*待刷新/);
});

test('only the confirmed Cursor included pool represents The X Subscription', async () => {
  const { quotaOverview } = await overview;
  const legacy = account('cursor', [
    { label: 'Grok Bot', kind: 'weekly', usedPercent: 70 },
    { label: 'Cursor Models', kind: 'billing', usedPercent: 10 }
  ], { planLabel: 'Super' });
  const grokCli = account('grok', [{ kind: 'weekly', usedPercent: 1 }]);
  assert.equal(quotaOverview([grokCli, legacy], now)[2].value, '未知');
  const unified = account('cursor', [{ label: 'Included usage', kind: 'weekly', usedPercent: 15, resetsAt: upcoming }]);
  assert.equal(quotaOverview([legacy, unified, grokCli], now)[2].value, '85%');
  assert.equal(quotaOverview([account('cursor', [{ label: 'Included usage', kind: 'weekly' }])], now)[2].value, '未知');
});

test('uses a Cursor panel reading only for Grok and keeps the displayed reset date precise to the day', async () => {
  const { quotaOverview } = await overview;
  const accounts = [
    account('codex', [{ kind: 'weekly', remainingPercent: 83 }]),
    account('antigravity', [{ kind: 'session', label: 'Gemini', usedPercent: 41 }]),
    account('cursor', [], { status: 'notConfigured' }),
    account('deepseek', [{ metric: 'credits', remaining: 2, currency: 'USD' }])
  ];
  const baseline = quotaOverview(accounts, now);
  assert.equal(baseline[2].value, '未连接');

  for (const [usedPercent, value] of [[0, '100%'], [100, '0%']]) {
    const sample = { usedPercent, resetText: '11月26日', observedAt: new Date(now).toISOString(), plan: 'Premium', live: true };
    const rows = quotaOverview(accounts, now, sample);
    assert.equal(rows[2].value, value);
    assert.match(rows[2].detail, /11月26日/);
    assert.doesNotMatch(rows[2].detail, /11月26日[^·／]*\d{1,2}:\d{2}|上次读取/);
    assert.deepEqual(rows.filter(row => row.id !== 'grok'), baseline.filter(row => row.id !== 'grok'));
  }
});

test('identifies a cached Cursor reading and prefers a confirmed native pool when it becomes available', async () => {
  const { quotaOverview } = await overview;
  const sample = { usedPercent: 38, resetText: '11月26日', observedAt: '2026-11-18T12:00:00Z', plan: 'Premium', live: false };
  const cached = quotaOverview([], now, sample)[2];
  assert.equal(cached.value, '62%');
  assert.match(cached.detail, /上次读取/);

  const native = account('cursor', [{ kind: 'weekly', label: 'Included usage', usedPercent: 8, resetsAt: upcoming }]);
  assert.deepEqual(quotaOverview([native], now, { ...sample, live: true })[2], quotaOverview([native], now)[2]);
  assert.equal(quotaOverview([native], now, sample)[2].value, '92%');
});

test('retains DeepSeek currency and zero, and leaves an undocumented amount unknown', async () => {
  const { quotaOverview } = await overview;
  const wallet = (remaining, currency) => account('deepseek', [{ metric: 'credits', remaining, currency }]);
  assert.equal(quotaOverview([wallet(0, 'CNY')], now)[3].value, '¥0.00');
  assert.equal(quotaOverview([wallet(32.5, 'USD')], now)[3].value, '$32.50');
  assert.equal(quotaOverview([wallet(32.5, null)], now)[3].value, '未知');
});
