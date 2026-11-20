// @ts-check
'use strict';

const ORIGIN = 'https://cursor.com';

// Runs in the ordinary Cursor page, under its browser origin and CSP. Only the
// status and body of an allowlisted dashboard read are returned to main.
/** @param {string} endpoint @param {string} body @param {string} cancelEvent */
async function postOnPage(endpoint, body, cancelEvent) {
  if (window.location.origin !== 'https://cursor.com') throw new Error('Cursor origin changed');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  window.addEventListener(cancelEvent, cancel, { once: true });
  try {
    const response = await fetch(endpoint, {
      method: 'POST', mode: 'same-origin', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body, signal: controller.signal
    });
    if (!response.ok || !response.body) return { status: response.status, data: null };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let data = '';
    let bytes = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > 64 * 1024 * 1024) {
        controller.abort();
        throw new Error('Cursor dashboard response is too large');
      }
      data += decoder.decode(chunk.value, { stream: true });
    }
    return { status: response.status, data: data + decoder.decode() };
  } finally { window.removeEventListener(cancelEvent, cancel); }
}

/** @param {()=>Electron.WebContentsView} createView */
function createCursorDashboardPage(createView) {
  /** @type {Electron.WebContentsView|null} */
  let view = null;
  /** @type {Promise<void>|undefined} */
  let ready;
  let sequence = 0;

  function close() {
    const contents = view?.webContents;
    view = null;
    ready = undefined;
    if (contents && !contents.isDestroyed()) contents.close();
  }

  /** @param {URL} url @param {string} body @param {AbortSignal} signal @returns {Promise<Response>} */
  async function post(url, body, signal) {
    signal.throwIfAborted();
    if (!view || view.webContents.isDestroyed()) {
      view = createView();
      const contents = view.webContents;
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      const restrict = (/** @type {{url:string,preventDefault:()=>void}} */ event) => {
        if (new URL(event.url).origin !== ORIGIN) event.preventDefault();
      };
      contents.on('will-navigate', restrict);
      contents.on('will-redirect', restrict);
      contents.once('render-process-gone', () => { if (view?.webContents === contents) close(); });
      ready = contents.loadURL(ORIGIN + '/').catch(error => {
        if (view?.webContents === contents) close();
        throw error;
      });
    }
    const contents = view.webContents;
    const cancelEvent = 'token-monitor-cancel-' + ++sequence;
    return new Promise((resolve, reject) => {
      let dispatched = false;
      const abort = () => {
        if (dispatched && !contents.isDestroyed()) {
          void contents.executeJavaScript(`window.dispatchEvent(new Event(${JSON.stringify(cancelEvent)}))`).catch(() => {});
        }
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve(ready).then(async () => {
        signal.throwIfAborted();
        if (new URL(contents.getURL()).origin !== ORIGIN) throw new Error('Cursor dashboard is unavailable');
        const args = [url.pathname + url.search, body, cancelEvent].map(value => JSON.stringify(value)).join(',');
        dispatched = true;
        const { status, data } = await contents.executeJavaScript(`(${postOnPage.toString()})(${args})`);
        return new Response(data, { status });
      }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
  return { post, close };
}

module.exports = { createCursorDashboardPage };
