'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('overlapping Cursor syncs share one read and later failures retain it across restarts', { skip: process.platform !== 'win32' }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-quota-fixture-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const backend = path.join(directory, 'backend.cjs');
  const script = path.join(directory, 'read-cursor-usage.ps1');
  fs.copyFileSync(require.resolve('../../plugins/personal-quota/backend.cjs'), backend);
  const { activate } = require(backend);
  const first = activate({ dataDirectory: directory });
  assert.equal(first.call('getCursorUsage'), null);
  const sample = { usedPercent: 0, resetText: 'Nov 26', plan: 'Premium' };
  fs.writeFileSync(script, [
    "Add-Content -LiteralPath (Join-Path $PSScriptRoot 'polls.txt') -Value poll -Encoding Ascii",
    `'${JSON.stringify({ ok: true, ...sample })}'`
  ].join('\n'));
  const [result, concurrent] = await Promise.all([first.call('syncCursorUsage'), first.call('syncCursorUsage')]);
  assert.equal(fs.readFileSync(path.join(directory, 'polls.txt'), 'ascii').trim(), 'poll');
  assert.deepEqual(concurrent, result);
  assert.ok(Number.isFinite(Date.parse(result?.observedAt)));
  assert.deepEqual(result, { ...sample, observedAt: result.observedAt, live: true });
  first.dispose();

  const restarted = activate({ dataDirectory: directory });
  t.after(() => restarted.dispose());
  const cached = { ...result, live: false };
  assert.deepEqual(restarted.call('getCursorUsage'), cached);
  fs.writeFileSync(script, "'{\"ok\":false}'");
  assert.deepEqual(await restarted.call('syncCursorUsage'), cached);
});
