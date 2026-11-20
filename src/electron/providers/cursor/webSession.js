// @ts-check
'use strict';

const { createSessionProxyApplier } = require('../../networkProxy');
const { createCursorDashboardPage } = require('./dashboardPage');

const PARTITION = 'persist:cursor-dashboard';
const DASHBOARD = 'https://cursor.com/dashboard';
const READ_ENDPOINTS = new Map([
  ['/api/auth/me', 'GET'],
  ['/api/usage-summary', 'GET'],
  ['/api/usage', 'GET'],
  ['/api/dashboard/get-sand-usage-status', 'POST'],
  ['/api/dashboard/get-plan-info', 'POST'],
  ['/api/dashboard/get-user-prepaid-billing', 'POST'],
  ['/api/dashboard/v2/query-billing-items', 'GET'],
  ['/api/dashboard/get-filtered-usage-events', 'POST']
]);

/** @param {string} url */
function isWebNavigation(url) {
  try { return new URL(url).protocol === 'https:'; } catch { return false; }
}

/**
 * @typedef {{ok:true,account:{id:string,email:string}} | {ok:false,code?:string,error?:string}} LoginResult
 * @param {{fromPartition:(name:string)=>Electron.Session, BrowserWindow:typeof import('electron').BrowserWindow, WebContentsView:typeof import('electron').WebContentsView,
 * readIdentity:(request:(url:string, init?:RequestInit)=>Promise<Response>, options:{signal:AbortSignal})=>Promise<{ok:boolean,account?:{id:string,email:string}}>,
 * getProxyConfig:()=>Electron.ProxyConfig|null}} options
 */
function createCursorWebSession({ fromPartition, BrowserWindow, WebContentsView, readIdentity, getProxyConfig }) {
  /** @type {Electron.Session|undefined} */
  let browserSession;
  /** @type {Promise<LoginResult>|null} */
  let pendingLogin = null;
  /** @type {Electron.BrowserWindow|null} */
  let loginWindow = null;
  let connection = new AbortController();

  function getSession() {
    if (!browserSession) {
      browserSession = fromPartition(PARTITION);
      browserSession.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
      browserSession.setPermissionCheckHandler(() => false);
      browserSession.on('will-download', (event) => event.preventDefault());
    }
    return browserSession;
  }

  const proxy = createSessionProxyApplier({ getSession, getConfig: getProxyConfig });
  const page = createCursorDashboardPage(() => new WebContentsView({
    webPreferences: { session: getSession(), sandbox: true, contextIsolation: true, nodeIntegration: false }
  }));

  /** @param {string} input @param {RequestInit} [init] */
  async function fetchDashboard(input, init = {}) {
    const url = new URL(input);
    const method = init.method || 'GET';
    if (url.origin !== 'https://cursor.com' || url.username || url.password || READ_ENDPOINTS.get(url.pathname) !== method) {
      throw new TypeError('Unsupported Cursor dashboard request');
    }
    const signal = init.signal ? AbortSignal.any([connection.signal, init.signal]) : connection.signal;
    await proxy.ensureReady();
    if (method === 'POST') {
      if (typeof init.body !== 'string') throw new TypeError('Cursor dashboard reads require a JSON body');
      return page.post(url, init.body, signal);
    }
    return getSession().fetch(url.href, {
      method, signal, headers: { Accept: 'application/json' },
      credentials: 'include', redirect: 'error', cache: 'no-store'
    });
  }

  async function openSignIn() {
    await proxy.ensureReady();
    const prefs = { session: getSession(), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false };
    const win = new BrowserWindow({ width: 840, height: 760, autoHideMenuBar: true, webPreferences: prefs });
    loginWindow = win;
    /** @type {Set<Electron.BrowserWindow>} */
    const children = new Set();
    const controller = new AbortController();
    let checking = false;
    /** @type {NodeJS.Timeout|undefined} */
    let timer;
    /** @type {Promise<LoginResult>} */
    const result = new Promise(resolve => {
      const timeout = setTimeout(() => finish({ ok: false, error: 'Cursor sign-in timed out.' }), 10 * 60_000);
      /** @param {LoginResult} value */
      function finish(value) {
        if (controller.signal.aborted) return;
        controller.abort();
        clearTimeout(timeout);
        clearTimeout(timer);
        for (const child of children) if (!child.isDestroyed()) child.destroy();
        if (!win.isDestroyed()) win.destroy();
        resolve(value);
      }
      const check = async () => {
        if (checking || controller.signal.aborted) return;
        checking = true;
        try {
          const identity = await readIdentity(fetchDashboard, { signal: controller.signal });
          if (identity.ok && identity.account) {
            await getSession().cookies.flushStore();
            finish({ ok: true, account: identity.account });
          }
        } catch { /* The login page remains available during a network interruption. */ }
        finally {
          checking = false;
          if (!controller.signal.aborted) {
            clearTimeout(timer);
            timer = setTimeout(check, 5000);
          }
        }
      };

      /** @param {Electron.BrowserWindow} window */
      function protect(window) {
        const wc = window.webContents;
        window.removeMenu();
        window.on('page-title-updated', event => event.preventDefault());
        wc.on('did-navigate', (_event, url) => {
          if (isWebNavigation(url)) window.setTitle('Cursor · ' + new URL(url).origin);
          void check();
        });
        /** @param {{url:string, preventDefault:()=>void}} event */
        const restrict = (event) => {
          if (!isWebNavigation(event.url)) event.preventDefault();
        };
        wc.on('will-navigate', restrict);
        wc.on('will-redirect', restrict);
        wc.setWindowOpenHandler(({ url }) => isWebNavigation(url)
          ? { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: prefs } }
          : { action: 'deny' });
        wc.on('did-create-window', child => {
          children.add(child);
          child.once('closed', () => children.delete(child));
          protect(child);
        });
      }
      protect(win);
      win.once('closed', () => finish({ ok: false, code: 'CANCELLED' }));
      void win.loadURL(DASHBOARD).catch(error => {
        if (error.code !== 'ERR_ABORTED') finish({ ok: false, error: 'Unable to open the Cursor login page.' });
      });
    });
    return result;
  }

  return {
    fetch: fetchDashboard,
    login() {
      if (pendingLogin) {
        loginWindow?.focus();
        return pendingLogin;
      }
      pendingLogin = openSignIn().finally(() => { pendingLogin = null; loginWindow = null; });
      return pendingLogin;
    },
    async disconnect() {
      loginWindow?.close();
      connection.abort();
      page.close();
      try { await getSession().clearData(); }
      finally { connection = new AbortController(); }
    }
  };
}

module.exports = { createCursorWebSession };
