'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const { createCursorWebSession } = require('../../src/electron/providers/cursor/webSession');

function fixture() {
  const requests = [];
  const windows = [];
  const views = [];
  const session = Object.assign(new EventEmitter(), {
    setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
    async fetch(url, init) { requests.push({ url, init }); return new Response('{}'); },
    cookies: { async flushStore() { session.flushed = true; } },
    async clearData() { session.cleared = true; }
  });
  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {} });
      windows.push(this);
    }
    removeMenu() {}
    setTitle() {}
    async loadURL(url) { this.url = url; }
    isDestroyed() { return !!this.closed; }
    destroy() { this.closed = true; this.emit('closed'); }
    close() { this.destroy(); }
  }
  class View {
    constructor(options) {
      this.options = options;
      const page = { window: new EventTarget(), Event, AbortController, TextDecoder,
        fetch: async (url, init) => { requests.push({ url, init, page: true }); return new Response('{"events":[]}'); } };
      this.webContents = Object.assign(new EventEmitter(), {
        setWindowOpenHandler() {},
        async loadURL(url) { page.window.location = new URL(url); },
        getURL: () => page.window.location.href,
        isDestroyed: () => !!this.closed,
        close: () => { this.closed = true; },
        executeJavaScript: script => vm.runInNewContext(script, page)
      });
      views.push(this);
    }
  }
  const account = { id: 'user_example', email: 'test@example.com' };
  const web = createCursorWebSession({
    BrowserWindow: Window, WebContentsView: View,
    fromPartition: name => { assert.equal(name, 'persist:cursor-dashboard'); return session; },
    readIdentity: async () => ({ ok: true, account }),
    getProxyConfig: () => null
  });
  return { requests, views, windows, session, account, web };
}

test('Cursor dashboard requests use the persistent session only for approved same-origin reads', async () => {
  const { web, requests, views, session } = fixture();
  const url = 'https://cursor.com/api/dashboard/get-filtered-usage-events';
  const result = await web.fetch(url, { method: 'POST', body: '{}', headers: { Authorization: 'unused' } });
  assert.deepEqual(await result.json(), { events: [] });
  assert.equal(requests[0].page, true);
  assert.equal(requests[0].url, '/api/dashboard/get-filtered-usage-events');
  assert.equal(requests[0].init.credentials, 'same-origin');
  assert.equal(requests[0].init.mode, 'same-origin');
  assert.equal(requests[0].init.redirect, 'error');
  assert.equal(requests[0].init.headers.Authorization, undefined);
  assert.equal(requests[0].init.headers.Origin, undefined);
  assert.equal(views[0].options.webPreferences.session, session);
  await web.fetch('https://cursor.com/api/auth/me');
  assert.equal(requests[1].init.credentials, 'include');
  await assert.rejects(web.fetch('https://example.com/api/auth/me'));
  await assert.rejects(web.fetch('https://cursor.com/api/unknown'));
  await assert.rejects(web.fetch(url, { method: 'DELETE' }));
  assert.equal(requests.length, 2);
  await web.disconnect();
  assert.equal(views[0].closed, true);
});

test('Cursor web login verifies an identity, flushes the scoped session and clears it on disconnect', async () => {
  const { web, windows, session, account } = fixture();
  const login = web.login();
  await new Promise(resolve => setImmediate(resolve));
  const [win] = windows;
  assert.equal(win.url, 'https://cursor.com/dashboard');
  assert.equal(win.options.webPreferences.session, session);
  assert.equal(win.options.webPreferences.sandbox, true);
  assert.equal(win.options.webPreferences.nodeIntegration, false);
  assert.equal(win.options.webPreferences.preload, undefined);
  win.webContents.emit('did-navigate', {}, win.url);
  assert.deepEqual(await login, { ok: true, account });
  assert.equal(session.flushed, true);
  assert.equal(win.closed, true);
  await web.disconnect();
  assert.equal(session.cleared, true);
});

test('Cursor refuses a dashboard read if its page has moved to another origin', async () => {
  const { web, views, requests } = fixture();
  const url = 'https://cursor.com/api/dashboard/get-plan-info';
  await web.fetch(url, { method: 'POST', body: '{}' });
  await views[0].webContents.loadURL('https://example.com/');
  await assert.rejects(web.fetch(url, { method: 'POST', body: '{}' }), /dashboard is unavailable/);
  assert.equal(requests.length, 1);
  await web.disconnect();
});

test('closing the Cursor login window leaves the account unlinked', async () => {
  const { web, windows, session } = fixture();
  const login = web.login();
  await new Promise(resolve => setImmediate(resolve));
  windows[0].close();
  assert.deepEqual(await login, { ok: false, code: 'CANCELLED' });
  assert.equal(session.flushed, undefined);
});
