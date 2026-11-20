'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { clientStatusTag, cursorTrackingBlockReason } = require('../../src/electron/renderer/clientStatusPresentation');

test('active and waiting share labels across clients', () => {
  assert.deepEqual(clientStatusTag('claude', 'active'), { key: 'settings.tools.status.active', tone: 'ok' });
  assert.deepEqual(clientStatusTag('cursor', 'active'), { key: 'settings.tools.status.active', tone: 'ok' });
  assert.deepEqual(clientStatusTag('opencode', 'waiting'), { key: 'settings.tools.status.waiting', tone: 'neutral' });
});

test('missing label is client-aware', () => {
  assert.deepEqual(clientStatusTag('claude', 'missing'), { key: 'settings.tools.status.missing', tone: 'muted' });
  assert.deepEqual(clientStatusTag('codex', 'missing'), { key: 'settings.tools.status.missing', tone: 'muted' });
  assert.deepEqual(clientStatusTag('cursor', 'missing'), { key: 'settings.tools.status.signIn', tone: 'setup' });
  assert.deepEqual(clientStatusTag('antigravity', 'missing'), { key: 'settings.tools.status.openApp', tone: 'setup' });
});

test('missing mapping is case-insensitive on client id', () => {
  assert.deepEqual(clientStatusTag('Cursor', 'missing'), { key: 'settings.tools.status.signIn', tone: 'setup' });
});

test('recognized desktop and linked cloud accounts wait for Cursor data when its cache is absent', () => {
  const desktop = { desktopAccount: { email: '' }, accounts: [] };
  const linked = { desktopAccount: null, accounts: [{ expired: false, error: '' }] };
  assert.deepEqual(clientStatusTag('cursor', 'missing', desktop), { key: 'settings.tools.status.waiting', tone: 'neutral' });
  assert.deepEqual(clientStatusTag('cursor', 'missing', linked), { key: 'settings.tools.status.waiting', tone: 'neutral' });
  assert.deepEqual(clientStatusTag('cursor', 'missing', { accounts: [{ expired: true }] }), { key: 'settings.tools.status.signIn', tone: 'setup' });
  assert.deepEqual(clientStatusTag('cursor', 'active', desktop), { key: 'settings.tools.status.active', tone: 'ok' });
  assert.deepEqual(clientStatusTag('antigravity', 'missing', desktop), { key: 'settings.tools.status.openApp', tone: 'setup' });
});

test('a desktop identity cannot enable cloud tracking, but tracking can always be turned off', () => {
  const status = { accounts: [], desktopAccount: { email: 'desktop@example.test' } };
  assert.equal(cursorTrackingBlockReason(status, false), 'settings.cursor.cloudRequired');
  assert.equal(cursorTrackingBlockReason(status, true), '');
  assert.equal(cursorTrackingBlockReason({ accounts: [] }, false), 'settings.cursor.loginRequired');
  assert.equal(cursorTrackingBlockReason({ ...status, accounts: [{ expired: true }] }, false), 'settings.cursor.cloudRequired');
  assert.equal(cursorTrackingBlockReason({ ...status, accounts: [{ enabled: false, expired: false, error: '' }] }, false), '');
});

test('unknown or absent status yields no tag', () => {
  assert.equal(clientStatusTag('claude', undefined), null);
  assert.equal(clientStatusTag('claude', 'disabled'), null);
  assert.equal(clientStatusTag('claude', ''), null);
});
