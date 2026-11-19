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

test('retains DeepSeek currency and zero, and leaves an undocumented amount unknown', async () => {
  const { quotaOverview } = await overview;
  const wallet = (remaining, currency) => account('deepseek', [{ metric: 'credits', remaining, currency }]);
  assert.equal(quotaOverview([wallet(0, 'CNY')], now)[3].value, '¥0.00');
  assert.equal(quotaOverview([wallet(32.5, 'USD')], now)[3].value, '$32.50');
  assert.equal(quotaOverview([wallet(32.5, null)], now)[3].value, '未知');
});
