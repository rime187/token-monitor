'use strict';

(function exposeClientStatusPresentation(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorClientStatusPresentation = api;
})(typeof window !== 'undefined' ? window : null, function createClientStatusPresentationApi() {
  // File-based clients own their data directory. Cursor and Antigravity read
  // generated caches, which can still be absent after a desktop sign-in.
  const MISSING_LABELS = {
    cursor: { key: 'settings.tools.status.signIn', tone: 'setup' },
    antigravity: { key: 'settings.tools.status.openApp', tone: 'setup' }
  };
  const MISSING_DEFAULT = { key: 'settings.tools.status.missing', tone: 'muted' };

  const STATUS_TAGS = {
    active: { key: 'settings.tools.status.active', tone: 'ok' },
    waiting: { key: 'settings.tools.status.waiting', tone: 'neutral' }
  };

  function normalizeId(value) {
    return String(value || '').trim().toLowerCase();
  }

  // Returns { key, tone } for a tag, or null when no tag should render
  // (untracked clients, or an unknown status).
  function clientStatusTag(clientId, status, cursorAccountStatus) {
    if (status === 'missing') {
      const id = normalizeId(clientId);
      if (id === 'cursor' && (cursorAccountStatus?.desktopAccount || hasCursorCloudAccount(cursorAccountStatus))) return STATUS_TAGS.waiting;
      return MISSING_LABELS[id] || MISSING_DEFAULT;
    }
    return STATUS_TAGS[status] || null;
  }

  function hasCursorCloudAccount(status) {
    return status?.accounts?.some(account => !account.expired && !account.error);
  }

  function cursorTrackingBlockReason(status, tracked) {
    if (tracked || hasCursorCloudAccount(status)) return '';
    return !status || status.desktopAccount ? 'settings.cursor.cloudRequired' : 'settings.cursor.loginRequired';
  }

  return { clientStatusTag, cursorTrackingBlockReason };
});
